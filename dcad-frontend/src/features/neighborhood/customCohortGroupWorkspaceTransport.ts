import { createCustomCohortJsonTransport } from './customCohortPreviewTransport.ts';
import { prepareCustomWorkspaceCheckpoint } from './customWorkspaceCheckpoint.ts';
import type { CustomWorkspaceObservationPeriod, CustomWorkspacePendingCapture } from './customWorkspaceCheckpoint';
import type { CustomWorkspaceDiscovery } from './customWorkspaceDiscovery';
import type { CustomCohortContextRef } from './customCohortPreviewController';
import { prepareCustomCohortRecordedGroupWrite, prepareCustomCohortGroupSelectionReference,
  checkCustomCohortRecordedGroupWriteReceipt } from './customCohortRecordedGroupTransport.ts';
import type { CustomCohortRecordedGroupWrite, CustomCohortGroupSelectionRef } from './customCohortRecordedGroupTransport';

export interface CustomCohortGroupWorkspaceCheckpoint {
  readonly workspace_version: 7;
  readonly active: { readonly context_ref: CustomCohortContextRef; readonly observation_period: CustomWorkspaceObservationPeriod;
    readonly selection_ref: CustomCohortGroupSelectionRef; readonly discovery?: CustomWorkspaceDiscovery } | null;
  readonly pending_capture: CustomWorkspacePendingCapture | null;
}
export interface CustomCohortGroupWorkspaceSection {
  readonly revision: number; readonly value: CustomCohortGroupWorkspaceCheckpoint;
}
export interface CustomCohortGroupWorkspaceSave extends CustomCohortRecordedGroupWrite {
  readonly expectedWorkspaceRevision: number;
}
export interface CustomCohortGroupWorkspaceComplete extends CustomCohortGroupWorkspaceSave {
  readonly expectedWorkspaceCheckpoint: CustomCohortGroupWorkspaceCheckpoint;
}
export interface CustomCohortGroupWorkspaceCancel {
  readonly accountId: string; readonly assignmentFileId: string; readonly expectedWorkspaceRevision: number;
  readonly expectedWorkspaceCheckpoint: CustomCohortGroupWorkspaceCheckpoint;
}
export interface CustomCohortGroupWorkspaceStart extends CustomCohortGroupWorkspaceCancel {
  readonly pendingCapture: CustomWorkspacePendingCapture;
}
type RecordValue = Record<string, unknown>;
function fail(): never { throw new TypeError('invalid_custom_cohort_group_workspace_transport'); }
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): RecordValue {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Reflect.ownKeys(value), result: RecordValue = {};
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))) fail();
  for (const key of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail();
    result[key] = d.value;
  }
  return result;
}
function revision(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < (zero ? 0 : 1) || value >= 2147483647) fail();
  return value;
}
function same(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }

/** V7 stores an exact server-owned reference, not flattened member/parcel arrays.
 * Reuse the unchanged legacy component grammar for dates/discovery/private intent
 * without changing old readers/defaults or silently upgrading a present file. */
export function prepareCustomCohortGroupWorkspaceCheckpoint(value: unknown): CustomCohortGroupWorkspaceCheckpoint {
  const v = closed(value, ['workspace_version', 'active', 'pending_capture']);
  if (v.workspace_version !== 7) fail();
  const pending = prepareCustomWorkspaceCheckpoint({ workspace_version: 6, active: null, pending_capture: v.pending_capture }).pending_capture;
  let active: CustomCohortGroupWorkspaceCheckpoint['active'] = null;
  if (v.active !== null) {
    const a = closed(v.active, ['context_ref', 'observation_period', 'selection_ref'], ['discovery']);
    const components = prepareCustomWorkspaceCheckpoint({ workspace_version: 6, pending_capture: null,
      active: { context_ref: a.context_ref, observation_period: a.observation_period,
        selection: { revision: 1, included_recorded_group_ids: [] }, ...(Object.hasOwn(a, 'discovery') ? { discovery: a.discovery } : {}) } }).active!;
    active = Object.freeze({ context_ref: components.context_ref, observation_period: components.observation_period,
      selection_ref: prepareCustomCohortGroupSelectionReference(a.selection_ref),
      ...(components.discovery ? { discovery: components.discovery } : {}) });
  }
  if (active && pending && active.context_ref.context_id === pending.operation_id
    && (!same(active.observation_period, pending.observation_period) || !same(active.discovery ?? null, pending.discovery ?? null))) fail();
  const result = Object.freeze({ workspace_version: 7 as const, active, pending_capture: pending });
  if (new TextEncoder().encode(JSON.stringify(result)).length > 32768) fail();
  return result;
}

/** Only undefined is absent. A corrupt/present/legacy value is not revision zero.
 * This reader does not verify context/source rights, select groups or write. */
