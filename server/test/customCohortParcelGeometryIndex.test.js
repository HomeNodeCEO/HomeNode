import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortParcelMap as map, buildCustomCohortParcelGeometryIndex as index,
  CUSTOM_COHORT_PARCEL_MAP_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { recordedProximityFixture, proximityPolygon } from './fixtures/customCohortRecordedProximityFixture.js';

const SOURCE_HASH = 'a'.repeat(64);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const square = (x = -96.65, y = 32.91, width = .01) => [[x, y], [x + width, y],
  [x + width, y + width], [x, y + width], [x, y]];
function uint(value, order) {
  const bytes = Buffer.alloc(4);
  if (order === 1) bytes.writeUInt32LE(value); else bytes.writeUInt32BE(value);
  return bytes;
}
function polygon(rings = [square()], { order = 1, srid = 4326 } = {}) {
  const bytes = Buffer.alloc(9 + (srid === null ? 0 : 4) + rings.reduce((sum, ring) => sum + 4 + ring.length * 16, 0));
  let offset = 0;
  bytes[offset++] = order;
  const write = value => { uint(value, order).copy(bytes, offset); offset += 4; };
  write(3 + (srid === null ? 0 : 0x20000000));
  if (srid !== null) write(srid);
  write(rings.length);
  for (const ring of rings) {
    write(ring.length);
    for (const point of ring) for (const value of point) {
      if (order === 1) bytes.writeDoubleLE(value, offset); else bytes.writeDoubleBE(value, offset);
      offset += 8;
    }
  }
  return bytes;
}
function multi(parts, { order = 1, srid = 4326 } = {}) {
  return Buffer.concat([Buffer.from([order]), uint(6 + (srid === null ? 0 : 0x20000000), order),
    ...(srid === null ? [] : [uint(srid, order)]), uint(parts.length, order), ...parts]);
}

// These lightweight fixtures exercise the pure adapter, not graph admission or
// native topology. The separate capture/reopen fixture below covers real retained
// wrapper identities. Repeated coordinates in budget fixtures are structural only.
function fixture(specs = [{ id: '9007199254740993', account: 'R-001', bytes: polygon() }]) {
  const encoded = new Map();
  const material = bytes => {
    if (!encoded.has(bytes)) encoded.set(bytes, { hex: bytes.toString('hex'), hash: digest(bytes) });
    return encoded.get(bytes);
  };
  const records = specs.map(({ id, account, bytes }) => ({ record_id: `parcel:${id}`, data: {
    record_id: `gis.dcad_parcels:${id}`, raw_projection: { object_id: id, account_id: account,
      source_record_hash: SOURCE_HASH, stored_geometry_ewkb: material(bytes).hex },
  } }));
  return { spatial: { status: 'captured', query_complete: true,
    account_ids: [...new Set(specs.map(spec => spec.account))].sort(),
    parcels: specs.map(({ id, account, bytes }) => ({ object_id: id, account_id: account,
      source_record_hash: SOURCE_HASH, geometry_sha256: material(bytes).hash })) },
  acquisition: { capture_result: { status: 'captured', query_complete: true, source_capture: {
    status: 'ready', sources: [{ payload: { projection: { definition: { role: 'parcels' } }, records } }],
  } } } };
}
const sources = input => input.acquisition.capture_result.source_capture.sources;
const rows = input => sources(input)[0].payload.records;
const raw = input => rows(input)[0].data.raw_projection;
function available(options) {
  const full = map(options), compact = index(options);
  assert.equal(full.status, 'available'); assert.equal(compact.status, 'available');
  assert.deepEqual(Object.keys(compact).sort(), ['counts', 'geometry_semantics', 'parcels', 'status']);
  assert.deepEqual(compact.counts, full.counts, 'including the hypothetical full GeoJSON byte count and selected accounts');
  assert.equal(compact.counts.geojson_bytes, Buffer.byteLength(JSON.stringify(full.geojson)));
  assert.equal(compact.geometry_semantics, full.geometry_semantics);
  assert.equal(compact.parcels.length, full.geojson.features.length);
  const roster = new Map(options.retained_inputs.spatial.parcels.map(parcel => [parcel.object_id, parcel]));
  const originals = new Map(sources(options.retained_inputs).filter(source => source.payload.projection.definition.role === 'parcels')
    .flatMap(source => source.payload.records.map(row => [row.data.raw_projection.object_id, row.data.raw_projection])));
  for (const [position, parcel] of compact.parcels.entries()) {
    const feature = full.geojson.features[position], original = roster.get(feature.properties.object_id);
    assert.deepEqual(parcel, { object_id: original.object_id, account_id: original.account_id,
      geometry_sha256: original.geometry_sha256, source_record_hash: original.source_record_hash,
      component_count: feature.geometry.type === 'Polygon' ? 1 : feature.geometry.coordinates.length,
      geometry_ewkb: originals.get(original.object_id).stored_geometry_ewkb });
    assert.ok(Object.isFrozen(parcel));
  }
  assert.ok(Object.isFrozen(compact) && Object.isFrozen(compact.parcels) && Object.isFrozen(compact.counts));
  return { full, compact };
}
function unavailable(options, reason) {
  const full = map(options), compact = index(options);
  assert.equal(full.status, 'unavailable'); assert.equal(full.reason, reason);
  assert.deepEqual(compact, { status: 'unavailable', reason, parcels: null, geometry_semantics: full.geometry_semantics });
  assert.ok(Object.isFrozen(compact));
  assert.equal(Object.hasOwn(compact, 'counts'), false, 'no partial success counts');
}

