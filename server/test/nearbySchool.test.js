import test from 'node:test';
import assert from 'node:assert/strict';
import { createNearbySchoolLookup, NEARBY_SCHOOL_SOURCE, isRetainedNearbySchoolContext } from '../src/services/nearbySchool.js';
import { validateAssignmentDetails } from '../src/util/reportManualValues.js';
const feature = (name, x = -96.8, y = 32.8) => ({ attributes: { USER_School_Name: name }, geometry: { x, y } });
const response = features => new Response(JSON.stringify({ spatialReference: { wkid: 4326 }, features }), {
  headers: { 'content-type': 'application/json' },
});
const pool = { query: async (sql, args) => {
  assert.match(sql, /account_id = \$1.*status = 'matched'.*review_required = false/);
  assert.deepEqual(args, ['synthetic']); return { rows: [{ longitude: -96.8, latitude: 32.8 }] };
} };
test('nearest school uses the fixed official provider, bounded point query and only an indexed local subject', async () => {
  let reads = 0;
  const lookup = createNearbySchoolLookup({ pool, fetchImpl: async (url, options) => {
    reads++; const parsed = new URL(url); assert.equal(parsed.origin + parsed.pathname, `${NEARBY_SCHOOL_SOURCE.url}/query`);
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(parsed.searchParams.get('outFields'), 'USER_School_Name');
    assert.equal(parsed.searchParams.get('resultRecordCount'), '500');
    assert.equal(parsed.searchParams.get('distance'), '6');
    return response([feature('Farther Example School', -96.83), feature('Closest Example School'), feature('Outside Search', -97)]);
  }, now: () => Date.parse('2026-10-06T12:00:00Z') });
  const result = await lookup({ accountId: 'synthetic', url: 'https://not-used.invalid' });
  assert.equal(result.school.name, 'Closest Example School'); assert.equal(result.school.distance_miles, 0);
  assert.deepEqual(result.source, NEARBY_SCHOOL_SOURCE);
  assert.equal(result.interpretation, 'approximate_nearby_amenity_not_attendance_or_travel_time');
  await lookup({ accountId: 'synthetic' }); assert.equal(reads, 1);
});
test('missing, review-required or invalid local coordinates do not geocode or contact any provider', async () => {
  for (const rows of [[], [{ longitude: null, latitude: null }], [{ longitude: -181, latitude: 32 }]]) {
    const lookup = createNearbySchoolLookup({ pool: { query: async () => ({ rows }) }, fetchImpl: () => { throw new Error('must not fetch'); } });
    assert.deepEqual(await lookup({ accountId: 'synthetic' }), { status: 'unavailable', reason: 'subject_location_unavailable' });
  }
});
test('partial, malformed, oversized, wrong-coordinate and failing feeds never produce a school assertion', async () => {
  for (const body of [ { error: { code: 500 } }, { features: [], exceededTransferLimit: true },
    { spatialReference: { wkid: 3857 }, features: [] },
    { spatialReference: { wkid: 4326 }, features: [feature('bad\nname')] },
    { spatialReference: { wkid: 4326 }, features: Array.from({ length: 501 }, () => feature('Example')) },
    { spatialReference: { wkid: 4326 }, features: [feature('Example', NaN)] } ]) {
    const lookup = createNearbySchoolLookup({ pool, fetchImpl: async () => new Response(JSON.stringify(body)) });
    assert.deepEqual(await lookup({ accountId: 'synthetic' }), { status: 'unavailable', reason: 'provider_unavailable' });
  }
  for (const fetchImpl of [async () => { throw new Error('private upstream detail'); },
    async () => new Response('x'.repeat(256 * 1024 + 1))]) {
    const lookup = createNearbySchoolLookup({ pool, fetchImpl });
    assert.equal((await lookup({ accountId: 'synthetic' })).status, 'unavailable');
  }
});
test('expired public cells refresh; no nearby campus is not an invented school or attendance assignment', async () => {
  let now = Date.now(), reads = 0;
  const lookup = createNearbySchoolLookup({ pool, now: () => now, fetchImpl: async () => { reads++; return response([]); } });
  assert.equal((await lookup({ accountId: 'synthetic' })).reason, 'no_nearby_school');
  now += 25 * 3600 * 1000; await lookup({ accountId: 'synthetic' }); assert.equal(reads, 2);
});
test('retained school evidence is bounded and does not establish travel times or accept other provider URLs', () => {
  const value = { status: 'available', account_id: 'synthetic', assignment_file_id: '1', source: NEARBY_SCHOOL_SOURCE,
    captured_at: '2026-10-06T12:00:00Z', school: { name: 'Example School', distance_miles: 1 },
    interpretation: 'approximate_nearby_amenity_not_attendance_or_travel_time' };
  assert.equal(isRetainedNearbySchoolContext(value), true);
  assert.equal(validateAssignmentDetails({ subject_neighborhood_summary_school: value }), true);
  for (const extra of [{ source: { ...value.source, url: 'http://localhost' } }, { school: { name: 'X', distance_miles: 50 } },
    { captured_at: 'bad' }, { assignment_file_id: '0' }, { token: 'unexpected' }]) {
    assert.equal(isRetainedNearbySchoolContext({ ...value, ...extra }), false);
    assert.throws(() => validateAssignmentDetails({ subject_neighborhood_summary_school: { ...value, ...extra } }), /invalid_subject_neighborhood_summary/);
  }
});

test('concurrent optional provider work is bounded and same-cell requests share only public results', async () => {
  const releases = [], fetches = [];
  const lookup = createNearbySchoolLookup({ pool: { query: async (_sql, [id]) => ({ rows: [{ longitude: -96.8, latitude: 32.8 + Number(id) / 10 }] }) },
    fetchImpl: (url) => { fetches.push(url); return new Promise(resolve => releases.push(() => resolve(response([])))); } });
  const first = lookup({ accountId: '0' }), duplicate = lookup({ accountId: '0' }), second = lookup({ accountId: '1' });
  const busy = await lookup({ accountId: '2' });
  assert.deepEqual(busy, { status: 'unavailable', reason: 'provider_busy' }); assert.equal(fetches.length, 2);
  releases.forEach(resolve => resolve()); await Promise.all([first, duplicate, second]);
});
