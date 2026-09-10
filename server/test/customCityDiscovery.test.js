import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { prepareCustomCityDiscoveryChoice as choiceOf, loadInstalledCustomCityDiscovery as load,
  validateRetainedCustomCityDiscovery as validate, CUSTOM_CITY_DISCOVERY_PROFILE_ID as PROFILE,
  CUSTOM_CITY_DISCOVERY_PARCEL_PREDICATE as PREDICATE, CUSTOM_CITY_DISCOVERY_LIMITS as L,
} from '../src/services/neighborhoodAssessment/customCityDiscovery.js';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

const DATA = new URL('../data/neighborhood-city-boundaries/', import.meta.url);
const ORIGINAL = new URL('../../dcad-frontend/public/neighborhood-city-boundaries/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('catalog.json', DATA), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const error = reason => e => e instanceof TypeError && e.code === 'CUSTOM_CITY_DISCOVERY_INVALID' && e.reason === reason;
const installedChoice = city => ({ profile_id: PROFILE, city: { geoid: city.geoid, vintage: catalog.vintage, asset_sha256: city.sha256 } });
const ring = [[-97, 32], [-96, 32], [-96, 33], [-97, 33], [-97, 32]];
const hole = [[-96.8, 32.2], [-96.8, 32.4], [-96.6, 32.4], [-96.6, 32.2], [-96.8, 32.2]];
function fixture(geometry = { type: 'Polygon', coordinates: [ring] }) {
  const city = catalog.cities[0];
  const feature = { type: 'Feature', properties: { GEOID: city.geoid, STATE: '48', PLACE: city.geoid.slice(2),
    NAME: `${city.name} city`, BASENAME: city.name, AREALAND: 1, AREAWATER: 0 }, geometry };
  const { cities: _cities, ...source } = catalog;
  const asset_utf8 = `${JSON.stringify(feature)}\n`, asset_sha256 = hash(asset_utf8);
  return { choice: { profile_id: PROFILE, city: { geoid: city.geoid, vintage: catalog.vintage, asset_sha256 } },
    asset_utf8, asset_sha256, geometry: structuredClone(geometry),
    source: { ...source, city: { ...city, sha256: asset_sha256, bytes: Buffer.byteLength(asset_utf8) } } };
}
function rawOf(value, raw) {
  const result = structuredClone(value); result.asset_utf8 = raw; result.asset_sha256 = hash(raw);
  result.choice.city.asset_sha256 = result.asset_sha256;
  result.source.city.sha256 = result.asset_sha256; result.source.city.bytes = Buffer.byteLength(raw);
  delete result.geometry; return result;
}
function changeFeature(value, mutate) {
  const original = JSON.parse(value.asset_utf8); mutate(original); return rawOf(value, `${JSON.stringify(original)}\n`);
}

test('fixed server catalog preserves original source provenance, rather than granting analysis authority', async () => {
  const frontend = JSON.parse(await readFile(new URL('../../dcad-frontend/src/data/neighborhoodCityBoundaries.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog, frontend); assert.equal(catalog.cities.length, 5);
  assert.equal(PROFILE, 'custom-city-polygon-v1'); assert.equal(PREDICATE, 'postgis_geometry_intersects_city_v1');
  assert.ok(Object.isFrozen(L));
});
for (const city of catalog.cities) test(`installed ${city.name} asset loads exact original bytes and compact replay`, async () => {
  const bytes = await readFile(new URL(`${catalog.vintage}/${city.geoid}.geojson`, DATA));
  const original = await readFile(new URL(`${catalog.vintage}/${city.geoid}.geojson`, ORIGINAL));
  assert.deepEqual(bytes, original); assert.equal(bytes.length, city.bytes); assert.equal(hash(bytes), city.sha256);
  const input = installedChoice(city), before = JSON.stringify(input), result = await load(input);
  assert.equal(result.asset_utf8, bytes.toString('utf8')); assert.equal(result.asset_sha256, city.sha256);
  assert.deepEqual(result.geometry, JSON.parse(bytes.toString('utf8')).geometry);
  const { cities: _cities, ...source } = catalog; assert.deepEqual(result.source, { ...source, city });
  const { geometry: _geometry, ...compact } = result;
  assert.deepEqual(validate(compact), result); assert.deepEqual(validate(result), result);
  assert.ok(Number(prepareNeighborhoodCohortBlob(canonicalAssessmentJson(compact)).canonical_utf8_bytes) < 1_500_000);
  assert.equal(JSON.stringify(input), before); assert.ok(Object.isFrozen(result.geometry.coordinates[0]));
  assert.ok(Object.isFrozen(result.source.city));
  assert.throws(() => { result.source.city.name = 'changed'; }, TypeError);
  assert.equal(Object.hasOwn(result, 'authority'), false); assert.equal(Object.hasOwn(result, 'valid'), false);
  assert.equal(result.source.purpose, catalog.purpose);
});
test('Dallas MultiPolygon retains every original island/ring and is never replaced by a hull', async () => {
  const r = await load(installedChoice(catalog.cities.find(city => city.name === 'Dallas')));
  assert.equal(r.geometry.type, 'MultiPolygon'); assert.ok(r.geometry.coordinates.length > 1);
  let vertices = 0; r.geometry.coordinates.forEach(p => p.forEach(ring => { vertices += ring.length; }));
  assert.equal(vertices, 16086);
});
test('choice and compact retained replay admit a valid historic identity absent from installed catalog', async () => {
  const f = fixture(); f.choice.city.vintage = '2024-02-29'; f.source.vintage = '2024-02-29';
  assert.deepEqual(choiceOf(f.choice), f.choice);
  assert.deepEqual(validate(f).choice, f.choice);
  await assert.rejects(load(f.choice), error('not_installed'));
});
test('retained source URLs are original metadata only, not fetched or compared to current registry', () => {
  const f = fixture(); f.source.sourceUrl = 'https://historical.example.invalid/source';
  f.source.sourceQuery = 'https://historical.example.invalid/query?fields=geometry';
  const result = validate(f); assert.equal(result.source.sourceUrl, f.source.sourceUrl);
});
test('new valid uninstalled city can be retained but cannot be chosen for a new installed acquisition', async () => {
  let f = fixture(); f.choice.city.geoid = '4899999'; f.source.city.geoid = '4899999';
  f = changeFeature(f, feature => { feature.properties.GEOID = '4899999'; feature.properties.PLACE = '99999'; });
  assert.equal(validate(f).choice.city.geoid, '4899999');
  await assert.rejects(load(f.choice), error('not_installed'));
});
for (const [name, mutate, reason] of [
  ['unknown top key', v => { v.url = 'https://example.invalid'; }, 'fields'],
  ['unknown city key', v => { v.city.path = '../private'; }, 'fields'],
  ['radius profile', v => { v.profile_id = 'custom-suburban-radius-v2'; }, 'profile'],
  ['numeric GEOID', v => { v.city.geoid = 4819000; }, 'geoid'],
  ['non-Texas GEOID', v => { v.city.geoid = '0619000'; }, 'geoid'],
  ['path traversal', v => { v.city.geoid = '../4819000'; }, 'geoid'],
  ['invalid calendar day', v => { v.city.vintage = '2026-02-29'; }, 'date'],
  ['zero year', v => { v.city.vintage = '0000-01-01'; }, 'date'],
  ['date suffix', v => { v.city.vintage = '2026-01-01/..'; }, 'date'],
  ['uppercase digest', v => { v.city.asset_sha256 = 'A'.repeat(64); }, 'digest'],
  ['missing digest', v => { delete v.city.asset_sha256; }, 'fields'],
]) test(`closed choice rejects ${name} before installed I/O`, async () => {
  const f = fixture().choice; mutate(f); assert.throws(() => choiceOf(f), error(reason));
  await assert.rejects(load(f), error(reason));
});
test('choice rejects getters, proxies, symbols and non-data properties without invoking them', () => {
  let calls = 0;
  const f = fixture().choice; Object.defineProperty(f, 'city', { enumerable: true, get() { calls++; return {}; } });
  assert.throws(() => choiceOf(f), error('data_property'));
  assert.throws(() => choiceOf(new Proxy({}, { ownKeys() { calls++; return []; } })), error('object'));
  const symbol = fixture().choice; symbol[Symbol('extra')] = true; assert.throws(() => choiceOf(symbol), error('fields'));
  assert.equal(calls, 0);
});
test('holes, ring order, exact winding and disconnected islands survive detached frozen replay', () => {
  const island = ring.map(([x, y]) => [x + 3, y + 3]);
  const f = fixture({ type: 'MultiPolygon', coordinates: [[ring, hole], [island]] }), before = JSON.stringify(f);
  const result = validate(f); assert.deepEqual(result.geometry, f.geometry); assert.equal(JSON.stringify(f), before);
  f.geometry.coordinates[0][0][0][0] = -80;
  assert.equal(result.geometry.coordinates[0][0][0][0], -97);
});
test('structural admission does not certify self-intersection or degenerate native geometry', () => {
  for (const coords of [[[-97, 32], [-96, 33], [-97, 33], [-96, 32], [-97, 32]],
    [[-97, 32], [-97, 32], [-97, 32], [-97, 32]]]) {
    const result = validate(fixture({ type: 'Polygon', coordinates: [coords] }));
    assert.deepEqual(result.geometry.coordinates, [coords]); assert.equal(Object.hasOwn(result, 'is_valid'), false);
  }
});
for (const [name, mutate, reason] of [
  ['wrong Feature type', f => { f.type = 'FeatureCollection'; }, 'feature_type'],
  ['Feature foreign member', f => { f.crs = { name: 'EPSG:3857' }; }, 'fields'],
  ['wrong city identity', f => { f.properties.GEOID = '4819000'; }, 'feature_identity'],
  ['wrong state', f => { f.properties.STATE = '49'; }, 'feature_identity'],
  ['wrong PLACE', f => { f.properties.PLACE = '00000'; }, 'feature_identity'],
  ['wrong name', f => { f.properties.NAME = 'Dallas city'; }, 'feature_identity'],
  ['unknown property', f => { f.properties.owner = 'not allowed'; }, 'fields'],
  ['negative area', f => { f.properties.AREALAND = -1; }, 'feature_area'],
  ['missing geometry', f => { f.geometry = null; }, 'object'],
  ['point geometry', f => { f.geometry = { type: 'Point', coordinates: [-97, 32] }; }, 'geometry_type'],
  ['unclosed ring', f => { f.geometry.coordinates[0].at(-1)[0] = -95; }, 'ring_open'],
  ['short ring', f => { f.geometry.coordinates[0].pop(); f.geometry.coordinates[0].pop(); }, 'ring_length'],
  ['third dimension', f => { f.geometry.coordinates[0][0].push(100); }, 'array_limit'],
  ['out of range', f => { f.geometry.coordinates[0][0][0] = -181; }, 'coordinate'],
  ['empty Polygon', f => { f.geometry.coordinates = []; }, 'empty_polygon'],
  ['empty MultiPolygon', f => { f.geometry = { type: 'MultiPolygon', coordinates: [] }; }, 'empty_geometry'],
]) test(`original Feature rejects ${name} even with matching recomputed raw hashes`, () => {
  assert.throws(() => validate(changeFeature(fixture(), mutate)), error(reason));
});
for (const [name, change] of [
  ['duplicate key', raw => raw.replace('"type":"Feature"', '"type":"Feature","type":"Feature"')],
  ['escaped duplicate key', raw => raw.replace('"type":"Feature"', '"type":"Feature","\\u0074ype":"Feature"')],
  ['nonfinite number', raw => raw.replace('-97,32', '1e999,32')],
  ['lossy decimal', raw => raw.replace('-97,32', '-97.000000000000000000001,32')],
  ['negative zero', raw => raw.replace('-97,32', '-0,32')],
  ['invalid Unicode', raw => raw.replace('Coppell city', 'Coppell\\ud800 city')],
  ['trailing payload', raw => `${raw}{}`],
]) test(`original scanner rejects ${name} without silently normalizing it`, () => {
  const f = fixture(); assert.throws(() => validate(rawOf(f, change(f.asset_utf8))), error('json_invalid'));
});
test('whole Feature bytes—not reserialized geometry—bind asset hash and length', () => {
  const f = fixture(); f.asset_utf8 = f.asset_utf8.replace('\n', ' ');
  assert.throws(() => validate(f), error('asset_hash'));
  const wrong = fixture(); wrong.source.city.bytes++; assert.throws(() => validate(wrong), error('asset_bytes'));
  const mismatched = fixture(); mismatched.asset_sha256 = 'f'.repeat(64); assert.throws(() => validate(mismatched), error('asset_identity'));
});
test('optional supplied geometry must exactly agree with original text', () => {
  const f = fixture(); f.geometry.coordinates[0][1][0] = -95;
  assert.throws(() => validate(f), error('geometry_mismatch'));
  const inverse = fixture(); inverse.geometry.coordinates[0].reverse();
  assert.throws(() => validate(inverse), error('geometry_mismatch'));
});
test('retained source identity and closed provenance cannot be substituted', () => {
  for (const mutate of [f => { f.source.vintage = '2025-01-01'; }, f => { f.source.city.geoid = '4819000'; },
    f => { f.source.city.sha256 = 'f'.repeat(64); }, f => { f.source.schemaVersion = 2; }]) {
    const f = fixture(); mutate(f); assert.throws(() => validate(f), error('source_identity'));
  }
  const f = fixture(); f.source.authorized = true; assert.throws(() => validate(f), error('fields'));
});
test('unsafe source URLs and malformed metadata are rejected but never used for I/O', () => {
  for (const sourceUrl of ['file:///secret', 'https://user:pass@example.invalid/path', 'https://example.invalid/#secret']) {
    const f = fixture(); f.source.sourceUrl = sourceUrl; assert.throws(() => validate(f), error('source_url'));
  }
  const f = fixture(); f.source.retrievedAt = '2026-02-30T00:00:00.000Z';
  assert.throws(() => validate(f), error('retrieval_time'));
});
test('oversized text, depth, coordinates, rings and polygons fail completely at explicit limits', () => {
  const tooLarge = fixture(); tooLarge.asset_utf8 = ' '.repeat(L.asset_utf8_bytes + 1);
  assert.throws(() => validate(tooLarge), error('asset_bytes'));
  let nested = 0; for (let i = 0; i < L.json_depth + 1; i++) nested = [nested];
  assert.throws(() => validate(changeFeature(fixture(), f => { f.properties.extra = nested; })), error('json_depth'));
  const overCoordinates = fixture({ type: 'Polygon', coordinates: [Array.from({ length: L.coordinates + 1 }, () => [-97, 32])] });
  assert.throws(() => validate(overCoordinates), error('array_limit'));
  const tooManyRings = fixture({ type: 'Polygon', coordinates: Array.from({ length: L.rings + 1 }, () => ring) });
  assert.throws(() => validate(tooManyRings), error('array_limit'));
  const tooManyPolygons = fixture({ type: 'MultiPolygon', coordinates: Array.from({ length: L.polygons + 1 }, () => [ring]) });
  assert.throws(() => validate(tooManyPolygons), error('array_limit'));
});
test('supplied geometry cannot invoke getters, accept sparse arrays, or hide extra array properties', () => {
  let calls = 0; const getter = fixture();
  Object.defineProperty(getter.geometry, 'coordinates', { enumerable: true, get() { calls++; return []; } });
  assert.throws(() => validate(getter), error('data_property'));
  const sparse = fixture(); delete sparse.geometry.coordinates[0][1]; assert.throws(() => validate(sparse), error('array_fields'));
  const extra = fixture(); extra.geometry.coordinates.extra = true; assert.throws(() => validate(extra), error('array_fields'));
  const proxy = fixture(); proxy.geometry = new Proxy(proxy.geometry, { ownKeys() { calls++; return []; } });
  assert.throws(() => validate(proxy), error('object')); assert.equal(calls, 0);
});