test('genuine captured/persisted/reopened parcels retain exact original evidence in the geometry index', async () => {
  const first = proximityPolygon(), second = proximityPolygon(-96.64);
  first.coordinates.push(proximityPolygon(-96.6498, 32.9102, .0001).coordinates[0].reverse());
  const captured = await recordedProximityFixture({ parcels: [{ account_id: 'subject', geometry: first },
    { account_id: 'R-001', geometry: { type: 'MultiPolygon', coordinates: [second.coordinates, proximityPolygon(-96.63).coordinates] } }] });
  const before = JSON.stringify(captured.retained_inputs);
  const { compact } = available({ retained_inputs: captured.retained_inputs, selected_account_ids: [captured.accountIds[0]] });
  assert.deepEqual(compact.parcels.map(parcel => parcel.component_count), [1, 2]);
  assert.equal(JSON.stringify(captured.retained_inputs), before);
});

for (const order of [0, 1]) test(`Polygon holes and mixed-endian MultiPolygon parts preserve counts and literal EWKB (${order})`, () => {
  const rings = [square(), square(-96.648, 32.912, .001).reverse()];
  const input = fixture([{ id: '9007199254740993', account: 'R-001', bytes: polygon(rings, { order }) },
    { id: '9223372036854775807', account: 'R-002', bytes: multi([
      polygon(rings, { order: 1 - order, srid: null }), polygon([square(-96.6, 33)], { order, srid: 4326 }),
    ], { order }) }]);
  raw(input).stored_geometry_ewkb = raw(input).stored_geometry_ewkb.toUpperCase();
  const { compact } = available({ retained_inputs: input });
  assert.deepEqual(compact.parcels.map(parcel => parcel.component_count), [1, 2], 'holes are not disconnected components');
  assert.equal(compact.counts.coordinates, 25);
  assert.equal(compact.parcels[0].geometry_ewkb, raw(input).stored_geometry_ewkb, 'do not normalize even hexadecimal case');
  assert.equal(JSON.stringify(compact.parcels).includes('coordinates'), false);
  assert.equal(JSON.stringify(compact).includes('FeatureCollection'), false);
});

test('selection changes only annotations and byte accounting, preserving all discovered geometry in roster order', () => {
  const bytes = polygon(), input = fixture([{ id: '10', account: 'R-001', bytes },
    { id: '11', account: 'R-001', bytes }, { id: '12', account: 'R-002', bytes }]);
  const original = rows(input).splice(0);
  rows(input).push(original[2], { record_id: 'parcel:13', data: { record_id: 'gis.dcad_parcels:13',
    raw_projection: { object_id: '13', account_id: 'R-001', stored_geometry_ewkb: 'ff' } } });
  sources(input).push({ payload: { projection: { definition: { role: 'parcels' } }, records: [original[1], original[0]] } });
  const omitted = available({ retained_inputs: input }).compact;
  for (const selected of [[], ['R-001'], ['R-002'], ['R-002', 'R-001']]) {
    const compact = available({ retained_inputs: input, selected_account_ids: selected }).compact;
    assert.deepEqual(compact.parcels, omitted.parcels);
    assert.equal(compact.counts.selected_accounts, selected.length);
    assert.equal(compact.counts.parcels, 3);
  }
  for (const selected of [['unknown'], ['R-001', 'R-001'], null]) unavailable({ retained_inputs: input, selected_account_ids: selected }, 'invalid_selection');
});

