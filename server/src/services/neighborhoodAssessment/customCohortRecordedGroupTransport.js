import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { prepareCustomCohortGroupSelectionReference } from './customCohortGroupSelectionRepository.js';
import { prepareCustomNeighborhoodRecordedGroupIds } from './customWorkspaceCheckpoint.js';
import { isCustomCohortPresentedSummary } from './customCohortPreviewPresentation.js';
import { isCustomCohortPresentedPrivateSales } from './customCohortPrivateSales.js';

export const CUSTOM_COHORT_GROUP_TRANSPORT_BYTES = 262_144;
// Existing 2,000,000-byte shared summary + 2MiB private summary + closed envelope.
// Intent request/receipt limits and each presenter's limits stay unchanged.
export const CUSTOM_COHORT_GROUP_SUMMARY_RESPONSE_BYTES = 4_100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function fail(output = false) {
  throw Object.assign(new TypeError(output ? 'custom_cohort_group_transport_invalid_response' : 'invalid_input'),
    { reason: output ? 'selection_response_invalid' : 'invalid_input' });
}
function closed(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function context(value) {
  return prepareCustomCohortContextReference(json(closed(value, ['context_id', 'context_revision', 'context_sha256'])));
}
function groups(value) {
  return Object.freeze([...prepareCustomNeighborhoodRecordedGroupIds(value, 3)].sort());
}

/** Closed HTTP syntax only, not assignment/source authorization. The service
 * derives complete original membership and CURRENT reviewer identity itself.
 * Empty is deliberate; neither omitted groups nor arbitrary account arrays
 * acquire a default selection. Detach everything before the execution gate.
 */
export function prepareCustomCohortRecordedGroupTransportRequest(body, writing) {
  try {
    const value = closed(body, ['assignment_file_id', 'context_ref', ...(writing
      ? ['operation_id', 'expected_selection_ref', 'included_recorded_group_ids'] : [])]);
    if (typeof value.assignment_file_id !== 'string' || !/^[1-9]\d{0,18}$/.test(value.assignment_file_id)
      || BigInt(value.assignment_file_id) > 9223372036854775807n) fail();
    const context_ref = context(value.context_ref);
    if (!writing) return Object.freeze({ assignment_file_id: value.assignment_file_id, context_ref });
    if (typeof value.operation_id !== 'string' || !UUID.test(value.operation_id)) fail();
    const expected_selection_ref = value.expected_selection_ref === null ? null
      : prepareCustomCohortGroupSelectionReference(value.expected_selection_ref);
    if (expected_selection_ref?.selection_revision === 2147483647) fail();
    return Object.freeze({ assignment_file_id: value.assignment_file_id, context_ref,
      operation_id: value.operation_id, expected_selection_ref,
      included_recorded_group_ids: groups(value.included_recorded_group_ids) });
  } catch { fail(); }
}

/** Compact intent receipt only. Never expose original catalog/roster/pages or
 * internal diagnostics if a future owner accidentally changes its result.
 * Selection saving is not Apply and does not certify a boundary or statistics.
 */
export function presentCustomCohortRecordedGroupTransportResponse(result, request, writing) {
  try {
    const value = closed(result, ['status', 'authority', 'context_ref', 'selection_ref',
      'included_recorded_group_ids', ...(writing ? ['operation_id'] : [])]);
    const context_ref = context(value.context_ref);
    if (value.authority !== 'not_established' || json(context_ref) !== json(request.context_ref)) fail();
    if (!writing && value.status === 'absent') {
      if (value.selection_ref !== null || value.included_recorded_group_ids !== null) fail();
      return Object.freeze({ status: 'absent', authority: 'not_established', context_ref,
        selection_ref: null, included_recorded_group_ids: null });
    }
    const selection_ref = prepareCustomCohortGroupSelectionReference(value.selection_ref);
    const included_recorded_group_ids = groups(value.included_recorded_group_ids);
    if (json(included_recorded_group_ids) !== json(value.included_recorded_group_ids)) fail();
    if (writing) {
      if (!['stored', 'reused'].includes(value.status) || value.operation_id !== request.operation_id
        || selection_ref.selection_revision !== (request.expected_selection_ref?.selection_revision ?? 0) + 1
        || json(included_recorded_group_ids) !== json(request.included_recorded_group_ids)) fail();
    } else if (value.status !== 'selected') fail();
    return Object.freeze({ status: value.status, authority: 'not_established', context_ref, selection_ref,
      included_recorded_group_ids, ...(writing ? { operation_id: value.operation_id } : {}) });
  } catch { fail(true); }
}

/** A current exact reference, not a replacement selection or default all. */
export function prepareCustomCohortGroupSummaryTransportRequest(body) {
  try {
    const value = closed(body, ['assignment_file_id', 'context_ref', 'selection_ref']);
    const read = prepareCustomCohortRecordedGroupTransportRequest({
      assignment_file_id: value.assignment_file_id, context_ref: value.context_ref }, false);
    const ref = closed(value.selection_ref, ['selection_version', 'selection_revision', 'selection_sha256', 'manifest_ref']);
    ref.manifest_ref = closed(ref.manifest_ref, ['content_sha256', 'canonical_utf8_bytes']);
    return Object.freeze({ ...read, selection_ref: prepareCustomCohortGroupSelectionReference(ref) });
  } catch { fail(); }
}

/** Only genuine public projections leave this path. The owner's initial/final
 * current-role, original-page and exposure fences are still mandatory. These
 * local witnesses certify projection shape, not rights, freshness or Apply. */
export function presentCustomCohortGroupSummaryTransportResponse(result, request, accountId) {
  try {
    if (!result || types.isProxy(result)) fail();
    const hasPrivate = Object.hasOwn(result, 'private_sales');
    const value = closed(result, ['status', 'authority', 'target', 'context_ref', 'selection_ref',
      'selection_revision', 'subject_freshness', 'summary', 'parcel_map', 'apply', ...(hasPrivate ? ['private_sales'] : [])]);
    const target = closed(value.target, ['account_id', 'assignment_file_id']);
    const ref = prepareCustomCohortGroupSelectionReference(value.selection_ref), c = context(value.context_ref);
    const map = closed(value.parcel_map, ['status', 'reason']), apply = closed(value.apply, ['status', 'reasons']);
    if (value.status !== 'preview' || value.authority !== 'not_established' || value.subject_freshness !== 'matched'
      || target.account_id !== accountId || target.assignment_file_id !== request.assignment_file_id
      || json(c) !== json(request.context_ref) || json(ref) !== json(request.selection_ref)
      || value.selection_revision !== ref.selection_revision || map.status !== 'omitted'
      || map.reason !== 'geometry_not_requested' || apply.status !== 'blocked'
      || !Array.isArray(apply.reasons) || types.isProxy(apply.reasons)
      || json(apply.reasons) !== '["observation_preview_only"]' || !isCustomCohortPresentedSummary(value.summary)) fail();
    const binding = value.summary.binding;
    if (json(binding.context_ref) !== json(c) || binding.selection_revision !== ref.selection_revision
      || binding.selection_sha256 !== ref.selection_sha256) fail();
    if (hasPrivate) {
      if (!isCustomCohortPresentedPrivateSales(value.private_sales)) fail();
      const p = value.private_sales, b = p.binding;
      if (json(b.context_ref) !== json(c) || b.selection_revision !== ref.selection_revision
        || b.selection_sha256 !== ref.selection_sha256 || b.target.account_id !== accountId
        || b.target.assignment_file_id !== request.assignment_file_id || p.effective_date !== value.summary.effective_date
        || json(p.observation_period) !== json(value.summary.observation_period)) fail();
    }
    return Object.freeze({ status: 'preview', authority: 'not_established',
      target: Object.freeze({ account_id: accountId, assignment_file_id: request.assignment_file_id }),
      context_ref: c, selection_ref: ref, selection_revision: ref.selection_revision,
      subject_freshness: 'matched', summary: value.summary,
      parcel_map: Object.freeze({ status: 'omitted', reason: 'geometry_not_requested' }),
      apply: Object.freeze({ status: 'blocked', reasons: Object.freeze(['observation_preview_only']) }),
      ...(hasPrivate ? { private_sales: value.private_sales } : {}) });
  } catch { fail(true); }
}
