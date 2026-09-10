import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { buildCustomCohortParcelMap, CUSTOM_COHORT_PARCEL_MAP_LIMITS } from './customCohortParcelMap.js';
import { representCustomCohortSubjectPoint } from './customCohortSubjectPoint.js';

export const CUSTOM_COHORT_RECORDED_PROXIMITY_BASIS = 'recorded_subject_centroid_to_retained_parcel_point_on_surface';
export const CUSTOM_COHORT_RECORDED_PROXIMITY_LIMITS = Object.freeze({ batch_parcels: 64,
  batch_utf8_bytes: 2_100_000, output_utf8_bytes: 32_000_000,
  parcels: CUSTOM_COHORT_PARCEL_MAP_LIMITS.parcels, maximum_distance_metres: 20_100_000 });
export const CUSTOM_COHORT_RECORDED_PROXIMITY_REASONS = Object.freeze(['subject_point_unavailable',
  'retained_map_unavailable', 'retained_binding_mismatch', 'capacity_exceeded', 'native_query_failed', 'native_result_invalid']);
const L = CUSTOM_COHORT_RECORDED_PROXIMITY_LIMITS, issued = new WeakMap();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) {
  Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function fail(reason) { throw Object.assign(new TypeError(`custom_cohort_recorded_proximity_${reason}`), {
  code: 'CUSTOM_COHORT_RECORDED_PROXIMITY_INVALID', reason }); }
function check(ok, reason) { if (!ok) fail(reason); }
function data(value) {
  check(value && typeof value === 'object' && !types.isProxy(value)
    && [Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)), 'invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).every(key => typeof key === 'string'), 'invalid_input');
  for (const [key, descriptor] of Object.entries(descriptors)) check(Object.hasOwn(descriptor, 'value')
    && (descriptor.enumerable || (Array.isArray(value) && key === 'length')), 'invalid_input');
  return value;
}
function tree(value) {
  const pending = [value], seen = new Set(); let nodes = 0;
  while (pending.length) {
    const current = pending.pop(); if (!current || typeof current !== 'object') continue;
    check(!seen.has(current) && ++nodes <= 1_000_000, 'invalid_input'); seen.add(current); data(current);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if (descriptor.value && typeof descriptor.value === 'object') pending.push(descriptor.value);
    }
  }
}
function context(value) { data(value); return prepareCustomCohortContextReference(json(value)); }
const same = (a, b) => json(a) === json(b);
const radiusOf = input => {
  const radius = input.spatial.radius_metres;
  const choice = input.study.discovery;
  if (choice === undefined) check(input.study.profile_id === 'custom-simple-suburban-radius-v1' && radius === '4828.032'
    && input.spatial.discovery === undefined, 'retained_binding_mismatch');
  else { data(choice); check(choice.profile_id === 'custom-suburban-radius-v2' && input.study.profile_id === choice.profile_id
    && ['4828.032', '8046.72', '16093.44'].includes(radius) && choice.radius_metres === radius
    && same(choice, input.spatial.discovery), 'retained_binding_mismatch'); }
  return radius;
};

// All geometry comes from bound retained EWKB parameters. No current GIS/source
// table, mutable location, radius lookup, transaction control or provider call.
// Validity gates native representative-point operations; multiple disconnected
// Polygon components contribute a diagnostic range, never a chosen location.
export const CUSTOM_COHORT_RECORDED_PROXIMITY_SQL = `/* custom-cohort-recorded-proximity:distances */
WITH supplied AS MATERIALIZED (
  SELECT object_id,ST_GeomFromEWKB(decode(geometry_ewkb,'hex')) AS geom
  FROM jsonb_to_recordset($1::jsonb) AS item(object_id text,geometry_ewkb text)
), checked AS MATERIALIZED (
  SELECT object_id,geom,ST_IsValid(geom) AND NOT ST_IsEmpty(geom)
    AND ST_SRID(geom)=4326 AND ST_GeometryType(geom) IN ('ST_Polygon','ST_MultiPolygon') AS valid
  FROM supplied
), measured AS (
  SELECT c.object_id,c.valid,m.location_count,m.minimum_metres,m.maximum_metres
  FROM checked c LEFT JOIN LATERAL (
    SELECT count(*)::integer AS location_count,min(distance_metres) AS minimum_metres,max(distance_metres) AS maximum_metres
    FROM (SELECT ST_Distance(ST_SetSRID(ST_MakePoint($2::double precision,$3::double precision),4326)::geography,
      ST_PointOnSurface(part.geom)::geography,true) AS distance_metres
      FROM ST_Dump(CASE WHEN c.valid THEN c.geom ELSE NULL END) part) distances
  ) m ON true
) SELECT object_id,valid,location_count,minimum_metres,maximum_metres FROM measured ORDER BY object_id`;

