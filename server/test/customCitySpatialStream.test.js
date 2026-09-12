import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { captureNeighborhoodSpatialMembership as keyset,
  captureNeighborhoodSpatialMembershipStream as stream } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { loadInstalledCustomCityDiscovery } from '../src/services/neighborhoodAssessment/customCityDiscovery.js';

const catalog = JSON.parse(await readFile(new URL('../data/neighborhood-city-boundaries/catalog.json', import.meta.url), 'utf8'));
const entry = catalog.cities[2];
const city = await loadInstalledCustomCityDiscovery({ profile_id: 'custom-city-polygon-v1',
  city: { geoid: entry.geoid, vintage: catalog.vintage, asset_sha256: entry.sha256 } });
const geometry = { geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
  coordinate_encoding: 'decimal_string_v1', coordinates: ['-96.9', '32.65'], source_sha256: 'a'.repeat(64) };
const snapshot = { isolation: 'repeatable read', read_only: 'on', backend_pid: 12,
  snapshot: '100:105:101,102', transaction_started_at: '2026-09-12T16:00:00.123456Z' };
const parcel = (id, account = `000${id}`) => ({ object_id: String(id), account_id: account,
  source_record_hash: 'b'.repeat(64), geometry_sha256: 'c'.repeat(64), sync_run_id: 'synthetic-city',
  synced_at: '2026-09-12T15:00:00.123456Z', source_updated_at: null });
