import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortStockComposition as build, readCustomCohortStockComposition as read,
  customCohortStockCompositionBatches as batches,
  getCustomCohortStockCompositionDefinition as definition, CUSTOM_COHORT_STOCK_COMPOSITION_PROFILE as PROFILE,
  CUSTOM_COHORT_STOCK_COMPOSITION_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/customCohortStockComposition.js';
import { buildCustomCohortPocketRecommendation, buildCustomCohortPocketRecommendationBatched } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCustomCohortRecordedHousing, getCustomCohortRecordedHousingProfile,
  CUSTOM_COHORT_RECORDED_HOUSING_STATES as HS, CUSTOM_COHORT_RECORDED_HOUSING_CATEGORIES as HC,
  CUSTOM_COHORT_RECORDED_HOUSING_BASIS } from '../src/services/neighborhoodAssessment/customCohortRecordedHousing.js';
import { buildCustomCohortIndexedObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { exactDistribution } from '../src/services/neighborhoodAssessment/statistics.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

const CONTEXT = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const NOW = '2026-09-06T08:00:00.123Z', FIELDS = ['gla_sqft', 'year_built', 'site_area_sqft'];
const error = reason => e => e.code === 'CUSTOM_COHORT_STOCK_COMPOSITION_INVALID' && e.reason === reason;

for (const mappingVersion of [4, 5]) test(`mapping${mappingVersion} owner-budgeted recommendation keeps exact sync results with optional composition`, async () => {
  const f = await cadEvidenceFixture({ mappingVersion, parcelCount: 4, parcelOverrides: { class_code: 'A11' } });
  const args = { context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs,
    selection: { revision: 1, included_recorded_group_ids: [] }, include_stock_composition: true };
  const before = JSON.stringify(args), expected = buildCustomCohortPocketRecommendation(args);
  let checks = 0;
  const actual = await buildCustomCohortPocketRecommendationBatched(args, { checkBudget() { checks++; } });
  assert.deepEqual(actual, expected); assert.equal(JSON.stringify(args), before);
  assert.equal(actual.stock_composition_v1.status, 'available');
  assert.equal(read(actual.stock_composition_v1, actual.stock_composition_v1.binding), actual.stock_composition_v1);
  assert.ok(checks > 10, 'The outer request budget is checked across nested composition yields');
  let aborted = 0;
  await assert.rejects(buildCustomCohortPocketRecommendationBatched(args, { checkBudget() {
    if (++aborted === checks - 2) throw new Error('request_budget_cancelled');
  } }), /request_budget_cancelled/);
  assert.equal(JSON.stringify(args), before);
});
const frozen = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};
function cell(value, state = 'observed') {
  return { state: state === 'partial' ? 'observed' : state, value: ['observed', 'partial'].includes(state) ? value : null,
    exact_value: ['observed', 'partial'].includes(state) ? String(value) : null,
    observed_record_count: state === 'conflicting' ? 2 : ['observed', 'partial'].includes(state) ? 1 : 0,
    missing_record_count: ['missing', 'partial'].includes(state) ? 1 : 0, invalid_record_count: state === 'invalid' ? 1 : 0 };
}
// Prepared-consumer shape fixture for bounded algebra/malformed-input tests,
// NOT a new retained acquisition, authorization or source-admission proof. The
// actual capture/persist/reopen and private indexed-preview cases are separate.
function fixture(rows = [{ id: 'A' }, { id: 'B' }], { subjectId = 'A', mapping = 4, catalogVersion = 1 } = {}) {
  const members = rows.map((row, i) => ({ account_id: row.id, parcel_object_ids: [String(i + 1)],
    observations: Object.fromEntries(FIELDS.map((field, index) => [field,
      cell(row.values?.[index] ?? [1800, 2000, 6000][index], row.states?.[index] ?? 'observed')])) }));
  const ids = rows.map(row => row.id), groups = new Map(), unassigned = [];
  for (const row of rows) {
    if (row.group === null) { unassigned.push(row.id); continue; }
    const key = row.group ?? `leaf:${row.id}`;
    if (!groups.has(key)) groups.set(key, { id: key, label: row.label ?? key, county: row.county ?? 'Dallas', account_ids: [], member_count: 0 });
    const group = groups.get(key); group.account_ids.push(row.id); group.member_count++;
  }
  const subjectRow = rows.find(row => row.id === subjectId);
  const subjectGroup = !subjectRow || subjectRow.group === null ? null : subjectRow.group ?? `leaf:${subjectId}`;
  const membership = { account_id: subjectId, assigned_pocket_id: subjectGroup, recorded_label_match_only: true,
    status: !subjectRow ? 'not_in_discovery' : subjectGroup === null ? 'unassigned' : 'recorded_label_matched' };
  const all = { account_ids: ids, stock: { member_count: rows.length, unique_account_count: rows.length, members,
    metrics: Object.fromEntries(FIELDS.map((field, index) => [field,
      { unit: ['ft2', 'year', 'ft2'][index], interpretation: 'captured_observations_only' }])) } };
  const preview = { preview_version: 1, status: 'observations_only', authority: 'not_established', apply: { status: 'blocked' },
    context_ref: { ...CONTEXT }, captured_at: NOW, selection_revision: 1, target: { account_id: subjectId }, all, selected: all, pockets: [] };
  const catalog = { catalog_version: catalogVersion, binding: { context_ref: { ...CONTEXT }, selection_revision: 1 },
    authority: 'not_established', apply: { status: 'blocked' }, catalog_complete: true, pockets: [...groups.values()],
    unassigned: { account_ids: unassigned, member_count: unassigned.length }, subject_membership: membership,
    coverage: { stock_member_count: rows.length, discovery_member_count: rows.length } };
  const accounts = rows.map(row => ({ account_id: row.id, origin: 'retained_current_cad', state: row.housingState ?? 'observed',
    category: (row.housingState ?? 'observed') === 'observed' ? row.category ?? HC[0] : null }));
  const states = Object.fromEntries(HS.map(state => [state, accounts.filter(row => row.state === state).length]));
  const housing = { mapping_version: mapping, housing_version: 1, profile: getCustomCohortRecordedHousingProfile(mapping),
    basis: CUSTOM_COHORT_RECORDED_HOUSING_BASIS, authority: 'not_established',
    binding: { context_ref: { ...CONTEXT }, captured_at: NOW }, accounts,
    subject: { state: 'missing', category: null, origin: 'current_subject_cad' },
    coverage: { account_count: rows.length, observed_count: states.observed, unknown_count: rows.length - states.observed, states } };
  const subject = { account_id: subjectId, in_discovery: !!subjectRow, membership: { ...membership },
    recorded_group_review_ids: subjectGroup === null ? [] : [subjectGroup],
    observations: Object.fromEntries(['gla', 'age', 'site_size'].map(key => [key, { state: 'missing', value: null, origin: 'saved_subject' }])) };
  return { preview, catalog, subject, housing };
}
const empty = () => [0, FIELDS.map(() => [Array(5).fill(0), Array(4).fill(0)]), [Array(5).fill(0), Array(7).fill(0)]];
function sum(rows) {
  const result = empty();
  for (const row of rows) {
    result[0] += row[0];
    for (let f = 0; f < 3; f++) for (let p = 0; p < 2; p++) row[1][f][p].forEach((v, i) => { result[1][f][p][i] += v; });
    for (let p = 0; p < 2; p++) row[2][p].forEach((v, i) => { result[2][p][i] += v; });
  }
  return result;
}
function totals(result) {
  assert.equal(result.status, 'available');
  for (const row of [result.all, ...result.pockets.map(row => row.slice(1))]) {
    for (const [states, bins] of row[1]) {
      assert.equal(states.reduce((a, b) => a + b, 0), row[0]);
      assert.equal(bins.reduce((a, b) => a + b, 0), states[0] + states[1]);
    }
    assert.equal(row[2][0].reduce((a, b) => a + b, 0), row[0]);
    assert.equal(row[2][1].reduce((a, b) => a + b, 0), row[2][0][0]);
  }
  assert.deepEqual(sum(result.pockets.map(row => row.slice(1))), result.all);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.output_utf8_bytes);
}

