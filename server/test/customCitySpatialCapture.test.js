import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { loadInstalledCustomCityDiscovery } from '../src/services/neighborhoodAssessment/customCityDiscovery.js';
import { prepareNeighborhoodDiscoveryChoice, prepareNeighborhoodSelectorInput, prepareNeighborhoodSelectorInputV1 } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { captureNeighborhoodSpatialMembership } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { prepareCustomCohortCaptureInputs } from '../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { customCohortDiscoveryExpansionFixture } from './fixtures/customCohortDiscoveryExpansionFixture.js';

const catalog = JSON.parse(await readFile(new URL('../data/neighborhood-city-boundaries/catalog.json', import.meta.url), 'utf8'));
const choiceFor = entry => ({ profile_id: 'custom-city-polygon-v1', city: { geoid: entry.geoid, vintage: catalog.vintage, asset_sha256: entry.sha256 } });
const city = await loadInstalledCustomCityDiscovery(choiceFor(catalog.cities[2]));
const geometry = () => ({ geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
  coordinate_encoding: 'decimal_string_v1', coordinates: ['-96.9', '32.65'], source_sha256: 'a'.repeat(64) });
const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const snapshot = { isolation: 'repeatable read', read_only: 'on', backend_pid: 12,
  snapshot: '100:105:101,102', transaction_started_at: '2026-09-10T16:00:00.123456Z' };
const parcel = n => ({ object_id: String(n), account_id: `000${n}`, source_record_hash: 'b'.repeat(64),
  geometry_sha256: 'c'.repeat(64), sync_run_id: id(6), synced_at: '2026-09-10T15:00:00.123456Z', source_updated_at: null });
