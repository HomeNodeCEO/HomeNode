import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildCustomCohortPocketRecommendation as build,
  CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY as V1,
  CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY_V2 as V2 } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { deriveCustomCohortRecordedProximity } from '../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { recordedProximityFixture, proximityPolygon } from './fixtures/customCohortRecordedProximityFixture.js';

const argumentsOf = input => ({ context_ref: input.expected.context_ref,
  retained_inputs: input.retained_inputs, selection: input.selection });
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const close = (a, b) => assert.ok(Math.abs(a - b) < .00011, `${a} != ${b}`);

// Pinned before the v2 source edit against complete actual capture/persist/reopen
// fixtures. These are complete output bytes, not merely score comparisons.
for (const [name, fixture, expected] of [
  ['mapping2', decisionEvidenceFixture, '78860738699f476933619fc5b5378bc3fe496ed007e22f5334b29d9e6060b2a2'],
  ['mapping3', saleWitnessMeaningFixture, '19afa6d54f9a425f4420aaf53b3d928f5ebdacc8bbdfdde20663012f2f953661'],
]) test(`${name} omitted proximity retains complete installed v1 output hash`, async () => {
  const { input } = await fixture(), result = build(argumentsOf(input));
  assert.equal(sha(result), expected);
  assert.equal(Object.hasOwn(result, 'recorded_proximity'), false);
  assert.deepEqual(result.policy, V1);
});

test('policy v2 changes only its explicit ID/revision, not weights or thresholds', () => {
  assert.deepEqual(V2, { ...V1, id: 'custom-current-observation-review-v2', revision: 2 });
  assert.deepEqual(V2.weights, { gla: .4, age: .3, housing_type: .2,
    site_size: 1 / 30, proximity: 1 / 30, sale_price: 1 / 30 });
  assert.ok(Object.isFrozen(V2) && Object.isFrozen(V2.weights));
});

for (const value of [null, {}, { supported: true }, { accounts: [], radius_metres: '4828.032' }]) {
  test(`caller cannot enable v2 with an unissued derivation: ${JSON.stringify(value)}`, async () => {
    const { input } = await decisionEvidenceFixture();
    assert.throws(() => build({ ...argumentsOf(input), recorded_proximity: value }));
  });
}

function assertBounds(result) {
  for (const row of [...result.properties, ...result.pockets.map(p => p.result), result.all, result.selected]) {
    const count = row.member_count;
    for (const value of Object.values(row.similarity)) {
      if (count === 0) assert.equal(value, null);
      else assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
    }
    if (count !== 0) assert.ok(row.similarity.lower <= row.similarity.upper);
  }
  for (const row of result.properties) {
    close(row.similarity.lower, Object.entries(row.factors).reduce((sum, [key, f]) => sum + (f.score ?? 0) * V2.weights[key], 0));
    close(row.similarity.known_weight_percent, Object.entries(row.factors).reduce((sum, [key, f]) => sum + (f.score === null ? 0 : V2.weights[key] * 100), 0));
    for (const key of ['housing_type', 'sale_price']) assert.deepEqual(row.factors[key], { score: null, state: 'not_established' });
  }
  for (const group of [result.all, result.selected, ...result.pockets.map(p => p.result)]) {
    for (const coverage of Object.values(group.factor_coverage)) {
      assert.equal(coverage.observed_count + coverage.unknown_count, group.member_count);
      assert.equal(Object.values(coverage.states).reduce((a, b) => a + b, 0), group.member_count);
    }
  }
}

