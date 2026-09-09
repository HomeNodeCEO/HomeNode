import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortPocketRecommendation as build, CUSTOM_COHORT_POCKET_RECOMMENDATION_POLICY as POLICY } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCachedSourceCaptures } from '../src/services/neighborhoodAssessment/cachedSourceCaptures.js';
import { mapCachedParcelRow, mapCachedAccountRow, mapCachedSaleRow } from '../src/services/neighborhoodAssessment/cachedRowMappings.js';
import { projectCustomNeighborhoodMaterialInputs } from '../src/services/neighborhoodAssessment/customMaterialInputs.js';
import { inputs, setPublic, setSection, argumentsOf } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';
import { contextFixture } from './fixtures/customCohortContextFixture.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

const NOW = '2026-09-06T08:00:00.123Z';
const context_ref = { context_id: contextFixture().context_id, context_revision: '1', context_sha256: 'e'.repeat(64) };
const parcel = (account, extra = {}, id = account) => ({ object_id: String(id), account_id: account,
  residential_year_built: 2000, residential_area_sqft: '1800', parcel_area_sqft: '6000', current_market_value: '330000',
  land_use_category: 'one_unit', classification_confidence: 'high', ...extra });
const sale = id => ({ source_record_id: String(id), sale_id: String(id), primary_account_id: 'A', sale_account_id: 'A',
  record_type: 'closed_sale', sale_closing_date: '2024-03-01', source_close_date: '2024-03-01',
  sale_price: '330000', source_current_price: '330000', source_living_area: '1800', source_year_built: 2000,
  source_housing_type: 'Single family', source_days_on_market: 0 });

// Consumer-level cases use ACTUAL projection/mapping/source builders, not a
// claimed supported fact or fake source-rights activation. The separate first
// test exercises actual retained capture/persist/load through the shared fixture.
function fixture({ accounts = ['A', 'B'], parcels = accounts.map(id => parcel(id)), sales = [],
  names = {}, county = 'Dallas', subject = 'A', publicProperty = {}, manual, land, revision = 1 } = {}) {
  parcels = parcels.map((row, index) => ({ ...row, object_id: String(9007199254740993n + BigInt(index)) }));
  const original = inputs(); original.target.account_id = subject;
  setPublic(original, { account: { account_id: subject }, ...publicProperty });
  if (manual !== undefined) setSection(original, 1, JSON.stringify(manual));
  if (land !== undefined) setSection(original, 0, JSON.stringify(land));
  const represented = projectCustomNeighborhoodMaterialInputs(...argumentsOf(original));
  assert.ok(represented.material_input, JSON.stringify(represented));
  const target = original.target;
  const scope = Object.fromEntries(['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'].map(key => [key, target[key]]));
  const wrap = (rows, mapper, prefix) => rows.map(row => { const mapped = mapper(row); return { record_id: `${prefix}:${mapped.record_id}`, data: mapped }; });
  const roles = { selection: accounts.map(account_id => ({ record_id: `selected:${account_id}`, data: { account_id } })),
    parcels: wrap(parcels, mapCachedParcelRow, 'parcel'),
    accounts: wrap(accounts.map(account_id => ({ account_id, county, subdivision: names[account_id] ?? `Group ${account_id}` })), mapCachedAccountRow, 'account'),
    transactions: wrap(sales, mapCachedSaleRow, 'sale'), sale_links: [], gis_sync: [] };
  const capture = buildCachedSourceCaptures({ scope, captures: Object.entries(roles).map(([role, records]) => ({
    upstream: { id: `local-cache:${role}`, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: 'fixture-v2', content_sha256: 'a'.repeat(64), captured_at: NOW, visibility: 'assignment_private', scope, row_count: records.length },
    metadata: { id: `local-cache-${role}`, provider: 'Synthetic local mirror', revision: 'fixture-v2', valid_from: null, valid_to: null,
      observed_at: NOW, historical_availability: 'unknown' },
    projection: { id: `cache-${role}`, revision: 'fixture-v2', definition: { role }, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records })) });
  assert.equal(capture.status, 'ready');
  return { context_ref, retained_inputs: { subject: { target, effective_date: '2024-06-30', material: represented.material_input },
    study: { observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } },
    spatial: { query_complete: true, account_ids: accounts, parcels: parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })) },
    acquisition: { captured_query_request: { scope, account_ids: accounts },
      capture_result: { query_complete: true, captured_at: NOW, source_capture: capture } } },
  selection: { revision, included_recorded_group_ids: [] } };
}
const property = (result, id = 'B') => result.properties.find(row => row.account_id === id);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.00011, `${actual} != ${expected}`);

