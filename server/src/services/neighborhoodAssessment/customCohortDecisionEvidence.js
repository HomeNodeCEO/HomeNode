import { createHash } from 'node:crypto';
import { assessmentDate, canonicalAssessmentJson as json } from './contract.js';
import { prepareCohortDecisionCommandV1, COHORT_DECISION_COMMAND_LIMITS } from './cohortDecisionCommand.js';
import { prepareCustomCohortAssessmentPreparation } from './customCohortAssessmentPreparation.js';
import { prepareCustomCohortContextHeader } from './customCohortContextContract.js';
import { CUSTOM_COHORT_CAPTURE_INPUT_LIMITS } from './customCohortCaptureInputs.js';

export const CUSTOM_COHORT_DECISION_EVIDENCE_VERSION = 1;
export const CUSTOM_COHORT_DECISION_EVIDENCE_LIMITS = Object.freeze({
  indexed_utf8_bytes: CUSTOM_COHORT_CAPTURE_INPUT_LIMITS.logical_utf8_bytes,
  output_utf8_bytes: 8_388_608,
  reference_utf8_bytes: 2_048,
});
const KEYS = ['capture_id', 'capture_revision', 'manifest_sha256', 'chunk_id',
  'chunk_sha256', 'record_key', 'record_content_sha256'];
const HASH_KEYS = new Set(['manifest_sha256', 'chunk_sha256', 'record_content_sha256']);
const L = CUSTOM_COHORT_DECISION_EVIDENCE_LIMITS;
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const address = (source, record) => JSON.stringify([source, record]);
const same = (a, b) => json(a) === json(b);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function fail(reason) {
  throw Object.assign(new TypeError(`custom_cohort_decision_evidence_${reason}`), {
    code: 'CUSTOM_COHORT_DECISION_EVIDENCE_INVALID', reason,
  });
}
function check(ok, reason) { if (!ok) fail(reason); }
function reference(value) {
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === KEYS.length && KEYS.every(key => Object.hasOwn(value, key)), 'reference_shape');
  for (const key of KEYS) {
    check(typeof value[key] === 'string' && value[key].length > 0, 'reference_shape');
    check(HASH_KEYS.has(key) ? /^[a-f0-9]{64}$/.test(value[key])
      : Buffer.byteLength(value[key]) <= COHORT_DECISION_COMMAND_LIMITS.opaque_bytes, 'reference_shape');
  }
  return value;
}
function output(value) {
  // These are detached, fully admitted records, never caller getters/toJSON.
  check(Buffer.byteLength(JSON.stringify(value)) <= L.output_utf8_bytes, 'output_limit');
  return freeze(value);
}
function validDate(value) {
  try { return assessmentDate(value); } catch { return null; }
}

/** Internal pure adapter over an owner-loaded exact retained graph. Admission
 * reuses the actual preparation's descriptor, header, all-four-dependency,
 * target, study-period, subject and recorded-selection checks. No caller flag
 * can replace them. This is NOT authentication, original-acquisition authority,
 * provider field meaning, factual support, a decision ledger or eligibility.
 */
