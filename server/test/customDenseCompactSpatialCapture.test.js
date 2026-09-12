import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { captureNeighborhoodSpatialMembershipStream as expandedCapture,
  captureNeighborhoodSpatialMembershipCompact as compactCapture } from '../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { iterateSpatialParcels, SPATIAL_PARCEL_TUPLE_ENCODING, SPATIAL_TUPLE_LIMITS }
  from '../src/services/neighborhoodAssessment/spatialMembershipEncoding.js';

const ACCOUNT_LIMIT = 50_000, LEGACY_BYTES = 16_777_216;
const geometry = Object.freeze({ geometry_version: 1, type: 'Point', crs: 'EPSG:4326', axis_order: 'longitude_latitude',
  coordinate_encoding: 'decimal_string_v1', coordinates: Object.freeze(['-96.63', '32.88']), source_sha256: 'a'.repeat(64) });
const snapshot = Object.freeze({ isolation: 'repeatable read', read_only: 'on', backend_pid: 12,
  snapshot: '100:105:101,102', transaction_started_at: '2026-09-12T16:00:00.123456Z' });
const hash = text => createHash('sha256').update(text).digest('hex');
const accountAt = position => String(position).padStart(17, '0');
function parcelAt(position) {
  return { object_id: String(9007199254740992n + BigInt(position)), account_id: accountAt(position),
    source_record_hash: hash(`synthetic-source:${position}`), sync_run_id: '11111111-1111-4111-8111-111111111111',
    synced_at: '2026-09-12T15:00:00.123456Z', source_updated_at: '2026-09-11T14:13:12.987654Z',
    geometry_sha256: hash(`synthetic-geometry:${position}`) };
}

// This is ONLY a synthetic read-only snapshot cursor. Generate bounded pages in
// reverse scan order without retaining a second 50k-row fixture. No PostgreSQL,
// source imports, geometry validity, authorization or downstream app capacity is
// claimed. The actual installed capture function owns sorting, limits and hashes.
function cursorFixture(total) {
  const calls = []; let offset = 0, portal = null, planner = 'on';
  return { calls, get supplied() { return offset; }, get openPortal() { return portal; }, async query(call) {
    const tag = /neighborhood-membership:([^* ]+)/.exec(call.text)?.[1];
    calls.push(tag);
    assert.ok(call.query_timeout > 0 && call.query_timeout <= 5000);
    assert.doesNotMatch(call.text, /\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|CREATE|DROP)\b/);
    if (tag === 'snapshot' || tag === 'snapshot-end') return { rows: [snapshot] };
    if (tag === 'geometry-eligibility') return { rows: [] };
    if (tag === 'cursor-plan-read') return { rows: [{ enable_indexscan: planner }] };
    if (tag === 'cursor-plan-start') { planner = 'off'; return { rows: [] }; }
    if (tag === 'cursor-plan-restore') {
      assert.deepEqual(call.values, ['on']); planner = 'on';
      return { rows: [{ enable_indexscan: planner }] };
    }
    if (tag === 'parcels-open') {
      assert.equal(planner, 'off');
      portal = /DECLARE (nh_membership_[a-f0-9]{32}) NO SCROLL CURSOR FOR/.exec(call.text)?.[1];
      assert.ok(portal); assert.doesNotMatch(call.text, /WITH HOLD|ORDER BY|LIMIT|object_id >/);
      assert.match(call.text, /ST_DWithin\(geom::geography,/);
      assert.deepEqual(call.values, [...geometry.coordinates]);
      return { rows: [] };
    }
    if (tag === 'parcels-fetch') {
      assert.equal(planner, 'on'); assert.ok(portal && call.text.endsWith(portal));
      const amount = Number(/FETCH FORWARD (\d+) FROM/.exec(call.text)?.[1]);
      assert.equal(amount, 500, 'use the unchanged default bounded page size');
      const count = Math.min(amount, total - offset);
      const rows = Array.from({ length: count }, (_, index) => ({ payload: parcelAt(total - offset - index) }));
      offset += count; return { rows };
    }
    assert.equal(tag, 'parcels-close'); assert.ok(portal && call.text.endsWith(portal));
    portal = null; return { rows: [] };
  } };
}
function wholeRefusal(result, reason, client) {
  assert.equal(result.status, 'incomplete'); assert.equal(result.query_complete, false);
  assert.equal(result.reason, reason); assert.equal(result.authority, 'not_established');
  assert.equal(result.source_coverage, 'not_established');
  for (const field of ['parcels', 'account_ids', 'membership_sha256', 'account_ids_sha256']) assert.ok(!Object.hasOwn(result, field));
  assert.equal(client.openPortal, null);
  assert.equal(client.calls.filter(tag => tag === 'parcels-close').length, 1);
  assert.equal(result.counts.queries, client.calls.length);
}

