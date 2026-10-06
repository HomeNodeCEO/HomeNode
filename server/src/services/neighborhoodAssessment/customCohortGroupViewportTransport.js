import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortGroupSummaryTransportRequest } from './customCohortRecordedGroupTransport.js';
import { prepareCustomCohortGroupSelectionReference } from './customCohortGroupSelectionRepository.js';
import { prepareCustomCohortViewport, isCustomCohortPresentedSelectionViewport } from './customCohortViewportMap.js';

export const CUSTOM_COHORT_SELECTION_VIEWPORT_BYTES = 4_000_000;
function fail(output = false) {
  throw Object.assign(new TypeError(output ? 'custom_cohort_group_viewport_invalid_response' : 'invalid_input'),
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

/** Closed display-only request, with the same exact current selection as the
 * numeric summary. A pan never supplies, replaces or filters analytical members. */
export function prepareCustomCohortGroupViewportTransportRequest(body) {
  try {
    const v = closed(body, ['assignment_file_id', 'context_ref', 'selection_ref', 'viewport']);
    const base = prepareCustomCohortGroupSummaryTransportRequest({ assignment_file_id: v.assignment_file_id,
      context_ref: v.context_ref, selection_ref: v.selection_ref });
    return Object.freeze({ ...base, viewport: prepareCustomCohortViewport(closed(v.viewport,
      ['west', 'south', 'east', 'north'])) });
  } catch { fail(); }
}

/** Admit the genuine frozen public projection only. Its witness is NOT rights;
 * the owner rechecks current assignment/actor/source and originals before return. */
export function presentCustomCohortGroupViewportTransportResponse(result, request, accountId) {
  try {
    const v = closed(result, ['status', 'authority', 'selection_ref', 'viewport_map']);
    const ref = prepareCustomCohortGroupSelectionReference(v.selection_ref), map = v.viewport_map;
    if (v.status !== 'viewport' || v.authority !== 'not_established'
      || json(ref) !== json(request.selection_ref) || !isCustomCohortPresentedSelectionViewport(map)
      || map.display_only !== true || map.target.account_id !== accountId
      || map.target.assignment_file_id !== request.assignment_file_id
      || json(map.context_ref) !== json(request.context_ref)
      || map.selection_revision !== ref.selection_revision || map.selection_sha256 !== ref.selection_sha256
      || json(map.viewport) !== json(request.viewport)
      || map.geometry_semantics !== 'current_observed_cached_parcels_not_legal_subdivision_boundary') fail();
    const output = Object.freeze({ status: 'viewport', authority: 'not_established', selection_ref: ref, viewport_map: map });
    if (Buffer.byteLength(JSON.stringify(output)) > CUSTOM_COHORT_SELECTION_VIEWPORT_BYTES)
      throw Object.assign(new TypeError('viewport_capacity_exceeded'), { reason: 'viewport_capacity_exceeded' });
    return output;
  } catch (error) {
    if (error?.reason === 'viewport_capacity_exceeded') throw error;
    fail(true);
  }
}