test('fixed profile binds every compact order, shared-cut rule, limit and exact existing housing profile', () => {
  assert.deepEqual(PROFILE, { id: 'custom-current-stock-composition-v1', revision: 1,
    content_sha256: '27dc44aa824a4d09b65ae9b96051613fff7731bd3494b8844dfecfbfd15e1ce8' });
  assert.equal(createHash('sha256').update(json(definition())).digest('hex'), PROFILE.content_sha256);
  assert.deepEqual(definition().numeric_fields, FIELDS);
  assert.deepEqual(definition().numeric_states, ['observed', 'partial', 'missing', 'invalid', 'conflicting']);
  assert.deepEqual(definition().housing_states, HS); assert.deepEqual(definition().housing_categories, HC);
  assert.deepEqual(definition().housing_profiles.map(row => row.content_sha256), [
    '12871b3b6251f507a19b1ac20e45df07ace43f6d10654ee513f314ad830de391',
    '636415258d1f8d1e74ab1aac1f5592ea5f3d634153225bd138113a63d993f135']);
  assert.ok(Object.isFrozen(PROFILE) && Object.isFrozen(definition().binning.intervals));
});

for (const mappingVersion of [4, 5]) test(`actual mapping${mappingVersion} retained reopen produces one count per account, not parcel, with no I/O or score changes`, async () => {
  const f = await cadEvidenceFixture({ mappingVersion, parcelCount: 4, parcelOverrides: { class_code: 'A11' } });
  const retained = f.input.retained_inputs, args = { context_ref: f.input.expected.context_ref,
    retained_inputs: retained, selection: f.input.selection };
  const recommendation = buildCustomCohortPocketRecommendation(args);
  const groups = [...f.catalog.pockets, ...(f.catalog.unassigned.member_count
    ? [{ id: 'discovery:unassigned', account_ids: f.catalog.unassigned.account_ids }] : [])];
  const housing = buildCustomCohortRecordedHousing({ retained_inputs: retained, preview: f.preview, groups });
  const before = JSON.stringify({ input: f.input, recommendation }), calls = f.base.f.state.calls.length;
  const result = build({ preview: f.preview, catalog: f.catalog, subject: recommendation.subject, housing }); totals(result);
  assert.equal(result.all[0], 2); assert.equal(result.mapping_version, mappingVersion);
  assert.deepEqual(result.all[1][0][0], [2, 0, 0, 0, 0]);
  assert.deepEqual(result.subject.numeric[0], ['observed', 2100, 'saved_subject']);
  assert.equal(result.subject.recorded_group_id, f.catalog.subject_membership.assigned_pocket_id);
  assert.deepEqual(result.subject.housing, [housing.subject.state, housing.subject.category, housing.subject.origin]);
  assert.deepEqual(buildCustomCohortPocketRecommendation(args), recommendation);
  assert.equal(JSON.stringify({ input: f.input, recommendation }), before); assert.equal(f.base.f.state.calls.length, calls);
  const indexed = buildCustomCohortIndexedObservationPreview({ ...args, selection: { revision: f.preview.selection_revision, pockets: [] } });
  assert.deepEqual(build({ preview: indexed, catalog: f.catalog, subject: recommendation.subject, housing }), result);
  assert.throws(() => build({ preview: structuredClone(indexed), catalog: f.catalog, subject: recommendation.subject, housing }), error('preview'));
});