function admitted(input) {
  data(input); data(input.spatial); data(input.study); data(input.subject);
  tree(input.subject); tree(input.study); tree(input.spatial.geometry_input); tree(input.spatial.discovery);
  data(input.spatial.account_ids); data(input.spatial.parcels);
  const ids = input.spatial.account_ids;
  check(ids.length <= L.parcels && input.spatial.parcels.length <= L.parcels
    && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64)
    && new Set(ids).size === ids.length, 'invalid_input');
  for (const row of input.spatial.parcels) data(row);
  const point = representCustomCohortSubjectPoint(input.subject);
  const counts = { accounts: ids.length, parcels: input.spatial.parcels.length, observed_accounts: 0, unknown_accounts: ids.length };
  let radius;
  try { radius = radiusOf(input); } catch { return { counts, point, reason: 'retained_binding_mismatch' }; }
  if (point.status !== 'represented') return { counts, point, radius, reason: 'subject_point_unavailable' };
  if (!same(point.geometry_input, input.spatial.geometry_input)) return { counts, point, radius, reason: 'retained_binding_mismatch' };
  const capture = data(data(input.acquisition).capture_result), sources = data(data(capture.source_capture).sources);
  check(Array.isArray(sources) && sources.length <= CUSTOM_COHORT_PARCEL_MAP_LIMITS.source_chunks, 'invalid_input');
  // Guard only the original fields consumed by the shared map adapter. Do not
  // walk/duplicate unrelated retained transaction, private CSV or metadata rows.
  let records = 0;
  for (const source of sources) {
    const payload = data(data(source).payload), rows = data(payload.records);
    check(Array.isArray(rows) && (records += rows.length) <= CUSTOM_COHORT_PARCEL_MAP_LIMITS.source_records, 'invalid_input');
    const projection = payload.projection === undefined ? null : data(payload.projection);
    const definition = projection?.definition === undefined ? null : data(projection.definition);
    if (definition?.role === 'parcels') for (const record of rows) data(data(data(record).data).raw_projection);
  }
  const map = buildCustomCohortParcelMap({ retained_inputs: input });
  if (map.status !== 'available') return { counts, point, radius,
    reason: map.reason === 'capacity_exceeded' ? 'capacity_exceeded' : 'retained_map_unavailable' };
  const components = new Map(map.geojson.features.map(row => [row.properties.object_id,
    row.geometry.type === 'Polygon' ? 1 : row.geometry.coordinates.length]));
  const wanted = new Set(components.keys()), raw = new Map();
  for (const source of input.acquisition.capture_result.source_capture.sources) {
    if (source.payload.projection?.definition?.role !== 'parcels') continue;
    for (const row of source.payload.records) {
      const projection = row.data.raw_projection;
      if (wanted.has(projection.object_id)) raw.set(projection.object_id, projection.stored_geometry_ewkb);
    }
  }
  const rows = input.spatial.parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id,
    geometry_sha256: row.geometry_sha256, source_record_hash: row.source_record_hash,
    component_count: components.get(row.object_id), geometry_ewkb: raw.get(row.object_id) })).sort((a, b) => compare(a.object_id, b.object_id));
  return { counts, point, radius, rows, ids: [...ids].sort(compare), reason: null };
}
function signature(input, prepared) {
  const hash = createHash('sha256').update('custom-cohort-recorded-proximity-v1\n');
  hash.update(json({ point: prepared.point, radius: prepared.radius ?? null, reason: prepared.reason, counts: prepared.counts,
    study: input.study, geometry_input: input.spatial.geometry_input,
    membership_sha256: input.spatial.membership_sha256 })).update('\n');
  for (const id of prepared.ids ?? input.spatial.account_ids) hash.update(json(id)).update('\n');
  // The map rechecks original EWKB against each digest. Do not allocate a
  // canonical megabyte-hex envelope or one city-sized array merely to hash it.
  for (const { geometry_ewkb, ...row } of prepared.rows ?? []) hash.update(json(row)).update('\n');
  return hash.digest('hex');
}
function budget(options) {
  data(options); check(Object.keys(options).every(key => ['signal', 'deadline'].includes(key))
    && (options.signal === undefined || options.signal instanceof AbortSignal)
    && (options.deadline === undefined || Number.isFinite(options.deadline)), 'invalid_options');
  return () => {
    if (options.signal?.aborted) fail('cancelled');
    if (options.deadline !== undefined && performance.now() >= options.deadline) fail('deadline_exceeded');
  };
}
function batches(rows) {
  const result = []; let batch = [], bytes = 2;
  for (const row of rows) {
    const item = { object_id: row.object_id, geometry_ewkb: row.geometry_ewkb }, size = Buffer.byteLength(JSON.stringify(item));
    if (size + 2 > L.batch_utf8_bytes) return null;
    if (batch.length === L.batch_parcels || bytes + size + (batch.length ? 1 : 0) > L.batch_utf8_bytes) {
      result.push(batch); batch = []; bytes = 2;
    }
    bytes += size + (batch.length ? 1 : 0); batch.push(item);
  }
  if (batch.length) result.push(batch);
  return result;
}
function measuredRows(result, requested, components) {
  if (!result || (result.rowCount !== undefined && result.rowCount !== requested.length)
    || !Array.isArray(result.rows) || result.rows.length !== requested.length) return null;
  const wanted = new Set(requested.map(row => row.object_id)), found = new Map();
  for (const row of result.rows) {
    if (!row || !wanted.has(row.object_id) || found.has(row.object_id) || typeof row.valid !== 'boolean'
      || !Number.isInteger(row.location_count) || row.location_count < 0 || row.location_count > CUSTOM_COHORT_PARCEL_MAP_LIMITS.coordinates / 4) return null;
    const { minimum_metres: low, maximum_metres: high } = row;
    if (row.valid ? row.location_count < 1 || row.location_count !== components.get(row.object_id)
      || typeof low !== 'number' || typeof high !== 'number'
      || !Number.isFinite(low) || !Number.isFinite(high) || low < 0 || high < low || high > L.maximum_distance_metres
      : row.location_count !== 0 || low !== null || high !== null) return null;
    if (row.valid && row.location_count === 1 && low !== high) return null;
    found.set(row.object_id, { valid: row.valid, location_count: row.location_count, low, high });
  }
  return found;
}