// The fixture performs actual capture/persistence/reopen. This injected native
// oracle tests real derivation/admission and kernel coupling, not PostGIS itself;
// the separate native integration suite owns actual spheroid/geometry results.
async function derived(options = {}, { distance = 1.5, measure, error, reverseRows = false } = {}) {
  const f = await recordedProximityFixture(options); let calls = 0;
  const query = async (sql, values) => {
    calls++;
    assert.match(sql, /custom-cohort-recorded-proximity:distances/);
    assert.deepEqual(values.slice(1), f.retained_inputs.spatial.geometry_input.coordinates);
    if (error) throw error;
    const request = JSON.parse(values[0]);
    const rows = request.map(row => {
      const parcel = f.parcels.find(p => p.object_id === row.object_id);
      assert.ok(parcel);
      const miles = typeof distance === 'function' ? distance(parcel) : distance;
      const count = parcel.geometry.type === 'MultiPolygon' ? parcel.geometry.coordinates.length : 1;
      return { object_id: row.object_id, valid: true, location_count: count,
        minimum_metres: miles * 1609.344, maximum_metres: miles * 1609.344,
        ...measure?.(parcel, row) };
    });
    return { rows: reverseRows ? rows.reverse() : rows };
  };
  const recorded_proximity = await deriveCustomCohortRecordedProximity(query,
    { context_ref: f.context_ref, retained_inputs: f.retained_inputs });
  return { f, recorded_proximity, calls: () => calls,
    build: selection => build({ ...argumentsOf(f.input), ...(selection ? { selection } : {}), recorded_proximity }) };
}
const rowOf = (result, id = 'R-001') => result.properties.find(row => row.account_id === id);

test('issued retained proximity adds only its weighted factor and exposes no private geometry or IDs in its summary', async () => {
  const d = await derived(), before = JSON.stringify(d.f.input), result = d.build(), prior = build(argumentsOf(d.f.input));
  assert.equal(result.recommendation_version, 1); assert.deepEqual(result.policy, V2);
  assert.equal(result.recorded_proximity.basis, 'recorded_subject_centroid_to_retained_parcel_point_on_surface');
  assert.deepEqual(result.recorded_proximity.counts, { accounts: 2, parcels: 2, observed_accounts: 2, unknown_accounts: 0 });
  assert.deepEqual(Object.keys(result.recorded_proximity).sort(), ['authority', 'basis', 'counts', 'proximity_version', 'radius_metres', 'reason', 'status']);
  assert.deepEqual(Object.keys(result.unavailable_factors), ['housing_type', 'sale_price']);
  for (const row of result.properties) {
    const old = rowOf(prior, row.account_id);
    assert.deepEqual(row.factors.proximity, { score: 50, state: 'observed' });
    for (const key of Object.keys(V1.weights).filter(key => key !== 'proximity')) assert.deepEqual(row.factors[key], old.factors[key]);
    close(row.similarity.lower - old.similarity.lower, 50 / 30);
    close(row.similarity.known_weight_percent - old.similarity.known_weight_percent, 100 / 30);
    close(old.similarity.upper - row.similarity.upper, 50 / 30);
  }
  assert.equal(result.authority, 'not_established'); assert.equal(result.apply.status, 'blocked');
  assert.deepEqual(result.selection, d.f.input.selection);
  assert.equal(JSON.stringify(d.f.input), before);
  assert.equal(d.calls(), 1, 'kernel performs no extra query');
  assert.ok(Object.isFrozen(result.recorded_proximity.counts)); assertBounds(result);
});

for (const [radius, expected] of [[undefined, 50], ['4828.032', 50], ['8046.72', 70], ['16093.44', 85]]) {
  test(`proximity scales against exact retained radius ${radius ?? 'legacy 3 miles'}`, async () => {
    const d = await derived({ radius }), result = d.build();
    assert.equal(rowOf(result).factors.proximity.score, expected);
    assert.equal(result.recorded_proximity.radius_metres, radius ?? '4828.032'); assertBounds(result);
  });
}

for (const [distance, expected] of [[0, 100], [3, 0], [10, 0]]) {
  test(`distance ${distance} miles is observed with bounded score ${expected}`, async () => {
    const d = await derived({}, { distance }), result = d.build();
    assert.deepEqual(rowOf(result).factors.proximity, { score: expected, state: 'observed' });
    assert.equal(result.all.factor_coverage.proximity.observed_count, 2); assertBounds(result);
  });
}

