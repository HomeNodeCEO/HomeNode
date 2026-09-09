import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortParcelMap as build, CUSTOM_COHORT_PARCEL_MAP_LIMITS as LIMITS }
  from '../src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { mapCachedParcelRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';

const HASH = 'a'.repeat(64);
const clone = value => structuredClone(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const square = (x = -96.65, y = 32.91, width = 0.01) => [[x, y], [x + width, y],
  [x + width, y + width], [x, y + width], [x, y]];
function uint(value, order) {
  const bytes = Buffer.alloc(4);
  if (order === 1) bytes.writeUInt32LE(value); else bytes.writeUInt32BE(value);
  return bytes;
}
function pair(value, order) {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 2; i++) {
    if (order === 1) bytes.writeDoubleLE(value[i], i * 8); else bytes.writeDoubleBE(value[i], i * 8);
  }
  return bytes;
}
function polygon(rings = [square()], { order = 1, srid = 4326 } = {}) {
  return Buffer.concat([Buffer.from([order]), uint(3 + (srid === null ? 0 : 0x20000000), order),
    ...(srid === null ? [] : [uint(srid, order)]), uint(rings.length, order),
    ...rings.flatMap(ring => [uint(ring.length, order), ...ring.map(point => pair(point, order))])]);
}
function multi(parts, { order = 1, srid = 4326 } = {}) {
  return Buffer.concat([Buffer.from([order]), uint(6 + (srid === null ? 0 : 0x20000000), order),
    ...(srid === null ? [] : [uint(srid, order)]), uint(parts.length, order), ...parts]);
}

// Match G's outer parcel routing identity and the ACTUAL retained mapper wrapper
// separately. These unit fixtures are not a substitute for the graph loader.
function record(id, account, bytes) {
  const mapped = mapCachedParcelRow({ object_id: id, account_id: account,
    source_record_hash: HASH, stored_geometry_ewkb: bytes.toString('hex') });
  return clone({ record_id: `parcel:${id}`, data: mapped });
}
function fixture(specs = [{ id: '9007199254740993', account: 'R-001', bytes: polygon() }]) {
  const records = specs.map(p => record(p.id, p.account, p.bytes));
  return { spatial: { status: 'captured', query_complete: true,
    account_ids: [...new Set(specs.map(p => p.account))].sort(),
    parcels: specs.map(p => ({ object_id: p.id, account_id: p.account,
      source_record_hash: HASH, geometry_sha256: digest(p.bytes) })) },
  acquisition: { capture_result: { status: 'captured', query_complete: true, source_capture: {
    status: 'ready', sources: [{ payload: { projection: { definition: { role: 'parcels' } }, records } }],
  } } } };
}
const sources = input => input.acquisition.capture_result.source_capture.sources;
const rows = input => sources(input)[0].payload.records;
const raw = input => rows(input)[0].data.raw_projection;
const map = (input, selected) => build({ retained_inputs: input, ...(selected === undefined ? {} : { selected_account_ids: selected }) });
function expectUnavailable(result, reason) {
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, reason);
  assert.equal(result.geojson, null);
  assert.equal(Object.hasOwn(result, 'counts'), false, 'never advertise partial success counts');
}

test('joins distinct original reader and mapper identities without relabeling either', () => {
  const input = fixture(), id = input.spatial.parcels[0].object_id, before = clone(rows(input)[0]);
  assert.equal(before.record_id, `parcel:${id}`);
  assert.equal(before.data.record_id, `gis.dcad_parcels:${id}`);
  assert.equal(map(input).status, 'available');
  assert.deepEqual(rows(input)[0], before);
  rows(input)[0].record_id = before.data.record_id;
  expectUnavailable(map(input), 'parcel_identity_mismatch');
  rows(input)[0].record_id = before.record_id;
  rows(input)[0].data.record_id = before.record_id;
  expectUnavailable(map(input), 'parcel_identity_mismatch');
});

