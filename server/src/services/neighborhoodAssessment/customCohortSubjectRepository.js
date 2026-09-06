import { canonicalAssessmentJson } from './contract.js';
import { decodeNeighborhoodOriginalValue } from './originalValueDecoding.js';
import { projectCustomNeighborhoodMaterialInputs } from './customMaterialInputs.js';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob } from './cohortEvidenceBlobRepository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = ['report.land_details', 'report.property_characteristics', 'report.subject_identification'];
const SCOPE_KEYS = ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id'];
const CAP = 1_500_000;
function fail(reason) { throw Object.assign(new Error(`custom_cohort_subject_${reason}`), { code: `custom_cohort_subject_${reason}` }); }
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1 || !result.rows[0]) fail('not_found');
  return result.rows[0];
}
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every(key => Object.hasOwn(value, key))) fail('invalid_shape');
}
function scopeOf(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) fail('invalid_scope');
  const decoded = decodeNeighborhoodOriginalValue('jsonb', 'present', text);
  if (decoded.status !== 'decoded') fail('invalid_scope');
  const scope = decoded.value;
  closed(scope, SCOPE_KEYS);
  for (const key of ['organization_id', 'report_file_id']) {
    if (typeof scope[key] !== 'string' || scope[key].length !== 36 || !UUID.test(scope[key])) fail('invalid_scope');
  }
  const id = scope.assignment_file_id;
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(id) || id.length > 19 ||
      String(BigInt(id)) !== id || BigInt(id) > 9223372036854775807n) fail('invalid_scope');
  const account = scope.account_id;
  if (typeof account !== 'string' || !account || account.length > 100 || account.trim() !== account ||
      /[\u0000-\u001f\u007f]/.test(account)) fail('invalid_scope');
  return Object.freeze({ ...scope, organization_id: scope.organization_id.toLowerCase(), report_file_id: scope.report_file_id.toLowerCase() });
}
function date(text, nullable = false) {
  if (nullable && text === null) return null;
  const decoded = decodeNeighborhoodOriginalValue('date', 'present', text);
  if (decoded.status !== 'decoded') fail('effective_date_unresolved');
  return decoded.value;
}
const pgCell = column => `jsonb_build_object('state', CASE WHEN ${column} IS NULL THEN 'sql_null'
  WHEN ${column}='null'::jsonb THEN 'json_null' ELSE 'present' END, 'pg_text', ${column}::text)`;
const boundedText = row => {
  if (typeof row.original_json !== 'string' || Buffer.byteLength(row.original_json) > CAP) fail('input_limit');
  return row.original_json;
};
function represented(target, sectionsJson, snapshotJson) {
  const result = projectCustomNeighborhoodMaterialInputs(canonicalAssessmentJson(target), sectionsJson, snapshotJson);
  if (result.status !== 'represented') fail(result.status === 'limit_exceeded' ? 'input_limit' : 'unsupported_inputs');
  // The shared projector has admitted every outer token and the complete
  // snapshot objects before this parse. Manual unselected numeric tokens stay
  // inside pg_text; do not parse/round those section values here.
  const s = JSON.parse(snapshotJson);
  const snapshot = { snapshot_evidence_version: 1, snapshot_id: s.id, appraisal_case_id: s.appraisal_case_id,
    snapshot_version: s.snapshot_version, parent_snapshot_id: s.parent_snapshot_id,
    source_report_file_id: s.source_report_file_id, verification_status: s.verification_status,
    effective_date: date(s.effective_date, true), inspection_date: date(s.inspection_date, true),
    subject_data: JSON.parse(s.subject_data.pg_text), source_manifest: JSON.parse(s.source_manifest.pg_text),
    legacy_checksum_sha256: s.checksum_sha256 };
  return { snapshot, material: result.material_input };
}

/** Actual scoped PostgreSQL reads plus immutable retained inputs, NOT an issuer
 * context or authorization grant. Caller supplies its checked-out client inside
 * a bounded transaction AFTER fresh exact assignment access. Capture takes the
 * target/workfile/report/case/snapshot locks in that order, all NOWAIT. Caller
 * owns rollback/commit/deadline and final freshness; no provider, source selector,
 * file creation, head selection, signing, or existing row writes occur here.
 * Do not expose this repository as an unguarded blob or context HTTP API.
 */
