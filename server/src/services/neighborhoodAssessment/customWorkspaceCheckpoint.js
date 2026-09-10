import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { normalizeCustomAppraisalSectionValue } from '../customAppraisalSectionValue.js';

// Editor navigation intent only. This is deliberately NOT the reserved accepted
// neighborhood_assessment section, an acquisition receipt or a source grant.
export const CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION = 'neighborhood_workspace';
export const CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS = Object.freeze({
  canonical_utf8_bytes: 32_768, group_ids: 129, recorded_group_ids: 128,
});
const UNASSIGNED = 'discovery:unassigned';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BATCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORDED_GROUP = /^recorded-cad:[a-f0-9]{64}$/;
const LIMITS = CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS;

function fail(reason) {
  throw Object.assign(new TypeError(`invalid_custom_neighborhood_workspace_checkpoint:${reason}`), {
    code: 'CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_INVALID', reason,
  });
}
function closed(value, required, name, optional = []) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(name);
  const allowed = [...required, ...optional], keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !allowed.includes(key))) fail(name);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${name}.non_data_property`);
  }
}
function period(value) {
  closed(value, ['start_date', 'end_date'], 'observation_period');
  let start, end;
  try { start = assessmentDate(value.start_date); end = assessmentDate(value.end_date); }
  catch { fail('observation_period'); }
  if (start > end) fail('observation_period');
  return { start_date: start, end_date: end };
}
function context(value) {
  closed(value, ['context_id', 'context_revision', 'context_sha256'], 'context_ref');
  // Bound each primitive before invoking the shared canonical/reference parser.
  if (typeof value.context_id !== 'string' || value.context_id.length !== 36
    || value.context_revision !== '1' || typeof value.context_sha256 !== 'string'
    || value.context_sha256.length !== 64) fail('context_ref');
  try { return prepareCustomCohortContextReference(canonicalAssessmentJson(value)); }
  catch { fail('context_ref'); }
}
function groups(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > LIMITS.group_ids) fail('group_ids');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail('group_ids');
  const result = [], seen = new Set(); let recorded = 0;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('group_ids');
    const id = descriptor.value;
    if (typeof id !== 'string' || (id !== UNASSIGNED && !RECORDED_GROUP.test(id)) || seen.has(id)) fail('group_ids');
    if (id !== UNASSIGNED && ++recorded > LIMITS.recorded_group_ids) fail('group_ids');
    seen.add(id); result.push(id);
  }
  return result; // Preserve explicit [] and order; never deduplicate or truncate.
}
function active(value) {
  if (value === null) return null;
  closed(value, ['context_ref', 'observation_period', 'selection'], 'active');
  closed(value.selection, ['revision', 'included_recorded_group_ids'], 'selection');
  if (!Number.isSafeInteger(value.selection.revision) || value.selection.revision < 1) fail('selection.revision');
  return { context_ref: context(value.context_ref), observation_period: period(value.observation_period),
    selection: { revision: value.selection.revision, included_recorded_group_ids: groups(value.selection.included_recorded_group_ids) } };
}
function privateSalesImport(value) {
  closed(value, ['batch_id', 'expected_review_revision'], 'private_sales_import');
  if (typeof value.batch_id !== 'string' || !BATCH_UUID.test(value.batch_id)
    || !Number.isInteger(value.expected_review_revision) || value.expected_review_revision < 1
    || value.expected_review_revision > 2147483647) fail('private_sales_import');
  return { batch_id: value.batch_id, expected_review_revision: value.expected_review_revision };
}
function pending(value, version) {
  if (value === null) return null;
  closed(value, ['operation_id', 'observation_period', ...(version === 2 ? ['private_sales_import'] : [])], 'pending_capture');
  if (typeof value.operation_id !== 'string' || !UUID.test(value.operation_id)) fail('pending_capture.operation_id');
  return { operation_id: value.operation_id, observation_period: period(value.observation_period),
    ...(version === 2 ? { private_sales_import: privateSalesImport(value.private_sales_import) } : {}) };
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Pure structural admission for the EXISTING versioned workfile section store.
 * It does not read/choose a context, expand group membership, authorize anything,
 * prove a committed capture, create a UUID, save a section or modify the report.
 * The workflow owner must reopen the exact context and validate every group
 * against its freshly authorized retained catalog before using this intent.
 */
export function prepareCustomNeighborhoodWorkspaceCheckpoint(value) {
  closed(value, ['workspace_version', 'active', 'pending_capture'], 'checkpoint');
  if (value.workspace_version !== 1 && value.workspace_version !== 2) fail('workspace_version');
  const result = { workspace_version: value.workspace_version, active: active(value.active), pending_capture: pending(value.pending_capture, value.workspace_version) };
  // Actual capture registers context_id = operationId and rejects changed study
  // on UUID replay. A pending retry may overlap active only for that same study.
  const current = result.active, next = result.pending_capture;
  if (current && next && current.context_ref.context_id === next.operation_id
    && (current.observation_period.start_date !== next.observation_period.start_date
      || current.observation_period.end_date !== next.observation_period.end_date)) fail('operation_study_conflict');
  if (Buffer.byteLength(canonicalAssessmentJson(result), 'utf8') > LIMITS.canonical_utf8_bytes) fail('checkpoint_bytes');
  normalizeCustomAppraisalSectionValue(result); // Rehearse the actual store's bound, without changing it.
  return freeze(result);
}

/** Only an undefined section is absent. A present null/broken section is not a
 * new file and must never reset to broad defaults or revision zero. Metadata
 * fields are the existing workfile API envelope, not fields in the checkpoint.
 * "restored" means valid saved intent, NOT a verified retained context/preview.
 */
export function readCustomNeighborhoodWorkspaceCheckpoint(section) {
  if (section === undefined) return freeze({ status: 'absent', section_revision: 0, checkpoint: null });
  try {
    closed(section, ['value', 'revision'], 'section', ['key', 'updated_by', 'updated_at']);
    if ((Object.hasOwn(section, 'key') && section.key !== CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION)
      || !Number.isInteger(section.revision) || section.revision < 1 || section.revision > 2_147_483_647) fail('section');
    for (const key of ['updated_by', 'updated_at']) {
      if (Object.hasOwn(section, key) && typeof section[key] !== 'string') fail('section');
    }
    return freeze({ status: 'restored', section_revision: section.revision,
      checkpoint: prepareCustomNeighborhoodWorkspaceCheckpoint(section.value) });
  } catch (error) {
    return freeze({ status: 'invalid', section_revision: null, checkpoint: null,
      reason: error?.code === 'CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_INVALID' ? error.reason : 'section' });
  }
}
