import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { RECORDED_HOUSING_PROFILES } from '../src/features/neighborhood/customCohortRecordedHousingProfiles.ts';
import { STOCK_COMPOSITION_PROFILE, STOCK_COMPOSITION_DEFINITION,
  COUNTY_STOCK_COMPOSITION_PROFILE, COUNTY_STOCK_COMPOSITION_DEFINITION } from '../src/features/neighborhood/customCohortStockCompositionDefinition.ts';
import { checkCustomCohortPocketCatalog as checkCatalog } from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { checkCustomCohortStockComposition as checkComposition,
  unionCustomCohortStockComposition as union } from '../src/features/neighborhood/customCohortStockComposition.ts';
import { buildCustomCohortSubdivisionFamilies } from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import { createCustomCohortStockCompositionComparison } from '../src/features/neighborhood/customCohortStockCompositionComparison.ts';
import { cadEvidenceFixture } from '../../server/test/fixtures/customCohortCadEvidenceFixture.js';
import { canonicalAssessmentJson as json } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { getCustomCohortRecordedHousingInterpretation } from '../../server/src/services/neighborhoodAssessment/customCohortRecordedHousingProfiles.js';
import { getCustomCohortStockCompositionDefinition, getCustomCohortStockCompositionProfile } from '../../server/src/services/neighborhoodAssessment/customCohortStockComposition.js';
import { buildCustomCohortPocketRecommendation as build } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as present } from '../../server/src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { presentCustomCohortPocketCatalog } from '../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js';

const fixtures = new Map();
function fixture(mappingVersion = 4, housingVersion = 2, county = 'DALLAS COUNTY') {
  const key = JSON.stringify([mappingVersion, housingVersion, county]);
  if (!fixtures.has(key)) fixtures.set(key, (async () => {
    const f = await cadEvidenceFixture({ mappingVersion, parcelCount: 4,
      accountOverridesByIndex: [{ county }, { county }],
      parcelOverrides: { class_code: 'A11', class_description: null, use_description: null, structure_type: null, built_up: true },
      ...(housingVersion === 2 ? { recordedHousingInterpretation: getCustomCohortRecordedHousingInterpretation(mappingVersion, 2).profile_ref } : {}) });
    const expected = { context_ref: f.input.expected.context_ref, selection_revision: f.preview.selection_revision };
    const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
    const kernel = build({ context_ref: expected.context_ref, retained_inputs: f.input.retained_inputs,
      selection: { revision: expected.selection_revision, included_recorded_group_ids: [] }, include_stock_composition: true });
    const recommendation = present({ recommendation: kernel, catalog, expected });
    const input = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
      contextRef: expected.context_ref, selection: { revision: expected.selection_revision, pockets: [] } };
    const response = { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
      context_ref: input.contextRef, selection_revision: input.selection.revision, subject_freshness: 'matched',
      catalog, recommendation, apply: { status: 'blocked' } };
    return { f, expected, catalog, kernel, input, response, checked: checkCatalog(response, input) };
  })());
  return fixtures.get(key);
}

for (const version of [1, 2]) test(`housing interpretation ${version} and stock definition have exact server/browser identity`, () => {
  for (const mapping of [4, 5]) {
    const installed = getCustomCohortRecordedHousingInterpretation(mapping, version);
    assert.deepEqual(RECORDED_HOUSING_PROFILES[version][mapping], installed.profile_ref);
    assert.equal(createHash('sha256').update(installed.definition_blob.canonical_json).digest('hex'), installed.profile_ref.content_sha256);
  }
  const definition = version === 1 ? STOCK_COMPOSITION_DEFINITION : COUNTY_STOCK_COMPOSITION_DEFINITION;
  const profile = version === 1 ? STOCK_COMPOSITION_PROFILE : COUNTY_STOCK_COMPOSITION_PROFILE;
  assert.deepEqual(definition, getCustomCohortStockCompositionDefinition(version));
  assert.deepEqual(profile, getCustomCohortStockCompositionProfile(version));
  assert.equal(createHash('sha256').update(json(definition)).digest('hex'), profile.content_sha256);
});

for (const mapping of [4, 5]) for (const version of [1, 2]) test(`original mapping${mapping} housing${version} reaches browser with exact full membership`, async () => {
  const f = await fixture(mapping, version), r = f.checked.recommendation;
  assert.equal(r.recorded_housing.housing_version, version);
  assert.deepEqual(r.recorded_housing.profile, RECORDED_HOUSING_PROFILES[version][mapping]);
  assert.equal(r.recorded_housing.coverage.account_count, 2);
  assert.equal(r.recorded_housing.coverage.observed_count, version === 2 ? 2 : 0);
  assert.equal(r.recorded_housing.subject.state, version === 2 ? 'observed' : 'unknown');
  assert.equal(r.recorded_housing.subject.category, version === 2 ? 'detached_single_family' : null);
  assert.equal(r.recorded_housing.subject.origin, 'current_subject_cad');
  assert.equal(r.stock_composition_v1.composition_version, version);
  assert.equal(r.stock_composition_v1.status, 'available');
  assert.deepEqual(union(r.stock_composition_v1, r.stock_composition_v1.pockets.map(p => p[0])), r.stock_composition_v1.all);
  assert.equal(union(r.stock_composition_v1, [])[0], 0);
  assert.equal(r.policy.revision, 3); assert.equal(f.response.recommendation.apply.status, 'blocked');
  assert.equal(r.all.factor_coverage.housing_type.observed_count, version === 2 ? 2 : 0);
  const raw = structuredClone(f.response), before = JSON.stringify(raw), checked = checkCatalog(raw, f.input);
  assert.equal(JSON.stringify(raw), before);
  assert.ok(Object.isFrozen(checked.recommendation.recorded_housing.profile));
  assert.notEqual(checked.recommendation.recorded_housing.profile, raw.recommendation.recorded_housing.profile);
});