test('actual retained capture/persist/reopen feeds a bound observation-only recommendation without writes', async () => {
  const f = await decisionEvidenceFixture(), { input } = f;
  const before = JSON.stringify(input), calls = f.f.state.calls.length;
  const result = build({ context_ref: input.expected.context_ref, retained_inputs: input.retained_inputs, selection: input.selection });
  assert.equal(result.status, 'recommendation_for_review');
  assert.deepEqual(result.binding.context_ref, input.expected.context_ref);
  assert.deepEqual(result.binding.target, input.retained_inputs.subject.target);
  assert.deepEqual(result.selection, input.selection);
  assert.equal(result.subject.observations.gla.value, 2100);
  assert.equal(result.subject.observations.gla.origin, 'saved_subject');
  assert.equal(result.subject.observations.age.origin, 'current_subject_cad');
  assert.deepEqual(result.properties.map(row => row.account_id), [...f.accountIds].sort());
  assert.equal(result.selected.member_count, 2); assert.equal(result.subject.in_selected_union, true);
  assert.equal(result.apply.status, 'blocked'); assert.equal(result.authority, 'not_established');
  assert.equal(f.f.state.calls.length, calls); assert.equal(JSON.stringify(input), before);
  assert.ok(Object.isFrozen(result.pockets[0].result.factor_coverage));
});

test('fixed 40/30/20/remainder-thirds weights return uncertainty bounds, never renormalized totals', () => {
  const result = build(fixture()), row = property(result);
  assert.deepEqual(POLICY.weights, { gla: .4, age: .3, housing_type: .2, site_size: 1 / 30, proximity: 1 / 30, sale_price: 1 / 30 });
  close(row.similarity.lower, 73.333333); close(row.similarity.upper, 100); close(row.similarity.known_weight_percent, 73.333333);
  assert.equal(row.factors.gla.score, 100); assert.equal(row.factors.age.score, 100);
  for (const key of ['housing_type', 'proximity', 'sale_price']) assert.deepEqual(row.factors[key], { score: null, state: 'not_established' });
  assert.equal(Object.hasOwn(row, 'score'), false); assert.equal(Object.hasOwn(result, 'reliability'), false);
  assert.match(POLICY.calibration, /not_empirical_reliability/);
});

test('original mapping3 capture retains the same current-CAD recommendation without treating raw sale witnesses as authority', async () => {
  const v3 = await saleWitnessMeaningFixture(), v2 = await decisionEvidenceFixture();
  const consume = fixture => build({ context_ref: fixture.input.expected.context_ref, retained_inputs: fixture.input.retained_inputs, selection: fixture.input.selection });
  const before = JSON.stringify(v3.input), result = consume(v3), baseline = consume(v2);
  assert.equal(JSON.parse(v3.input.retained_inputs.acquisition.compact_metadata_json).mapping_version, 3);
  assert.deepEqual(result.properties, baseline.properties); assert.deepEqual(result.pockets, baseline.pockets);
  assert.deepEqual(result.recommended_recorded_group_ids, baseline.recommended_recorded_group_ids);
  for (const row of result.properties) for (const key of ['housing_type', 'proximity', 'sale_price']) assert.equal(row.factors[key].score, null);
  assert.equal(result.apply.status, 'blocked'); assert.equal(result.authority, 'not_established');
  assert.equal(JSON.stringify(v3.input), before); assert.equal(v3.f.state.calls.length, 0);
});

test('explicit empty selection stays empty while the full discovery is still scored', () => {
  const result = build(fixture());
  assert.deepEqual(result.selection.included_recorded_group_ids, []); assert.deepEqual(result.selected.account_ids, []);
  assert.equal(result.selected.member_count, 0); assert.equal(result.selected.similarity.lower, null);
  assert.equal(result.properties.length, 2); assert.equal(result.subject.in_selected_union, false);
  assert.ok(result.properties.every(row => !row.selected)); assert.ok(result.recommended_recorded_group_ids.length > 0);
});

test('changing selection/revision does not change the common scoring baseline or select any unrequested group', () => {
  const input = fixture(), baseline = build(input), chosen = baseline.pockets.find(pocket => !pocket.contains_subject).id;
  input.selection = { revision: 21, included_recorded_group_ids: [chosen] };
  const result = build(input);
  assert.equal(result.binding.selection_revision, 21); assert.deepEqual(result.selected.account_ids, ['B']);
  assert.deepEqual(result.properties.map(row => row.similarity), baseline.properties.map(row => row.similarity));
  assert.equal(result.subject.in_selected_union, false);
});

