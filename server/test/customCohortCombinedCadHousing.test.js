import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { buildCustomCohortCurrentCadBaseline as baseline } from '../src/services/neighborhoodAssessment/customCohortCurrentCadBaseline.js';
import { buildCustomCohortRecordedHousing as housing, getCustomCohortRecordedHousingProfile as profileFor,
  CUSTOM_COHORT_RECORDED_HOUSING_PROFILE as V1, CUSTOM_COHORT_COMBINED_RECORDED_HOUSING_PROFILE as V2,
  CUSTOM_COHORT_RECORDED_HOUSING_STATES as STATES } from '../src/services/neighborhoodAssessment/customCohortRecordedHousing.js';
import { buildCustomCohortPocketRecommendation as recommend,
  buildCustomCohortPocketRecommendationBatched as recommendBatched } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as present } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { deriveCustomCohortRecordedProximity as proximity } from '../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';

const EMPTY = { class_code: null, class_description: null, use_description: null, structure_type: null, built_up: null };
const DETACHED = { ...EMPTY, class_code: 'A11', built_up: false };
const copy = value => structuredClone(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const groupsOf = catalog => [...catalog.pockets, ...(catalog.unassigned.member_count
  ? [{ id: 'discovery:unassigned', account_ids: catalog.unassigned.account_ids }] : [])];
const argsOf = f => ({ retained_inputs: f.input.retained_inputs, preview: f.preview, groups: groupsOf(f.catalog) });
const kernelArgs = f => ({ context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs,
  selection: { revision: f.input.selection.revision, included_recorded_group_ids: [] } });
function presentation(f, recommendation) {
  const expected = { context_ref: f.input.expected.context_ref, selection_revision: f.input.selection.revision };
  const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  return present({ recommendation, catalog, expected });
}
const sourceOf = (input, role) => input.acquisition.capture_result.source_capture.sources
  .find(source => source.payload.projection.definition.role === role);
function unbind(value) {
  const result = copy(value);
  // Only the context-bound digest changes when a new original mapping changes
  // retained source identities. Preserve context ID/revision/time and all data.
  if (result.binding?.context_ref) result.binding.context_ref.context_sha256 = '<context-bound>';
  return result;
}
function cadMeaning(value) { const result = unbind(value); delete result.mapping_version; return result; }
function housingMeaning(value) { const result = unbind(value); delete result.mapping_version; delete result.profile; return result; }
function recommendationMeaning(value) {
  const result = unbind(value);
  result.recorded_housing = housingMeaning(result.recorded_housing);
  result.cad_recorded_evidence = cadMeaning(result.cad_recorded_evidence);
  // Public catalog selection hashes bind the entire versioned context too.
  if (result.binding.selection_sha256) result.binding.selection_sha256 = '<context-bound-selection>';
  return result;
}
function checkCounts(result) {
  assert.equal(result.accounts.length, 2);
  for (const population of [result.coverage, ...result.pockets]) {
    assert.deepEqual(Object.keys(population.states), STATES);
    assert.equal(Object.values(population.states).reduce((sum, n) => sum + n, 0), population.account_count);
    assert.equal(population.observed_count + population.unknown_count, population.account_count);
  }
  assert.equal(result.pockets.reduce((sum, p) => sum + p.account_count, 0), result.accounts.length);
}

test('mapping4 and mapping5 housing profiles have exact independent definition identities', () => {
  assert.deepEqual(V1, { id: 'custom-recorded-housing-v1', revision: 1,
    content_sha256: '12871b3b6251f507a19b1ac20e45df07ace43f6d10654ee513f314ad830de391' });
  assert.deepEqual(V2, { id: 'custom-recorded-housing-v2', revision: 2,
    content_sha256: '636415258d1f8d1e74ab1aac1f5592ea5f3d634153225bd138113a63d993f135' });
  assert.equal(profileFor(4), V1); assert.equal(profileFor(5), V2);
  assert.ok(Object.isFrozen(V1) && Object.isFrozen(V2));
  let invoked = false;
  const hostile = new Proxy({}, { get() { invoked = true; assert.fail('profile discriminator inspected'); } });
  for (const value of [undefined, null, 2, 3, 6, '4', '5', new Number(5), hostile]) {
    assert.throws(() => profileFor(value), e => e.code === 'CUSTOM_COHORT_RECORDED_HOUSING_INVALID' && e.reason === 'mapping_profile');
  }
  assert.equal(invoked, false);
});

test('default mapping4 fixture and literal baseline bytes stay pinned', async () => {
  const f = await cadEvidenceFixture();
  assert.equal(JSON.parse(f.input.retained_inputs.acquisition.compact_metadata_json).mapping_version, 4);
  assert.equal(digest(baseline(argsOf(f))), '7309d3214adf0628b896d12bb9314836ecd1e5e7c2bdeb42a9654c36ac9b5692');
  assert.equal(housing(argsOf(f)).profile, V1);
  assert.equal(Object.hasOwn(f.marketPurposes[0], 'source_projection'), false);
});

const cases = [
  ['detached_single_family', { ...EMPTY, class_code: ' A11 ' }, 'observed', 'detached_single_family'],
  ['townhouse', { ...EMPTY, class_code: 'A12' }, 'observed', 'townhouse'],
  ['condominium', { ...EMPTY, class_code: 'A13' }, 'observed', 'condominium'],
  ['duplex', { ...EMPTY, class_code: 'B12' }, 'observed', 'duplex'],
  ['apartment', { ...EMPTY, class_code: 'B11' }, 'observed', 'apartment'],
  ['mobile_home', { ...EMPTY, class_code: 'A20' }, 'observed', 'mobile_home'],
  ['manufactured_home', { ...EMPTY, structure_type: ' Manufactured Home ' }, 'observed', 'manufactured_home'],
  ['missing', EMPTY, 'missing', null],
  ['unknown numeric class', { ...EMPTY, class_code: '111', structure_type: '21' }, 'unknown', null],
  ['conflicting labels', { ...DETACHED, class_description: 'MFR - APARTMENTS' }, 'conflicting', null],
];
for (const [label, parcelOverrides, state, category] of cases) {
  test(`actual mapping4/5 capture and reopen retain identical CAD/housing meaning: ${label}`, async () => {
    const a = await cadEvidenceFixture({ parcelOverrides }), b = await cadEvidenceFixture({ mappingVersion: 5, parcelOverrides });
    const before = JSON.stringify(b.input), calls = b.base.f.state.calls.length;
    const oldCad = baseline(argsOf(a)), combinedCad = baseline(argsOf(b));
    const oldHousing = housing(argsOf(a)), combinedHousing = housing(argsOf(b));
    assert.equal(JSON.parse(b.input.retained_inputs.acquisition.compact_metadata_json).mapping_version, 5);
    assert.equal(sourceOf(b.input.retained_inputs, 'parcels').payload.records[0].data.data.cached_mapping_version, 5);
    assert.equal(sourceOf(b.input.retained_inputs, 'transactions').payload.records[0].data.raw_projection.source_raw_witness.witness_version, 2);
    assert.deepEqual(b.marketPurposes[0].source_projection.mapping_version, 5);
    assert.equal(combinedCad.cad_baseline_version, 1); assert.equal(combinedCad.mapping_version, 5);
    assert.equal(combinedHousing.housing_version, 1); assert.equal(combinedHousing.mapping_version, 5);
    assert.equal(combinedHousing.profile, V2); assert.equal(oldHousing.profile, V1);
    assert.deepEqual(cadMeaning(combinedCad), cadMeaning(oldCad));
    assert.deepEqual(housingMeaning(combinedHousing), housingMeaning(oldHousing));
    checkCounts(combinedHousing);
    assert.equal(combinedHousing.subject.state, state); assert.equal(combinedHousing.subject.category, category);
    assert.equal(combinedHousing.coverage.states[state], 2);
    assert.deepEqual(recommendationMeaning(recommend(kernelArgs(b))), recommendationMeaning(recommend(kernelArgs(a))));
    assert.ok(Object.isFrozen(combinedHousing.accounts[0]) && Object.isFrozen(combinedCad.all));
    assert.equal(JSON.stringify(b.input), before); assert.equal(b.base.f.state.calls.length, calls);
  });
}

for (const [label, second, expected] of [['partial', EMPTY, 'partial'],
  ['conflicting multiple parcels', { ...EMPTY, class_code: 'A12' }, 'conflicting']]) {
  test(`every retained parcel contributes to mapping5 ${label}, never majority/first-row selection`, async () => {
    const options = { parcelCount: 4, parcelOverrides: DETACHED, parcelOverridesByIndex: [{}, {}, second, second] };
    const a = await cadEvidenceFixture(options), b = await cadEvidenceFixture({ ...options, mappingVersion: 5 });
    const result = housing(argsOf(b)); checkCounts(result);
    assert.equal(result.coverage.states[expected], 2); assert.equal(result.subject.state, expected);
    assert.deepEqual(housingMeaning(result), housingMeaning(housing(argsOf(a))));
    assert.deepEqual(cadMeaning(baseline(argsOf(b))), cadMeaning(baseline(argsOf(a))));
    assert.equal(baseline(argsOf(b)).all.fields.class_code.record_count, 4);
  });
}

test('combined raw-sale aliases never replace CAD/housing classification or promote a sale-price factor', async () => {
  const a = await cadEvidenceFixture({ mappingVersion: 5, parcelOverrides: DETACHED });
  const b = await cadEvidenceFixture({ mappingVersion: 5, parcelOverrides: DETACHED, legacy: true,
    rawPayload: { PropertySubType: 'Apartment', StructuralStyle: 'Townhouse', PropertyAttachedYN: true,
      Currency: 'USD', PriceCurrency: 'CAD', CurrentPriceCurrency: 'EUR', ClosePriceCurrency: 'JPY',
      CurrentPrice: '800000', ClosePrice: null, LivingArea: '9999', LivingAreaUnits: 'Square Meters' } });
  const result = housing(argsOf(b)); assert.deepEqual(housingMeaning(result), housingMeaning(housing(argsOf(a))));
  const recommendation = recommend(kernelArgs(b));
  assert.equal(recommendation.recorded_housing.subject.category, 'detached_single_family');
  assert.ok(recommendation.properties.every(row => row.factors.sale_price.score === null));
  const shown = presentation(b, recommendation), encoded = JSON.stringify(shown);
  assert.equal(shown.cad_recorded_evidence.mapping_version, 5); assert.equal(shown.recorded_housing.mapping_version, 5);
  for (const forbidden of ['source_raw_witness', 'ClosePriceCurrency', 'Square Meters', '800000', 'EUR', 'JPY']) {
    assert.equal(encoded.includes(forbidden), false);
  }
  assert.equal(shown.authority, 'not_established'); assert.equal(shown.apply.status, 'blocked');
});

test('available recorded-proximity inputs yield identical 4/5 scores and public summaries, with fixed housing profiles', async () => {
  const fixtures = await Promise.all([4, 5].map(mappingVersion => cadEvidenceFixture({ mappingVersion,
    recordedProximity: true, parcelOverrides: DETACHED })));
  const results = [], publicResults = [];
  for (const f of fixtures) {
    let queries = 0;
    const recorded_proximity = await proximity(async (_sql, values) => {
      queries++;
      return { rows: JSON.parse(values[0]).map(row => ({ object_id: row.object_id, valid: true, location_count: 1,
        minimum_metres: 1609.344, maximum_metres: 1609.344 })) };
    }, { context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs });
    assert.equal(recorded_proximity.status, 'available'); assert.equal(queries, 1);
    const args = { ...kernelArgs(f), recorded_proximity }, result = recommend(args);
    assert.deepEqual(await recommendBatched(args), result);
    assert.equal(result.evidence_mode, 'recorded_housing_and_proximity');
    assert.ok(result.properties.every(row => row.factors.proximity.state === 'observed' && row.factors.proximity.score !== null));
    assert.ok(result.properties.every(row => row.factors.housing_type.score === 100));
    results.push(result); publicResults.push(presentation(f, result));
  }
  assert.deepEqual(recommendationMeaning(results[1]), recommendationMeaning(results[0]));
  assert.deepEqual(recommendationMeaning(publicResults[1]), recommendationMeaning(publicResults[0]));
});

for (const version of [4, 5]) for (const role of ['parcels', 'accounts', 'transactions', 'sale_links', 'gis_sync', 'selection']) {
  test(`mapping${version} CAD/housing consumers reject mixed ${role} projection metadata`, async () => {
    const f = await cadEvidenceFixture({ mappingVersion: version }), args = argsOf(f);
    args.retained_inputs = copy(args.retained_inputs);
    sourceOf(args.retained_inputs, role).payload.projection.definition.mapping_version = version === 4 ? 5 : 4;
    for (const [builder, code] of [[baseline, 'CUSTOM_COHORT_CURRENT_CAD_BASELINE_INVALID'], [housing, 'CUSTOM_COHORT_RECORDED_HOUSING_INVALID']]) {
      assert.throws(() => builder(args), e => e.code === code && e.reason === 'mapping_profile_mismatch');
    }
  });
}

for (const version of [4, 5]) for (const role of ['parcels', 'accounts']) {
  test(`mapping${version} CAD/housing consumers reject mixed normalized ${role} rows`, async () => {
    const f = await cadEvidenceFixture({ mappingVersion: version }), args = argsOf(f);
    args.retained_inputs = copy(args.retained_inputs);
    sourceOf(args.retained_inputs, role).payload.records[0].data.data.cached_mapping_version = version === 4 ? 5 : 4;
    for (const [builder, code] of [[baseline, 'CUSTOM_COHORT_CURRENT_CAD_BASELINE_INVALID'], [housing, 'CUSTOM_COHORT_RECORDED_HOUSING_INVALID']]) {
      assert.throws(() => builder(args), e => e.code === code && e.reason === `mapping_v${version}_required`);
    }
  });
}

for (const version of [4, 5]) test(`mapping${version} public summary rejects wrong profile pairs and cross-version CAD/housing`, async () => {
  const f = await cadEvidenceFixture({ mappingVersion: version }), original = recommend(kernelArgs(f));
  for (const mutate of [
    r => { r.recorded_housing.profile = copy(profileFor(version === 4 ? 5 : 4)); },
    r => { r.recorded_housing.mapping_version = version === 4 ? 5 : 4; },
    r => { r.recorded_housing.profile.revision++; },
    r => { r.recorded_housing.profile.content_sha256 = '0'.repeat(64); },
    r => { r.recorded_housing.mapping_version = String(version); },
    r => { r.cad_recorded_evidence.mapping_version = version === 4 ? 5 : 4; },
  ]) {
    const changed = copy(original); mutate(changed);
    assert.throws(() => presentation(f, changed), e => e.code === 'CUSTOM_COHORT_RECOMMENDATION_PRESENTATION_INVALID'
      && ['housing', 'housing_mapping'].includes(e.reason));
  }
  assert.equal(presentation(f, original).recorded_housing.profile.content_sha256, profileFor(version).content_sha256);
});