test('actual precise decimal parcel conflicts stay conflicting rather than becoming equal rounded Numbers', async () => {
  const f = await cadEvidenceFixture({ parcelCount: 4, parcelOverridesByIndex: [
    { residential_area_sqft: '1000.000000000000000001' }, {}, { residential_area_sqft: '1000.000000000000000002' },
    { residential_area_sqft: null }] });
  const recommendation = buildCustomCohortPocketRecommendation({ context_ref: f.input.expected.context_ref,
    retained_inputs: f.input.retained_inputs, selection: f.input.selection });
  const housing = buildCustomCohortRecordedHousing({ retained_inputs: f.input.retained_inputs, preview: f.preview, groups: f.catalog.pockets });
  const result = build({ preview: f.preview, catalog: f.catalog, subject: recommendation.subject, housing }); totals(result);
  assert.deepEqual(result.all[1][0][0], [0, 1, 0, 0, 1]);
  assert.equal(result.all[1][0][1].reduce((a, b) => a + b, 0), 1);
});

test('equal medians with different distributions remain visibly different under shared context cuts', () => {
  const left = [1000, 1000, 2000, 3000, 3000], right = [2000, 2000, 2000, 2000, 2000];
  assert.equal(exactDistribution(left).median, exactDistribution(right).median);
  const result = build(fixture([...left.map((value, i) => ({ id: `A${i}`, group: 'left', values: [value, 2000, 6000] })),
    ...right.map((value, i) => ({ id: `B${i}`, group: 'right', values: [value, 2000, 6000] }))], { subjectId: 'A0' })); totals(result);
  assert.deepEqual(result.bin_cuts[0], [2000, 2000, 2000]);
  assert.deepEqual(result.pockets.map(row => row[2][0][1]), [[2, 0, 0, 3], [0, 0, 0, 5]]);
  assert.equal(Object.hasOwn(result, 'reliability'), false); assert.equal(Object.hasOwn(result, 'score'), false);
});

