import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { deriveCustomCohortRecordedProximity as derive, readCustomCohortRecordedProximity as read,
  CUSTOM_COHORT_RECORDED_PROXIMITY_SQL as SQL, CUSTOM_COHORT_RECORDED_PROXIMITY_LIMITS as LIMITS,
  CUSTOM_COHORT_RECORDED_PROXIMITY_BASIS as BASIS } from '../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { recordedProximityFixture as fixture, proximityPolygon as polygon } from './fixtures/customCohortRecordedProximityFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
const copy = value => structuredClone(value);
const inputOf = f => ({ context_ref: f.context_ref ?? f.input.expected.context_ref, retained_inputs: f.retained_inputs ?? f.input.retained_inputs });
const goodRow = (object_id, metres = 1609.344) => ({ object_id, valid: true, location_count: 1, minimum_metres: metres, maximum_metres: metres });
function oracle(change = rows => rows) {
  const calls = [];
  return { calls, query: async (text, values) => {
    calls.push({ text, values }); return { rows: change(JSON.parse(values[0]).map(row => goodRow(row.object_id))) };
  } };
}
function unavailable(result, reason, accounts = 2) {
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, reason); assert.equal(result.accounts, null);
  assert.equal(result.counts.accounts, accounts); assert.equal(result.counts.observed_accounts, 0); assert.equal(result.counts.unknown_accounts, accounts);
}
function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }

