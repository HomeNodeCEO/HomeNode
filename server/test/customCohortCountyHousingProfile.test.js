import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { getCustomCohortRecordedHousingInterpretation as interpretation,
  getCustomCohortRecordedHousingProfile as housingProfile,
  buildCustomCohortRecordedHousing as housing } from '../src/services/neighborhoodAssessment/customCohortRecordedHousing.js';
import { getCustomCohortStockCompositionDefinition as definition,
  getCustomCohortStockCompositionProfile as stockProfile,
  buildCustomCohortStockComposition as stock } from '../src/services/neighborhoodAssessment/customCohortStockComposition.js';
import { buildCustomCohortPocketRecommendation as recommend,
  buildCustomCohortPocketRecommendationBatched as recommendBatched } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { presentCustomCohortPocketRecommendation as present } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { projectCustomNeighborhoodMaterialInputs } from '../src/services/neighborhoodAssessment/customMaterialInputs.js';
import { inputs, setPublic, argumentsOf } from './fixtures/neighborhoodCustomMaterialInputsFixture.js';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';

const CAD = { class_code: 'A11', class_description: null, use_description: null, structure_type: null, built_up: null };
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const groupsOf = f => [...f.catalog.pockets, ...(f.catalog.unassigned.member_count
  ? [{ id: 'discovery:unassigned', account_ids: f.catalog.unassigned.account_ids }] : [])];
const argsOf = f => ({ retained_inputs: f.input.retained_inputs, preview: f.preview, groups: groupsOf(f) });
const recommendationArgs = f => ({ context_ref: f.input.expected.context_ref, retained_inputs: f.input.retained_inputs,
  selection: { revision: f.preview.selection_revision, included_recorded_group_ids: [] } });
async function fixture(mappingVersion = 4, marked = true, county = 'DALLAS COUNTY', extra = {}) {
  return cadEvidenceFixture({ mappingVersion, accountOverridesByIndex: [{ county }, { county }], parcelOverrides: CAD,
    ...(marked ? { recordedHousingInterpretation: housingProfile(mappingVersion, 2) } : {}), ...extra });
}
function compositionArgs(f, h = housing(argsOf(f))) {
  return { preview: f.preview, catalog: f.catalog, subject: recommend(recommendationArgs(f)).subject,
    housing: h, ...(h.housing_version === 2 ? { composition_version: 2 } : {}) };
}
function publicResult(f, recommendation) {
  const expected = { context_ref: f.input.expected.context_ref, selection_revision: f.preview.selection_revision };
  const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  return present({ recommendation, catalog, expected });
}

test('new housing definitions change only identity and exact county aliases; all four hashes are fixed', () => {
  const hashes = ['12871b3b6251f507a19b1ac20e45df07ace43f6d10654ee513f314ad830de391',
    '636415258d1f8d1e74ab1aac1f5592ea5f3d634153225bd138113a63d993f135',
    '03857dd5dee53b922f4d4f540c385fb65125ff55300d409af4fe547026fa88dc',
    '11db17964e872f315959b71c211f8ad6dc434b092508c32713f3928b061dd6ca'];
  for (const mapping of [4, 5]) for (const version of [1, 2]) {
    const bundle = interpretation(mapping, version), parsed = JSON.parse(bundle.definition_blob.canonical_json);
    assert.equal(hash(parsed), hashes[(version - 1) * 2 + mapping - 4]);
    assert.equal(bundle.profile_ref.content_sha256, hash(parsed));
    assert.equal(bundle.housing_version, version);
    assert.equal(bundle.definition_blob.ref.canonical_utf8_bytes, String(Buffer.byteLength(bundle.definition_blob.canonical_json)));
    assert.ok(Object.isFrozen(bundle) && Object.isFrozen(bundle.profile_ref) && Object.isFrozen(bundle.definition_blob.ref));
    if (version === 2) {
      const old = JSON.parse(interpretation(mapping).definition_blob.canonical_json);
      assert.deepEqual(parsed, { ...old, id: mapping === 4 ? 'custom-recorded-housing-v3' : 'custom-recorded-housing-v4',
        revision: mapping === 4 ? 3 : 4, cad_county_aliases: ['DALLAS', 'DALLAS COUNTY'] });
    }
  }
  assert.equal(housingProfile(4), interpretation(4, 1).profile_ref);
  for (const version of [null, 0, 3, '2', {}, false]) assert.throws(() => interpretation(4, version), /housing_version/);
});