test('Type-7 interpolation and right-open bins agree with existing retained statistics', () => {
  const values = [1000, 2000, 3000, 4000, 5000];
  const result = build(fixture(values.map((v, i) => ({ id: String(i), group: 'one', values: [v, 2000, 6000] })), { subjectId: '0' }));
  const d = exactDistribution(values); assert.deepEqual(result.bin_cuts[0], [d.q1, d.median, d.q3]);
  assert.deepEqual(result.all[1][0][1], [1, 1, 1, 2]);
  const interpolated = build(fixture([1000, 2000, 4000, 8000].map((v, i) => ({ id: String(i), values: [v, 2000, 6000] })), { subjectId: '0' }));
  assert.deepEqual(interpolated.bin_cuts[0], [1750, 3000, 5000]); totals(interpolated);
});

test('every numeric uncertainty state and existing housing category/state has its full account denominator', () => {
  const states = definition().numeric_states;
  const rows = HC.map((category, i) => ({ id: String(i), group: 'one', category }));
  rows.push(...HS.slice(1).map((housingState, i) => ({ id: `H${i}`, group: null, housingState,
    states: [states[i + 1], states[i + 1], states[i + 1]] })));
  const result = build(fixture(rows, { subjectId: '0' })); totals(result);
  assert.deepEqual(result.all[1][0][0], [7, 1, 1, 1, 1]);
  assert.deepEqual(result.all[2][0], [7, 1, 1, 1, 1]); assert.deepEqual(result.all[2][1], HC.map(() => 1));
  assert.equal(result.pockets.find(row => row[0] === 'discovery:unassigned')[1], 4);
});

test('literal Dallas/DALLAS COUNTY/name aliases stay separate original leaves and merge only by exact IDs', () => {
  const result = build(fixture([{ id: 'A', group: 'original-dallas', label: 'MONICA PARK 1', county: 'Dallas' },
    { id: 'B', group: 'original-county', label: 'MONICA PARK 1', county: 'DALLAS COUNTY', housingState: 'unknown' },
    { id: 'C', group: 'heights', label: 'MONICA PARK HEIGHTS' }])); totals(result);
  assert.equal(result.pockets.length, 3);
  const chosen = result.pockets.filter(row => ['original-dallas', 'original-county'].includes(row[0]));
  const union = sum(chosen.map(row => row.slice(1))); assert.equal(union[0], 2);
  assert.deepEqual(union[2][0], [1, 0, 1, 0, 0]);
  assert.deepEqual(sum([...chosen].reverse().map(row => row.slice(1))), union);
  assert.deepEqual(sum([]), empty());
  assert.equal(result.subject.recorded_group_id, 'original-dallas');
  assert.equal(JSON.stringify(result).includes('MONICA'), false, 'no labels or inferred family identities are published');
});

test('all-or-nothing empty stock and unknown subject reference have no fabricated cutpoints or counts', () => {
  const result = build(fixture([])); totals(result);
  assert.deepEqual(result.bin_cuts, [null, null, null]); assert.deepEqual(result.all, empty());
  assert.deepEqual(result.pockets, []); assert.equal(result.subject.group_reason, 'not_in_discovery');
  const missing = build(fixture([{ id: 'A', group: null, states: ['missing', 'missing', 'missing'], housingState: 'missing' }]));
  assert.deepEqual(missing.bin_cuts, [null, null, null]); assert.equal(missing.subject.recorded_group_id, null);
  assert.equal(missing.subject.group_reason, 'unassigned'); totals(missing);
});

for (const state of ['missing', 'invalid', 'conflicting', 'json_null', 'ambiguous_rows']) {
  test(`resolved subject ${state} blocks all new fallback despite available candidate observations`, () => {
    const args = fixture();
    args.subject.observations.gla = { state, value: null, origin: 'saved_subject' };
    const result = build(args); assert.deepEqual(result.subject.numeric[0], [state, null, 'saved_subject']);
    assert.equal(result.all[1][0][0][0], 2);
  });
}

