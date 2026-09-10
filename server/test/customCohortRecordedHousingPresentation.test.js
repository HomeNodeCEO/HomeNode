import assert from 'node:assert/strict';
import test from 'node:test';
import { cadEvidenceFixture } from './fixtures/customCohortCadEvidenceFixture.js';
import { buildCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { presentCustomCohortPocketRecommendation as present } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';

const fixture = cadEvidenceFixture();
async function input() {
  const f = await fixture, context_ref = f.input.expected.context_ref;
  const expected = { context_ref, selection_revision: f.preview.selection_revision };
  const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  const recommendation = buildCustomCohortPocketRecommendation({ context_ref, retained_inputs: f.input.retained_inputs,
    selection: { revision: expected.selection_revision, included_recorded_group_ids: [] } });
  return { catalog, recommendation, expected };
}

test('housing presentation exposes only a closed current-observation summary with all-account denominators', async () => {
  const args = await input(), result = present(args), housing = result.recorded_housing;
  assert.equal(result.policy.revision, 3);
  assert.equal(result.evidence_mode, 'recorded_housing_only');
  assert.equal(Object.hasOwn(result, 'recorded_proximity'), false);
  assert.deepEqual(Object.keys(result.unavailable_factors).sort(), ['proximity', 'sale_price']);
  assert.deepEqual(Object.keys(housing).sort(), ['authority', 'basis', 'coverage', 'housing_version', 'mapping_version', 'profile', 'subject']);
  assert.equal(housing.coverage.account_count, result.all.member_count);
  assert.equal(housing.coverage.observed_count + housing.coverage.unknown_count, result.all.member_count);
  assert.equal(housing.authority, 'not_established');
  assert.equal(result.apply.status, 'blocked');
  assert.ok(Object.isFrozen(housing.subject));
  assert.equal(Object.hasOwn(housing, 'accounts'), false);
  assert.equal(Object.hasOwn(housing, 'pockets'), false);
  assert.deepEqual(housing, args.recommendation.recorded_housing);
});

for (const [name, mutate] of [
  ['version relabeling', r => { r.recorded_housing.housing_version = 2; }],
  ['mapping relabeling', r => { r.recorded_housing.mapping_version = 2; }],
  ['dictionary hash mutation', r => { r.recorded_housing.profile.content_sha256 = 'a'.repeat(64); }],
  ['authority promotion', r => { r.recorded_housing.authority = 'verified'; }],
  ['private account list', r => { r.recorded_housing.accounts = ['private']; }],
  ['pocket list', r => { r.recorded_housing.pockets = []; }],
  ['missing required summary', r => { delete r.recorded_housing; }],
  ['missing mode', r => { delete r.evidence_mode; }],
  ['invented proximity mode', r => { r.evidence_mode = 'recorded_housing_and_proximity'; }],
  ['subject candidate origin', r => { r.recorded_housing.subject.origin = 'retained_current_cad'; }],
  ['subject null origin', r => { r.recorded_housing.subject.origin = null; }],
  ['unknown subject with category', r => { r.recorded_housing.subject.state = 'unknown'; r.recorded_housing.subject.category = 'townhouse'; }],
  ['unrecognized category', r => { r.recorded_housing.subject.state = 'observed'; r.recorded_housing.subject.category = 'one_unit'; }],
  ['non-enumerated state', r => { r.recorded_housing.subject.state = 'verified'; }],
  ['negative coverage', r => { r.recorded_housing.coverage.unknown_count = -1; }],
  ['invented coverage state', r => { r.recorded_housing.coverage.states.verified = 0; }],
  ['state total drift', r => { r.recorded_housing.coverage.states.unknown++; }],
  ['account total drift', r => { r.recorded_housing.coverage.account_count++; }],
  ['summary to factor drift', r => {
    r.recorded_housing.subject = { state: 'observed', category: 'townhouse', origin: 'current_subject_cad' };
  }],
  ['unavailable proximity claimed observed', r => {
    for (const group of [r.all, ...r.pockets.map(p => p.result)]) group.factor_coverage.proximity = {
      observed_count: group.member_count, unknown_count: 0, states: { observed: group.member_count } };
  }],
  ['unavailable sale price claimed observed', r => {
    for (const group of [r.all, ...r.pockets.map(p => p.result)]) group.factor_coverage.sale_price = {
      observed_count: group.member_count, unknown_count: 0, states: { observed: group.member_count } };
  }],
  ['invented unavailable reason', r => { r.unavailable_factors.sale_price = 'verified'; }],
]) test(`housing presenter refuses ${name}`, async () => {
  const args = structuredClone(await input()); mutate(args.recommendation);
  assert.throws(() => present(args), error => error.code === 'CUSTOM_COHORT_RECOMMENDATION_PRESENTATION_INVALID');
});
