import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationFixture } from './fixtures/customCohortDenseRecommendationFixture.js';
import { buildCustomCohortIndexedObservationPreview as preview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog as catalog, presentCustomCohortPocketCatalog as present,
  customCohortCatalogGroupLimit } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendation as recommend } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation as presentRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { customCohortOpeningGroupIds, customCohortOpeningSelection } from '../src/services/neighborhoodAssessment/customCohortOpeningPreview.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as checkpoint, customWorkspaceCatalogVersion,
  prepareCustomNeighborhoodRecordedGroupIds } from '../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';

function fixture(count) {
  const accounts = Array.from({ length: count }, (_, i) => `A${String(i).padStart(5, '0')}`);
  return recommendationFixture({ accounts, subject: accounts[0], mapping4: true });
}
function view(args) {
  return preview({ ...args, selection: { revision: 1, pockets: [] } });
}

test('1475 real mapped groups open with exact numeric preview and versioned recommendation, while v2 remains unresolved', t => {
  const args = fixture(1475), all = view(args), expected = { context_ref: args.context_ref, selection_revision: 1 };
  const old = catalog({ retained_inputs: args.retained_inputs, preview: all, catalog_version: 2 });
  assert.equal(old.catalog_complete, false); assert.deepEqual(old.reasons, ['pocket_count_limit']);
  const next = catalog({ retained_inputs: args.retained_inputs, preview: all, catalog_version: 3 });
  const shown = present({ catalog: next, preview: all, expected });
  assert.equal(shown.catalog_version, 3); assert.equal(shown.catalog_complete, true); assert.equal(shown.pockets.length, 1475);
  assert.deepEqual(shown.pockets.flatMap(p => p.account_ids).sort(), old.unassigned.account_ids);
  const selection = customCohortOpeningSelection(shown, customCohortOpeningGroupIds(shown), 1);
  const opening = preview({ ...args, selection });
  assert.deepEqual(opening.selected.stock.metrics, all.all.stock.metrics);
  assert.equal(opening.selected.stock.member_count, 1475);
  assert.equal(opening.selected.stock.metrics.gla_sqft.median, 1800);
  const recommendation = recommend({ ...args, catalog_version: 3, observation_preview: all, include_stock_composition: true });
  assert.equal(recommendation.recommendation_version, 3);
  assert.equal(recommendation.stock_composition_v1.status, 'unavailable');
  assert.equal(recommendation.stock_composition_v1.reason, 'group_limit');
  const result = presentRecommendation({ recommendation, catalog: shown, expected });
  assert.equal(result.presentation_version, 3); assert.equal(result.pockets.length, 1475);
  assert.equal(result.all.member_count, 1475);
  assert.equal(result.stock_composition_v1.reason, 'group_limit');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2500000);
  t.diagnostic(JSON.stringify({ groups: shown.pockets.length, catalog_bytes: Buffer.byteLength(JSON.stringify(shown)),
    recommendation_bytes: Buffer.byteLength(JSON.stringify(result)), selected_accounts: opening.selected.stock.member_count }));
});

test('catalog3 preserves every catalog2 byte except explicit version within its old capacity', () => {
  const args = fixture(25), observation = view(args), expected = { context_ref: args.context_ref, selection_revision: 1 };
  const results = [2, 3].map(catalog_version => {
    const internal = catalog({ retained_inputs: args.retained_inputs, preview: observation, catalog_version });
    const shown = present({ catalog: internal, preview: observation, expected });
    const recommendation = recommend({ ...args, catalog_version, observation_preview: observation, include_stock_composition: true });
    return { internal, shown, recommendation, presented: presentRecommendation({ recommendation, catalog: shown, expected }) };
  });
  assert.deepEqual({ ...results[1].internal, catalog_version: 2 }, results[0].internal);
  assert.deepEqual({ ...results[1].shown, catalog_version: 2 }, results[0].shown);
  assert.deepEqual({ ...results[1].recommendation, recommendation_version: 2 }, results[0].recommendation);
  assert.deepEqual({ ...results[1].presented, presentation_version: 2, recommendation_version: 2 }, results[0].presented);
});

test('2048 group ceiling is explicit; overflow returns the complete unresolved roster', () => {
  for (const count of [2048, 2049]) {
    const args = fixture(count), observation = view(args);
    const result = catalog({ retained_inputs: args.retained_inputs, preview: observation, catalog_version: 3 });
    assert.equal(result.catalog_complete, count === 2048);
    if (count === 2049) assert.deepEqual(result.reasons, ['pocket_count_limit']);
    assert.deepEqual([...result.pockets.flatMap(p => p.account_ids), ...result.unassigned.account_ids].sort(), args.retained_inputs.spatial.account_ids);
  }
  assert.deepEqual([1, 2, 3].map(customCohortCatalogGroupLimit), [128, 1024, 2048]);
  for (const value of [0, 4, null, '3']) assert.throws(() => customCohortCatalogGroupLimit(value));
});

test('checkpoint6 and opening ID admission retain older version limits and bind catalog3', () => {
  const args = fixture(1475), groups = Array.from({ length: 1475 }, (_, i) => `recorded-cad:${i.toString(16).padStart(64, '0')}`);
  const value = { workspace_version: 6, active: { context_ref: args.context_ref,
    observation_period: args.retained_inputs.study.observation_period, selection: { revision: 1, included_recorded_group_ids: groups } }, pending_capture: null };
  assert.equal(customWorkspaceCatalogVersion(checkpoint(value)), 3);
  assert.deepEqual(prepareCustomNeighborhoodRecordedGroupIds(groups, 3), groups);
  assert.throws(() => checkpoint({ ...value, workspace_version: 5 }), /group_ids/);
  assert.throws(() => prepareCustomNeighborhoodRecordedGroupIds(groups, 2), /group_ids/);
  assert.equal(customWorkspaceCatalogVersion(checkpoint({ ...value, workspace_version: 5,
    active: { ...value.active, selection: { revision: 1, included_recorded_group_ids: ['discovery:unassigned'] } } })), 2);
});