test('genuine original EWKB and exact subject decimal strings alone enter bounded native SQL', async () => {
  const f = await fixture(), input = inputOf(f), before = copy(input), q = oracle();
  const result = await derive(q.query, input);
  assert.equal(result.status, 'available'); assert.equal(result.reason, null); assert.equal(result.basis, BASIS);
  assert.equal(result.authority, 'not_established'); assert.deepEqual(result.binding.context_ref, f.context_ref);
  assert.deepEqual(result.binding.target, f.retained_inputs.subject.target);
  assert.equal(result.binding.subject_point_source_sha256, f.retained_inputs.subject.original_snapshot_row.content_sha256);
  assert.equal(result.binding.spatial_membership_sha256, f.retained_inputs.spatial.membership_sha256);
  assert.deepEqual(result.counts, { accounts: 2, parcels: 2, observed_accounts: 2, unknown_accounts: 0 });
  assert.ok(result.accounts.every(row => row.state === 'observed' && row.distance_miles === 1 && row.parcel_count === 1 && row.location_count === 1));
  assert.equal(q.calls.length, 1); assert.equal(q.calls[0].text, SQL);
  assert.deepEqual(q.calls[0].values.slice(1), ['-96.65', '32.91']);
  assert.deepEqual(JSON.parse(q.calls[0].values[0]), f.parcels.map(row => ({ object_id: row.object_id, geometry_ewkb: row.geometry_ewkb })));
  assert.doesNotMatch(SQL, /\b(?:FROM|JOIN)\s+(?:gis|core|app)\.|\b(?:BEGIN|COMMIT|ROLLBACK|UPDATE|DELETE|INSERT|SET LOCAL)\b/i);
  assert.match(SQL, /CASE WHEN c\.valid THEN c\.geom ELSE NULL END/);
  assert.match(SQL, /ST_PointOnSurface\(part\.geom\)::geography,true/);
  assert.match(SQL, /\$2::double precision,\$3::double precision/);
  assert.deepEqual(input, before); assert.equal(read(result, input), result); frozen(result);
});
for (const radius of [undefined, '4828.032', '8046.72', '16093.44']) test(`retained radius ${String(radius)} is bound without changing native distance or selecting accounts`, async () => {
  const f = await fixture({ radius }), input = inputOf(f), q = oracle(rows => rows.map((row, i) => goodRow(row.object_id, i ? 3218.688 : 0)));
  const result = await derive(q.query, input);
  assert.equal(result.binding.radius_metres, radius ?? '4828.032');
  assert.deepEqual(result.accounts.map(row => row.distance_miles), [0, 2]);
  assert.equal(Object.hasOwn(result, 'selection'), false); assert.equal(Object.hasOwn(result, 'score'), false);
});
test('holes preserve literal EWKB and do not become extra locations', async () => {
  const geometry = polygon(); geometry.coordinates.push(polygon(-96.6498, 32.9102, .0002).coordinates[0]);
  const f = await fixture({ parcels: [{ account_id: 'subject', geometry }, { account_id: 'R-001', geometry: polygon(-96.64) }] });
  const q = oracle(), result = await derive(q.query, inputOf(f));
  assert.equal(result.accounts[0].state, 'observed'); assert.equal(result.accounts[0].location_count, 1);
  assert.equal(JSON.parse(q.calls[0].values[0])[0].geometry_ewkb, f.parcels[0].geometry_ewkb);
});
test('two discovered parcels of one account preserve full native range and stay unknown for scoring', async () => {
  const f = await fixture({ parcels: [{ account_id: 'subject', geometry: polygon() },
    { account_id: 'R-001', geometry: polygon(-96.64) }, { account_id: 'R-001', geometry: polygon(-96.63) }] });
  const q = oracle(rows => rows.map((row, i) => goodRow(row.object_id, i * 1609.344))), result = await derive(q.query, inputOf(f));
  assert.deepEqual(result.accounts[1], { account_id: 'R-001', state: 'multiple_locations', parcel_count: 2,
    location_count: 2, distance_miles: null, distance_range_miles: { low: 1, high: 2 } });
  assert.deepEqual(result.counts, { accounts: 2, parcels: 3, observed_accounts: 1, unknown_accounts: 1 });
});
test('disconnected MultiPolygon is multiple locations even in one retained parcel row', async () => {
  const f = await fixture({ parcels: [{ account_id: 'subject', geometry: polygon() },
    { account_id: 'R-001', geometry: { type: 'MultiPolygon', coordinates: [polygon(-96.64).coordinates, polygon(-96.63).coordinates] } }] });
  const q = oracle(rows => rows.map((row, i) => i ? { ...row, location_count: 2, maximum_metres: 3218.688 } : row));
  const result = await derive(q.query, inputOf(f));
  assert.deepEqual(result.accounts[1], { account_id: 'R-001', state: 'multiple_locations', parcel_count: 1,
    location_count: 2, distance_miles: null, distance_range_miles: { low: 1, high: 2 } });
  unavailable(await derive(oracle().query, inputOf(f)), 'native_result_invalid');
});
test('one invalid parcel invalidates its whole account; never use a convenient valid sibling', async () => {
  const f = await fixture({ parcels: [{ account_id: 'subject', geometry: polygon() },
    { account_id: 'R-001', geometry: polygon(-96.64) }, { account_id: 'R-001', geometry: polygon(-96.63) }] });
  const q = oracle(rows => rows.map((row, i) => i === 2 ? { ...row, valid: false, location_count: 0, minimum_metres: null, maximum_metres: null } : row));
  const result = await derive(q.query, inputOf(f));
  assert.deepEqual(result.accounts[1], { account_id: 'R-001', state: 'invalid_geometry', parcel_count: 2,
    location_count: null, distance_miles: null, distance_range_miles: null });
  assert.equal(result.counts.unknown_accounts, 1);
});
test('old genuine missing geometry is explicit whole unavailable and makes no native query', async () => {
  const f = await decisionEvidenceFixture(); const input = inputOf(f);
  const result = await derive(() => assert.fail('no query on malformed retained EWKB'), input);
  unavailable(result, 'retained_map_unavailable'); assert.equal(read(result, input), result);
});
test('hash mismatch and missing/unsupported original subject point do not query or substitute current GIS', async () => {
  const f = await fixture();
  for (const [change, reason] of [
    [i => { i.spatial.parcels[0].geometry_sha256 = '0'.repeat(64); }, 'retained_map_unavailable'],
    [i => { i.subject.original_snapshot_row = null; }, 'subject_point_unavailable'],
    [i => { i.spatial.geometry_input.coordinates.reverse(); }, 'retained_binding_mismatch'],
    [i => { i.spatial.radius_metres = '8046.72'; }, 'retained_binding_mismatch'],
  ]) {
    const input = { context_ref: f.context_ref, retained_inputs: copy(f.retained_inputs) }; change(input.retained_inputs);
    unavailable(await derive(() => assert.fail('not admitted'), input), reason);
  }
});
for (const [name, change] of [
  ['missing', rows => rows.slice(1)], ['duplicate', rows => [rows[0], rows[0]]],
  ['foreign', rows => rows.map((row, i) => i ? { ...row, object_id: '999' } : row)],
  ['negative', rows => rows.map(row => ({ ...row, minimum_metres: -1 }))],
  ['NaN', rows => rows.map(row => ({ ...row, minimum_metres: NaN }))],
  ['infinity', rows => rows.map(row => ({ ...row, maximum_metres: Infinity }))],
  ['oversize', rows => rows.map(row => ({ ...row, minimum_metres: LIMITS.maximum_distance_metres + 1, maximum_metres: LIMITS.maximum_distance_metres + 1 }))],
  ['numeric string', rows => rows.map(row => ({ ...row, minimum_metres: '1609.344' }))],
  ['single-location range', rows => rows.map(row => ({ ...row, maximum_metres: 3000 }))],
  ['invalid with values', rows => rows.map(row => ({ ...row, valid: false }))],
  ['invented component', rows => rows.map(row => ({ ...row, location_count: 2 }))],
]) test(`native ${name} response never produces a partial usable account map`, async () => {
  const f = await fixture(); unavailable(await derive(oracle(change).query, inputOf(f)), 'native_result_invalid');
});
test('all parcels are batched once, bounded by both row count and exact encoded payload', async () => {
  const f = await fixture({ parcels: Array.from({ length: 130 }, (_, i) => ({ account_id: i === 0 ? 'subject' : 'R-001', geometry: polygon(-96.65 + i * .00001) })) });
  const q = oracle(), result = await derive(q.query, inputOf(f));
  assert.deepEqual(q.calls.map(call => JSON.parse(call.values[0]).length), [64, 64, 2]);
  assert.ok(q.calls.every(call => Buffer.byteLength(call.values[0]) <= LIMITS.batch_utf8_bytes));
  assert.equal(new Set(q.calls.flatMap(call => JSON.parse(call.values[0]).map(row => row.object_id))).size, 130);
  assert.equal(result.accounts[1].parcel_count, 129); assert.equal(result.accounts[1].state, 'multiple_locations');
  assert.equal(result.counts.accounts, 2);
});
function detailedPolygon() {
  const ring = Array.from({ length: 1800 }, (_, i) => [-96.65 + .001 * Math.cos(i / 1800 * Math.PI * 2),
    32.91 + .001 * Math.sin(i / 1800 * Math.PI * 2)]);
  ring.push([...ring[0]]); return { type: 'Polygon', coordinates: [ring] };
}
test('encoded byte cap splits native batches before the 64-parcel cap', async () => {
  const geometry = detailedPolygon(), f = await fixture({ parcels: Array.from({ length: 60 }, (_, i) => ({
    account_id: i === 0 ? 'subject' : 'R-001', geometry })) });
  const q = oracle(), result = await derive(q.query, inputOf(f));
  assert.equal(result.status, 'available'); assert.equal(q.calls.length, 2);
  assert.ok(q.calls.every(call => JSON.parse(call.values[0]).length < 64 && Buffer.byteLength(call.values[0]) <= LIMITS.batch_utf8_bytes));
  assert.equal(q.calls.reduce((sum, call) => sum + JSON.parse(call.values[0]).length, 0), 60);
});
test('actual retained coordinate capacity refusal yields no native query and no partial prefix', async () => {
  const geometry = detailedPolygon(), f = await fixture({ parcels: Array.from({ length: 140 }, (_, i) => ({
    account_id: i === 0 ? 'subject' : 'R-001', geometry })) });
  const result = await derive(() => assert.fail('whole map coordinate cap precedes native work'), inputOf(f));
  unavailable(result, 'capacity_exceeded'); assert.equal(result.counts.parcels, 140); frozen(result);
});
test('bad later batch discards every earlier distance, with no subsequent native query', async () => {
  const f = await fixture({ parcels: Array.from({ length: 130 }, (_, i) => ({ account_id: i === 0 ? 'subject' : 'R-001', geometry: polygon() })) });
  let calls = 0;
  const result = await derive(async (_sql, params) => { calls++;
    return { rows: calls === 1 ? JSON.parse(params[0]).map(row => goodRow(row.object_id)) : [] };
  }, inputOf(f));
  unavailable(result, 'native_result_invalid'); assert.equal(result.counts.parcels, 130); assert.equal(calls, 2);
});
test('native exceptions abort the caller workflow, preserve only fixed busy codes, and leak no raw message/cause', async () => {
  const f = await fixture();
  for (const code of ['55P03', '57014', '40001', '40P01', 'XX000', undefined]) {
    await assert.rejects(derive(async () => { throw Object.assign(new Error('SECRET source at postgres://private'), { code }); }, inputOf(f)), error => {
      assert.equal(error.message.includes('SECRET'), false); assert.equal(Object.hasOwn(error, 'cause'), false);
      if (['55P03', '57014', '40001', '40P01'].includes(code)) assert.equal(error.code, code);
      else assert.equal(error.reason, 'native_query_failed');
      return true;
    });
  }
});
test('pre-abort, deadline, and cancellation after awaited native work refuse result publication', async () => {
  const f = await fixture(), input = inputOf(f), abort = new AbortController(); abort.abort();
  await assert.rejects(derive(() => assert.fail('pre-abort query'), input, { signal: abort.signal }), /cancelled/);
  await assert.rejects(derive(() => assert.fail('expired query'), input, { deadline: performance.now() - 1 }), /deadline_exceeded/);
  const later = new AbortController();
  await assert.rejects(derive(async (sql, values) => { later.abort(); return oracle().query(sql, values); }, input, { signal: later.signal }), /cancelled/);
});
test('cloned/unissued results, foreign context, different retained object and in-place evidence mutation cannot enter scoring', async () => {
  const f = await fixture(), input = { context_ref: f.context_ref, retained_inputs: copy(f.retained_inputs) };
  const result = await derive(oracle().query, input);
  assert.throws(() => read(copy(result), input), /unissued_result/);
  assert.throws(() => read(result, { ...input, context_ref: { ...f.context_ref, context_sha256: 'a'.repeat(64) } }), /binding_mismatch/);
  assert.throws(() => read(result, { ...input, retained_inputs: copy(input.retained_inputs) }), /binding_mismatch/);
  for (const mutate of [i => { i.spatial.radius_metres = '8046.72'; }, i => { i.spatial.parcels.reverse(); i.spatial.parcels[0].geometry_sha256 = '0'.repeat(64); },
    i => { i.spatial.account_ids[0] = 'OTHER'; }, i => { i.subject.original_snapshot_row.content_sha256 = '0'.repeat(64); }]) {
    const fresh = { context_ref: f.context_ref, retained_inputs: copy(f.retained_inputs) }, issued = await derive(oracle().query, fresh);
    mutate(fresh.retained_inputs); assert.throws(() => read(issued, fresh));
  }
});
test('record ordering and selection changes do not change distances or account denominators', async () => {
  const f = await fixture(), a = inputOf(f), b = { context_ref: f.context_ref, retained_inputs: copy(f.retained_inputs) };
  b.retained_inputs.spatial.parcels.reverse(); b.retained_inputs.spatial.account_ids.reverse();
  b.retained_inputs.acquisition.capture_result.source_capture.sources.reverse();
  assert.deepEqual(await derive(oracle().query, a), await derive(oracle().query, b));
  assert.throws(() => read({}, a), /unissued_result/);
});
test('getters and proxies at consumed boundaries are rejected without executing traps', async () => {
  const f = await fixture(); let calls = 0;
  const forbidden = () => { calls++; throw Error('must not execute'); };
  const top = new Proxy({}, { get: forbidden, getPrototypeOf: forbidden, ownKeys: forbidden });
  await assert.rejects(derive(() => assert.fail('query'), top));
  const nested = copy(f.retained_inputs); Object.defineProperty(nested.subject.snapshot.subject_data, 'custom_property_snapshot', { enumerable: true, get: forbidden });
  await assert.rejects(derive(() => assert.fail('query'), { context_ref: f.context_ref, retained_inputs: nested }));
  assert.equal(calls, 0);
});