for (const [label, selection] of [
  ['unknown', { revision: 1, included_recorded_group_ids: [`recorded-cad:${'0'.repeat(64)}`] }],
  ['duplicate', { revision: 1, included_recorded_group_ids: ['discovery:unassigned', 'discovery:unassigned'] }],
  ['malformed', { revision: 1, included_recorded_group_ids: ['all'] }],
  ['sparse', { revision: 1, included_recorded_group_ids: Array(1) }],
  ['extra instruction', { revision: 1, included_recorded_group_ids: [], includeAll: true }],
  ['invalid revision', { revision: 0, included_recorded_group_ids: [] }],
]) test(`${label} selection fails closed instead of becoming all`, () => {
  assert.throws(() => build({ ...fixture(), selection }));
});

test('subject group receives a separate review marker without score boosting or forced selection', () => {
  const input = fixture({ parcels: [parcel('A', { residential_area_sqft: '90000', residential_year_built: 1800 }), parcel('B')],
    publicProperty: { improvement: { living_area_sqft: 1800, year_built: 2000 } } });
  const result = build(input), subjectGroup = result.pockets.find(row => row.contains_subject);
  assert.equal(subjectGroup.subject_group_review, true); assert.equal(subjectGroup.meets_review_policy, false);
  assert.ok(subjectGroup.review_rank > result.pockets.find(row => !row.contains_subject).review_rank);
  assert.deepEqual(result.subject.recorded_group_review_ids, [subjectGroup.id]);
  assert.equal(result.recommended_recorded_group_ids.includes(subjectGroup.id), false);
  assert.deepEqual(result.selection.included_recorded_group_ids, []); assert.ok(property(result, 'A').similarity.lower < 55);
});

test('missing members remain in group denominators and widen bounds rather than disappearing', () => {
  const result = build(fixture({ accounts: ['A', 'B', 'C'], names: { B: 'Others', C: 'Others' },
    parcels: [parcel('A'), parcel('B', { residential_area_sqft: null, residential_year_built: null, parcel_area_sqft: null }), parcel('C')] }));
  const group = result.pockets.find(row => row.label === 'Others');
  assert.equal(group.result.member_count, 2); close(group.result.similarity.lower, 36.66665);
  close(group.result.similarity.known_weight_percent, 36.66665); assert.equal(group.result.similarity.upper, 100);
  assert.equal(group.result.factor_coverage.gla.unknown_count, 1); assert.equal(group.meets_review_policy, false);
  assert.deepEqual(property(result).similarity, { lower: 0, upper: 100, known_weight_percent: 0 });
  assert.equal(property(result).factors.gla.state, 'candidate_missing');
});

test('all accounts and all source records survive multiple chunks, without a top-30 subset', () => {
  const accounts = Array.from({ length: 64 }, (_, index) => index === 0 ? 'A' : `P${String(index).padStart(3, '0')}`);
  const input = fixture({ accounts, names: Object.fromEntries(accounts.map(id => [id, 'Shared recorded name'])),
    parcels: [...accounts.map(id => parcel(id)), parcel('A', {}, 'A-second')], sales: Array.from({ length: 1001 }, (_, index) => sale(index + 1)) });
  const result = build(input);
  assert.equal(result.properties.length, 64); assert.equal(result.all.member_count, 64);
  assert.equal(result.pockets[0].account_ids.length, 64); assert.equal(result.pockets[0].result.member_count, 64);
  assert.equal(result.coverage.source_records_examined, 64 + 65 + 64 + 1001);
  assert.ok(input.retained_inputs.acquisition.capture_result.source_capture.sources.filter(s => s.payload.projection.definition.role === 'transactions').length > 1);
});

test('duplicate parcel evidence counts one account; exact conflicting decimal observations stay unknown', () => {
  const result = build(fixture({ parcels: [parcel('A'), parcel('B', { residential_area_sqft: '1800.0000000000000001' }),
    parcel('B', { residential_area_sqft: '1800.0000000000000002' }, 'B-2')] }));
  assert.equal(result.all.member_count, 2); assert.equal(property(result).factors.gla.state, 'candidate_conflicting');
  assert.equal(property(result).factors.gla.score, null); close(property(result).similarity.known_weight_percent, 33.333333);
});

test('partially observed duplicate evidence is disclosed without discarding known observations', () => {
  const result = build(fixture({ parcels: [parcel('A'), parcel('B'), parcel('B', { residential_area_sqft: null }, 'B-2')] }));
  assert.equal(property(result).factors.gla.score, 100); assert.deepEqual(property(result).partially_observed_factors, ['gla']);
});

