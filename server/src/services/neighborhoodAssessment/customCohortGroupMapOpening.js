import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextScope, prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { prepareCustomCohortGroupSelectionReference } from './customCohortGroupSelectionRepository.js';
import { prepareCustomCohortGroupSummaryTransportRequest } from './customCohortRecordedGroupTransport.js';
import { checkCustomCohortPreparedMapOpening, CUSTOM_COHORT_MAP_OPENING_BYTES } from './customCohortPreparedMapOpeningRepository.js';

export const CUSTOM_COHORT_GROUP_MAP_OPENING_RESPONSE_BYTES = 4_100_000;
const SEMANTICS = 'current_observed_cached_parcels_not_legal_subdivision_boundary';
const witnessed = new WeakSet();
function fail() {
  throw Object.assign(new TypeError('custom_cohort_group_map_opening_invalid_projection'),
    { reason: 'selection_response_invalid' });
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
function array(value, limit) {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail();
    return d.value;
  });
}
function point(value) {
  const p = array(value, 2);
  if (p.length !== 2 || !p.every(Number.isFinite)) fail();
  return p;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function manifestOf(value) {
  if (!value || types.isProxy(value)) fail();
  const unavailable = Object.getOwnPropertyDescriptor(value, 'status')?.value === 'unavailable';
  const m = closed(value, ['status', 'context_ref', 'geometry_semantics', ...(unavailable ? ['reason']
    : ['bounds', 'labels', 'unlabelled_group_ids', 'subject_parcels', 'counts'])]);
  m.context_ref = prepareCustomCohortContextReference(json(closed(m.context_ref,
    ['context_id', 'context_revision', 'context_sha256'])));
  if (m.geometry_semantics !== SEMANTICS) fail();
  if (unavailable) {
    if (typeof m.reason !== 'string' || !m.reason || m.reason.length > 200 || /[\u0000-\u001f\u007f]/.test(m.reason)) fail();
  } else {
    if (m.status !== 'available') fail();
    m.bounds = array(m.bounds, 2).map(point);
    m.counts = closed(m.counts, ['captured_parcels', 'captured_accounts']);
    m.labels = closed(m.labels, ['type', 'features']);
    m.labels.features = array(m.labels.features, 2048).map(value => {
      const label = closed(value, ['type', 'id', 'geometry', 'properties']);
      label.geometry = closed(label.geometry, ['type', 'coordinates']);
      label.geometry.coordinates = point(label.geometry.coordinates);
      label.properties = closed(label.properties, ['pocket_id', 'label', 'county', 'account_id', 'parcel_id', 'anchor_basis']);
      return label;
    });
    m.unlabelled_group_ids = array(m.unlabelled_group_ids, 2048);
    m.subject_parcels = array(m.subject_parcels, 100_000).map(value => {
      const marker = closed(value, ['parcel_id', 'account_id', 'coordinates', 'anchor_basis']);
      marker.coordinates = point(marker.coordinates); return marker;
    });
  }
  if (Buffer.byteLength(JSON.stringify(m)) > CUSTOM_COHORT_MAP_OPENING_BYTES) fail();
  return m;
}

/** Display-only projection. The transaction owner must first verify every
 * original selection page and separately recheck current assignment/source
 * rights before delivery. Bounds and anchors never determine membership. */
export function presentCustomCohortGroupMapOpening({ scopeJson, contextRef, selectionRef, catalog, manifest }) {
  const scope = prepareCustomCohortContextScope(scopeJson), context = prepareCustomCohortContextReference(json(contextRef));
  const ref = prepareCustomCohortGroupSelectionReference(selectionRef), checked = manifestOf(manifest);
  checkCustomCohortPreparedMapOpening(checked, { catalog }, context, scope.account_id);
  const result = freeze({ display_only: true,
    target: { account_id: scope.account_id, assignment_file_id: scope.assignment_file_id },
    context_ref: context, selection_revision: ref.selection_revision, selection_sha256: ref.selection_sha256,
    manifest: checked });
  witnessed.add(result); return result;
}

// Same closed exact-current-reference request as the numeric view: no area,
// member array, new selection, default-all or operation allocation is accepted.
export const prepareCustomCohortGroupMapOpeningTransportRequest = prepareCustomCohortGroupSummaryTransportRequest;
export function presentCustomCohortGroupMapOpeningTransportResponse(result, request, accountId) {
  try {
    const v = closed(result, ['status', 'authority', 'selection_ref', 'map_opening']);
    const ref = prepareCustomCohortGroupSelectionReference(v.selection_ref), map = v.map_opening;
    if (v.status !== 'opening' || v.authority !== 'not_established' || json(ref) !== json(request.selection_ref)
      || !witnessed.has(map) || map.display_only !== true || map.target.account_id !== accountId
      || map.target.assignment_file_id !== request.assignment_file_id || json(map.context_ref) !== json(request.context_ref)
      || map.selection_revision !== ref.selection_revision || map.selection_sha256 !== ref.selection_sha256) fail();
    const output = Object.freeze({ status: 'opening', authority: 'not_established', selection_ref: ref, map_opening: map });
    if (Buffer.byteLength(JSON.stringify(output)) > CUSTOM_COHORT_GROUP_MAP_OPENING_RESPONSE_BYTES) fail();
    return output;
  } catch { fail(); }
}