export function createCustomCohortDecisionEvidenceResolver(input) {
  let preparation;
  try { preparation = prepareCustomCohortAssessmentPreparation(input); }
  catch { fail('retained_input_invalid'); }
  const header = prepareCustomCohortContextHeader(input.context_header_json).body;
  const binding = freeze({ context_ref: { ...preparation.binding.context_ref }, target_ref: {
    report_file_id: header.target.report_file_id, workflow_type: 'custom_appraisal',
    workflow_target_id: header.target.workflow_target_id },
  // Explicit Custom adapter identity, not an assertion of an existing study registry.
  study_ref: { study_id: header.context_id, definition_revision: '1',
    definition_sha256: header.study_input.content_sha256 } });
  const capture = input.retained_inputs.acquisition.capture_result.source_capture;
  const snapshots = new Map(capture.source_snapshots.map(source => [source.id, source]));
  const records = new Map(), candidates = new Map(), canonical = new Map();
  const stock = new Set(input.retained_inputs.selector.account_roster.account_ids);
  let indexedBytes = 0;
  for (const source of capture.sources) {
    const role = source.payload.projection.definition.role;
    for (const row of source.payload.records) {
      // Store admitted canonical bytes, not references to the caller's mutable
      // graph. Only a requested record is decoded; no full-graph output copy.
      const bytes = json(row);
      indexedBytes += Buffer.byteLength(bytes);
      check(indexedBytes <= L.indexed_utf8_bytes, 'index_limit');
      const ref = freeze(reference({ capture_id: source.payload.metadata.id,
        capture_revision: source.payload.metadata.revision,
        manifest_sha256: header.selection_input.content_sha256, chunk_id: source.id,
        chunk_sha256: snapshots.get(source.id).content_sha256, record_key: row.record_id,
        record_content_sha256: sha(bytes) }));
      const key = address(source.id, row.record_id);
      check(!records.has(key), 'duplicate_record');
      const entry = { evidence_ref: ref, role, bytes };
      records.set(key, entry);
      if (role === 'transactions') {
        check(!candidates.has(row.record_id), 'duplicate_candidate');
        const data = row.data.data;
        entry.canonical_id = data.canonical_transaction_id;
        // Preserve raw stored date values; do not substitute normalized dates.
        entry.dates = [row.data.raw_projection.sale_closing_date, row.data.raw_projection.source_close_date];
        candidates.set(row.record_id, entry);
        if (entry.canonical_id !== null) {
          const rows = canonical.get(entry.canonical_id) ?? [];
          rows.push(entry); canonical.set(entry.canonical_id, rows);
        }
      }
    }
  }
  function deriveEvidenceRef(sourceRef, recordId) {
    check(typeof sourceRef === 'string' && typeof recordId === 'string', 'record_address');
    const entry = records.get(address(sourceRef, recordId));
    check(entry, 'record_not_found');
    return entry.evidence_ref;
  }
  function lookup(ref) {
    reference(ref);
    const entry = records.get(address(ref.chunk_id, ref.record_key));
    check(entry && same(entry.evidence_ref, ref), 'evidence_reference_mismatch');
    return entry;
  }
  const resolvedRecord = entry => ({ evidence_ref: entry.evidence_ref, role: entry.role, record: JSON.parse(entry.bytes) });
  function resolveEvidenceRef(referenceJson) {
    check(typeof referenceJson === 'string' && Buffer.byteLength(referenceJson) <= L.reference_utf8_bytes, 'reference_input');
    let ref;
    try { ref = JSON.parse(referenceJson); } catch { fail('reference_input'); }
    check(JSON.stringify(ref) === referenceJson, 'reference_input');
    return output(resolvedRecord(lookup(ref)));
  }
  function closingDate(command, candidate) {
    const rows = candidate.canonical_id === null ? [candidate] : canonical.get(candidate.canonical_id);
    let firstDate = null, conflicting = false, observed = 0, missing = 0, invalid = 0;
    // Inspect the entire retained canonical-row group, including uncited rows,
    // so selecting the one convenient source cannot hide captured conflicts.
    // This is an existing canonical grouping, not verified economic equivalence.
    for (const row of rows) for (const raw of row.dates) {
      if (raw === null || raw === undefined || raw === '') { missing++; continue; }
      const date = validDate(raw);
      if (date === null) { invalid++; continue; }
      observed++;
      if (firstDate === null) firstDate = date;
      else if (date !== firstDate) conflicting = true;
    }
    const known = command.claim.state === 'known';
    const cited = known && command.claim.value.event_evidence_refs.some(ref => same(ref, candidate.evidence_ref));
    const claimed = known ? command.claim.value.date : null;
    const status = !known ? 'not_evaluated' : conflicting ? 'conflicting_evidence'
      : !cited || !observed || missing || invalid ? 'missing_evidence'
        : firstDate !== claimed ? 'claim_mismatch' : 'matched';
    return { status, reason: !known ? 'unknown_claim' : null,
      claimed_date: claimed, observed_date: conflicting ? null : firstDate,
      candidate_cited: Boolean(cited), canonical_transaction_id: candidate.canonical_id,
      evaluated_record_count: rows.length, observed_field_count: observed,
      missing_field_count: missing, invalid_field_count: invalid,
      conflicting_observations: conflicting,
      comparison_basis: 'captured_stored_canonical_and_source_date_columns',
      source_meaning: 'not_established', transaction_equivalence: 'not_established' };
  }
  function bindCommand(commandJson) {
    const admitted = prepareCohortDecisionCommandV1(commandJson);
    check(admitted.status === 'syntax_valid', `command_${admitted.reason}`);
    const command = admitted.command;
    check(same(command.target_ref, binding.target_ref), 'target_mismatch');
    check(same(command.expected_context, binding.context_ref), 'context_mismatch');
    check(same(command.study_ref, binding.study_ref), 'study_mismatch');
    const candidate = command.subject_ref.kind === 'capture_candidate' ? candidates.get(command.subject_ref.key) : null;
    check(command.subject_ref.kind === 'capture_candidate' ? candidate : stock.has(command.subject_ref.key), 'subject_not_found');
    const entries = command.evidence_refs.map(lookup);
    check(entries.reduce((total, entry) => total + Buffer.byteLength(entry.bytes), 0) <= L.output_utf8_bytes, 'output_limit');
    const resolved = entries.map(resolvedRecord);
    // Arbitrary supporting references can be bound without implying they prove
    // the subject's claim. Only closing_date currently compares field values.
    const observation = command.claim.kind === 'closing_date' ? closingDate(command, candidate)
      : { status: 'not_evaluated', reason: 'claim_meaning_resolver_unavailable' };
    return output({ binding_version: 1, status: 'bound', validation_scope: 'retained_evidence_binding_only',
      authority: 'not_established', binding, command, resolved_evidence: resolved, claim_observation: observation,
      runtime_requirements: { authorization: 'not_checked', provider_rights: 'not_checked', subject_freshness: 'not_checked',
        generation: 'not_checked', predecessor: 'not_checked', decision_references: 'not_checked' },
      assessment: null, apply: { status: 'blocked', reason: 'supported_fact_resolver_unavailable' } });
  }
  return Object.freeze({ binding, deriveEvidenceRef, resolveEvidenceRef, bindCommand });
}