for (const value of [null, '', 'bad', 0]) test(`explicit subject GLA ${JSON.stringify(value)} never falls back to good public/CAD data`, () => {
  const result = build(fixture({ publicProperty: { improvement: { living_area_sqft: 1800, year_built: 2000 } },
    manual: { main_improvement: { living_area_sqft: value } } }));
  assert.equal(result.status, 'insufficient_observations'); assert.equal(result.subject.observations.gla.value, null);
  assert.equal(result.subject.observations.gla.origin, 'saved_subject'); assert.equal(property(result).factors.gla.score, null);
});

test('a null improvement clears both factors; absent saved cells can use retained public then subject CAD', () => {
  const cleared = build(fixture({ manual: { main_improvement: null }, publicProperty: { improvement: { living_area_sqft: 1800, year_built: 2000 } } }));
  assert.equal(cleared.subject.observations.gla.state, 'json_null'); assert.equal(cleared.subject.observations.age.state, 'json_null');
  const present = build(fixture({ manual: { main_improvement: { living_area_sqft: 1900 } },
    publicProperty: { improvement: { living_area_sqft: 1800, year_built: 1990 } } }));
  assert.equal(present.subject.observations.gla.value, 1900); assert.equal(present.subject.observations.age.value, 1990);
  assert.equal(present.subject.observations.age.origin, 'retained_subject_public');
});

for (const [value, expected] of [[2200, 2200], [null, null], ['', null], [0, null], ['bad', null]]) {
  test(`same-source saved total_living_area alias ${JSON.stringify(value)} precedes public/CAD fallback`, () => {
    const result = build(fixture({ manual: { main_improvement: { total_living_area: value } },
      publicProperty: { improvement: { living_area_sqft: 1800 } } }));
    assert.equal(result.subject.observations.gla.value, expected); assert.equal(result.subject.observations.gla.origin, 'saved_subject');
    if (expected === null) assert.equal(property(result).factors.gla.score, null);
  });
}

test('retained public GLA alias is honored, but total_area_sqft is not assumed to be living area', () => {
  const alias = build(fixture({ publicProperty: { improvement: { total_living_area: 2200 } } }));
  assert.equal(alias.subject.observations.gla.value, 2200); assert.equal(alias.subject.observations.gla.origin, 'retained_subject_public');
  const total = build(fixture({ manual: { main_improvement: { total_area_sqft: 9999 } } }));
  assert.equal(total.subject.observations.gla.value, 1800); assert.equal(total.subject.observations.gla.origin, 'current_subject_cad');
  const canonical = build(fixture({ manual: { main_improvement: { living_area_sqft: null, total_living_area: 2200 } } }));
  assert.equal(canonical.subject.observations.gla.state, 'json_null');
});

for (const land of [[], [{ area_sqft: 0 }], [{ area_sqft: 3000 }, { area_sqft: 3000 }]]) test(`explicit subject site lines ${JSON.stringify(land)} are not guessed or summed`, () => {
  const result = build(fixture({ land: { land_detail: land }, publicProperty: { land: [{ area_sqft: 6000 }] } }));
  assert.equal(result.subject.observations.site_size.value, null); assert.equal(result.subject.observations.site_size.origin, 'saved_subject');
  assert.equal(property(result).factors.site_size.score, null);
});

test('zero/non-numeric/future physical observations do not become similarities', () => {
  const result = build(fixture({ parcels: [parcel('A'), parcel('B', { residential_area_sqft: 0, residential_year_built: 2030, parcel_area_sqft: 'bad' })] }));
  assert.equal(property(result).factors.gla.state, 'candidate_invalid');
  assert.equal(property(result).factors.age.state, 'candidate_invalid');
  assert.equal(property(result).factors.site_size.state, 'candidate_invalid');
  assert.deepEqual(property(result).similarity, { lower: 0, upper: 100, known_weight_percent: 0 });
});

test('current building-year comparison is explicitly not age at the historical report date', () => {
  const result = build(fixture({ parcels: [parcel('A', { residential_year_built: 2025 }), parcel('B', { residential_year_built: 2025 })] }));
  assert.equal(property(result).factors.age.score, 100);
  assert.equal(result.binding.observation_period.end_date, '2024-06-30');
  assert.ok(result.limitations.includes('current_observations_not_historical_housing_population'));
});

