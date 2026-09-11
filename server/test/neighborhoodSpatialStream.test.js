import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNeighborhoodSpatialMembership as keyset,
  captureNeighborhoodSpatialMembershipStream as stream } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';

const geometry = { geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
  coordinate_encoding: 'decimal_string_v1', coordinates: ['-96.63', '32.88'], source_sha256: 'a'.repeat(64) };
const snapshot = { isolation: 'repeatable read', read_only: 'on', backend_pid: 12,
  snapshot: '100:105:101,102', transaction_started_at: '2026-09-08T16:00:00.123456Z' };
const parcel = (id, account = `000${id}`) => ({ object_id: String(id), account_id: account,
  source_record_hash: 'b'.repeat(64), geometry_sha256: 'c'.repeat(64), sync_run_id: 'sync-one',
  synced_at: '2026-09-08T15:00:00.123456Z', source_updated_at: null });
function clientFor(rows, options = {}) {
  let offset = 0, portal = null;
  const calls = [];
  return { calls, async query(call) {
    calls.push(call);
    const tag = /neighborhood-membership:([^* ]+)/.exec(call.text)?.[1];
    if (options.throwOn === tag) throw new Error('database failure');
    if (tag === 'snapshot') return { rows: [options.snapshot ?? snapshot] };
    if (tag === 'snapshot-end') return { rows: [options.end ?? snapshot] };
    if (tag === 'geometry-eligibility') return { rows: options.invalidGeometry ? [{}] : [] };
    if (tag === 'parcels-open') {
      portal = /DECLARE (nh_membership_[a-f0-9]{32}) NO SCROLL CURSOR FOR/.exec(call.text)?.[1];
      assert.ok(portal); assert.doesNotMatch(call.text, /WITH HOLD|ORDER BY|LIMIT|object_id >/);
      assert.match(call.text, /ST_DWithin\(geom::geography,/);
      assert.match(call.text, /octet_length\(payload::text\) <= 2048/);
      assert.deepEqual(call.values.slice(0, 2), geometry.coordinates);
      if (call.values.length === 3) { assert.match(call.text, /\$3::double precision, true/); }
      else assert.match(call.text, /4828\.032, true/);
      return { rows: [] };
    }
    if (tag === 'parcels-fetch') {
      const amount = Number(/FETCH FORWARD (\d+) FROM/.exec(call.text)?.[1]);
      assert.ok(portal && call.text.endsWith(portal)); assert.ok(amount > 0 && amount <= 500);
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      const page = options.oversized ? rows : rows.slice(offset, offset + amount); offset += amount;
      return { rows: page.map(payload => ({ payload })) };
    }
    if (tag === 'parcels-close') { assert.ok(call.text.endsWith(portal)); portal = null; return { rows: [] }; }
    assert.equal(tag, 'parcels');
    const selected = rows.filter(p => call.values[2] === null || BigInt(p.object_id) > BigInt(call.values[2]))
      .slice(0, call.values[3]);
    return { rows: selected.map(payload => ({ payload })) };
  } };
}
const semantic = result => { const { counts, ...rest } = result; return { ...rest, counts: { ...counts, queries: 0 } }; };

test('one-pass arbitrary scan order preserves every row, canonical order, counts and membership hashes', async () => {
  const sorted = [parcel(-7), parcel(1), parcel(2, '0001'), parcel(99), parcel(900)];
  for (const discovery of [undefined, { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' }]) {
    const reference = await keyset(clientFor(sorted), geometry, { page_size: 2 }, discovery);
    const client = clientFor([sorted[4], sorted[1], sorted[3], sorted[0], sorted[2]]);
    const actual = await stream(client, geometry, { page_size: 2 }, discovery);
    assert.equal(actual.status, 'captured'); assert.deepEqual(semantic(actual), semantic(reference));
    assert.equal(actual.counts.queries, client.calls.length);
    assert.equal(client.calls.filter(c => c.text.includes(':parcels-open')).length, 1);
    assert.equal(client.calls.filter(c => c.text.includes(':parcels-fetch')).length, 3);
    assert.ok(client.calls.at(-2).text.includes(':parcels-close'));
    assert.equal(actual.authority, 'not_established'); assert.equal(actual.source_coverage, 'not_established');
  }
});
test('empty and exact-full batches are complete only after the final fetch', async () => {
  for (const rows of [[], [parcel(1), parcel(2)]]) {
    const c = clientFor(rows); const r = await stream(c, geometry, { page_size: 2 });
    assert.equal(r.status, 'captured'); assert.equal(r.parcels.length, rows.length);
    assert.equal(c.calls.filter(q => q.text.includes(':parcels-fetch')).length, rows.length ? 2 : 1);
  }
});
test('stream refuses incomplete/invalid inputs and closes without returning a partial roster', async t => {
  for (const [name, rows, limits, opts, reason] of [
    ['duplicates', [parcel(1), parcel(1)], {}, {}, 'parcel_order_invalid'],
    ['malformed id', [parcel('01')], {}, {}, 'parcel_order_invalid'],
    ['missing account', [parcel(1, '')], {}, {}, 'parcel_account_unresolved'],
    ['missing provenance', [{ ...parcel(1), source_record_hash: null }], {}, {}, 'parcel_provenance_incomplete'],
    ['row size', [null], {}, {}, 'row_bytes_limit'],
    ['parcel cap', [parcel(1), parcel(2)], { parcels: 1 }, {}, 'parcel_limit'],
    ['account cap', [parcel(1), parcel(2)], { accounts: 1 }, {}, 'account_limit'],
    ['byte cap', [parcel(1)], { bytes: 1 }, {}, 'byte_limit'],
    ['oversized batch', [parcel(1), parcel(2)], { page_size: 1 }, { oversized: true }, 'database_page_invalid'],
    ['deadline', [parcel(1)], { duration_ms: 5 }, { delay: 15 }, 'duration_limit'],
    ['snapshot change', [parcel(1)], {}, { end: { ...snapshot, backend_pid: 99 } }, 'transaction_changed'],
  ]) await t.test(name, async () => {
    const c = clientFor(rows, opts); const r = await stream(c, geometry, limits);
    assert.equal(r.status, 'incomplete'); assert.equal(r.reason, reason); assert.equal(r.query_complete, false);
    assert.equal(r.parcels, undefined); assert.equal(r.membership_sha256, undefined);
    assert.ok(c.calls.some(q => q.text.includes(':parcels-close')));
    assert.equal(r.counts.queries, c.calls.length);
  });
});
test('database fetch failure propagates after bounded portal cleanup', async () => {
  const c = clientFor([], { throwOn: 'parcels-fetch' });
  await assert.rejects(stream(c, geometry), /database failure/);
  const cleanup = c.calls.at(-1); assert.ok(cleanup.text.includes(':parcels-close')); assert.ok(cleanup.query_timeout <= 1000);
  assert.ok(!c.calls.some(q => /\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(q.text)));
});
test('invalid cache or snapshot refuses acquisition before opening a cursor', async () => {
  for (const options of [{ invalidGeometry: true }, { snapshot: { ...snapshot, read_only: 'off' } }]) {
    const c = clientFor([], options); assert.equal((await stream(c, geometry)).status, 'incomplete');
    assert.ok(!c.calls.some(q => q.text.includes(':parcels-open')));
  }
});
test('stream wall-clock budget is bounded; data, batch and statement ceilings are unchanged', async () => {
  for (const overrides of [{ duration_ms: 30001 }, { page_size: 501 }, { parcels: 100001 },
    { accounts: 50001 }, { bytes: 16777217 }, { query_ms: 5001 }]) {
    const c = clientFor([]); await assert.rejects(stream(c, geometry, overrides), /invalid_spatial_membership_limits/);
    assert.equal(c.calls.length, 0);
  }
  assert.equal((await stream(clientFor([]), geometry, { duration_ms: 30000 })).status, 'captured');
  await assert.rejects(keyset(clientFor([]), geometry, { duration_ms: 15001 }), /invalid_spatial_membership_limits/);
});