for (const [name, change, reason] of [
  ['source hash', input => { raw(input).source_record_hash = 'b'.repeat(64); }, 'parcel_identity_mismatch'],
  ['geometry hash', input => { input.spatial.parcels[0].geometry_sha256 = 'b'.repeat(64); }, 'parcel_identity_mismatch'],
  ['reader identity', input => { rows(input)[0].record_id = 'parcel:1'; }, 'parcel_identity_mismatch'],
  ['mapper identity', input => { rows(input)[0].data.record_id = 'gis.dcad_parcels:1'; }, 'parcel_identity_mismatch'],
  ['off-roster account', input => { raw(input).account_id = 'foreign'; }, 'invalid_retained_inputs'],
  ['missing geometry', input => { delete raw(input).stored_geometry_ewkb; }, 'missing_parcel_geometry'],
  ['missing parcel role', input => { sources(input)[0].payload.projection.definition.role = 'accounts'; }, 'missing_parcel_geometry'],
  ['duplicate source', input => { rows(input).push(structuredClone(rows(input)[0])); }, 'duplicate_parcel'],
  ['duplicate discovered parcel', input => { input.spatial.parcels.push(structuredClone(input.spatial.parcels[0])); }, 'duplicate_parcel'],
  ['malformed hex', input => { raw(input).stored_geometry_ewkb = '00xx'; }, 'invalid_geometry'],
  ['odd hex', input => { raw(input).stored_geometry_ewkb = 'a'; }, 'invalid_geometry'],
  ['incomplete source query', input => { input.acquisition.capture_result.query_complete = false; }, 'invalid_retained_inputs'],
  ['incomplete spatial query', input => { input.spatial.query_complete = false; }, 'invalid_retained_inputs'],
]) test(`index and full map fail closed for ${name}`, () => {
  const input = fixture(); change(input);
  unavailable({ retained_inputs: input }, reason);
});

for (const [name, bytes, reason = 'invalid_geometry'] of [
  ['truncated header', Buffer.from([1, 3])],
  ['truncated coordinates', polygon().subarray(0, -1)],
  ['trailing bytes', Buffer.concat([polygon(), Buffer.from([0])])],
  ['open ring', polygon([[[-96, 32], [-95, 32], [-95, 33], [-94, 33]]])],
  ['nonfinite coordinate', polygon([[[NaN, 32], [-95, 32], [-95, 33], [NaN, 32]]])],
  ['empty polygon', polygon([])],
  ['empty multipolygon', multi([])],
  ['wrong SRID', polygon([square()], { srid: 26914 }), 'unsupported_geometry'],
  ['missing SRID', polygon([square()], { srid: null }), 'unsupported_geometry'],
  ['nested multipolygon', multi([multi([polygon()])]), 'unsupported_geometry'],
]) test(`a later ${name} returns no partial geometry index even with matching hashes`, () => {
  unavailable({ retained_inputs: fixture([{ id: '1', account: 'R-001', bytes: polygon() },
    { id: '2', account: 'R-002', bytes }]) }, reason);
});

test('malformed input and unchanged source/geometry admission caps have identical failures', () => {
  for (const options of [null, [], {}, { retained_inputs: null }, { retained_inputs: {} }]) unavailable(options, 'invalid_retained_inputs');
  for (const change of [
    input => { raw(input).stored_geometry_ewkb = '00'.repeat(LIMITS.geometry_bytes + 1); },
    input => { input.spatial.parcels = new Array(LIMITS.parcels + 1); },
    input => { input.acquisition.capture_result.source_capture.sources = new Array(LIMITS.source_chunks + 1); },
    input => { rows(input).length = LIMITS.source_records + 1; },
  ]) {
    const input = fixture(); change(input); unavailable({ retained_inputs: input }, 'capacity_exceeded');
  }
  for (const offset of [9, 13]) {
    const bytes = polygon(); bytes.writeUInt32LE(0xffffffff, offset);
    unavailable({ retained_inputs: fixture([{ id: '1', account: 'R-001', bytes }]) }, 'capacity_exceeded');
  }
});