test('input order, selection revision and duplicate parcel metadata do not change complete stock distributions', () => {
  const args = fixture(), result = build(args), reversed = structuredClone(args);
  reversed.preview.all.stock.members.reverse(); reversed.preview.all.account_ids.reverse(); reversed.catalog.pockets.reverse(); reversed.housing.accounts.reverse();
  reversed.preview.selection_revision = 9; reversed.catalog.binding.selection_revision = 9;
  reversed.preview.all.stock.members.forEach(row => { row.parcel_object_ids.push(...row.parcel_object_ids); });
  assert.deepEqual(build(reversed), result); totals(result);
});

for (const [label, mutate, reason] of [
  ['overlap across leaves', f => { f.catalog.pockets[1].account_ids = ['A']; }, 'catalog_partition'],
  ['duplicate in one leaf', f => { f.catalog.pockets[0].account_ids.push('A'); f.catalog.pockets[0].member_count++; }, 'catalog_partition'],
  ['lost leaf', f => { f.catalog.pockets.pop(); }, 'catalog_partition'],
  ['duplicate stock account', f => { f.preview.all.stock.members[1].account_id = 'A'; }, 'duplicate_account'],
  ['wrong roster', f => { f.preview.all.account_ids[1] = 'outside'; }, 'stock_roster'],
  ['missing housing account', f => { f.housing.accounts.pop(); }, 'housing_roster'],
  ['duplicate housing account', f => { f.housing.accounts[1].account_id = 'A'; }, 'housing_roster'],
  ['mixed housing profile', f => { f.housing.mapping_version = 5; }, 'housing_profile'],
  ['housing false total', f => { f.housing.coverage.states.observed--; }, 'housing_coverage'],
  ['foreign catalog', f => { f.catalog.binding.context_ref.context_sha256 = 'b'.repeat(64); }, 'binding'],
  ['foreign housing time', f => { f.housing.binding.captured_at = '2026-09-07T00:00:00.000Z'; }, 'housing_binding'],
  ['wrong units', f => { f.preview.all.stock.metrics.gla_sqft.unit = null; }, 'numeric_units'],
  ['nonfinite known cell', f => { f.preview.all.stock.members[0].observations.gla_sqft.value = Infinity; }, 'numeric_value'],
  ['new subject origin', f => { f.subject.observations.gla.origin = 'guessed'; }, 'subject_numeric'],
  ['fabricated subject family', f => { f.subject.recorded_group_review_ids.push('leaf:B'); }, 'input_limit'],
]) test(`${label} fails closed, never emits a partial sidecar`, () => {
  const args = fixture(); mutate(args); assert.throws(() => build(args), error(reason));
});

test('new helper never executes getters, array accessors, proxy traps or toJSON on inspected input fields', () => {
  let executions = 0;
  const throwing = () => { executions++; throw Error('must not execute'); };
  const getter = fixture(); Object.defineProperty(getter.subject.observations.gla, 'state', { enumerable: true, get: throwing });
  assert.throws(() => build(getter), error('data_property'));
  const accessor = fixture(); Object.defineProperty(accessor.catalog.pockets[0].account_ids, '0', { enumerable: true, get: throwing });
  assert.throws(() => build(accessor), error('data_property'));
  const proxy = fixture(); proxy.housing.accounts = new Proxy([], { get: throwing, ownKeys: throwing, getPrototypeOf: throwing });
  assert.throws(() => build(proxy), error('input_limit'));
  const version = fixture(); Object.defineProperty(version.preview, 'preview_version', { enumerable: true, get: throwing });
  assert.throws(() => build(version), error('data_property'));
  const members = fixture(); Object.defineProperty(members.preview.all.stock, 'members', { enumerable: true, get: throwing });
  assert.throws(() => build(members), error('data_property'));
  const identity = fixture(); identity.preview.context_ref.context_id = { toJSON: throwing };
  assert.throws(() => build(identity), error('binding'));
  const profile = fixture(); profile.housing.profile = { ...profile.housing.profile, id: { toJSON: throwing } };
  assert.throws(() => build(profile), error('housing_profile'));
  const toJSON = fixture(); toJSON.subject.observations.gla.toJSON = throwing; assert.equal(build(toJSON).status, 'available');
  assert.equal(executions, 0);
});