test('subject distance is not forced to zero or boosted to a matching score', async () => {
  const d = await derived({}, { distance: 2 }), result = d.build();
  const subject = rowOf(result, result.subject.account_id);
  assert.equal(subject.factors.proximity.score, 33.3);
  assert.equal(subject.factors.proximity.score, rowOf(result).factors.proximity.score);
  assertBounds(result);
});

test('changed selection, explicit empty, and reversed selection order preserve all property scores and review suggestions', async () => {
  const d = await derived(), baseline = d.build();
  const compareScores = result => {
    const strip = rows => rows.map(({ selected, ...row }) => row);
    assert.deepEqual(strip(result.properties), strip(baseline.properties));
    assert.deepEqual(result.recommended_recorded_group_ids, baseline.recommended_recorded_group_ids);
    assert.deepEqual(result.all, baseline.all); assertBounds(result);
  };
  for (const ids of [[], [baseline.pockets[0].id], [...d.f.input.selection.included_recorded_group_ids].reverse()]) {
    const selection = { revision: 91, included_recorded_group_ids: ids }, result = d.build(selection);
    assert.deepEqual(result.selection, selection); compareScores(result);
    assert.ok(result.properties.every(row => row.selected === ids.includes(row.recorded_group_id)));
    if (ids.length === 0) assert.equal(result.selected.member_count, 0);
  }
  assert.equal(d.calls(), 1);
  assert.throws(() => d.build({ revision: 92, included_recorded_group_ids: [`recorded-cad:${'0'.repeat(64)}`] }), /unknown_group_id/);
});

const twoLocations = () => [{ account_id: 'subject', geometry: proximityPolygon() },
  { account_id: 'R-001', geometry: proximityPolygon(-96.64) }, { account_id: 'R-001', geometry: proximityPolygon(-96.62) }];
test('multiple retained parcels preserve the entire account as unknown, never choose the nearest location', async () => {
  const d = await derived({ parcels: twoLocations() }, { distance: p => p.account_id === 'R-001' ? 0 : 1.5 });
  const result = d.build();
  assert.deepEqual(rowOf(result).factors.proximity, { score: null, state: 'candidate_multiple_locations' });
  assert.equal(result.all.member_count, 2);
  assert.deepEqual(result.all.factor_coverage.proximity, { observed_count: 1, unknown_count: 1,
    states: { observed: 1, candidate_multiple_locations: 1 } });
  assert.equal(result.recorded_proximity.counts.parcels, 3); assertBounds(result);
});

test('disconnected components within one MultiPolygon are not one unambiguous location', async () => {
  const d = await derived({ parcels: [{ account_id: 'subject', geometry: proximityPolygon() },
    { account_id: 'R-001', geometry: { type: 'MultiPolygon', coordinates: [proximityPolygon(-96.64).coordinates, proximityPolygon(-96.60).coordinates] } }] });
  const result = d.build();
  assert.deepEqual(rowOf(result).factors.proximity, { score: null, state: 'candidate_multiple_locations' });
  assert.equal(result.recorded_proximity.counts.parcels, 2); assertBounds(result);
});

test('one invalid parcel alongside a valid same-account parcel remains unknown with the complete denominator', async () => {
  let seen = false;
  const d = await derived({ parcels: twoLocations() }, { measure: p => {
    if (p.account_id !== 'R-001' || seen) return {};
    seen = true; return { valid: false, location_count: 0, minimum_metres: null, maximum_metres: null };
  } });
  const result = d.build();
  assert.deepEqual(rowOf(result).factors.proximity, { score: null, state: 'candidate_invalid_geometry' });
  assert.equal(result.all.member_count, 2); assert.equal(result.all.factor_coverage.proximity.unknown_count, 1);
  assert.equal(result.recorded_proximity.counts.unknown_accounts, 1); assertBounds(result);
});

