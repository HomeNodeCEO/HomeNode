import type { CustomCohortContextRef, CustomCohortPreviewInput } from './customCohortPreviewController';
import { customCohortCatalogGroupIds, selectionFromRecordedGroups } from './customCohortPocketCatalog';
import type { CheckedPocketCatalog } from './customCohortPocketCatalog';

export const CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION = 'neighborhood_workspace';
export const CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS = Object.freeze({
  canonical_utf8_bytes: 32_768, group_ids: 129, recorded_group_ids: 128,
});
export interface CustomWorkspaceObservationPeriod {
  readonly start_date: string; readonly end_date: string;
}
export interface CustomWorkspacePrivateSalesImport {
  readonly batch_id: string; readonly expected_review_revision: number;
}
export interface CustomWorkspacePendingCapture {
  readonly operation_id: string; readonly observation_period: CustomWorkspaceObservationPeriod;
  readonly private_sales_import?: CustomWorkspacePrivateSalesImport;
}
export interface CustomWorkspaceActiveCheckpoint {
  readonly context_ref: CustomCohortContextRef;
  readonly observation_period: CustomWorkspaceObservationPeriod;
  readonly selection: { readonly revision: number; readonly included_recorded_group_ids: readonly string[] };
}
export interface CustomWorkspaceCheckpoint {
  readonly workspace_version: 1 | 2;
  readonly active: CustomWorkspaceActiveCheckpoint | null;
  readonly pending_capture: CustomWorkspacePendingCapture | null;
}
type Absent = { readonly status: 'absent'; readonly section_revision: 0; readonly checkpoint: null };
type Invalid = { readonly status: 'invalid'; readonly section_revision: null; readonly checkpoint: null; readonly reason: string };
export type CustomWorkspaceCheckpointRead = Absent | Invalid | {
  readonly status: 'restored'; readonly section_revision: number; readonly checkpoint: CustomWorkspaceCheckpoint;
};
export type CustomWorkspaceSelectionRestore = Absent | Invalid | {
  readonly status: 'no_active'; readonly section_revision: number; readonly checkpoint: CustomWorkspaceCheckpoint;
} | {
  readonly status: 'restored'; readonly section_revision: number; readonly checkpoint: CustomWorkspaceCheckpoint;
  readonly active: CustomWorkspaceActiveCheckpoint; readonly selection: CustomCohortPreviewInput['selection'];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BATCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const RECORDED_GROUP = /^recorded-cad:[a-f0-9]{64}$/;
const UNASSIGNED = 'discovery:unassigned';
const LIMITS = CUSTOM_NEIGHBORHOOD_WORKSPACE_CHECKPOINT_LIMITS;

function fail(reason: string): never {
  throw Object.assign(new TypeError('Invalid custom neighborhood workspace checkpoint'), { checkpointReason: reason });
}
function closed(value: unknown, required: readonly string[], name: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(name);
  const allowed = [...required, ...optional], keys = Reflect.ownKeys(value as object);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => typeof key !== 'string' || !allowed.includes(key))) fail(name);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${name}.non_data_property`);
  }
  return value as Record<string, unknown>;
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('observation_period');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('observation_period');
  return value;
}
function period(value: unknown): CustomWorkspaceObservationPeriod {
  const record = closed(value, ['start_date', 'end_date'], 'observation_period');
  const start_date = date(record.start_date), end_date = date(record.end_date);
  if (start_date > end_date) fail('observation_period');
  return { start_date, end_date };
}
function context(value: unknown): CustomCohortContextRef {
  const record = closed(value, ['context_id', 'context_revision', 'context_sha256'], 'context_ref');
  if (typeof record.context_id !== 'string' || !UUID.test(record.context_id) || record.context_revision !== '1'
    || typeof record.context_sha256 !== 'string' || !HASH.test(record.context_sha256)) fail('context_ref');
  return { context_id: record.context_id, context_revision: '1', context_sha256: record.context_sha256 };
}
function groups(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > LIMITS.group_ids) fail('group_ids');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('group_ids');
  const result: string[] = [], seen = new Set<string>(); let recorded = 0;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('group_ids');
    const id: unknown = descriptor.value;
    if (typeof id !== 'string' || (id !== UNASSIGNED && !RECORDED_GROUP.test(id)) || seen.has(id)) fail('group_ids');
    if (id !== UNASSIGNED && ++recorded > LIMITS.recorded_group_ids) fail('group_ids');
    seen.add(id); result.push(id);
  }
  return result; // Preserve intentional order and [], without repairing malformed input.
}
function active(value: unknown): CustomWorkspaceActiveCheckpoint | null {
  if (value === null) return null;
  const record = closed(value, ['context_ref', 'observation_period', 'selection'], 'active');
  const selection = closed(record.selection, ['revision', 'included_recorded_group_ids'], 'selection');
  if (!Number.isSafeInteger(selection.revision) || Number(selection.revision) < 1) fail('selection.revision');
  return { context_ref: context(record.context_ref), observation_period: period(record.observation_period),
    selection: { revision: selection.revision as number, included_recorded_group_ids: groups(selection.included_recorded_group_ids) } };
}
/** Exact saved review selection, not source rights or a request for latest. */
export function prepareCustomWorkspacePrivateSalesImport(value: unknown): CustomWorkspacePrivateSalesImport {
  const record = closed(value, ['batch_id', 'expected_review_revision'], 'private_sales_import');
  if (typeof record.batch_id !== 'string' || !BATCH_UUID.test(record.batch_id)
    || !Number.isInteger(record.expected_review_revision) || Number(record.expected_review_revision) < 1
    || Number(record.expected_review_revision) > 2147483647) fail('private_sales_import');
  return Object.freeze({ batch_id: record.batch_id, expected_review_revision: record.expected_review_revision as number });
}
function pending(value: unknown, version: 1 | 2): CustomWorkspaceCheckpoint['pending_capture'] {
  if (value === null) return null;
  const record = closed(value, ['operation_id', 'observation_period', ...(version === 2 ? ['private_sales_import'] : [])], 'pending_capture');
  if (typeof record.operation_id !== 'string' || !UUID.test(record.operation_id)) fail('pending_capture.operation_id');
  return { operation_id: record.operation_id, observation_period: period(record.observation_period),
    ...(version === 2 ? { private_sales_import: prepareCustomWorkspacePrivateSalesImport(record.private_sales_import) } : {}) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}

/** Structural editor intent only: no stored geometry, metric results, captured
 * source bodies, authorization, or accepted report group can be smuggled in. */
export function prepareCustomWorkspaceCheckpoint(value: unknown): CustomWorkspaceCheckpoint {
  const record = closed(value, ['workspace_version', 'active', 'pending_capture'], 'checkpoint');
  if (record.workspace_version !== 1 && record.workspace_version !== 2) fail('workspace_version');
  const result: CustomWorkspaceCheckpoint = { workspace_version: record.workspace_version, active: active(record.active), pending_capture: pending(record.pending_capture, record.workspace_version) };
  const current = result.active, next = result.pending_capture;
  if (current && next && current.context_ref.context_id === next.operation_id
    && (current.observation_period.start_date !== next.observation_period.start_date
      || current.observation_period.end_date !== next.observation_period.end_date)) fail('operation_study_conflict');
  // Closed ASCII field names/primitives make ordinary JSON and server canonical
  // JSON identical in byte length; key sorting cannot affect this size bound.
  if (new TextEncoder().encode(JSON.stringify(result)).length > LIMITS.canonical_utf8_bytes) fail('checkpoint_bytes');
  return freeze(result);
}

/** Read the existing workfile section envelope, not an arbitrary API response.
 * Its owning request must already be bound to the correct account/file/session.
 * Only undefined is absent; a null or malformed saved value is never a new file. */
export function readCustomWorkspaceCheckpoint(section: unknown): CustomWorkspaceCheckpointRead {
  if (section === undefined) return freeze({ status: 'absent', section_revision: 0, checkpoint: null });
  try {
    const record = closed(section, ['value', 'revision'], 'section', ['key', 'updated_by', 'updated_at']);
    if ((Object.hasOwn(record, 'key') && record.key !== CUSTOM_NEIGHBORHOOD_WORKSPACE_SECTION)
      || !Number.isInteger(record.revision) || Number(record.revision) < 1 || Number(record.revision) > 2_147_483_647) fail('section');
    for (const key of ['updated_by', 'updated_at']) {
      if (Object.hasOwn(record, key) && typeof record[key] !== 'string') fail('section');
    }
    return freeze({ status: 'restored', section_revision: record.revision as number, checkpoint: prepareCustomWorkspaceCheckpoint(record.value) });
  } catch (error) {
    const reason = error instanceof Error && 'checkpointReason' in error && typeof error.checkpointReason === 'string' ? error.checkpointReason : 'section';
    return freeze({ status: 'invalid', section_revision: null, checkpoint: null, reason });
  }
}

/** Reopen the exact retained context and check its authorized catalog before
 * calling this helper. Pending capture intent is preserved, never promoted to a
 * completed context. Unknown group IDs fail the entire restore, not just a row. */
export function restoreCustomWorkspaceSelection(section: unknown, catalog: CheckedPocketCatalog | null): CustomWorkspaceSelectionRestore {
  const result = readCustomWorkspaceCheckpoint(section);
  if (result.status !== 'restored') return result;
  const current = result.checkpoint.active;
  if (current === null) return freeze({ ...result, status: 'no_active' });
  const invalid = (reason: string): Invalid => freeze({ status: 'invalid', section_revision: null, checkpoint: null, reason });
  if (!catalog) return invalid('catalog_unavailable');
  try {
    const expected = current.context_ref, actual = catalog.binding.context_ref;
    if (expected.context_id !== actual.context_id || expected.context_revision !== actual.context_revision
      || expected.context_sha256 !== actual.context_sha256) return invalid('catalog_context_mismatch');
    const available = new Set(customCohortCatalogGroupIds(catalog));
    const included = current.selection.included_recorded_group_ids;
    if (included.some(id => !available.has(id))) return invalid('unknown_recorded_group');
    const selection = selectionFromRecordedGroups(catalog, included, current.selection.revision);
    return freeze({ ...result, active: current, selection });
  } catch { return invalid('invalid_catalog'); }
}