test('stock v2 preserves all binning/limits/weights-independent meaning and binds only the new housing profiles', () => {
  assert.equal(stockProfile().content_sha256, '27dc44aa824a4d09b65ae9b96051613fff7731bd3494b8844dfecfbfd15e1ce8');
  assert.deepEqual(stockProfile(2), { id: 'custom-current-stock-composition-v2', revision: 2,
    content_sha256: '38c5d3a8f4682e4ccb589148b4bb5d8c43f3545d36746c1fd6dda585eef534f2' });
  assert.equal(hash(definition(2)), stockProfile(2).content_sha256);
  assert.deepEqual(definition(2), { ...definition(), id: stockProfile(2).id, revision: 2,
    housing_profiles: [housingProfile(4, 2), housingProfile(5, 2)] });
  assert.ok(Object.isFrozen(definition(2).housing_profiles));
  for (const version of [null, 0, 3, '2']) assert.throws(() => definition(version), /composition_version/);
});

// Full canonical outputs were obtained from the original e4e03b6 housing/stock
// modules (git show HEAD before this branch's implementation), using these
// genuine original acquisitions. These are not post-change expected snapshots.
const LEGACY = [
  [4, 'DALLAS', 'cf81a1612d8e3818ae530ab8c8991f04445d59990fada4afbf87a602bf42fd07', 'f54f52b9daf0d65e5a6525d94be7d13d6356ad449d02269aa5f0acb513cbbdd6'],
  [4, 'DALLAS COUNTY', 'eefc063f8d64c7451a773d90aeff084fe033f3360bff1c97d725e99ef951f371', 'e0f753492ff8756ce5b389563e400ab663eafa456533e776dde751f12766a43c'],
  [5, 'DALLAS', '954f0ccbfebc9ba1067ac536ae2bf6dcb809527038147dfb7e61694609b3d051', '9a80db03f6400a0797d39c7aaacc84cb870c9dd2b752ad22337d8ccbbf437d0e'],
  [5, 'DALLAS COUNTY', '1076c091343c9c29b8d30a7450db18d5ba6bd7fab56807573ce900d5c1fe67cb', '26c599fda4504f93a781d216adea7d83d7e0916586d1ef4ae3203c26054574ee'],
];
for (const [mapping, county, housingHash, stockHash] of LEGACY) test(`unmarked original mapping${mapping} ${county} retains exact full legacy bytes`, async () => {
  const f = await fixture(mapping, false, county), h = housing(argsOf(f));
  assert.equal(hash(h), housingHash); assert.equal(hash(stock(compositionArgs(f, h))), stockHash);
  assert.equal(h.housing_version, 1); assert.equal(h.coverage.observed_count, county === 'DALLAS' ? 2 : 0);
  assert.equal(Object.hasOwn(f.input.retained_inputs, 'recorded_housing_interpretation'), false);
});

for (const mapping of [4, 5]) test(`new original mapping${mapping} aliases retain full counts, sync/cooperative/public parity and no input changes`, async () => {
  const f = await fixture(mapping), before = json(f.input), calls = f.base.f.state.calls.length;
  const h = housing(argsOf(f)), s = stock(compositionArgs(f, h));
  assert.equal(h.housing_version, 2); assert.equal(h.coverage.observed_count, 2);
  assert.equal(h.subject.category, 'detached_single_family'); assert.equal(h.subject.origin, 'current_subject_cad');
  assert.equal(h.profile, housingProfile(mapping, 2));
  assert.equal(s.composition_version, 2); assert.deepEqual(s.housing_profile, h.profile);
  assert.equal(s.all[0], 2); assert.equal(s.pockets.reduce((sum, row) => sum + row[1], 0), 2);
  const args = { ...recommendationArgs(f), include_stock_composition: true };
  const result = recommend(args), batched = await recommendBatched(args);
  assert.deepEqual(batched, result); assert.equal(result.recorded_housing.housing_version, 2);
  assert.deepEqual(result.stock_composition_v1, s);
  const presented = publicResult(f, result);
  assert.equal(presented.recorded_housing.housing_version, 2);
  assert.equal(presented.stock_composition_v1.composition_version, 2);
  assert.equal(json(f.input), before); assert.equal(f.base.f.state.calls.length, calls);
  assert.ok(Object.isFrozen(s.all[2][0]) && Object.isFrozen(h.accounts[0]));
});