test('native query failure throws a sanitized error rather than issuing a score after an aborted transaction', async () => {
  await assert.rejects(derived({}, { error: new Error('not a public error') }), error => {
    assert.equal(error.reason, 'native_query_failed');
    assert.ok(!error.message.includes('not a public error')); return true;
  });
});

test('actual older retained fixture with unrepresentable EWKB has unknown proximity without any query', async () => {
  const { input } = await decisionEvidenceFixture();
  const recorded_proximity = await deriveCustomCohortRecordedProximity(() => assert.fail('must not query invalid EWKB'),
    { context_ref: input.expected.context_ref, retained_inputs: input.retained_inputs });
  const result = build({ ...argumentsOf(input), recorded_proximity });
  assert.equal(result.recorded_proximity.reason, 'retained_map_unavailable');
  assert.equal(result.recorded_proximity.status, 'unavailable');
  assert.equal(result.all.factor_coverage.proximity.observed_count, 0);
  assert.equal(result.recorded_proximity.counts.unknown_accounts, result.all.member_count);
  const old = build(argumentsOf(input));
  for (const row of result.properties) {
    assert.deepEqual(row.factors.proximity, { state: 'proximity_unavailable', score: null });
    assert.deepEqual(row.similarity, rowOf(old, row.account_id).similarity);
  }
  assertBounds(result);
});

test('cloned result, other context and other retained object cannot lend their distance to the current cohort', async () => {
  const d = await derived(), args = argumentsOf(d.f.input);
  assert.throws(() => build({ ...args, recorded_proximity: structuredClone(d.recorded_proximity) }), /unissued_result/);
  assert.throws(() => build({ ...args, context_ref: { ...args.context_ref, context_sha256: 'a'.repeat(64) }, recorded_proximity: d.recorded_proximity }), /binding_mismatch/);
  assert.throws(() => build({ ...args, retained_inputs: structuredClone(args.retained_inputs), recorded_proximity: d.recorded_proximity }), /binding_mismatch/);
});

test('frozen retained radius or a changed-radius copy cannot reuse old observed distances', async () => {
  const d = await derived({ radius: '8046.72' });
  assert.throws(() => { d.f.retained_inputs.spatial.radius_metres = '16093.44'; }, TypeError);
  const changed = structuredClone(d.f.retained_inputs); changed.spatial.radius_metres = '16093.44';
  assert.throws(() => build({ ...argumentsOf(d.f.input), retained_inputs: changed, recorded_proximity: d.recorded_proximity }), /binding_mismatch/);
  assert.equal(d.build().recorded_proximity.radius_metres, '8046.72');
});

test('native row order does not change full v2 scores, rankings, counts or suggestion order', async () => {
  const normal = await derived(), reversed = await derived({}, { reverseRows: true });
  assert.deepEqual(reversed.build(), normal.build());
});

test('different retained parcel order and identities still associate every distance with its exact account', async () => {
  const parcels = [{ account_id: 'subject', geometry: proximityPolygon() },
    { account_id: 'R-001', geometry: proximityPolygon(-96.64) }];
  const measurement = { distance: p => p.account_id === 'R-001' ? 1.5 : .25 };
  const normal = (await derived({ parcels }, measurement)).build();
  const reversed = (await derived({ parcels: [...parcels].reverse() }, measurement)).build();
  assert.notDeepEqual(reversed.binding.context_ref, normal.binding.context_ref, 'these are two genuinely distinct retained captures');
  for (const key of ['properties', 'pockets', 'all', 'selected', 'recommended_recorded_group_ids', 'recorded_proximity']) {
    assert.deepEqual(reversed[key], normal[key]);
  }
  assert.equal(rowOf(normal).factors.proximity.score, 50);
  assert.equal(rowOf(normal, normal.subject.account_id).factors.proximity.score, 91.7);
  assertBounds(normal); assertBounds(reversed);
});
