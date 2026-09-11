import { createHash } from 'node:crypto';
import { customCohortObservationRecordLimit } from './customCohortObservationMapping.js';
import { setImmediate as yieldToRequests } from 'node:timers/promises';

export const CUSTOM_COHORT_PARCEL_MAP_LIMITS = Object.freeze({
  parcels: 100_000, source_chunks: 1_000, source_records: 100_000,
  geometry_bytes: 1_000_000, total_geometry_bytes: 16_000_000,
  coordinates: 250_000, geojson_bytes: 16_000_000,
});
const SEMANTICS = 'current_observed_cached_parcels_not_legal_subdivision_boundary';
const HASH = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-fA-F]+$/;
const LIMITS = CUSTOM_COHORT_PARCEL_MAP_LIMITS;

class UnavailableMap extends Error {}
const unavailable = reason => { throw new UnavailableMap(reason); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const accountId = value => typeof value === 'string' && value.length > 0 && value.length <= 64
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
function objectId(value) {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,18}|-[1-9]\d{0,18})$/.test(value)
    && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// Display-only structural decoder. The retained acquisition's native spatial
// reader established polygon validity; this is not a topology/coverage check.
// Do not repair, orient, simplify, join, buffer or transform original rings.
function decodeGeometry(bytes, budget) {
  let offset = 0;
  const need = size => { if (size > bytes.length - offset) unavailable('invalid_geometry'); };
  function geometry(nested = false) {
    need(5);
    const order = bytes[offset++];
    if (order !== 0 && order !== 1) unavailable('invalid_geometry');
    const uint = () => {
      need(4);
      const value = order === 1 ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      offset += 4;
      return value;
    };
    const encoded = uint(), hasSrid = (encoded & 0x20000000) !== 0, kind = encoded & 0x0fffffff;
    if (encoded !== kind + (hasSrid ? 0x20000000 : 0)
      || (nested ? kind !== 3 : kind !== 3 && kind !== 6)
      || (!nested && !hasSrid) || (hasSrid && uint() !== 4326)) unavailable('unsupported_geometry');
    const size = uint();
    if (!size) unavailable('invalid_geometry');
    // Every ring/part needs at least four coordinate pairs. Check before loops
    // and allocations; the coordinate budget is shared by the complete map.
    if (size > Math.floor((LIMITS.coordinates - budget.coordinates) / 4)) unavailable('capacity_exceeded');
    if (kind === 6) {
      need(size * 77); // Minimum child Polygon: header + one four-point ring.
      const polygons = [];
      for (let i = 0; i < size; i++) polygons.push(geometry(true).coordinates);
      return { type: 'MultiPolygon', coordinates: polygons };
    }
    need(size * 68); // Ring count has already been read; each ring needs its size.
    const rings = [];
    for (let i = 0; i < size; i++) {
      const count = uint();
      if (count < 4) unavailable('invalid_geometry');
      if (count > LIMITS.coordinates - budget.coordinates) unavailable('capacity_exceeded');
      need(count * 16);
      budget.coordinates += count;
      const ring = [];
      for (let j = 0; j < count; j++) {
        const x = order === 1 ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset);
        const y = order === 1 ? bytes.readDoubleLE(offset + 8) : bytes.readDoubleBE(offset + 8);
        offset += 16;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180 || x > 180 || y < -90 || y > 90) {
          unavailable('invalid_geometry');
        }
        ring.push([x, y]);
      }
      if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) unavailable('invalid_geometry');
      rings.push(ring);
    }
    return { type: 'Polygon', coordinates: rings };
  }
  const result = geometry();
  if (offset !== bytes.length) unavailable('invalid_geometry');
  return result;
}

function rosterOf(spatial, selected) {
  if (!object(spatial) || spatial.status !== 'captured' || spatial.query_complete !== true
    || !Array.isArray(spatial.parcels) || !Array.isArray(spatial.account_ids)) unavailable('invalid_retained_inputs');
  if (spatial.parcels.length > LIMITS.parcels || spatial.account_ids.length > LIMITS.parcels) unavailable('capacity_exceeded');
  const accounts = new Set();
  for (const id of spatial.account_ids) {
    if (!accountId(id) || accounts.has(id)) unavailable('invalid_retained_inputs');
    accounts.add(id);
  }
  const parcels = new Map(), represented = new Set();
  for (const parcel of spatial.parcels) {
    if (!object(parcel) || !objectId(parcel.object_id) || !accounts.has(parcel.account_id)
      || !HASH.test(parcel.source_record_hash ?? '') || !HASH.test(parcel.geometry_sha256 ?? '')) unavailable('invalid_retained_inputs');
    if (parcels.has(parcel.object_id)) unavailable('duplicate_parcel');
    parcels.set(parcel.object_id, parcel);
    represented.add(parcel.account_id);
  }
  if (represented.size !== accounts.size) unavailable('invalid_retained_inputs');
  if (selected === undefined) return { parcels, accounts, selected: accounts };
  if (!Array.isArray(selected) || selected.length > accounts.size) unavailable('invalid_selection');
  const selectedSet = new Set();
  for (const id of selected) {
    if (!accountId(id) || !accounts.has(id) || selectedSet.has(id)) unavailable('invalid_selection');
    selectedSet.add(id);
  }
  return { parcels, accounts, selected: selectedSet };
}