test('new county vocabulary changes only the housing profile for already recognized Dallas observations', async () => {
  const old = await fixture(4, 1, 'Dallas'), current = await fixture(4, 2, 'Dallas');
  assert.deepEqual(old.checked.recommendation.all, current.checked.recommendation.all);
  assert.deepEqual(old.checked.recommendation.stock_composition_v1.all, current.checked.recommendation.stock_composition_v1.all);
  assert.notDeepEqual(old.input.contextRef, current.input.contextRef, 'the interpretation choice belongs to a distinct retained study');
});

for (const [name, change] of [
  ['unknown housing version', r => { r.recorded_housing.housing_version = 3; }],
  ['legacy housing profile on new version', r => { r.recorded_housing.profile = RECORDED_HOUSING_PROFILES[1][4]; }],
  ['other mapping housing profile', r => { r.recorded_housing.profile = RECORDED_HOUSING_PROFILES[2][5]; }],
  ['new housing profile on legacy version', r => { r.recorded_housing.housing_version = 1; }],
  ['changed housing hash', r => { r.recorded_housing.profile.content_sha256 = 'f'.repeat(64); }],
  ['unknown composition version', r => { r.stock_composition_v1.composition_version = 3; }],
  ['legacy composition profile', r => { r.stock_composition_v1.profile = STOCK_COMPOSITION_PROFILE; }],
  ['legacy composition definition', r => { r.stock_composition_v1.definition = STOCK_COMPOSITION_DEFINITION; }],
  ['other mapping composition housing', r => { r.stock_composition_v1.housing_profile = RECORDED_HOUSING_PROFILES[2][5]; }],
  ['complete but crossed composition version', r => { Object.assign(r.stock_composition_v1, { composition_version: 1,
    profile: STOCK_COMPOSITION_PROFILE, definition: STOCK_COMPOSITION_DEFINITION, housing_profile: RECORDED_HOUSING_PROFILES[1][4] }); }],
]) test(`checked catalog rejects ${name}`, async () => {
  const f = await fixture(), response = structuredClone(f.response); change(response.recommendation);
  assert.throws(() => checkCatalog(response, f.input));
});

test('budget-unavailable composition keeps the new version and cannot be paired with legacy housing', async () => {
  const f = await fixture(), without = structuredClone(f.kernel); delete without.stock_composition_v1;
  const baseline = present({ recommendation: without, catalog: f.catalog, expected: f.expected });
  const limited = present({ recommendation: f.kernel, catalog: f.catalog, expected: f.expected,
    maximumBytes: Buffer.byteLength(JSON.stringify(baseline)) + 600 });
  assert.equal(limited.stock_composition_v1.status, 'unavailable');
  assert.equal(limited.stock_composition_v1.composition_version, 2);
  assert.deepEqual(limited.stock_composition_v1.profile, COUNTY_STOCK_COMPOSITION_PROFILE);
  const response = { ...f.response, recommendation: limited };
  assert.equal(checkCatalog(response, f.input).recommendation.stock_composition_v1.reason, 'output_byte_limit');
  const crossed = structuredClone(response);
  crossed.recommendation.stock_composition_v1.composition_version = 1;
  crossed.recommendation.stock_composition_v1.profile = STOCK_COMPOSITION_PROFILE;
  assert.throws(() => checkCatalog(crossed, f.input));
});

test('new stock composition supports the existing request-free subdivision comparison', async () => {
  const f = await fixture(), composition = f.checked.recommendation.stock_composition_v1;
  const families = buildCustomCohortSubdivisionFamilies(f.checked);
  const family = families.families.find(p => p.pocket_ids.includes(f.checked.subject_membership.assigned_pocket_id));
  assert.ok(family);
  const compare = createCustomCohortStockCompositionComparison({ catalog: f.checked, families,
    contextRef: f.input.contextRef, composition });
  const result = compare({ family, inspectedPocketIds: family.pocket_ids, selectedPocketIds: family.pocket_ids });
  assert.equal(result.status, 'available'); assert.deepEqual(result.profile, COUNTY_STOCK_COMPOSITION_PROFILE);
  assert.equal(result.inspected.member_count, family.member_count);
  assert.equal(result.selected.member_count, family.member_count);
  assert.equal(result.inspected.fields.find(field => field.key === 'housing').overlap_percent, 100);
  const copy = structuredClone(f.response.recommendation.stock_composition_v1);
  Object.defineProperty(copy, 'profile', { enumerable: true, get() { assert.fail('accessor must not execute'); } });
  assert.throws(() => checkComposition(copy, f.checked));
});