test('all 50000 distinct accounts exceed legacy metadata bytes but fit complete compact capture with identical full hashes', async t => {
  const bytesPerRow = Buffer.byteLength(json(parcelAt(1)));
  assert.equal(bytesPerRow, 383, 'realistic fixed-width IDs, hashes, UUID and two microsecond timestamps');
  assert.ok(bytesPerRow >= 380);
  const expectedExpandedBytes = bytesPerRow * ACCOUNT_LIMIT;
  assert.ok(expectedExpandedBytes > LEGACY_BYTES);
  const legacyClient = cursorFixture(ACCOUNT_LIMIT);
  const legacy = await expandedCapture(legacyClient, geometry);
  wholeRefusal(legacy, 'byte_limit', legacyClient);
  assert.ok(legacy.counts.bytes > LEGACY_BYTES && legacy.counts.accounts < ACCOUNT_LIMIT);

  const client = cursorFixture(ACCOUNT_LIMIT), before = process.memoryUsage(), started = performance.now();
  // No overrides: neither duration nor any production data ceiling is raised.
  const result = await compactCapture(client, geometry);
  const captureMs = performance.now() - started, after = process.memoryUsage();
  assert.equal(result.status, 'captured', result.reason); assert.equal(result.query_complete, true);
  assert.equal(result.authority, 'not_established'); assert.equal(result.source_coverage, 'not_established');
  assert.equal(result.parcel_encoding, SPATIAL_PARCEL_TUPLE_ENCODING);
  assert.equal(result.parcels.length, ACCOUNT_LIMIT); assert.equal(result.account_ids.length, ACCOUNT_LIMIT);
  assert.equal(result.counts.parcels, ACCOUNT_LIMIT); assert.equal(result.counts.accounts, ACCOUNT_LIMIT);
  assert.equal(result.counts.bytes, expectedExpandedBytes);
  assert.equal(result.counts.bytes, 19_150_000);
  assert.equal(result.counts.encoded_bytes, Buffer.byteLength(JSON.stringify(result.parcels)));
  assert.equal(result.counts.encoded_bytes, 13_700_001);
  assert.ok(result.counts.encoded_bytes <= LEGACY_BYTES);
  assert.ok(result.counts.bytes <= SPATIAL_TUPLE_LIMITS.expanded_bytes);
  assert.equal(client.supplied, ACCOUNT_LIMIT); assert.equal(client.openPortal, null);
  assert.equal(client.calls.filter(tag => tag === 'parcels-open').length, 1);
  assert.equal(client.calls.filter(tag => tag === 'parcels-fetch').length, 101, 'the exact final full page requires an empty terminating fetch');
  assert.deepEqual(client.calls.slice(-2), ['parcels-close', 'snapshot-end']);
  assert.equal(result.counts.queries, client.calls.length);

  const membership = createHash('sha256').update('homenode-cached-spatial-membership-v1\n')
    .update(json({ geometry_input: geometry, radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1' })).update('\n');
  const expectedDecoded = createHash('sha256'), actualDecoded = createHash('sha256');
  const accounts = createHash('sha256').update('{"account_ids":[');
  let position = 0, logicalBytes = 0;
  for (const row of iterateSpatialParcels(result)) {
    position++;
    const expected = json(parcelAt(position)), actual = json(row);
    assert.equal(actual, expected, `complete decoded row ${position}`);
    assert.equal(result.account_ids[position - 1], accountAt(position));
    expectedDecoded.update(expected).update('\n'); actualDecoded.update(actual).update('\n');
    membership.update(expected).update('\n'); logicalBytes += Buffer.byteLength(actual);
    accounts.update(position === 1 ? '' : ',').update(JSON.stringify(accountAt(position)));
    assert.ok(Object.isFrozen(result.parcels[position - 1]));
  }
  assert.equal(position, ACCOUNT_LIMIT); assert.equal(logicalBytes, result.counts.bytes);
  const decodedHash = actualDecoded.digest('hex');
  assert.equal(decodedHash, expectedDecoded.digest('hex'));
  assert.equal(result.membership_sha256, membership.digest('hex'));
  assert.equal(result.account_ids_sha256, accounts.update(']}').digest('hex'));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.parcels) && Object.isFrozen(result.account_ids));
  t.diagnostic(JSON.stringify({ synthetic_capture_only: true, accounts: ACCOUNT_LIMIT,
    expanded_bytes: result.counts.bytes, encoded_bytes: result.counts.encoded_bytes,
    capture_ms: Math.round(captureMs), heap_before: before.heapUsed, heap_after: after.heapUsed,
    rss_before: before.rss, rss_after: after.rss, decoded_sha256: decodedHash,
    membership_sha256: result.membership_sha256, account_ids_sha256: result.account_ids_sha256 }));
});

test('50001 distinct accounts still refuse the whole compact capture under unchanged default limits', async () => {
  const client = cursorFixture(ACCOUNT_LIMIT + 1);
  const result = await compactCapture(client, geometry);
  wholeRefusal(result, 'account_limit', client);
  assert.equal(client.supplied, ACCOUNT_LIMIT + 1);
  assert.equal(result.counts.accounts, ACCOUNT_LIMIT + 1);
  assert.equal(result.counts.parcels, ACCOUNT_LIMIT + 1);
  assert.ok(result.counts.encoded_bytes < LEGACY_BYTES, 'the unchanged account cap, not encoded size, refuses this complete row set');
  assert.equal(client.calls.includes('snapshot-end'), false);
});
