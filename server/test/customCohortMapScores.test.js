import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomCohortMapScoresBatched, buildCustomCohortPocketRecommendation }
  from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCustomCohortPocketRecommendationPresentation }
  from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { buildCustomCohortObservationPreview, buildCustomCohortIndexedObservationPreview }
  from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog }
  from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { decisionEvidenceFixture } from './fixtures/customCohortDecisionEvidenceFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';

for (const [version, fixture] of [[1, decisionEvidenceFixture], [3, saleWitnessMeaningFixture]]) {
  test(`historical map v${version} retains exact existing score means without ranking, members or report authority`, async () => {
    const f = await fixture({ effectiveDate: '2026-09-05' });
    const retained_inputs = f.input.retained_inputs, context_ref = f.input.expected.context_ref;
    const preview = (version === 1 ? buildCustomCohortObservationPreview : buildCustomCohortIndexedObservationPreview)(
      { context_ref, retained_inputs, selection: { revision: 7, pockets: [] } });
    const args = { context_ref, retained_inputs, catalog_version: version, observation_preview: version === 1 ? undefined : preview,
      selection: { revision: 7, included_recorded_group_ids: [] } };
    const original = buildCustomCohortPocketRecommendation(args);
    let budgetChecks = 0;
    const result = await buildCustomCohortMapScoresBatched(args, { checkBudget: () => budgetChecks++ });
    assert.ok(budgetChecks > 1, 'cooperative yields keep requests responsive');
    assert.equal(result.version, 2);
    assert.equal(result.authority, 'not_established');
    assert.equal(result.source_observed_at, preview.captured_at);
    assert.equal(result.retained_capture_at, preview.captured_at);
    for (const group of result.groups) {
      const pocket = original.pockets.find(row => row.id === group.id);
      assert.equal(group.member_count, pocket.result.member_count);
      assert.equal(group.lower, pocket.result.similarity.lower);
      assert.equal(group.upper, pocket.result.similarity.upper);
      assert.equal(group.supported_member_count, original.properties.filter(row => row.recorded_group_id === group.id
        && row.similarity.known_weight_percent > 0).length);
    }
    for (const key of ['properties', 'account_ids', 'review_rank', 'recommended_recorded_group_ids', 'stock_composition_v1', 'apply'])
      assert.equal(JSON.stringify(result).includes(`"${key}":`), false, key);
    assert.ok(Object.isFrozen(result.groups[0]));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(JSON.stringify(original)) / 4);
    const expected = { context_ref, selection_revision: 7 };
    const catalog = presentCustomCohortPocketCatalog({ catalog: buildCustomCohortPocketCatalog({ retained_inputs,
      preview, catalog_version: version }), preview, expected });
    assert.equal(buildCustomCohortPocketRecommendationPresentation({ catalog, expected, retained_inputs }), null,
      'display colors do not re-enable historical auto recommendations');
    const changed = await buildCustomCohortMapScoresBatched({ ...args,
      selection: { revision: 7, included_recorded_group_ids: [result.groups[0].id] } });
    assert.deepEqual(changed, result, 'inclusion never changes the color baseline');
  });
}

test('display scorer honors owner budget instead of returning partial groups', async () => {
  const f = await decisionEvidenceFixture();
  let count = 0;
  await assert.rejects(buildCustomCohortMapScoresBatched({ context_ref: f.input.expected.context_ref,
    retained_inputs: f.input.retained_inputs, selection: { revision: 7, included_recorded_group_ids: [] } },
  { checkBudget() { if (++count === 2) throw new Error('budget'); } }), /budget/);
});