test('cooperative generator matches sync bytes, yields no partial result, and can stop before issuance', () => {
  const args = fixture(Array.from({ length: 800 }, (_, i) => ({ id: `A${i}`, group: `G${i % 10}` })), { subjectId: 'A0' });
  const expected = build(args), iterator = batches(args); let yields = 0, step;
  do {
    step = iterator.next();
    if (!step.done) { yields++; assert.equal(step.value, undefined); assert.throws(() => read(step.value, expected.binding), error('unissued_composition')); }
  } while (!step.done);
  assert.ok(yields >= 16); assert.equal(JSON.stringify(step.value), JSON.stringify(expected));
  assert.equal(read(step.value, expected.binding), step.value);
  const stopped = batches(args); assert.equal(stopped.next().done, false);
  assert.deepEqual(stopped.return(), { value: undefined, done: true });
  assert.deepEqual(stopped.next(), { value: undefined, done: true });
});

test('frozen output carries only identity lookup; copies, foreign binding and mutation cannot substitute counts', () => {
  const args = frozen(fixture()), before = JSON.stringify(args), result = build(args);
  assert.equal(read(result, result.binding), result); assert.equal(JSON.stringify(args), before);
  assert.throws(() => read(structuredClone(result), result.binding), error('unissued_composition'));
  assert.throws(() => read(result, { ...result.binding, captured_at: '2026-09-07T00:00:00.000Z' }), error('binding'));
  assert.throws(() => { result.pockets[0][2][0][0][0]++; }, TypeError);
  assert.ok(Object.isFrozen(result.subject.numeric[0]) && Object.isFrozen(result.bin_cuts[0]));
});

for (const [reason, mutate] of [
  ['catalog_incomplete', f => { f.catalog.catalog_complete = false; }],
  ['account_limit', f => { f.preview.all.stock.member_count = 50_001; }],
  ['group_limit', f => { f.catalog.pockets = Array.from({ length: 129 }, () => f.catalog.pockets[0]); }],
  ['housing_interpretation_unavailable', f => { f.housing = null; }],
  ['output_byte_limit', f => { f.maximumBytes = 0; }],
]) test(`optional ${reason} returns an issued envelope without any prefix/counts`, () => {
  const args = fixture(); mutate(args); const result = build(args);
  assert.deepEqual(Object.keys(result).sort(), ['binding', 'composition_version', 'profile', 'reason', 'status']);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, reason); assert.equal(read(result, result.binding), result);
});

test('byte boundary is exact and cannot be raised; old input and result remain untouched on omission', () => {
  const args = fixture(), result = build(args), bytes = Buffer.byteLength(JSON.stringify(result)), before = JSON.stringify(args);
  assert.deepEqual(build({ ...args, maximumBytes: bytes }), result);
  assert.equal(build({ ...args, maximumBytes: bytes - 1 }).reason, 'output_byte_limit');
  for (const maximumBytes of [-1, 1.5, LIMITS.output_utf8_bytes + 1, NaN]) assert.throws(() => build({ ...args, maximumBytes }), error('byte_limit'));
  assert.equal(JSON.stringify(args), before);
});

test('50,000 accounts / 1,024 original leaves plus unresolved stock fit the independent compact budget', t => {
  const rows = Array.from({ length: 50_000 }, (_, i) => ({ id: `A${i}`, group: i === 49_999 ? null
    : `recorded-cad:${(i % 1024).toString(16).padStart(64, '0')}`,
    values: [500 + i % 8000, 1900 + i % 127, i % 50_000], category: HC[i % HC.length],
    states: i % 13 === 0 ? ['partial', 'missing', 'invalid'] : undefined }));
  const args = fixture(rows, { subjectId: 'A0', catalogVersion: 2 });
  const start = performance.now(), result = build(args), elapsed = performance.now() - start; totals(result);
  const bytes = Buffer.byteLength(JSON.stringify(result));
  assert.equal(result.all[0], 50_000); assert.equal(result.pockets.length, 1025);
  assert.equal(result.pockets.reduce((n, row) => n + row[1], 0), 50_000);
  t.diagnostic(`Pure prepared-consumer dense fixture: ${bytes} JSON bytes, ${elapsed.toFixed(1)} ms; no source reads, no latency guarantee.`);
  const iterator = batches(args); let step, yields = 0, maximumStepMs = 0;
  do { const started = performance.now(); step = iterator.next(); maximumStepMs = Math.max(maximumStepMs, performance.now() - started);
    if (!step.done) { yields++; assert.equal(step.value, undefined); }
  } while (!step.done);
  assert.deepEqual(step.value, result);
  t.diagnostic(`Same dense cooperative kernel: ${yields} empty yields, longest synchronous step ${maximumStepMs.toFixed(1)} ms; timing diagnostic only.`);
});