function* parcelRows(input, roster) {
  const capture = input.acquisition?.capture_result;
  if (capture?.status !== 'captured' || capture.query_complete !== true
    || capture.source_capture?.status !== 'ready' || !Array.isArray(capture.source_capture.sources)) unavailable('invalid_retained_inputs');
  const sources = capture.source_capture.sources;
  if (sources.length > LIMITS.source_chunks) unavailable('capacity_exceeded');
  const rows = new Map();
  let sourceRecordLimit;
  try { sourceRecordLimit = customCohortObservationRecordLimit(input.acquisition); }
  catch { unavailable('invalid_retained_inputs'); }
  let sourceRecords = 0, parcelRole = false;
  for (const source of sources) {
    const payload = source?.payload;
    if (!object(payload) || !Array.isArray(payload.records)) unavailable('invalid_retained_inputs');
    sourceRecords += payload.records.length;
    if (sourceRecords > sourceRecordLimit) unavailable('capacity_exceeded');
    if (payload.projection?.definition?.role !== 'parcels') continue;
    parcelRole = true;
    for (const record of payload.records) {
      if (rows.size % 125 === 0) yield;
      const raw = record?.data?.raw_projection;
      if (!object(raw) || !objectId(raw.object_id) || !roster.accounts.has(raw.account_id)) unavailable('invalid_retained_inputs');
      // G reads all parcel rows for the discovery accounts. An account can have
      // another disconnected parcel outside H's three-mile discovery: exclude it.
      const parcel = roster.parcels.get(raw.object_id);
      if (!parcel) continue;
      // The reader's routing identity and the retained mapper's identity are
      // intentionally distinct. Compare both originals; never relabel either.
      if (record.record_id !== `parcel:${parcel.object_id}`
        || record.data.record_id !== `gis.dcad_parcels:${parcel.object_id}` || raw.account_id !== parcel.account_id
        || raw.source_record_hash !== parcel.source_record_hash) unavailable('parcel_identity_mismatch');
      if (rows.has(parcel.object_id)) unavailable('duplicate_parcel');
      rows.set(parcel.object_id, raw);
    }
  }
  if (!parcelRole || rows.size !== roster.parcels.size) unavailable('missing_parcel_geometry');
  return rows;
}

/** Consume ONLY the internal retained_inputs returned by the verified retention
 * loader. This pure display adapter does not authenticate a caller, validate the
 * complete retained graph, recreate an original acquisition handle, establish
 * current facts, certify a legal boundary, or select/similarity-score a cohort.
 * selected_account_ids annotates an exact discovery subset; omitted means all.
 * Failure always returns geojson:null, never a partially displayed discovery.
 */
export function buildCustomCohortParcelMap(options = {}) {
  const iterator = parcelMapBatches(options);
  while (true) { const step = iterator.next(); if (step.done) return step.value; }
}

export async function buildCustomCohortParcelMapBatched(options, { check = () => {} } = {}) {
  check(); freeze(options); check();
  const iterator = parcelMapBatches(options);
  try {
    while (true) { check(); const step = iterator.next(); check(); if (step.done) return step.value; await yieldToRequests(); }
  } finally { iterator.return(); }
}

function* parcelMapBatches(options) {
  try {
    if (!object(options)) unavailable('invalid_retained_inputs');
    const { retained_inputs: input, selected_account_ids: selected } = options;
    if (!object(input)) unavailable('invalid_retained_inputs');
    const roster = rosterOf(input.spatial, selected), rows = yield* parcelRows(input, roster);
    const budget = { geometry_bytes: 0, coordinates: 0 };
    const geojson = { type: 'FeatureCollection', features: [] };
    let jsonBytes = Buffer.byteLength(JSON.stringify(geojson));
    for (const [id, parcel] of roster.parcels) {
      if (geojson.features.length % 125 === 0) yield;
      const hex = rows.get(id).stored_geometry_ewkb;
      if (typeof hex !== 'string' || !hex.length) unavailable('missing_parcel_geometry');
      if (hex.length > LIMITS.geometry_bytes * 2) unavailable('capacity_exceeded');
      if (hex.length % 2 !== 0 || !HEX.test(hex)) unavailable('invalid_geometry');
      budget.geometry_bytes += hex.length / 2;
      if (budget.geometry_bytes > LIMITS.total_geometry_bytes) unavailable('capacity_exceeded');
      const bytes = Buffer.from(hex, 'hex');
      if (createHash('sha256').update(bytes).digest('hex') !== parcel.geometry_sha256) unavailable('parcel_identity_mismatch');
      const feature = { type: 'Feature', id: `gis.dcad_parcels:${id}`,
        properties: { object_id: id, account_id: parcel.account_id, selected: roster.selected.has(parcel.account_id) },
        geometry: decodeGeometry(bytes, budget) };
      jsonBytes += Buffer.byteLength(JSON.stringify(feature)) + (geojson.features.length ? 1 : 0);
      if (jsonBytes > LIMITS.geojson_bytes) unavailable('capacity_exceeded');
      geojson.features.push(feature);
    }
    return freeze({ status: 'available', geojson, geometry_semantics: SEMANTICS,
      counts: { parcels: geojson.features.length, accounts: roster.accounts.size,
        selected_accounts: roster.selected.size, coordinates: budget.coordinates,
        geometry_bytes: budget.geometry_bytes, geojson_bytes: jsonBytes } });
  } catch (error) {
    if (!(error instanceof UnavailableMap)) throw error;
    return Object.freeze({ status: 'unavailable', reason: error.message, geojson: null, geometry_semantics: SEMANTICS });
  }
}