export function readCustomCohortGroupWorkspaceSection(section: unknown) {
  if (section === undefined) return Object.freeze({ status: 'absent' as const, section_revision: 0 as const, checkpoint: null });
  try {
    const s = closed(section, ['revision', 'value'], ['key', 'updated_by', 'updated_at']);
    if (typeof s.revision !== 'number' || !Number.isInteger(s.revision) || s.revision < 1 || s.revision > 2147483647
      || (Object.hasOwn(s, 'key') && s.key !== 'neighborhood_workspace')) fail();
    for (const key of ['updated_by', 'updated_at']) if (Object.hasOwn(s, key) && typeof s[key] !== 'string') fail();
    return Object.freeze({ status: 'restored' as const, section_revision: s.revision,
      checkpoint: prepareCustomCohortGroupWorkspaceCheckpoint(s.value) });
  } catch { return Object.freeze({ status: 'invalid' as const, section_revision: null, checkpoint: null }); }
}

function writingInput(value: unknown, completing: boolean): CustomCohortGroupWorkspaceSave | CustomCohortGroupWorkspaceComplete {
  const v = closed(value, ['accountId', 'assignmentFileId', 'contextRef', 'operationId', 'expectedSelectionRef',
    'includedRecordedGroupIds', 'expectedWorkspaceRevision', ...(completing ? ['expectedWorkspaceCheckpoint'] : [])]);
  const r = prepareCustomCohortRecordedGroupWrite({ accountId: v.accountId, assignmentFileId: v.assignmentFileId,
    contextRef: v.contextRef, operationId: v.operationId, expectedSelectionRef: v.expectedSelectionRef, includedRecordedGroupIds: v.includedRecordedGroupIds });
  const expectedWorkspaceRevision = revision(v.expectedWorkspaceRevision);
  if (!completing) return Object.freeze({ ...r, expectedWorkspaceRevision });
  const prior = prepareCustomCohortGroupWorkspaceCheckpoint(v.expectedWorkspaceCheckpoint);
  if (r.expectedSelectionRef !== null || prior.pending_capture === null || prior.pending_capture.operation_id !== r.contextRef.context_id) fail();
  return Object.freeze({ ...r, expectedWorkspaceRevision, expectedWorkspaceCheckpoint: prior });
}
function transitionInput(value: unknown, starting: boolean): CustomCohortGroupWorkspaceCancel | CustomCohortGroupWorkspaceStart {
  const v = closed(value, ['accountId', 'assignmentFileId', 'expectedWorkspaceRevision', 'expectedWorkspaceCheckpoint', ...(starting ? ['pendingCapture'] : [])]);
  if (typeof v.accountId !== 'string' || !v.accountId || v.accountId.length > 64 || v.accountId.trim() !== v.accountId
    || typeof v.assignmentFileId !== 'string' || !/^[1-9]\d{0,18}$/.test(v.assignmentFileId)
    || BigInt(v.assignmentFileId) > 9223372036854775807n) fail();
  for (let i = 0; i < v.accountId.length; i++) { const code = v.accountId.charCodeAt(i); if (code < 32 || code === 127) fail(); }
  const expectedWorkspaceRevision = revision(v.expectedWorkspaceRevision, starting);
  const prior = prepareCustomCohortGroupWorkspaceCheckpoint(v.expectedWorkspaceCheckpoint);
  if ((starting ? prior.pending_capture !== null : prior.pending_capture === null)
    || (expectedWorkspaceRevision === 0 && (prior.active !== null || prior.pending_capture !== null))) fail();
  const next = prepareCustomCohortGroupWorkspaceCheckpoint({ ...prior, pending_capture: starting ? v.pendingCapture : null });
  if (starting && (next.pending_capture === null || next.pending_capture.operation_id === prior.active?.context_ref.context_id)) fail();
  return Object.freeze({ accountId: v.accountId, assignmentFileId: v.assignmentFileId, expectedWorkspaceRevision,
    expectedWorkspaceCheckpoint: prior, ...(starting ? { pendingCapture: next.pending_capture! } : {}) });
}
function workspace(value: unknown, expected: number): CustomCohortGroupWorkspaceSection {
  const v = closed(value, ['revision', 'value']);
  if (v.revision !== expected + 1) fail();
  return Object.freeze({ revision: v.revision as number, value: prepareCustomCohortGroupWorkspaceCheckpoint(v.value) });
}
function written(value: unknown, request: CustomCohortGroupWorkspaceSave | CustomCohortGroupWorkspaceComplete, completing: boolean) {
  const v = closed(value, ['status', 'authority', 'context_ref', 'selection_ref', 'included_recorded_group_ids', 'operation_id', 'workspace']);
  const selected = checkCustomCohortRecordedGroupWriteReceipt({ status: v.status, authority: v.authority, context_ref: v.context_ref,
    selection_ref: v.selection_ref, included_recorded_group_ids: v.included_recorded_group_ids, operation_id: v.operation_id }, request);
  const saved = workspace(v.workspace, request.expectedWorkspaceRevision), active = saved.value.active;
  if (!active || saved.value.pending_capture !== null || !same(active.context_ref, selected.context_ref) || !same(active.selection_ref, selected.selection_ref)) fail();
  if (completing) {
    const pending = (request as CustomCohortGroupWorkspaceComplete).expectedWorkspaceCheckpoint.pending_capture!;
    if (!same(active.observation_period, pending.observation_period) || !same(active.discovery ?? null, pending.discovery ?? null)) fail();
  }
  return Object.freeze({ ...selected, workspace: saved });
}
function transitioned(value: unknown, request: CustomCohortGroupWorkspaceCancel | CustomCohortGroupWorkspaceStart, starting: boolean) {
  const v = closed(value, ['status', 'authority', 'workspace']);
  if (!['stored', 'reused'].includes(String(v.status)) || v.authority !== 'not_established') fail();
  const saved = workspace(v.workspace, request.expectedWorkspaceRevision);
  const next = prepareCustomCohortGroupWorkspaceCheckpoint({ ...request.expectedWorkspaceCheckpoint,
    pending_capture: starting ? (request as CustomCohortGroupWorkspaceStart).pendingCapture : null });
  if (!same(next, saved.value)) fail();
  return Object.freeze({ status: v.status as 'stored' | 'reused', authority: 'not_established' as const, workspace: saved });
}