for (const order of [0, 1]) {
  test(`preserves Polygon holes and exact coordinates in ${order ? 'little' : 'big'} endian`, () => {
    const rings = [square(), square(-96.648, 32.912, 0.001).reverse()];
    const bytes = polygon(rings, { order }), input = fixture([{ id: '9007199254740993', account: 'R-001', bytes }]);
    const result = map(input);
    assert.equal(result.status, 'available');
    assert.deepEqual(result.geojson.features[0], { type: 'Feature', id: 'gis.dcad_parcels:9007199254740993',
      properties: { object_id: '9007199254740993', account_id: 'R-001', selected: true },
      geometry: { type: 'Polygon', coordinates: rings } });
    assert.deepEqual(result.counts, { parcels: 1, accounts: 1, selected_accounts: 1, coordinates: 10,
      geometry_bytes: bytes.length, geojson_bytes: Buffer.byteLength(JSON.stringify(result.geojson)) });
    assert.equal(result.geometry_semantics, 'current_observed_cached_parcels_not_legal_subdivision_boundary');
  });

  test(`preserves disconnected MultiPolygon parts, holes, and child byte orders under ${order ? 'LE' : 'BE'} root`, () => {
    const first = [square(), square(-96.648, 32.912, 0.001).reverse()], second = [square(-96.6, 33)];
    const bytes = multi([polygon(first, { order: 1 - order, srid: null }), polygon(second, { order, srid: 4326 })], { order });
    const result = map(fixture([{ id: '9223372036854775807', account: 'Exact-Account', bytes }]));
    assert.equal(result.status, 'available');
    assert.deepEqual(result.geojson.features[0].geometry, { type: 'MultiPolygon', coordinates: [first, second] });
    assert.equal(result.counts.coordinates, 15);
  });
}

test('matches only actual discovered IDs across chunks, never an outside-discovery same-account parcel', () => {
  const input = fixture([{ id: '10', account: 'R-001', bytes: polygon() },
    { id: '11', account: 'R-001', bytes: polygon([square(-96.6, 33)]) },
    { id: '12', account: 'R-002', bytes: polygon() }]);
  const original = rows(input).splice(0);
  rows(input).push(original[2], record('13', 'R-001', Buffer.from('ff', 'hex')));
  sources(input).push({ payload: { projection: { definition: { role: 'parcels' } }, records: [original[1], original[0]] } });
  const result = map(input, ['R-001']);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.geojson.features.map(f => [f.properties.object_id, f.properties.selected]),
    [['10', true], ['11', true], ['12', false]]);
  assert.equal(result.counts.accounts, 2);
  assert.equal(result.counts.selected_accounts, 1);
});

test('selection only annotates the discovery; an empty selection does not omit geometry', () => {
  const result = map(fixture(), []);
  assert.equal(result.status, 'available');
  assert.equal(result.geojson.features.length, 1);
  assert.equal(result.geojson.features[0].properties.selected, false);
  assert.equal(result.counts.selected_accounts, 0);
});

test('empty verified discovery is an empty available collection, not missing evidence', () => {
  const result = map(fixture([]));
  assert.equal(result.status, 'available');
  assert.deepEqual(result.geojson, { type: 'FeatureCollection', features: [] });
});

test('accepts hexadecimal case differences only as the same exact EWKB bytes', () => {
  const input = fixture();
  raw(input).stored_geometry_ewkb = raw(input).stored_geometry_ewkb.toUpperCase();
  assert.equal(map(input).status, 'available');
});

for (const [name, selected] of Object.entries({ off_roster: ['R-002'], alias: [' R-001 '],
  duplicate: ['R-001', 'R-001'], numeric: [1], null: null, not_array: 'R-001' })) {
  test(`rejects ${name} selection without normalizing account identity`, () => {
    expectUnavailable(map(fixture(), selected), 'invalid_selection');
  });
}