export function createCustomCohortSubjectRepository(client, scopeJson) {
  if (typeof client?.query !== 'function' || typeof client.release !== 'function') fail('caller_client_required');
  const scope = scopeOf(scopeJson), query = client.query.bind(client);
  const values = [scope.organization_id, scope.report_file_id, scope.assignment_file_id, scope.account_id];
  const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
  const readBlob = async ref => {
    closed(ref, ['content_sha256', 'canonical_utf8_bytes']);
    const text = await blobs.get(ref.content_sha256, ref.canonical_utf8_bytes);
    if (text === null) fail('missing_evidence');
    return JSON.parse(text);
  };
  const sameScope = target => {
    if (!SCOPE_KEYS.every(key => target?.[key] === scope[key])) fail('target_mismatch');
  };
  return Object.freeze({
    async capture() {
      one(await query(`/* custom-cohort-subject:assignment */ SELECT id::text FROM app.assignment_files
        WHERE organization_id=$1 AND id=$2::bigint AND account_id=$3 FOR UPDATE NOWAIT`,
      [scope.organization_id, scope.assignment_file_id, scope.account_id]));
      const workfile = one(await query(`/* custom-cohort-subject:workfile */ SELECT status, signed_at::text
        FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1::bigint FOR UPDATE NOWAIT`, [scope.assignment_file_id]));
      if (workfile.status !== 'draft' || workfile.signed_at !== null) fail('protected_workfile');
      if (one(await query(`/* custom-cohort-subject:signature */ SELECT EXISTS(SELECT 1 FROM app.custom_appraisal_signed_snapshots
        WHERE assignment_file_id=$1::bigint) AS present`, [scope.assignment_file_id])).present !== false) fail('protected_workfile');
      const report = one(await query(`/* custom-cohort-subject:report */ SELECT appraisal_case_id, subject_snapshot_id
        FROM app.report_files WHERE organization_id=$1 AND id=$2 AND custom_assignment_file_id=$3::bigint
          AND account_id=$4 AND workflow_type='custom_appraisal' AND uad_workfile_id IS NULL AND tax_protest_file_id IS NULL
        FOR SHARE NOWAIT`, values));
      const caseRow = one(await query(`/* custom-cohort-subject:case */ SELECT effective_date::text
        FROM app.appraisal_cases WHERE id=$1 AND organization_id=$2 AND account_id=$3 FOR SHARE NOWAIT`,
      [report.appraisal_case_id, scope.organization_id, scope.account_id]));
      const snapshotJson = boundedText(one(await query(`/* custom-cohort-subject:snapshot */
        WITH held AS (SELECT id, appraisal_case_id, snapshot_version, parent_snapshot_id, source_report_file_id,
          verification_status, effective_date::text, inspection_date::text,
          ${pgCell('subject_data')} AS subject_data, ${pgCell('source_manifest')} AS source_manifest,
          checksum_sha256, created_by_user_id, created_at::text
          FROM app.appraisal_subject_snapshots WHERE id=$1 AND appraisal_case_id=$2 FOR SHARE NOWAIT),
        encoded AS (SELECT row_to_json(held)::text AS value FROM held)
        SELECT CASE WHEN octet_length(value)<=$3 THEN value ELSE NULL END AS original_json FROM encoded`,
      [report.subject_snapshot_id, report.appraisal_case_id, CAP])));
      const sectionsJson = boundedText(one(await query(`/* custom-cohort-subject:sections */
        WITH held AS (SELECT assignment_file_id::text, section_key, ${pgCell('section_value')} AS section_value,
          revision, last_applied_session_id, last_applied_by_user_id, created_at::text, updated_at::text
          FROM app.custom_appraisal_sections WHERE assignment_file_id=$1::bigint AND section_key=ANY($2::text[])
          ORDER BY section_key COLLATE "C" FOR SHARE NOWAIT),
        encoded AS (SELECT jsonb_agg(jsonb_build_object('section_key', k, 'row_state',
          CASE WHEN held.section_key IS NULL THEN 'absent' ELSE 'present' END, 'row', to_jsonb(held)) ORDER BY ord)::text AS value
          FROM unnest($2::text[]) WITH ORDINALITY AS keys(k,ord) LEFT JOIN held ON held.section_key=k)
        SELECT CASE WHEN octet_length(value)<=$3 THEN value ELSE NULL END AS original_json FROM encoded`,
      [scope.assignment_file_id, KEYS, CAP])));
      const decoded = decodeNeighborhoodOriginalValue('jsonb', 'present', snapshotJson);
      if (decoded.status !== 'decoded' || !decoded.value || typeof decoded.value !== 'object' || Array.isArray(decoded.value)) fail('unsupported_inputs');
      const s = decoded.value;
      const target = { ...scope, workflow_type: 'custom_appraisal', appraisal_case_id: report.appraisal_case_id,
        subject_snapshot_id: report.subject_snapshot_id, snapshot_version: s.snapshot_version };
      const caseDate = date(caseRow.effective_date, true), snapshotDate = date(s.effective_date, true);
      if ((!caseDate && !snapshotDate) || (caseDate && snapshotDate && caseDate !== snapshotDate)) fail('effective_date_unresolved');
      const prepared = represented(target, sectionsJson, snapshotJson);
      // Admit the entire bounded bundle before the first INSERT. Oversize raw
      // wrappers (JSON string escaping included) cannot leave partial evidence.
      const pending = [];
      const prepare = value => {
        const text = canonicalAssessmentJson(value), ref = prepareNeighborhoodCohortBlob(text);
        pending.push(text);
        return ref;
      };
      const body = { subject_input_version: 1, usage: 'retained_subject_inputs_only', target,
        effective_date: snapshotDate ?? caseDate, case_effective_date: caseDate,
        original_snapshot_row: prepare({ pg_row_json: snapshotJson }),
        original_section_reads: prepare({ pg_reads_json: sectionsJson }),
        snapshot_evidence: prepare(prepared.snapshot), material_input: prepare(prepared.material) };
      const ref = prepare(body);
      for (const text of pending) await blobs.put(text);
      return ref;
    },
    async load(ref) {
      // Current tenant/file integrity remains required, but history must NOT be
      // silently rebound to the report's newer case/snapshot or current sections.
      one(await query(`/* custom-cohort-subject:history-target */ SELECT r.id FROM app.report_files r
        JOIN app.assignment_files a ON a.id=r.custom_assignment_file_id AND a.organization_id=r.organization_id AND a.account_id=r.account_id
        WHERE r.organization_id=$1 AND r.id=$2 AND r.custom_assignment_file_id=$3::bigint AND r.account_id=$4
          AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL`, values));
      const body = await readBlob(ref);
      closed(body, ['subject_input_version', 'usage', 'target', 'effective_date', 'case_effective_date',
        'original_snapshot_row', 'original_section_reads', 'snapshot_evidence', 'material_input']);
      if (body.subject_input_version !== 1 || body.usage !== 'retained_subject_inputs_only') fail('invalid_shape');
      sameScope(body.target);
      const originalSnapshot = await readBlob(body.original_snapshot_row), originalSections = await readBlob(body.original_section_reads);
      closed(originalSnapshot, ['pg_row_json']); closed(originalSections, ['pg_reads_json']);
      const prepared = represented(body.target, originalSections.pg_reads_json, originalSnapshot.pg_row_json);
      const caseDate = date(body.case_effective_date, true), snapshotDate = prepared.snapshot.effective_date;
      if ((!caseDate && !snapshotDate) || (caseDate && snapshotDate && caseDate !== snapshotDate) ||
          body.effective_date !== (snapshotDate ?? caseDate)) fail('effective_date_unresolved');
      const snapshot = await readBlob(body.snapshot_evidence), material = await readBlob(body.material_input);
      if (canonicalAssessmentJson(snapshot) !== canonicalAssessmentJson(prepared.snapshot) ||
          canonicalAssessmentJson(material) !== canonicalAssessmentJson(prepared.material)) fail('evidence_mismatch');
      return { ...body, original_snapshot: originalSnapshot, original_sections: originalSections, snapshot, material };
    },
  });
}
