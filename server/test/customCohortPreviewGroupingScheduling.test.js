import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildCustomCohortObservationPreview as legacy, buildCustomCohortIndexedObservationPreview as indexed,
  buildCustomCohortIndexedObservationPreviewBatched as batched, customCohortIndexedObservationPreviewBatches as batches,
  customCohortObservationMembers as members } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { encodeSpatialParcel, SPATIAL_PARCEL_TUPLE_ENCODING } from '../src/services/neighborhoodAssessment/spatialMembershipEncoding.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { recommendationFixture } from './fixtures/customCohortDenseRecommendationFixture.js';

const fingerprint = value => {
  const text = JSON.stringify(value);
  return [Buffer.byteLength(text), createHash('sha256').update(text).digest('hex')];
};
function frozen(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); assert.ok(Object.isFrozen(value)); Object.values(value).forEach(item => frozen(item, seen));
  }
}
function seal(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); Object.values(value).forEach(item => seal(item, seen)); Object.freeze(value);
  }
  return value;
}
function drain(stages) {
  let yields = 0;
  for (;;) {
    const step = stages.next();
    if (step.done) return { result: step.value, yields };
    assert.equal(step.value, undefined, 'A grouping checkpoint exposes neither a Map nor a partial preview');
    yields++;
  }
}
// Test-only scheduler for the internal bridge. Production public/report owners
// retain their existing seal, paired checks, finally/return and final rights.
async function consume(stages, { check = () => {}, onYield = () => {} } = {}) {
  let yields = 0;
  try {
    for (;;) {
      check(); const step = stages.next(); check();
      if (step.done) return step.value;
      assert.equal(step.value, undefined); onYield(++yields);
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally { stages.return(); }
}
const captureOf = args => args.retained_inputs.acquisition.capture_result.source_capture;
function visitCount(args) {
  const weights = { selection: 1, parcels: 1, accounts: 1, sale_links: 1, transactions: 2, gis_sync: 0 };
  return captureOf(args).sources.reduce((n, source) => n
    + weights[source.payload.projection.definition.role] * source.payload.records.length, 0)
    + args.retained_inputs.spatial.parcels.length;
}
// Existing source, stock/canonical/source-member, index-table and population
// checkpoints, independent of the added grouping counter. Table rows include
// omitted canonical transactions; null grouping keys do not create table rows.
const originalYields = output => Math.floor(output.work.source_records / 125)
  + 2 * Object.values(output.member_tables).reduce((n, rows) => n + Math.ceil(rows.length / 125), 0)
  + 2 + output.pockets.length;
function compact(args) {
  // Faithful consumer representation comparison only. Existing compact-original
  // persistence/reopen tests prove owner admission separately; this does not
  // rewrite a stored capture or relabel its source mapping/profile.
  const spatial = args.retained_inputs.spatial, parcels = spatial.parcels.map(encodeSpatialParcel);
  return { ...args, retained_inputs: { ...args.retained_inputs,
    spatial: { ...spatial, parcel_encoding: SPATIAL_PARCEL_TUPLE_ENCODING, parcels,
      counts: { ...spatial.counts, encoded_bytes: Buffer.byteLength(JSON.stringify(parcels)) } } } };
}
const fixtures = new Map();
function originalFixture(version, parcelCount = 2) {
  const key = `${version}-${parcelCount}`;
  if (!fixtures.has(key)) fixtures.set(key, version === 2
    ? decisionEvidenceFixture({ effectiveDate: '2026-09-06', parcelCount })
    : cadEvidenceFixture({ mappingVersion: version, effectiveDate: '2026-09-06', parcelCount,
      ...(version === 5 ? { rawPayload: { MlsStatus: 'Closed', CloseDate: '2024-03-01', ClosePrice: '300000.000000000001',
        ClosePriceCurrency: 'USD', LivingArea: '180.5', LivingAreaUnits: 'Square Meters' } } : {}) }));
  return fixtures.get(key);
}
function argsOf(f, shape = 'empty') {
  const pockets = shape === 'empty' ? [] : [{ id: 'picked', label: 'Picked', account_ids: ['R-001'] },
    ...(shape === 'overlap' ? [{ id: 'all', label: 'All', account_ids: [...f.input.retained_inputs.spatial.account_ids] }] : [])];
  return { context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs, selection: { revision: 9, pockets } };
}

// Original full JSON hashes/key order, exact bytes and checkpoint counts captured
// from fd65f630. Only indexed member-work accounting is normalized back to that
// original counter for the old golden hash; every other byte must still match.
// The new counter is asserted separately, never normalized in production.
const GOLDENS = {
  '2-empty': ['f35f3573c8824deb574b1ace6c361600521290de79bdf891f81062ba70df6116', '16c59190896370ec4130fab66ce3a44eedf6bee84e67558b6772fa9db29b6871'],
  '2-subset': ['9842069ca4e6e4b61f60b73e4283ee91946d00c07f1b40385b855fb53e02e909', 'c8f8917cb95b6ee0b221205c66bf934c4cf972ff2aa09f33c284f70b94a64b92'],
  '2-overlap': ['084263b4c32c19f1d5bd788be509e24d3595fa444e5acd391794e606ab50e32e', 'bbe99da9f2d04cdd7c1fbed3673c4be8dcc21125d51d32764f0d6c47efc1df28'],
  '4-empty': ['4aa29967252fd199d85086633f2c249d7712fa1b46992025a497df14fdc8bc3d', 'ae58ac031d03bf9365cbef93e336003f15561f7eba0f1f9e63f8f3b74d35526a'],
  '4-subset': ['e8b16347ea97ee26c79bd0083bf03c4eb686433596322aa38061e8dee728e7d3', 'e2892d51b9914ea375e51f4a721238bc596efd35d39bbf39eff93d1b8c937ce3'],
  '4-overlap': ['5192f5f73df10d3858e98b17cdff9020cd8fb3a832c585d0737376713ea275c7', 'f1b06b91e12d771ae24c139dc01cd6cd1f4add1c039edd2f94f03bec0ae7a402'],
  '5-empty': ['c373e2c7210d2b53063b7db4f8a3143b6780e8b1ea2a788f3722121b566021dd', '0d2eb17b1aa707a1ebe04f681e89d208a716a962ffe205255326ad97ce5854ba'],
  '5-subset': ['3ec7094a09a2d1881d009f49ac9c5e76f31c324e9391f8a8e0b831a61998ee5e', '59fcf8d7eacfc045e48f6f672531fc946346e8cb0cf4bcf8773608103303c5da'],
  '5-overlap': ['2d30dcea4a48fa2900f7cf1789391fb202f843a389e5a9057f5840dd60dfa23c', '5fbaf4aa139fa14b5dca7bbc252ca17c3ab850732069c1d354ce828b67344ace'],
};
const SHAPES = {
  empty: { bytes: [33187, 33356], bounds: [39686, 39749], measurement: 38, member: [20, 32], yields: 8 },
  subset: { bytes: [46190, 44006], bounds: [52641, 50349], measurement: 46, member: [28, 40], yields: 9 },
  overlap: { bytes: [67252, 54546], bounds: [73658, 60839], measurement: 80, member: [60, 52], yields: 10 },
};
for (const version of [2, 4, 5]) for (const shape of ['empty', 'subset', 'overlap']) {
  test(`mapping${version} ${shape}: original full legacy/indexed bytes and work survive both spatial encodings`, async () => {
    const f = await originalFixture(version), expanded = argsOf(f, shape), expected = [legacy(expanded), indexed(expanded)];
    const spec = SHAPES[shape];
    for (const input of [expanded, compact(expanded)]) {
      seal(input); const before = fingerprint(input);
      for (const [index, build] of [legacy, indexed].entries()) {
        const output = build(input);
        assert.deepEqual(fingerprint({ ...output, work: { ...output.work, member_work: spec.member[0] } }),
          [spec.bytes[index], GOLDENS[`${version}-${shape}`][index]]);
        assert.deepEqual(output, expected[index]); frozen(output);
        assert.deepEqual(output.work, { source_records: 10, measurement_values: spec.measurement,
          member_work: spec.member[index], output_utf8_bytes_bound: spec.bounds[index] });
      }
      const completed = drain(batches(input));
      assert.equal(completed.yields, spec.yields + Math.floor(visitCount(input) / 125));
      assert.deepEqual(completed.result, expected[1]); assert.deepEqual(await batched(input), expected[1]);
      assert.deepEqual(fingerprint(input), before);
      assert.deepEqual(members(completed.result, completed.result.all, 'transactions')[0].associated_account_ids,
        ['0000123456789', 'R-LINKED-ONLY']);
    }
  });
}

const BOUNDARIES = {
  0: [2, 27520, '09454fc078ba9562ebf41c7b9ff4248cd9e3f06f70942c6419beb7b5f881c095', 33913],
  31: [4, 65989, 'aff9a9014985be2c902e22111f945d56c5541fae917f76705125849a763c9f3b', 72378],
  32: [4, 67180, '5a72d58371ad26562cd9784a4061301ff8527a436465f211879e0fdd2607241e', 73569],
  124: [6, 181626, '9317e96b87244e5916ae265767fe24301d7c2ac8290c1cb58e71042efdf223cc', 188013],
  125: [7, 182832, '735980872226c51b0df8e1274254842375f271fbfa2448d97427fa0dbbdb0754', 189218],
  126: [9, 184112, 'f172b6ce35d708397355744ca458275565e7a05f558ea6aca89de70cba6819f2', 190498],
  250: [12, 338333, '2317b4e74e4fa876f97387b6d1a8f5c8edfd089e2426df0bb79eb79bdcaa9542', 344718],
  251: [14, 339616, 'b4583fd103bff17b48cd0ac8a35ea2315f0d513dd499fcd9c90a902bc4d7ebcc', 346001],
};
function stockFixture(count) {
  const accounts = Array.from({ length: count }, (_, i) => `GROUP-${String(i).padStart(4, '0')}`);
  const f = recommendationFixture({ accounts, subject: accounts[0] ?? 'SUBJECT-OUTSIDE', mapping4: true });
  return { context_ref: f.context_ref, retained_inputs: f.retained_inputs, selection: { revision: 1, pockets: [] } };
}
for (const [rawCount, [oldYields, bytes, hash, bound]] of Object.entries(BOUNDARIES)) {
  const count = Number(rawCount);
  test(`${count} accounts preserve old full output and add only the independently counted grouping visits`, () => {
    const input = seal(stockFixture(count)), completed = drain(batches(input));
    assert.equal(visitCount(input), 4 * count);
    assert.equal(completed.yields, oldYields + Math.floor(4 * count / 125));
    assert.equal(originalYields(completed.result), oldYields);
    assert.deepEqual(fingerprint({ ...completed.result, work: { ...completed.result.work, member_work: 4 * count } }), [bytes, hash]);
    assert.deepEqual(completed.result.work, { source_records: 3 * count, measurement_values: 8 * count,
      member_work: 5 * count, output_utf8_bytes_bound: bound });
    assert.deepEqual(completed.result, indexed(input));
  });
}

test('124 + 124 short grouping passes cannot reset or evade the invocation-wide visit counter', () => {
  const input = seal(stockFixture(124)), completed = drain(batches(input));
  assert.equal(completed.yields - originalYields(completed.result), 3);
  assert.equal(completed.result.all.stock.member_count, 124);
  const again = drain(batches(input)); assert.equal(again.yields, completed.yields);
  assert.deepEqual(again.result, completed.result, 'A later invocation starts its counter at zero');
});

for (const compacted of [false, true]) test(`${compacted ? 'compact' : 'expanded'} spatial grouping can be cancelled at every checkpoint without partial issuance`, async () => {
  const f = await originalFixture(4, 61), expanded = argsOf(f), input = seal(compacted ? compact(expanded) : expanded);
  const before = fingerprint(input), expected = indexed(input), completed = drain(batches(input));
  assert.equal(visitCount(input), 129);
  assert.equal(completed.yields, originalYields(expected) + 1);
  // The first 3 maps consume 65 visits. Visit 125 is spatial row60, before
  // the former first stock-member yield; no individual pass reaches125.
  const pendingInput = structuredClone(input); Object.freeze(pendingInput);
  const controller = new AbortController(), cancelled = new Error('new-spatial-checkpoint');
  let checks = 0, serviced = false;
  await assert.rejects(batched(pendingInput, { check() {
    checks++; controller.signal.throwIfAborted();
    if (checks === 4) setImmediate(() => { serviced = true; controller.abort(cancelled); });
  } }), error => error === cancelled);
  assert.equal(serviced, true); assert.equal(checks, 5);
  frozen(pendingInput);
  for (let stop = 1; stop <= completed.yields; stop++) {
    const stages = batches(input), signal = new AbortController(), failure = new Error(`stop-${stop}`);
    let last = 0;
    await assert.rejects(consume(stages, { check: () => signal.signal.throwIfAborted(), onYield(n) {
      last = n; if (n === stop) setImmediate(() => signal.abort(failure));
    } }), error => error === failure);
    assert.equal(last, stop); assert.deepEqual(stages.next(), { done: true, value: undefined });
  }
  assert.deepEqual(fingerprint(input), before); assert.deepEqual(await batched(input), expected);
  assert.equal(expected.all.stock.parcel_object_count, 61);
});

test('null canonical/source keys still consume visits while source-only and canonical-only populations remain distinct', async () => {
  const sales = Array.from({ length: 124 }, (_, i) => ({ source_record_id: String(i + 1), sale_id: null,
    primary_account_id: 'A', record_type: 'listing', source_current_price: '123456', source_year_built: 2000 }));
  sales.push(...Array.from({ length: 124 }, (_, i) => ({ source_record_id: null, sale_id: String(1000 + i),
    sale_account_id: 'A', sale_closing_date: '2024-03-01', sale_price: '234567' })));
  const f = recommendationFixture({ accounts: ['A'], sales });
  const input = seal({ context_ref: f.context_ref, retained_inputs: f.retained_inputs, selection: { revision: 1, pockets: [] } });
  const completed = drain(batches(input));
  assert.equal(visitCount(input), 500);
  assert.equal(completed.yields - originalYields(completed.result), 4, 'Both transaction grouping passes count their null keys');
  assert.equal(completed.result.member_tables.transactions.length, 124);
  assert.equal(completed.result.member_tables.source_reported.length, 124);
  assert.equal(completed.result.all.source_reported.without_canonical_transaction_count, 124);
  assert.deepEqual(completed.result, indexed(input)); assert.deepEqual(await batched(input), completed.result);
});

test('legacy null/undefined spatial accounts consume visits without adding parcels to a population', async () => {
  const f = await originalFixture(2), input = structuredClone(argsOf(f));
  const original = input.retained_inputs.spatial.parcels[0];
  input.retained_inputs.spatial.parcels.push(...Array.from({ length: 250 }, (_, i) => ({ ...original,
    object_id: String(10000 + i), account_id: i % 2 ? null : undefined })));
  // Explicit downstream defense fixture; changed spatial rows are not a new
  // admitted original capture and cannot be published by these pure builders.
  seal(input); const completed = drain(batches(input));
  assert.equal(completed.yields - originalYields(completed.result), Math.floor(visitCount(input) / 125));
  assert.equal(completed.result.all.stock.parcel_object_count, 2);
  assert.deepEqual(completed.result, indexed(input)); assert.deepEqual(await batched(input), completed.result);
});

for (const index of [0, 1, 2, 3, 4, 5, 6]) test(`late compact tuple field${index} is still validated after a grouping checkpoint`, async () => {
  const f = await originalFixture(4, 61), input = structuredClone(compact(argsOf(f)));
  input.retained_inputs.spatial.parcels.at(-1)[index] = { invalid_scalar: true }; seal(input);
  const stages = batches(input);
  assert.deepEqual(stages.next(), { done: false, value: undefined }, 'Row60 checkpoint precedes decoding malformed row61');
  assert.throws(() => stages.next(), { name: 'TypeError', message: 'invalid_spatial_membership_encoding:scalar' });
  assert.deepEqual(stages.next(), { done: true, value: undefined });
  for (const build of [legacy, indexed]) assert.throws(() => build(input),
    { name: 'TypeError', message: 'invalid_spatial_membership_encoding:scalar' });
  await assert.rejects(batched(input), { name: 'TypeError', message: 'invalid_spatial_membership_encoding:scalar' });
});

test('whole spatial-array descriptor preflight still precedes any tuple decode and never invokes an accessor', async () => {
  const f = await originalFixture(4, 61), input = structuredClone(compact(argsOf(f)));
  const parcels = input.retained_inputs.spatial.parcels;
  parcels[0][6] = null; // This scalar fault must lose to the later array fault.
  let invoked = false;
  Object.defineProperty(parcels, '60', { enumerable: true, configurable: true,
    get() { invoked = true; throw new Error('must-not-read'); } });
  // Do not call the public deep-sealing owner on an accessor-bearing fake.
  // This tests the pure kernel/codec's existing rejection order synchronously.
  for (const run of [() => legacy(input), () => indexed(input), () => drain(batches(input))]) {
    assert.throws(run, { name: 'TypeError', message: 'invalid_spatial_membership_encoding:data_property' });
  }
  assert.equal(invoked, false);
});

test('source routing and preview array limits retain precedence over later spatial encoding failures', async () => {
  const f = await originalFixture(4, 61), base = compact(argsOf(f));
  for (const [mutate, message] of [
    [input => { captureOf(input).references = []; }, 'custom_cohort_observation_preview_source_routing'],
    [input => { input.retained_inputs.spatial.parcels.length = 100001; }, 'custom_cohort_observation_preview_spatial_parcels_limit'],
  ]) {
    const input = structuredClone(base); input.retained_inputs.spatial.parcel_encoding = 'unknown'; mutate(input); seal(input);
    for (const build of [legacy, indexed]) assert.throws(() => build(input), { name: 'TypeError', message });
    await assert.rejects(batched(input), { name: 'TypeError', message });
  }
});

test('duplicates, input ordering, exact parcel IDs and complete source references survive grouping', async () => {
  const f = await originalFixture(5, 126), original = argsOf(f, 'overlap'), expected = indexed(original);
  const input = structuredClone(original), before = fingerprint(input);
  input.retained_inputs.spatial.parcels.reverse();
  input.retained_inputs.spatial.parcels.push({ ...input.retained_inputs.spatial.parcels[0] });
  for (const source of captureOf(input).sources) source.payload.records.reverse();
  // Pure consumer order/duplicate defense, not a claim that a changed original
  // capture could pass its independent owner hash/completeness admission.
  seal(input); const completed = drain(batches(input));
  assert.notDeepEqual(fingerprint(input), before);
  assert.deepEqual(completed.result, expected, 'Existing sorted/deduplicated parcel identities and source-reference ordering are unchanged');
  assert.deepEqual(await batched(input), expected);
  assert.deepEqual(members(completed.result, completed.result.all, 'stock').map(row => row.parcel_object_ids),
    members(expected, expected.all, 'stock').map(row => row.parcel_object_ids));
  frozen(completed.result);
});
