import test from 'node:test';
import assert from 'node:assert/strict';
import { captureNeighborhoodSpatialMembership } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { prepareNeighborhoodDiscoveryGeometryV1 } from '../src/services/neighborhoodAssessment/selectorInputProfile.js';

const geometry = () => ({ geometry_version: 1, type: 'Point', crs: 'EPSG:4326',
  axis_order: 'longitude_latitude', coordinate_encoding: 'decimal_string_v1',
  coordinates: ['-96.63', '32.88'], source_sha256: 'a'.repeat(64) });
const snapshot = () => ({ isolation: 'repeatable read', read_only: 'on', backend_pid: 12,
  snapshot: '100:105:101,102', transaction_started_at: '2026-09-08T16:00:00.123456Z' });
const parcel = (id, account = `000${id}`) => ({ object_id: String(id), account_id: account,
  source_record_hash: 'b'.repeat(64), geometry_sha256: 'c'.repeat(64),
  sync_run_id: '11111111-1111-4111-8111-111111111111', synced_at: '2026-09-08T15:00:00.123456Z', source_updated_at: null });
function clientFor(parcels, options = {}) {
  const calls = [];
  return { calls, async query(call) {
    calls.push(call);
    const tag = /neighborhood-membership:([^* ]+)/.exec(call.text)?.[1];
    if (options.throwOn === tag) throw new Error('database failure');
    if (tag === 'snapshot') return { rows: [options.snapshot ?? snapshot()] };
    if (tag === 'snapshot-end') return { rows: [options.end ?? snapshot()] };
    if (tag === 'geometry-eligibility') return { rows: options.invalidGeometry ? [{ object_id: '99' }] : [] };
    assert.equal(tag, 'parcels');
    assert.match(call.text, /ST_DWithin\(geom::geography,/);
    assert.match(call.text, /4828\.032, true/);
    assert.doesNotMatch(call.text, /centroid|land_use_category|sale_price|residential_area_sqft/i);
    const [lon, lat, cursor, limit] = call.values;
    assert.equal(lon, '-96.63'); assert.equal(lat, '32.88');
    const selected = options.rows ?? parcels.filter(row => cursor === null || BigInt(row.object_id) > BigInt(cursor)).slice(0, limit);
    return { rows: selected.map(payload => ({ payload })) };
  } };
}
test('shares exact canonical geometry validation without issuing authority', () => {
  const raw = geometry(); const result = prepareNeighborhoodDiscoveryGeometryV1(raw);
  assert.equal(result.status, 'prepared'); assert.equal(result.authority, 'not_established');
  raw.coordinates[0] = '12'; assert.equal(result.geometry_input.coordinates[0], '-96.63');
  assert.ok(Object.isFrozen(result.geometry_input.coordinates));
  for (const coordinates of [[-96.63, 32.88], ['-96.630', '32.88'], ['-181', '32.88'], ['-0', '32.88']]) {
    assert.equal(prepareNeighborhoodDiscoveryGeometryV1({ ...geometry(), coordinates }).status, 'invalid');
  }
});
test('keyset pages every parcel and retains duplicate-account object identities', async () => {
  const client = clientFor([parcel(1, '0002'), parcel(2), parcel(3, '0002'), parcel(4)]);
  const result = await captureNeighborhoodSpatialMembership(client, geometry(), { page_size: 2 });
  assert.equal(result.status, 'captured'); assert.equal(result.query_complete, true);
  assert.deepEqual(result.parcels.map(row => row.object_id), ['1', '2', '3', '4']);
  assert.deepEqual(result.account_ids, ['0002', '0004']);
  assert.equal(result.counts.parcels, 4); assert.equal(result.counts.accounts, 2);
  assert.deepEqual(client.calls.filter(call => call.text.includes(':parcels')).map(call => call.values[2]), [null, '2']);
  assert.equal(result.authority, 'not_established'); assert.equal(result.source_coverage, 'not_established');
  assert.ok(Object.isFrozen(result.parcels[0]));
});
test('stable membership hashes ignore snapshot identity but bind geometry and source changes', async () => {
  const one = await captureNeighborhoodSpatialMembership(clientFor([parcel(1)]), geometry());
  const nextSnapshot = { ...snapshot(), transaction_started_at: '2026-09-08T16:00:01.123456Z' };
  const two = await captureNeighborhoodSpatialMembership(clientFor([parcel(1)], { snapshot: nextSnapshot, end: nextSnapshot }), geometry());
  assert.equal(one.membership_sha256, two.membership_sha256);
  for (const delta of [{ geometry_sha256: 'd'.repeat(64) }, { source_record_hash: 'e'.repeat(64) }, { object_id: '2' }]) {
    const changed = await captureNeighborhoodSpatialMembership(clientFor([{ ...parcel(1), ...delta }]), geometry());
    assert.equal(changed.status, 'captured'); assert.notEqual(one.membership_sha256, changed.membership_sha256);
  }
});
test('fails closed without partial membership on each bound or missing identity', async t => {
  for (const [name, options, rows, expected] of [
    ['parcels', { parcels: 1 }, [parcel(1), parcel(2)], 'parcel_limit'],
    ['accounts', { accounts: 1 }, [parcel(1), parcel(2)], 'account_limit'],
    ['bytes', { bytes: 1 }, [parcel(1)], 'byte_limit'],
    ['account', {}, [parcel(1, null)], 'parcel_account_unresolved'],
    ['empty account', {}, [parcel(1, '')], 'parcel_account_unresolved'],
    ['whitespace account', {}, [parcel(1, '   ')], 'parcel_account_unresolved'],
    ['padded account', {}, [parcel(1, ' 0001 ')], 'parcel_account_unresolved'],
    ['tab account', {}, [parcel(1, '000\t1')], 'parcel_account_unresolved'],
    ['newline account', {}, [parcel(1, '000\n1')], 'parcel_account_unresolved'],
    ['nul account', {}, [parcel(1, '000\u00001')], 'parcel_account_unresolved'],
    ['delete account', {}, [parcel(1, '000\u007f1')], 'parcel_account_unresolved'],
    ['hash', {}, [{ ...parcel(1), source_record_hash: null }], 'parcel_provenance_incomplete'],
    ['sync', {}, [{ ...parcel(1), sync_run_id: null }], 'parcel_provenance_incomplete'],
  ]) await t.test(name, async () => {
    const result = await captureNeighborhoodSpatialMembership(clientFor(rows), geometry(), options);
    assert.equal(result.status, 'incomplete'); assert.equal(result.reason, expected);
    assert.equal(result.query_complete, false); assert.equal(result.parcels, undefined); assert.equal(result.membership_sha256, undefined);
  });
});
test('rejects wrong or changed transaction and never owns transaction lifecycle', async () => {
  for (const options of [{ snapshot: { ...snapshot(), isolation: 'read committed' } },
    { snapshot: { ...snapshot(), read_only: 'off' } }, { end: { ...snapshot(), backend_pid: 13 } },
    { end: { ...snapshot(), snapshot: '100:106:' } }]) {
    const client = clientFor([parcel(1)], options);
    const result = await captureNeighborhoodSpatialMembership(client, geometry());
    assert.equal(result.status, 'incomplete');
    assert.ok(client.calls.every(call => !/\b(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/.test(call.text)));
  }
});
test('does not drop bad geometry or oversized/nonadvancing rows', async () => {
  for (const [options, reason] of [[{ invalidGeometry: true }, 'cached_geometry_ineligible'],
    [{ rows: [null] }, 'row_bytes_limit'], [{ rows: [parcel(1), parcel(1)] }, 'parcel_order_invalid']]) {
    const result = await captureNeighborhoodSpatialMembership(clientFor([], options), geometry());
    assert.equal(result.reason, reason); assert.equal(result.query_complete, false);
  }
});
test('validates before querying and propagates DB failures for caller rollback', async () => {
  const client = clientFor([]);
  const result = await captureNeighborhoodSpatialMembership(client, { ...geometry(), coordinates: ['181', '32.88'] });
  assert.equal(result.status, 'invalid'); assert.equal(client.calls.length, 0);
  await assert.rejects(captureNeighborhoodSpatialMembership(client, geometry(), { parcels: 100001 }), /invalid_spatial_membership_limits/);
  assert.equal(client.calls.length, 0);
  await assert.rejects(captureNeighborhoodSpatialMembership(clientFor([], { throwOn: 'parcels' }), geometry()), /database failure/);
});
test('canonical account roster overflow is explicitly incomplete, never a partial result or uncaught throw', async () => {
  const rows = Array.from({ length: 23000 }, (_, index) => parcel(index + 1, `R${String(index + 1).padStart(63, '0')}`));
  const result = await captureNeighborhoodSpatialMembership(clientFor(rows), geometry());
  assert.equal(result.status, 'incomplete'); assert.equal(result.reason, 'account_roster_canonical_byte_limit');
  assert.equal(result.counts.accounts, 23000); assert.equal(result.parcels, undefined);
  assert.equal(result.membership_sha256, undefined); assert.equal(result.query_complete, false);
});