/** Owner-internal native computation on the original verified retained graph.
 * The caller owns authorization, explicit read-only transaction, statement and
 * query timeouts, and final freshness/rights fences. This module never checks
 * out a connection or creates a transaction. Query is the bounded owner query,
 * not a public distance-result injection seam. A result confers no source or
 * historical authority and changes neither selection nor accepted report data.
 */
export async function deriveCustomCohortRecordedProximity(query, value, options = {}) {
  check(typeof query === 'function', 'query_required'); data(value);
  check(Object.keys(value).length === 2 && Object.hasOwn(value, 'context_ref') && Object.hasOwn(value, 'retained_inputs'), 'invalid_input');
  const checkBudget = budget(options); checkBudget();
  const ref = context(value.context_ref), input = value.retained_inputs, prepared = admitted(input);
  checkBudget(); const fingerprint = signature(input, prepared);
  const binding = { context_ref: ref, target: structuredClone(input.subject.target),
    subject_point_source_sha256: prepared.point.geometry_input?.source_sha256 ?? null,
    spatial_membership_sha256: input.spatial.membership_sha256, radius_metres: prepared.radius ?? input.spatial.radius_metres };
  function issue(reason, accounts = null) {
    checkBudget();
    const counts = { ...prepared.counts };
    if (accounts) { counts.observed_accounts = accounts.filter(row => row.state === 'observed').length;
      counts.unknown_accounts = counts.accounts - counts.observed_accounts; }
    let result = { proximity_version: 1, basis: CUSTOM_COHORT_RECORDED_PROXIMITY_BASIS, authority: 'not_established',
      status: reason === null ? 'available' : 'unavailable', reason, binding, counts, accounts };
    if (Buffer.byteLength(JSON.stringify(result)) > L.output_utf8_bytes) result = { ...result, status: 'unavailable',
      reason: 'capacity_exceeded', accounts: null, counts: { ...prepared.counts } };
    freeze(result); issued.set(result, { input, context: json(ref), fingerprint }); return result;
  }
  if (prepared.reason) return issue(prepared.reason);
  const requests = batches(prepared.rows); if (!requests) return issue('capacity_exceeded');
  const measured = new Map(), components = new Map(prepared.rows.map(row => [row.object_id, row.component_count]));
  for (const request of requests) {
    checkBudget(); let result;
    try { result = await query(CUSTOM_COHORT_RECORDED_PROXIMITY_SQL,
      [JSON.stringify(request), ...prepared.point.geometry_input.coordinates]); }
    catch (error) {
      checkBudget();
      if (['55P03', '57014', '40001', '40P01'].includes(error?.code)) {
        throw Object.assign(new Error('custom_cohort_recorded_proximity_interrupted'), { code: error.code });
      }
      // A failed PostgreSQL statement may abort the caller's transaction. Never
      // turn that into a successful result that lets its owner attempt COMMIT.
      throw Object.assign(new Error('custom_cohort_recorded_proximity_query_failed'), { reason: 'native_query_failed' });
    }
    checkBudget(); const checked = measuredRows(result, request, components);
    if (!checked) return issue('native_result_invalid');
    for (const [id, row] of checked) measured.set(id, row);
  }
  const grouped = new Map(prepared.ids.map(id => [id, []]));
  for (const row of prepared.rows) grouped.get(row.account_id).push(measured.get(row.object_id));
  const accounts = [...grouped].map(([account_id, rows]) => {
    const invalid = rows.some(row => !row.valid), locations = rows.reduce((sum, row) => sum + row.location_count, 0);
    const state = invalid ? 'invalid_geometry' : rows.length === 1 && locations === 1 ? 'observed' : 'multiple_locations';
    const low = invalid ? null : rows.reduce((value, row) => Math.min(value, row.low), Infinity) / 1609.344;
    const high = invalid ? null : rows.reduce((value, row) => Math.max(value, row.high), -Infinity) / 1609.344;
    return { account_id, state, parcel_count: rows.length, location_count: invalid ? null : locations,
      distance_miles: state === 'observed' ? low : null,
      distance_range_miles: invalid ? null : { low, high } };
  });
  return issue(null, accounts);
}

/** Only the exact factory result may enter scoring. Re-admit the same retained
 * evidence to detect in-place point, radius, roster or geometry mutation, too;
 * object identity alone is not a claim that arbitrary caller data is immutable.
 */
export function readCustomCohortRecordedProximity(result, value) {
  const entry = issued.get(result); check(entry, 'unissued_result'); data(value);
  check(value.retained_inputs === entry.input && json(context(value.context_ref)) === entry.context, 'binding_mismatch');
  check(signature(entry.input, admitted(entry.input)) === entry.fingerprint, 'binding_mismatch');
  return result;
}