for (const [county, observed] of [['DALLAS', 2], [' dallas county ', 2], ['Dallas  County', 0],
  ['DALLAS COUNTY extra', 0], ['DALLAS-COUNTY', 0], ['COLLIN', 0], ['', 0], [null, 0]]) {
  test(`new alias uses exact whole normalized county ${JSON.stringify(county)} only`, async () => {
    const result = housing(argsOf(await fixture(4, true, county)));
    assert.equal(result.coverage.observed_count, observed);
    assert.equal(result.coverage.account_count, 2);
    assert.equal(result.coverage.observed_count + result.coverage.unknown_count, 2);
  });
}
for (const [extra, state] of [
  [{ parcelOverrides: { ...CAD, class_code: '1', structure_type: '2' } }, 'unknown'],
  [{ parcelOverrides: { ...CAD, class_code: null, structure_type: 'SingleFamily' } }, 'unknown'],
  [{ parcelOverrides: { ...CAD, class_code: null, structure_type: 'Single Family' } }, 'unknown'],
  [{ parcelOverrides: { ...CAD, class_description: 'SFR - TOWNHOUSES' } }, 'conflicting'],
  [{ parcelCount: 4, parcelOverridesByIndex: [{}, {}, { class_code: null }, { class_code: null }] }, 'partial'],
  [{ parcelCount: 4, parcelOverridesByIndex: [{}, {}, { class_code: 'A12' }, { class_code: 'A12' }] }, 'conflicting'],
]) test(`county alias cannot change category/parcel resolution: ${JSON.stringify(extra)}`, async () => {
  const h = housing(argsOf(await fixture(4, true, 'DALLAS COUNTY', extra)));
  assert.ok(h.accounts.every(row => row.state === state && row.category === null));
});

test('retained-public Unknown still blocks CAD fallback under the new county profile', async () => {
  const f = await fixture(), args = argsOf(f), retained = structuredClone(args.retained_inputs);
  // Focused downstream material fixture only, not a claimed retained acquisition.
  // The preceding test separately covers the genuine marker/definition graph.
  const raw = inputs(); raw.target = { ...retained.subject.target };
  setPublic(raw, { account: { account_id: retained.subject.target.account_id }, housing_profile: { housing_type: 'Unknown' } });
  retained.subject.material = projectCustomNeighborhoodMaterialInputs(...argumentsOf(raw)).material_input;
  const result = housing({ ...args, retained_inputs: retained });
  assert.deepEqual(result.subject, { state: 'unknown', category: null, origin: 'retained_subject_public' });
  assert.equal(result.coverage.observed_count, 2);
});

test('consumer rejects a present malformed/legacy/foreign marker without silently selecting legacy meaning', async () => {
  const f = await fixture(), args = argsOf(f);
  for (const marker of [undefined, null, {}, housingProfile(4), housingProfile(5, 2),
    { ...housingProfile(4, 2), content_sha256: 'a'.repeat(64) }, { ...housingProfile(4, 2), extra: true }]) {
    assert.throws(() => housing({ ...args, retained_inputs: { ...args.retained_inputs, recorded_housing_interpretation: marker } }),
      e => e.code === 'CUSTOM_COHORT_RECORDED_HOUSING_INVALID');
  }
  let accessed = 0;
  const marker = { ...housingProfile(4, 2) };
  Object.defineProperty(marker, 'id', { enumerable: true, get() { accessed++; return 'custom-recorded-housing-v3'; } });
  assert.throws(() => housing({ ...args, retained_inputs: { ...args.retained_inputs, recorded_housing_interpretation: marker } }), /data_property/);
  assert.equal(accessed, 0);
});

test('stock rejects cross-version housing pairs and preserves version2 on all early/byte unavailable envelopes', async () => {
  const f = await fixture(), args = compositionArgs(f);
  for (const version of [undefined, null, 0, 3, '2']) assert.throws(() => stock({ ...args, composition_version: version }), /composition_version/);
  assert.throws(() => stock({ ...args, composition_version: 1 }), /housing/);
  assert.throws(() => stock({ ...args, housing: { ...args.housing, profile: housingProfile(4) } }), /housing_profile/);
  for (const [override, reason] of [[{ maximumBytes: 0 }, 'output_byte_limit'],
    [{ catalog: { ...f.catalog, catalog_complete: false } }, 'catalog_incomplete'],
    [{ housing: null }, 'housing_interpretation_unavailable']]) {
    const result = stock({ ...args, ...override });
    assert.equal(result.status, 'unavailable'); assert.equal(result.reason, reason);
    assert.equal(result.composition_version, 2); assert.equal(result.profile, stockProfile(2));
    assert.equal(Object.hasOwn(result, 'all'), false);
  }
  const recommendation = recommend({ ...recommendationArgs(f), include_stock_composition: true });
  assert.throws(() => publicResult(f, { ...recommendation,
    recorded_housing: { ...recommendation.recorded_housing, housing_version: 1 } }), /housing/);
});