// The lifecycle uses the same structural acknowledgment checks as finite I/O.
// An injected adapter cannot turn a wrong revision/reference into saved state.
export function checkCustomCohortGroupWorkspaceWriteReceipt(value: unknown,
  request: CustomCohortGroupWorkspaceSave | CustomCohortGroupWorkspaceComplete, completing: boolean) {
  return written(value, writingInput(request, completing), completing);
}
export function checkCustomCohortGroupWorkspaceTransitionReceipt(value: unknown,
  request: CustomCohortGroupWorkspaceCancel | CustomCohortGroupWorkspaceStart, starting: boolean) {
  return transitioned(value, transitionInput(request, starting), starting);
}

/** Finite authenticated I/O only. No timer, automatic retry, UUID allocation,
 * default selection, generic section write or report Apply. The consumer must
 * bind all projections to this exact receipt and enable V7 as one whole path. */
export function createCustomCohortGroupWorkspaceTransport(options: Parameters<typeof createCustomCohortJsonTransport>[0]) {
  const post = createCustomCohortJsonTransport(options);
  return Object.freeze({
    async save(value: CustomCohortGroupWorkspaceSave, io: { signal: AbortSignal }) {
      const r = writingInput(value, false);
      return written(await post(r.accountId, 'save-groups', { assignment_file_id: r.assignmentFileId, context_ref: r.contextRef,
        operation_id: r.operationId, expected_selection_ref: r.expectedSelectionRef, included_recorded_group_ids: r.includedRecordedGroupIds,
        expected_workspace_revision: r.expectedWorkspaceRevision }, io), r, false);
    },
    async complete(value: CustomCohortGroupWorkspaceComplete, io: { signal: AbortSignal }) {
      const r = writingInput(value, true) as CustomCohortGroupWorkspaceComplete;
      return written(await post(r.accountId, 'complete-group-capture', { assignment_file_id: r.assignmentFileId, context_ref: r.contextRef,
        operation_id: r.operationId, expected_selection_ref: r.expectedSelectionRef, included_recorded_group_ids: r.includedRecordedGroupIds,
        expected_workspace_revision: r.expectedWorkspaceRevision, expected_workspace_checkpoint: r.expectedWorkspaceCheckpoint }, io), r, true);
    },
    async start(value: CustomCohortGroupWorkspaceStart, io: { signal: AbortSignal }) {
      const r = transitionInput(value, true) as CustomCohortGroupWorkspaceStart;
      return transitioned(await post(r.accountId, 'start-group-capture', { assignment_file_id: r.assignmentFileId,
        expected_workspace_revision: r.expectedWorkspaceRevision, expected_workspace_checkpoint: r.expectedWorkspaceCheckpoint,
        pending_capture: r.pendingCapture }, io), r, true);
    },
    async cancel(value: CustomCohortGroupWorkspaceCancel, io: { signal: AbortSignal }) {
      const r = transitionInput(value, false);
      return transitioned(await post(r.accountId, 'cancel-group-capture', { assignment_file_id: r.assignmentFileId,
        expected_workspace_revision: r.expectedWorkspaceRevision, expected_workspace_checkpoint: r.expectedWorkspaceCheckpoint }, io), r, false);
    },
  });
}