test('the exact aggregate coordinate ceiling is admitted and one extra coordinate fails identically', () => {
  const count = 50_000, ring = length => Array.from({ length }, () => [-96, 32]);
  const bytes = polygon([ring(count)]), quotient = Math.floor(LIMITS.coordinates / count), remainder = LIMITS.coordinates % count;
  const specs = Array.from({ length: quotient }, (_, position) => ({ id: String(position + 1), account: 'R-001', bytes }));
  if (remainder) specs.push({ id: String(specs.length + 1), account: 'R-001', bytes: polygon([ring(remainder)]) });
  assert.equal(remainder, 0, 'fixture pins the current installed ceiling without widening admission');
  const exact = available({ retained_inputs: fixture(specs) }).compact;
  assert.equal(exact.counts.coordinates, LIMITS.coordinates);
  specs[specs.length - 1] = { ...specs.at(-1), bytes: polygon([ring(count + 1)]) };
  unavailable({ retained_inputs: fixture(specs) }, 'capacity_exceeded');
});

test('the index enforces the exact hypothetical full-GeoJSON UTF-8 byte ceiling independently of index serialization', () => {
  const firstId = 9007199254740993n, account = '界'.repeat(64);
  const bytes = polygon([square(-96.12345678901234, 32.123456789012345)]);
  const seed = map({ retained_inputs: fixture([{ id: String(firstId), account, bytes }]) });
  assert.equal(seed.status, 'available');
  const framing = Buffer.byteLength(JSON.stringify({ type: 'FeatureCollection', features: [] }));
  const perFeature = seed.counts.geojson_bytes - framing;
  const count = Math.floor((LIMITS.geojson_bytes - framing + 1) / (perFeature + 1)) + 1;
  assert.ok(count < LIMITS.parcels && count * seed.counts.coordinates < LIMITS.coordinates);
  assert.ok(count * bytes.length < LIMITS.total_geometry_bytes);
  const specs = Array.from({ length: count }, (_, position) => ({ id: String(firstId + BigInt(position)), account, bytes }));
  // Account IDs may have 1..192 UTF-8 bytes within the 64-character limit.
  // Reduce the just-over-limit map by an exact number of bytes, then add one.
  const accountWithBytes = size => '界'.repeat(Math.floor(size / 3)) + (size % 3 === 2 ? 'é' : size % 3 === 1 ? 'a' : '');
  let excess = framing + count * (perFeature + 1) - 1 - LIMITS.geojson_bytes, position = count;
  while (excess > 0) {
    const reduction = Math.min(191, excess);
    specs[--position].account = accountWithBytes(192 - reduction); excess -= reduction;
  }
  const exact = available({ retained_inputs: fixture(specs) }).compact;
  assert.equal(exact.counts.geojson_bytes, LIMITS.geojson_bytes);
  specs[position].account = accountWithBytes(Buffer.byteLength(specs[position].account) + 1);
  unavailable({ retained_inputs: fixture(specs) }, 'capacity_exceeded');
});

test('the index neither mutates nor freezes its original inputs, and returns independent deeply frozen results', () => {
  const input = fixture(), options = { retained_inputs: input, selected_account_ids: ['R-001'] }, before = structuredClone(options);
  const first = available(options).compact;
  assert.deepEqual(options, before);
  assert.equal(Object.isFrozen(options), false); assert.equal(Object.isFrozen(input), false);
  const second = index(options);
  assert.deepEqual(first, second); assert.notEqual(first.parcels, second.parcels); assert.notEqual(first.parcels[0], second.parcels[0]);
  assert.throws(() => { first.parcels[0].geometry_ewkb = ''; }, TypeError);
  assert.throws(() => { first.parcels.push({}); }, TypeError);
  assert.throws(() => { first.counts.geojson_bytes = 0; }, TypeError);
  raw(input).stored_geometry_ewkb = '00'; options.selected_account_ids.length = 0;
  assert.deepEqual(first, second, 'later caller mutation cannot rewrite prior evidence');
  function deepFreeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
  }
  available(deepFreeze({ retained_inputs: fixture(), selected_account_ids: [] }));
});