for (const [name, change, reason] of [
  ['missing source row', input => { rows(input).length = 0; }, 'missing_parcel_geometry'],
  ['missing parcel role', input => { sources(input)[0].payload.projection.definition.role = 'accounts'; }, 'missing_parcel_geometry'],
  ['missing geometry without a GeoJSON fallback', input => { delete raw(input).stored_geometry_ewkb;
    raw(input).stored_geometry_geojson = { type: 'Polygon', coordinates: [square()] }; }, 'missing_parcel_geometry'],
  ['wrong source hash', input => { raw(input).source_record_hash = 'b'.repeat(64); }, 'parcel_identity_mismatch'],
  ['wrong geometry hash', input => { input.spatial.parcels[0].geometry_sha256 = 'b'.repeat(64); }, 'parcel_identity_mismatch'],
  ['wrong wrapper identity', input => { rows(input)[0].data.record_id = 'gis.dcad_parcels:1'; }, 'parcel_identity_mismatch'],
  ['wrong source identity', input => { rows(input)[0].record_id = 'parcel:1'; }, 'parcel_identity_mismatch'],
  ['wrong object identity', input => { raw(input).object_id = '1'; }, 'missing_parcel_geometry'],
  ['off-roster source account', input => { raw(input).account_id = 'R-foreign'; }, 'invalid_retained_inputs'],
  ['off-roster membership account', input => { input.spatial.parcels[0].account_id = 'R-foreign'; }, 'invalid_retained_inputs'],
  ['unrepresented account roster entry', input => { input.spatial.account_ids.push('R-foreign'); }, 'invalid_retained_inputs'],
  ['duplicate account roster entry', input => { input.spatial.account_ids.push('R-001'); }, 'invalid_retained_inputs'],
  ['duplicate discovered ID', input => { input.spatial.parcels.push(clone(input.spatial.parcels[0])); }, 'duplicate_parcel'],
  ['duplicate parcel source row', input => { rows(input).push(clone(rows(input)[0])); }, 'duplicate_parcel'],
  ['incomplete spatial membership', input => { input.spatial.query_complete = false; }, 'invalid_retained_inputs'],
  ['incomplete source capture', input => { input.acquisition.capture_result.source_capture.status = 'incomplete'; }, 'invalid_retained_inputs'],
  ['incomplete source query', input => { input.acquisition.capture_result.query_complete = false; }, 'invalid_retained_inputs'],
]) {
  test(`unavailable for ${name}`, () => {
    const input = fixture(); change(input);
    expectUnavailable(map(input), reason);
  });
}

test('rejects a mismatched source account even when both accounts are in the discovery roster', () => {
  const input = fixture([{ id: '10', account: 'R-001', bytes: polygon() }, { id: '11', account: 'R-002', bytes: polygon() }]);
  raw(input).account_id = 'R-002';
  expectUnavailable(map(input), 'parcel_identity_mismatch');
});

test('only the original parcel projection role supplies geometry, never a similarly shaped other role', () => {
  const input = fixture();
  sources(input).unshift({ payload: { projection: { definition: { role: 'transactions' } },
    records: [record('9007199254740993', 'R-001', Buffer.from('ff', 'hex'))] } });
  assert.equal(map(input).status, 'available');
});

for (const [name, bytes, reason = 'invalid_geometry'] of [
  ['trailing bytes', Buffer.concat([polygon(), Buffer.from([0])])],
  ['truncated header', Buffer.from([1, 3])],
  ['truncated coordinates', polygon().subarray(0, -1)],
  ['invalid byte order', Buffer.concat([Buffer.from([2]), polygon().subarray(1)])],
  ['open ring', polygon([[[-96, 32], [-95, 32], [-95, 33], [-94, 33]]])],
  ['short ring', polygon([[[-96, 32], [-95, 32], [-96, 32]]])],
  ['empty Polygon', polygon([])],
  ['empty MultiPolygon', multi([])],
  ['infinite coordinate', polygon([[[Infinity, 32], [-95, 32], [-95, 33], [Infinity, 32]]])],
  ['NaN coordinate', polygon([[[NaN, 32], [-95, 32], [-95, 33], [NaN, 32]]])],
  ['longitude outside WGS84', polygon([square(181, 32)])],
  ['latitude outside WGS84', polygon([square(-96, 91)])],
  ['wrong root SRID', polygon([square()], { srid: 26914 }), 'unsupported_geometry'],
  ['missing root SRID', polygon([square()], { srid: null }), 'unsupported_geometry'],
  ['wrong nested SRID', multi([polygon([square()], { srid: 26914 })]), 'unsupported_geometry'],
  ['nested MultiPolygon', multi([multi([polygon()])]), 'unsupported_geometry'],
]) {
  test(`rejects ${name} even when its bytes match the retained geometry hash`, () => {
    expectUnavailable(map(fixture([{ id: '1', account: 'R-001', bytes }])), reason);
  });
}

for (const [name, encoded] of [['Z', 0xa0000003], ['M', 0x60000003], ['BBOX', 0x30000003],
  ['ISO 3D', 0x200003eb], ['Point', 0x20000001], ['GeometryCollection', 0x20000007]]) {
  test(`does not silently drop ${name} dimensions or geometry members`, () => {
    const bytes = polygon(); bytes.writeUInt32LE(encoded, 1);
    expectUnavailable(map(fixture([{ id: '1', account: 'R-001', bytes }])), 'unsupported_geometry');
  });
}