test('unknown recorded membership remains selectable but is not recommended as a legal neighborhood', () => {
  const input = fixture({ county: null }), baseline = build(input);
  assert.equal(baseline.pockets.length, 1); assert.deepEqual(baseline.pockets[0].account_ids, ['A', 'B']);
  assert.equal(baseline.pockets[0].id, 'discovery:unassigned'); assert.deepEqual(baseline.recommended_recorded_group_ids, []);
  input.selection.included_recorded_group_ids = ['discovery:unassigned'];
  assert.deepEqual(build(input).selected.account_ids, ['A', 'B']);
});

test('catalog limits do not return a ranked prefix or fabricate missing membership', () => {
  const accounts = Array.from({ length: 129 }, (_, index) => index === 0 ? 'A' : `P${index}`);
  const result = build(fixture({ accounts }));
  assert.equal(result.status, 'insufficient_observations'); assert.equal(result.coverage.catalog_complete, false);
  assert.equal(result.properties.length, 129); assert.equal(result.pockets.length, 1);
  assert.equal(result.pockets[0].id, 'discovery:unassigned'); assert.equal(result.pockets[0].account_ids.length, 129);
  assert.deepEqual(result.recommended_recorded_group_ids, []);
});

test('missing discovery subject is explicit: no injected account or falsely complete recommendation', () => {
  const result = build(fixture({ accounts: ['B', 'C'], publicProperty: { improvement: { living_area_sqft: 1800, year_built: 2000 } } }));
  assert.equal(result.subject.in_discovery, false); assert.equal(result.status, 'insufficient_observations');
  assert.deepEqual(result.properties.map(row => row.account_id), ['B', 'C']); assert.deepEqual(result.recommended_recorded_group_ids, []);
});

test('empty discovery remains a genuinely empty result', () => {
  const result = build(fixture({ accounts: [], parcels: [] }));
  assert.equal(result.all.member_count, 0); assert.deepEqual(result.properties, []); assert.deepEqual(result.pockets, []);
  assert.equal(result.all.similarity.lower, null); assert.equal(result.status, 'insufficient_observations');
});

test('ties use stable exact ID order; reordered source rows do not change scores/ranks', () => {
  const forward = build(fixture()), reverse = build(fixture({ accounts: ['B', 'A'] }));
  assert.deepEqual(forward.pockets.map(row => row.id), [...forward.pockets.map(row => row.id)].sort());
  assert.deepEqual(forward.properties, reverse.properties); assert.deepEqual(forward.pockets, reverse.pockets);
});

test('subject material target mismatch or unrecognized profile is rejected', () => {
  for (const change of [{ account_id: 'OTHER' }, { profile_revision: '2' }, { material_input_version: 2 }]) {
    const input = fixture(); input.retained_inputs.subject.material = { ...input.retained_inputs.subject.material, ...change };
    assert.throws(() => build(input), /subject_material_binding/);
  }
});

test('every property/group bound and coverage stays finite in [0,100] for extremes and unknowns', () => {
  const result = build(fixture({ accounts: ['A', 'B', 'C', 'D'], parcels: [parcel('A'),
    parcel('B', { residential_area_sqft: '9'.repeat(127), parcel_area_sqft: '9'.repeat(127), residential_year_built: 1600 }),
    parcel('C', { residential_area_sqft: '.00000000000000000000000001', parcel_area_sqft: null }),
    parcel('D', { residential_area_sqft: null, residential_year_built: null, parcel_area_sqft: null })] }));
  for (const row of [...result.properties, ...result.pockets.map(group => group.result), result.all]) {
    const { lower, upper, known_weight_percent } = row.similarity;
    for (const value of [lower, upper, known_weight_percent]) assert.ok(Number.isFinite(value) && value >= 0 && value <= 100);
    assert.ok(lower <= upper);
  }
  for (const row of result.properties) for (const factor of Object.values(row.factors)) {
    assert.equal(factor.state === 'observed', factor.score !== null);
  }
});

test('the full maximum-group selected/recommended envelope, including ID lists, obeys its byte ceiling', () => {
  const accounts = Array.from({ length: 128 }, (_, index) => index === 0 ? 'A' : `P${index}`);
  const input = fixture({ accounts }), first = build(input);
  input.selection.included_recorded_group_ids = first.pockets.map(group => group.id);
  const result = build(input);
  assert.equal(result.selection.included_recorded_group_ids.length, 128);
  assert.equal(result.recommended_recorded_group_ids.length, 128);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= POLICY.output_utf8_bytes);
  assert.ok(Buffer.byteLength(JSON.stringify([result.selection, result.recommended_recorded_group_ids])) > 16000);
});