function clientFor(rows, options = {}) {
  let offset = 0, portal = null;
  const calls = [];
  return { calls, async query(call) {
    calls.push(call); const tag = /neighborhood-membership:([^* ]+)/.exec(call.text)?.[1];
    assert.ok(call.query_timeout > 0 && call.query_timeout <= 5000);
    assert.doesNotMatch(call.text, /\b(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b|set_config|cursor-plan-|WITH HOLD/);
    if (options.throwOn === tag) throw new Error('synthetic city query failure');
    if (tag === 'snapshot') return { rows: [options.snapshot ?? snapshot] };
    if (tag === 'snapshot-end') return { rows: [options.end ?? snapshot] };
    if (tag === 'city-geometry-eligibility') return { rows: [{ valid: options.cityValid !== false }] };
    if (tag === 'geometry-eligibility') return { rows: options.invalidCache ? [{}] : [] };
    if (tag === 'parcels-open' || tag === 'parcels') {
      assert.deepEqual(JSON.parse(call.values[0]), city.geometry);
      assert.match(call.text, /geom && ST_SetSRID\(ST_GeomFromGeoJSON\(\$1::text\), 4326\)/);
      assert.match(call.text, /ST_Intersects\(geom,/);
      assert.match(call.text, /octet_length\(payload::text\) <= 2048/);
      assert.doesNotMatch(call.text, /ST_DWithin|ST_Intersection\(|centroid|mailing|"coordinates"/i);
      if (tag === 'parcels') return { rows: rows
        .filter(p => call.values[1] === null || BigInt(p.object_id) > BigInt(call.values[1]))
        .slice(0, call.values[2]).map(payload => ({ payload })) };
      portal = /DECLARE (nh_membership_[a-f0-9]{32}) NO SCROLL CURSOR FOR/.exec(call.text)?.[1];
      assert.ok(portal); assert.doesNotMatch(call.text, /ORDER BY|LIMIT|object_id >|\$[2-9]/);
      assert.equal(call.values.length, 1); return { rows: [] };
    }
    if (tag === 'parcels-fetch') {
      const amount = Number(/FETCH FORWARD (\d+) FROM/.exec(call.text)?.[1]);
      assert.ok(portal && call.text.endsWith(portal)); assert.ok(amount > 0 && amount <= 500);
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      const page = options.oversized ? rows : rows.slice(offset, offset + amount); offset += amount;
      return { rows: page.map(payload => ({ payload })) };
    }
    assert.equal(tag, 'parcels-close'); assert.ok(call.text.endsWith(portal)); portal = null;
    if (options.cleanupFails) throw new Error('synthetic cleanup failure');
    return { rows: [] };
  } };
}
const run = (client, limits = {}) => stream(client, geometry, limits, city.choice, city);
const semantic = ({ counts, ...rest }) => ({ ...rest, counts: { ...counts, queries: 0 } });

test('one city predicate pass preserves every row, original city/subject and keyset membership digests', async () => {
  const rows = [parcel(-7), parcel(1), parcel(2, '0001'), parcel(99), parcel(900)];
  const reference = await keyset(clientFor(rows), geometry, { page_size: 2 }, city.choice, city);
  const client = clientFor([rows[4], rows[1], rows[3], rows[0], rows[2]]), actual = await run(client, { page_size: 2 });
  assert.equal(actual.status, 'captured'); assert.deepEqual(semantic(actual), semantic(reference));
  assert.equal(actual.counts.queries, client.calls.length);
  assert.equal(client.calls.filter(call => call.text.includes(':parcels-open')).length, 1);
  assert.equal(client.calls.filter(call => call.text.includes(':parcels-fetch')).length, 3);
  assert.ok(client.calls.at(-2).text.includes(':parcels-close'));
  assert.equal(Object.hasOwn(actual, 'radius_metres'), false);
  assert.equal(actual.city_scope.asset_utf8, city.asset_utf8);
  assert.equal(actual.authority, 'not_established'); assert.equal(actual.source_coverage, 'not_established');
});

test('empty/exact-full city batches require the final fetch before declaring completeness', async () => {
  for (const rows of [[], [parcel(1), parcel(2)]]) {
    const client = clientFor(rows), result = await run(client, { page_size: 2 });
    assert.equal(result.status, 'captured'); assert.equal(result.parcels.length, rows.length);
    assert.equal(client.calls.filter(call => call.text.includes(':parcels-fetch')).length, rows.length ? 2 : 1);
  }
});

for (const [name, rows, limits, options, reason] of [
  ['duplicate IDs', [parcel(1), parcel(1)], {}, {}, 'parcel_order_invalid'],
  ['malformed ID', [parcel('01')], {}, {}, 'parcel_order_invalid'],
  ['unresolved account', [parcel(1, '')], {}, {}, 'parcel_account_unresolved'],
  ['missing provenance', [{ ...parcel(1), geometry_sha256: null }], {}, {}, 'parcel_provenance_incomplete'],
  ['row bytes', [null], {}, {}, 'row_bytes_limit'],
  ['account ceiling', [parcel(1), parcel(2)], { accounts: 1 }, {}, 'account_limit'],
  ['parcel ceiling', [parcel(1), parcel(2)], { parcels: 1 }, {}, 'parcel_limit'],
  ['byte ceiling', [parcel(1)], { bytes: 1 }, {}, 'byte_limit'],
  ['batch ceiling', [parcel(1), parcel(2)], { page_size: 1 }, { oversized: true }, 'database_page_invalid'],
  ['deadline', [parcel(1)], { duration_ms: 5 }, { delay: 15 }, 'duration_limit'],
  ['changed snapshot', [parcel(1)], {}, { end: { ...snapshot, backend_pid: 13 } }, 'transaction_changed'],
]) test(`city ${name} refuses the entire roster and closes its portal`, async () => {
  const client = clientFor(rows, options), result = await run(client, limits);
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, reason);
  assert.equal(result.query_complete, false); assert.equal(Object.hasOwn(result, 'parcels'), false);
  assert.equal(Object.hasOwn(result, 'membership_sha256'), false);
  assert.ok(client.calls.some(call => call.text.includes(':parcels-close')));
  assert.equal(result.counts.queries, client.calls.length);
});

test('city failure cleanup is bounded and does not mask the original query failure', async () => {
  for (const throwOn of ['parcels-open', 'parcels-fetch']) {
    const client = clientFor([], { throwOn, cleanupFails: true });
    await assert.rejects(run(client), /synthetic city query failure/);
    assert.ok(client.calls.at(-1).text.includes(':parcels-close'));
    assert.ok(client.calls.at(-1).query_timeout <= 1000);
  }
});

test('city/cache/snapshot ineligibility prevents opening the portal', async () => {
  for (const options of [{ cityValid: false }, { invalidCache: true }, { snapshot: { ...snapshot, read_only: 'off' } }]) {
    const client = clientFor([], options); assert.equal((await run(client)).status, 'incomplete');
    assert.ok(!client.calls.some(call => call.text.includes(':parcels-open')));
  }
  const client = clientFor([]);
  await assert.rejects(stream(client, geometry, {}, city.choice, { ...city, asset_sha256: 'd'.repeat(64) }));
  assert.equal(client.calls.length, 0);
});

test('city keeps its original 15s duration and all original data/SQL limits', async () => {
  for (const limits of [{ duration_ms: 15001 }, { page_size: 501 }, { parcels: 100001 },
    { accounts: 50001 }, { bytes: 16777217 }, { query_ms: 5001 }]) {
    const client = clientFor([]); await assert.rejects(run(client, limits), /invalid_spatial_membership_limits/);
    assert.equal(client.calls.length, 0);
  }
});