for (const hex of ['a', '00xx', ' 0103', '0103 ']) {
  test(`refuses malformed hex ${JSON.stringify(hex)} instead of Buffer truncation`, () => {
    const input = fixture(); raw(input).stored_geometry_ewkb = hex;
    expectUnavailable(map(input), 'invalid_geometry');
  });
}

test('a later invalid parcel returns no partial FeatureCollection', () => {
  const input = fixture([{ id: '1', account: 'R-001', bytes: polygon() },
    { id: '2', account: 'R-001', bytes: Buffer.from([0]) }]);
  expectUnavailable(map(input), 'invalid_geometry');
});

test('rejects oversized per-parcel bytes before hex decoding', () => {
  const input = fixture(); raw(input).stored_geometry_ewkb = '00'.repeat(LIMITS.geometry_bytes + 1);
  expectUnavailable(map(input), 'capacity_exceeded');
});

test('rejects declared coordinate/ring counts before allocating them', () => {
  for (const offset of [9, 13]) {
    const bytes = polygon(); bytes.writeUInt32LE(0xffffffff, offset);
    expectUnavailable(map(fixture([{ id: '1', account: 'R-001', bytes }])), 'capacity_exceeded');
  }
});

test('charges the aggregate coordinate budget across every feature, without returning a prefix', () => {
  const ring = Array.from({ length: 30_000 }, (_, i) => [-96 + (i % 2) * 0.001, 32]);
  ring[ring.length - 1] = ring[0];
  const bytes = polygon([ring]);
  const input = fixture(Array.from({ length: 9 }, (_, i) => ({ id: String(i + 1), account: 'R-001', bytes })));
  expectUnavailable(map(input), 'capacity_exceeded');
});

test('charges actual aggregate GeoJSON UTF-8 bytes, including properties, before returning any map', () => {
  const firstId = 9007199254740993n, account = '\u754c'.repeat(64);
  const bytes = polygon([square(-96.12345678901234, 32.123456789012345)]);
  const first = map(fixture([{ id: String(firstId), account, bytes }]));
  const framing = Buffer.byteLength(JSON.stringify({ type: 'FeatureCollection', features: [] }));
  const perFeature = first.counts.geojson_bytes - framing;
  const count = Math.ceil((LIMITS.geojson_bytes - framing) / (perFeature + 1)) + 1;
  assert.ok(count < LIMITS.parcels && count * first.counts.coordinates < LIMITS.coordinates);
  assert.ok(count * bytes.length < LIMITS.total_geometry_bytes);
  const input = fixture(Array.from({ length: count }, (_, i) => ({ id: String(firstId + BigInt(i)), account, bytes })));
  const records = rows(input), chunks = [];
  for (let i = 0; i < records.length; i += 1_000) chunks.push({ payload: {
    projection: { definition: { role: 'parcels' } }, records: records.slice(i, i + 1_000),
  } });
  input.acquisition.capture_result.source_capture.sources = chunks;
  expectUnavailable(map(input), 'capacity_exceeded');
});

test('bounded roster, source chunk and source record admission happens before traversal', () => {
  for (const change of [
    input => { input.spatial.parcels = new Array(LIMITS.parcels + 1); },
    input => { input.acquisition.capture_result.source_capture.sources = new Array(LIMITS.source_chunks + 1); },
    input => { rows(input).length = LIMITS.source_records + 1; },
  ]) {
    const input = fixture(); change(input);
    expectUnavailable(map(input), 'capacity_exceeded');
  }
});

test('fails closed on missing or malformed retained input structure', () => {
  for (const input of [undefined, null, [], {}, { spatial: {} }]) expectUnavailable(map(input), 'invalid_retained_inputs');
  expectUnavailable(build(null), 'invalid_retained_inputs');
});

test('does not mutate even recursively frozen input, and returns independent immutable geometry', () => {
  function deepFreeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
  }
  const input = deepFreeze(fixture()), before = JSON.stringify(input), selected = Object.freeze(['R-001']);
  const first = map(input, selected), second = map(input, selected);
  assert.equal(first.status, 'available');
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(first, second);
  assert.notEqual(first.geojson, second.geojson);
  assert.notEqual(first.geojson.features[0].geometry.coordinates, second.geojson.features[0].geometry.coordinates);
  assert.throws(() => { first.geojson.features[0].geometry.coordinates[0][0][0] = 0; }, TypeError);
  assert.throws(() => { first.geojson.features.push({}); }, TypeError);
  assert.throws(() => { first.counts.parcels = 0; }, TypeError);
});