function clientFor(rows = [parcel(1), parcel(2)], options = {}) {
  const calls = [];
  return { calls, async query(call) {
    calls.push(call); const tag = /neighborhood-membership:([^* ]+)/.exec(call.text)?.[1];
    if (tag === options.throwOn) throw Object.assign(new Error('synthetic database failure'), { code: '57014' });
    if (tag === 'snapshot') return { rows: [options.snapshot ?? snapshot] };
    if (tag === 'snapshot-end') return { rows: [options.end ?? snapshot] };
    if (tag === 'city-geometry-eligibility') return { rows: [{ valid: options.cityValid !== false }] };
    if (tag === 'geometry-eligibility') return { rows: options.invalidCache ? [{ object_id: '99' }] : [] };
    assert.equal(tag, 'parcels');
    assert.deepEqual(JSON.parse(call.values[0]), city.geometry);
    assert.match(call.text, /geom && ST_SetSRID\(ST_GeomFromGeoJSON\(\$1::text\), 4326\)/);
    assert.match(call.text, /ST_Intersects\(geom,/); assert.doesNotMatch(call.text, /ST_DWithin|centroid|ST_Intersection|mailing|city\s*=/i);
    return { rows: rows.filter(row => call.values[1] === null || BigInt(row.object_id) > BigInt(call.values[1]))
      .slice(0, call.values[2]).map(payload => ({ payload })) };
  } };
}
function selectorInput() {
  return { profile_id: city.choice.profile_id,
    target: { report_file_id: id(1), workflow_type: 'custom_appraisal', workflow_target_id: '2' },
    scope: { organization_id: id(3), appraisal_case_id: id(4), subject_snapshot_id: id(5), account_id: '0002' },
    effective_date: '2026-09-10', selection: { id: 'city-selection', revision: 1, source_sha256: 'a'.repeat(64) },
    geometry_input: geometry(), discovery: { city: { ...city.choice.city }, parcel_predicate: 'postgis_geometry_intersects_city_v1' },
    roster: { complete: true, account_count: 2, account_ids: ['0001', '0002'] } };
}
test('city selector retains original subject point and binds exact asset with distinct query version', () => {
  assert.deepEqual(prepareNeighborhoodDiscoveryChoice(city.choice), city.choice);
  const input = selectorInput(), result = prepareNeighborhoodSelectorInput(input);
  assert.equal(result.status, 'prepared'); assert.equal(result.query_input.definition.query_input_version, 3);
  assert.deepEqual(result.query_input.definition.geometry_input, geometry());
  assert.deepEqual(result.query_input.definition.discovery, input.discovery);
  assert.equal(result.authority, 'not_established'); assert.equal(result.spatial_membership, 'unverified');
  assert.equal(prepareNeighborhoodSelectorInputV1(input).status, 'unsupported');
  for (const mutate of [v => { v.discovery.city.asset_sha256 = 'e'.repeat(64); }, v => { v.discovery.city.vintage = '2025-01-01'; },
    v => { v.geometry_input.coordinates[0] = '-96.91'; }]) {
    const changed = structuredClone(input); mutate(changed);
    assert.notEqual(prepareNeighborhoodSelectorInput(changed).selection_binding_sha256, result.selection_binding_sha256);
  }
});
test('city selector does not repair missing subject, bounds, geometry or changed predicate', () => {
  for (const mutate of [v => { v.roster.account_ids = ['0001']; v.roster.account_count = 1; },
    v => { v.discovery.radius_metres = '16093.44'; }, v => { v.discovery.parcel_predicate = 'bbox_only'; },
    v => { v.geometry_input.type = 'Polygon'; }, v => { v.discovery.city.url = 'https://example.com'; }]) {
    const input = selectorInput(); mutate(input); assert.notEqual(prepareNeighborhoodSelectorInput(input).status, 'prepared');
  }
});
test('city membership uses bounded keyset pages and exact predicate with no radius or clipped geometry', async () => {
  const client = clientFor(), out = await captureNeighborhoodSpatialMembership(client, geometry(), { page_size: 1 }, city.choice, city);
  assert.equal(out.status, 'captured'); assert.deepEqual(out.account_ids, ['0001', '0002']);
  assert.equal(Object.hasOwn(out, 'radius_metres'), false); assert.equal(Object.hasOwn(out.city_scope, 'geometry'), false);
  assert.equal(out.city_scope.asset_utf8, city.asset_utf8); assert.deepEqual(out.geometry_input, geometry());
  const expected = createHash('sha256').update('homenode-cached-spatial-membership-city-v1\n')
    .update(json({ geometry_input: geometry(), discovery: city.choice, parcel_predicate: 'postgis_geometry_intersects_city_v1' })).update('\n')
    .update(json(parcel(1))).update('\n').update(json(parcel(2))).update('\n').digest('hex');
  assert.equal(out.membership_sha256, expected);
  assert.deepEqual(client.calls.filter(call => call.text.includes(':parcels')).map(call => call.values[1]), [null, '1']);
  assert.ok(client.calls.every(call => !/\b(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/.test(call.text)));
});
test('city native validity, source geometry, capacity and changed snapshot failures return no partial roster', async () => {
  for (const [limits, options, reason] of [[{}, { cityValid: false }, 'city_geometry_ineligible'],
    [{}, { invalidCache: true }, 'cached_geometry_ineligible'], [{ accounts: 1 }, {}, 'account_limit'],
    [{ parcels: 1 }, {}, 'parcel_limit'], [{ bytes: 1 }, {}, 'byte_limit'],
    [{}, { end: { ...snapshot, backend_pid: 13 } }, 'transaction_changed']]) {
    const out = await captureNeighborhoodSpatialMembership(clientFor(undefined, options), geometry(), limits, city.choice, city);
    assert.equal(out.status, 'incomplete'); assert.equal(out.reason, reason);
    assert.equal(Object.hasOwn(out, 'parcels'), false); assert.equal(Object.hasOwn(out, 'membership_sha256'), false);
  }
  const client = clientFor();
  await assert.rejects(captureNeighborhoodSpatialMembership(client, geometry(), {}, city.choice, { ...city, asset_sha256: 'a'.repeat(64) }));
  assert.equal(client.calls.length, 0);
  await assert.rejects(captureNeighborhoodSpatialMembership(clientFor(undefined, { throwOn: 'parcels' }), geometry(), {}, city.choice, city), { code: '57014' });
});
for (const privateSales of [false, true]) test(`new city acquisition fully retains/reopens original Feature and source closure, private=${privateSales}`, async () => {
  const f = await customCohortDiscoveryExpansionFixture({ city, privateSales });
  assert.deepEqual(f.reopened.retained_inputs, f.input); assert.deepEqual(f.reopened.summary.discovery, city.choice);
  assert.equal(Object.hasOwn(f.reopened.summary, 'radius_metres'), false); assert.equal(f.reopened.summary.account_count, 4);
  assert.equal(f.reopened.retained_inputs.spatial.city_scope.asset_utf8, city.asset_utf8);
  assert.deepEqual(f.reopened.retained_inputs.subject, f.previous.subject);
  assert.deepEqual(f.input.acquisition.captured_query_request.transaction_closure.closure_account_ids,
    f.previous.acquisition.captured_query_request.transaction_closure.closure_account_ids);
  for (const mutate of [v => { v.study.discovery.city.asset_sha256 = 'a'.repeat(64); },
    v => { v.spatial.city_scope.asset_utf8 += ' '; }, v => { v.spatial.radius_metres = '4828.032'; },
    v => { v.selector.query_input.definition.discovery.parcel_predicate = 'bbox_only'; },
    v => { v.acquisition_intent.body.study.discovery.city.vintage = '2025-01-01'; }]) {
    const input = structuredClone(f.input); mutate(input); assert.throws(() => prepareCustomCohortCaptureInputs(input));
  }
});
