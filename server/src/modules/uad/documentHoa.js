import { createHash } from 'node:crypto';
import { persistUadSectionWithClient } from './editor.js';
import { normalizedMonthlyHoaDues } from './completionSuggestions.js';
import { normalizeUadWorkfileId } from './workfiles.js';
import { assertLockedUadWorkfileMutable } from './workfileLifecycle.js';
import { sfrepDocumentPropertyRole } from '../../services/sfrepSubjectContext.js';
import { purchaseContractBoolean, purchaseContractCurrency } from '../../services/purchaseContractAnalysis.js';
import { rollbackWithDiscardReason } from '../../database/transactionCleanup.js';

export const UAD_HOA_DOCUMENT_FIELDS = new Set(['pud', 'hoa_dues_amount', 'hoa_frequency']);
const target = (context_key, uid, value) => ({ context_key, uid, value });
const raw = candidate => candidate.confirmed_value ?? candidate.normalized_value ?? candidate.raw_value;
const fieldKey = row => `${row.field_context}:${row.uad_uid}`;
const PUD = 'subject:0100.0026', DUES = 'project_association_dues:2500.0007';

/** One reviewed document supplies a coherent group. This application layer
 * requires an explicitly reviewed PUD candidate, including an extraction-stage
 * HOA workflow assumption; it never infers PUD from dues alone or unknown.
 * Existing appraiser fields (even null) are preserved;
 * only this same PDF's prior automatic group may be refreshed or cleared. */
export function buildUadDocumentHoaPlan(document, subjectContext, existing = []) {
  if (document?.document_type !== 'mls_sheet') throw new Error('uad_document_project_mls_requires_manual_entry');
  if (!Number.isSafeInteger(document.id) || document.id <= 0 || !/^[a-f0-9]{64}$/.test(document.checksum_sha256 || '')
    || !Array.isArray(document.candidates) || document.candidates.length > 200) throw new Error('invalid_document_project_evidence');
  if (sfrepDocumentPropertyRole({ ...document, subject_context: subjectContext }) !== 'subject') {
    throw new Error('uad_document_project_subject_requires_manual_entry');
  }
  const candidates = document.candidates.filter(row => row.review_status === 'confirmed'
    && Number(row.document_id) === document.id && UAD_HOA_DOCUMENT_FIELDS.has(row.field_key));
  const warnings = [], conflicts = [], sections = [];
  const read = (key, normalize) => {
    const entries = candidates.filter(row => row.field_key === key);
    const values = entries.map(row => normalize(raw(row)));
    if (values.some(value => value === null) || new Set(values).size > 1) throw new Error('uad_document_project_conflicting_values_requires_manual_entry');
    return values[0] ?? null;
  };
  const pud = read('pud', purchaseContractBoolean);
  const dues = pud === true ? read('hoa_dues_amount', purchaseContractCurrency) : null;
  const frequency = pud === true ? read('hoa_frequency', value => ['per_month', 'per_year', 'per_quarter', 'other'].includes(value) ? value : null) : null;
  const prefix = `assignment_document:${document.id}:hoa_project:sha256:${document.checksum_sha256}:`;
  const proof = candidates.map(row => ({ id: Number(row.id), field: row.field_key, value: raw(row),
    rawValue: row.raw_value, extractionMethod: row.extraction_method || null })).sort((a, b) => a.id - b.id);
  const sourceReference = `${prefix}evidence:${createHash('sha256').update(JSON.stringify(proof)).digest('hex')}`;
  if (candidates.some(row => row.field_key === 'pud' && /\bhoa_workflow_proxy$/.test(row.extraction_method || ''))) {
    warnings.push('HOA-based PUD selection is a reviewed workflow assumption, not legal proof of PUD status.');
  }
  if (candidates.some(row => row.field_key === 'pud' && /^voluntary$/i.test(String(row.raw_value || '').trim()))) {
    warnings.push('Voluntary HOA: no mandatory dues are inferred; the PUD decision remains subject to appraiser review.');
  }
  const result = () => ({ sections, conflicts, warnings, sourceReference, sourceEvidence: proof });
  if (pud === null) { warnings.push('PUD status needs confirmation before HOA fields can be applied.'); return result(); }
  const rows = existing.filter(row => !row.entity_id && [PUD, DUES].includes(fieldKey(row)));
  if (new Set(rows.map(fieldKey)).size !== rows.length) throw new Error('invalid_document_project_saved_values');
  const saved = new Map(rows.map(row => [fieldKey(row), row]));
  const owned = row => row?.source_type === 'document'
    && typeof row.source_reference === 'string' && row.source_reference.startsWith(prefix);
  const currentPud = saved.get(PUD);
  if (currentPud && !owned(currentPud) && currentPud.value !== pud) {
    conflicts.push({ field_key: PUD, reason: 'existing_value_preserved' });
    return result();
  }
  const currentDues = saved.get(DUES);
  if (currentDues && !owned(currentDues)) {
    conflicts.push({ field_key: DUES, reason: 'existing_value_preserved' });
    return result();
  }
  if (!currentPud || owned(currentPud)) sections.push({ section: 'subject', values: [target('subject', '0100.0026', pud)] });
  const monthlyDues = pud ? normalizedMonthlyHoaDues({ hoa_dues_amount: dues, hoa_frequency: frequency }) : null;
  if (pud && monthlyDues === null) warnings.push('Confirmed HOA amount and monthly, quarterly, or annual frequency are required to fill dues.');
  if (monthlyDues !== null || owned(currentDues)) {
    sections.push({ section: 'project_information', values: [target('project_association_dues', '2500.0007', monthlyDues)] });
  }
  return result();
}

