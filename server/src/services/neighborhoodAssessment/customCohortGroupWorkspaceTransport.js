import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint } from './customWorkspaceCheckpoint.js';
import { prepareCustomCohortRecordedGroupTransportRequest,
  presentCustomCohortRecordedGroupTransportResponse } from './customCohortRecordedGroupTransport.js';

const ACTIONS = new Set(['save-groups', 'start-group-capture', 'cancel-group-capture', 'complete-group-capture']);
function fail(output = false) {
  throw Object.assign(new TypeError(output ? 'custom_cohort_group_workspace_transport_invalid_response' : 'invalid_input'),
    { reason: output ? 'selection_response_invalid' : 'invalid_input' });
}
function closed(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  const result = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail();
    result[key] = d.value;
  }
  return result;
}
function checkpoint(value) {
  const result = prepareCustomNeighborhoodWorkspaceCheckpoint(value);
  if (result.workspace_version !== 7) fail();
  return result;
}
function revision(value, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value >= 2147483647) fail();
  return value;
}
function target(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail();
  return value;
}

/** Syntax and byte admission only. No browser reviewer, source rows, account
 * arrays, accepted statistics, or generic section writer may enter this path.
 * The opt-in router still invokes the current-role/rights/transaction owner. */
export function prepareCustomCohortGroupWorkspaceTransportRequest(body, action) {
  try {
    if (!ACTIONS.has(action)) fail();
    const writing = action === 'save-groups' || action === 'complete-group-capture';
    const starting = action === 'start-group-capture', completing = action === 'complete-group-capture';
    const v = closed(body, ['assignment_file_id', 'expected_workspace_revision',
      ...(writing ? ['context_ref', 'operation_id', 'expected_selection_ref', 'included_recorded_group_ids'] : []),
      ...(action !== 'save-groups' ? ['expected_workspace_checkpoint'] : []), ...(starting ? ['pending_capture'] : [])]);
    const expected_workspace_revision = revision(v.expected_workspace_revision, starting);
    const assignment_file_id = target(v.assignment_file_id);
    if (writing) {
      const command = prepareCustomCohortRecordedGroupTransportRequest({ assignment_file_id, context_ref: v.context_ref,
        operation_id: v.operation_id, expected_selection_ref: v.expected_selection_ref,
        included_recorded_group_ids: v.included_recorded_group_ids }, true);
      if (!completing) return Object.freeze({ ...command, expected_workspace_revision });
      const prior = checkpoint(v.expected_workspace_checkpoint);
      if (command.expected_selection_ref !== null || prior.pending_capture === null
        || prior.pending_capture.operation_id !== command.context_ref.context_id) fail();
      return Object.freeze({ ...command, expected_workspace_revision, expected_workspace_checkpoint: prior });
    }
    const prior = checkpoint(v.expected_workspace_checkpoint);
    if ((starting ? prior.pending_capture !== null : prior.pending_capture === null)
      || (expected_workspace_revision === 0 && (prior.active !== null || prior.pending_capture !== null))) fail();
    const next = checkpoint({ ...prior, pending_capture: starting ? v.pending_capture : null });
    if (starting && (next.pending_capture === null || next.pending_capture.operation_id === prior.active?.context_ref.context_id)) fail();
    return Object.freeze({ assignment_file_id, expected_workspace_revision, expected_workspace_checkpoint: prior,
      ...(starting ? { pending_capture: next.pending_capture } : {}) });
  } catch { fail(); }
}

/** Only the immediate exact CAS successor is returned. Selection receipts and
 * checkpoints must agree; pending intent cannot become report authority.
 * Source facts, history, private originals, and SQL diagnostics stay private. */
export function presentCustomCohortGroupWorkspaceTransportResponse(result, request, action) {
  try {
    if (!ACTIONS.has(action)) fail();
    const writing = action === 'save-groups' || action === 'complete-group-capture';
    const v = closed(result, ['status', 'workspace', ...(writing
      ? ['authority', 'context_ref', 'selection_ref', 'included_recorded_group_ids', 'operation_id'] : [])]);
    if (!['stored', 'reused'].includes(v.status)) fail();
    const w = closed(v.workspace, ['revision', 'value']);
    if (w.revision !== request.expected_workspace_revision + 1) fail();
    const value = checkpoint(w.value), workspace = Object.freeze({ revision: w.revision, value });
    if (!writing) {
      const next = checkpoint({ ...request.expected_workspace_checkpoint,
        pending_capture: action === 'start-group-capture' ? request.pending_capture : null });
      if (json(value) !== json(next)) fail();
      return Object.freeze({ status: v.status, authority: 'not_established', workspace });
    }
    const selected = presentCustomCohortRecordedGroupTransportResponse({ status: v.status, authority: v.authority,
      context_ref: v.context_ref, selection_ref: v.selection_ref, included_recorded_group_ids: v.included_recorded_group_ids,
      operation_id: v.operation_id }, request, true);
    if (value.active === null || value.pending_capture !== null
      || json(value.active.context_ref) !== json(selected.context_ref)
      || json(value.active.selection_ref) !== json(selected.selection_ref)) fail();
    if (action === 'complete-group-capture') {
      const pending = request.expected_workspace_checkpoint.pending_capture;
      if (json(value.active.observation_period) !== json(pending.observation_period)
        || json(value.active.discovery ?? null) !== json(pending.discovery ?? null)) fail();
    }
    return Object.freeze({ ...selected, workspace });
  } catch { fail(true); }
}