/** Existing document route owns authorization. This transaction rechecks source,
 * signature state, confirmation, and preserved fields under the workfile lock.
 * Both sections commit together; never retry over a newer appraiser revision. */
export async function synchronizeUadDocumentHoa(pool, workfileIdValue, documentId, candidateId, actorUserId = null) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  if (![documentId, candidateId].every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('invalid_document_candidate');
  const client = await pool.connect();
  let rollbackFailure = null;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const locked = await client.query(`SELECT id, account_id, status, signed_at, current_revision
      FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`, [workfileId]);
    const workfile = locked.rows[0];
    if (!workfile) throw new Error('uad_workfile_not_found');
    await assertLockedUadWorkfileMutable(client, workfile);
    const documentRows = await client.query(`SELECT id, account_id, uad_workfile_id, document_type, processing_status, checksum_sha256
      FROM app.assignment_documents WHERE id = $1 AND uad_workfile_id = $2 AND account_id = $3 FOR UPDATE`,
    [documentId, workfileId, workfile.account_id]);
    const document = documentRows.rows[0];
    if (!document) throw new Error('document_not_found');
    const snapshot = await client.query(`SELECT subject_data FROM appraisal.uad_subject_snapshots
      WHERE workfile_id = $1 ORDER BY snapshot_version DESC LIMIT 1`, [workfileId]);
    const account = snapshot.rows[0]?.subject_data?.account;
    if (!account || account.account_id !== workfile.account_id) throw new Error('uad_subject_snapshot_conflict');
    const candidates = await client.query(`SELECT id, document_id, field_key, raw_value, normalized_value,
      confirmed_value, review_status, extraction_method FROM app.assignment_document_field_candidates
      WHERE document_id = $1 ORDER BY id LIMIT 201 FOR UPDATE`, [documentId]);
    const trigger = candidates.rows.find(row => Number(row.id) === candidateId);
    if (!trigger || !UAD_HOA_DOCUMENT_FIELDS.has(trigger.field_key)) throw new Error('invalid_document_candidate');
    if (trigger.review_status !== 'confirmed') throw new Error('uad_document_candidate_confirmation_required');
    const existing = await client.query('SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1 FOR UPDATE', [workfileId]);
    const plan = buildUadDocumentHoaPlan({ ...document, id: Number(document.id), candidates: candidates.rows },
      { accountId: account.account_id, address: account.address, city: account.city, postalCode: account.postal_code, state: account.state }, existing.rows);
    let revision = Number(workfile.current_revision), changed = 0;
    for (const section of plan.sections) {
      const saved = await persistUadSectionWithClient(client, { workfileId, expectedRevision: revision,
        saveReason: 'autosave', allowIncomplete: true, section: section.section, input: { values: section.values }, actorUserId,
        trustedSource: { sourceType: 'document', sourceReference: plan.sourceReference,
          changeSummary: 'Applied reviewed MLS HOA/PUD evidence as one protected group' } });
      revision = saved.currentRevision;
      changed += saved.changedCount;
    }
    if (changed) await client.query(`INSERT INTO appraisal.uad_audit_events
      (workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data, metadata)
      VALUES ($1::uuid, $2::uuid, 'uad_document.project_applied', 'assignment_document', $3, $4::jsonb, $5::jsonb)`,
    [workfileId, actorUserId, String(documentId), JSON.stringify(plan.sourceEvidence),
      JSON.stringify({ document_id: documentId, source_reference: plan.sourceReference, current_revision: revision,
        preserve_existing: true, warnings: plan.warnings, conflicts: plan.conflicts })]);
    await client.query('COMMIT');
    return { applied: changed > 0, field_key: trigger.field_key, section: 'project_information',
      sections: plan.sections.map(section => section.section), current_revision: revision, changed_field_count: changed,
      source_reference: plan.sourceReference, applied_fields: plan.sections.flatMap(section => section.values.map(value => ({ ...value, entity_id: null }))),
      warnings: plan.warnings, conflicts: plan.conflicts, ...(changed ? {} : { reason: 'existing_values_preserved_or_review_required' }) };
  } catch (error) {
    rollbackFailure = await rollbackWithDiscardReason(client, 'uad_document_project_rollback_failed');
    throw error;
  } finally { client.release(rollbackFailure || undefined); }
}
