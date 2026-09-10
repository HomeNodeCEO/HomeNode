import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedProximityFixture } from './fixtures/customCohortRecordedProximityFixture.js';
import { deriveCustomCohortRecordedProximity } from '../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { buildCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { presentCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';

async function fixture(radius) {
  const f = await recordedProximityFixture({ radius });
  const expected = { context_ref: f.context_ref, selection_revision: 7 };
  const catalog = presentCustomCohortPocketCatalog({ catalog: f.catalog, preview: f.preview, expected });
  const recorded_proximity = await deriveCustomCohortRecordedProximity(async (_sql, values) => ({
    rows: JSON.parse(values[0]).map(row => ({ object_id: row.object_id, valid: true,
      location_count: 1, minimum_metres: 1609.344, maximum_metres: 1609.344 })),
  }), { context_ref: f.context_ref, retained_inputs: f.retained_inputs });
  const recommendation = buildCustomCohortPocketRecommendation({ context_ref: f.context_ref,
    retained_inputs: f.retained_inputs, selection: { revision: 7, included_recorded_group_ids: [] }, recorded_proximity });
  return { catalog, expected, recommendation };
}

for (const radius of [undefined, '4828.032', '8046.72', '16093.44']) {
  test(`compact v2 presenter retains exact ${radius ?? 'legacy'} radius and complete coverage without private native rows`, async () => {
    const args = await fixture(radius), value = presentCustomCohortPocketRecommendation(args);
    assert.equal(value.policy.revision, 2);
    assert.equal(value.recorded_proximity.radius_metres, radius ?? '4828.032');
    assert.deepEqual(value.recorded_proximity.counts, { accounts: 2, parcels: 2, observed_accounts: 2, unknown_accounts: 0 });
    assert.equal(value.all.factor_coverage.proximity.observed_count, 2);
    assert.equal(value.pockets.reduce((n, p) => n + p.factor_coverage.proximity.observed_count, 0), 2);
    assert.equal(Object.hasOwn(value, 'properties'), false);
    assert.equal(Object.hasOwn(value.recorded_proximity, 'accounts'), false);
    assert.equal(Object.hasOwn(value.recorded_proximity, 'binding'), false);
    assert.deepEqual(Object.keys(value.unavailable_factors), ['housing_type', 'sale_price']);
    assert.ok(Object.isFrozen(value.recorded_proximity.counts));
  });
}

test('v2 native aggregate cannot contradict its all-account and pocket coverage', async () => {
  const args = await fixture('8046.72');
  for (const edit of [
    r => { r.recorded_proximity.counts.accounts++; },
    r => { r.recorded_proximity.counts.parcels = 1; },
    r => { r.recorded_proximity.counts.observed_accounts--; r.recorded_proximity.counts.unknown_accounts++; },
    r => { r.recorded_proximity.status = 'unavailable'; r.recorded_proximity.reason = 'retained_map_unavailable'; },
    r => { r.recorded_proximity.radius_metres = '9999'; },
    r => { r.recorded_proximity.binding = { fabricated: true }; },
    r => { r.recorded_proximity.reason = 'free-form native error'; },
    r => { delete r.recorded_proximity; },
    r => { r.policy.revision = 1; },
  ]) {
    const recommendation = structuredClone(args.recommendation); edit(recommendation);
    assert.throws(() => presentCustomCohortPocketRecommendation({ ...args, recommendation }));
  }
});

test('full-discovery v2 baseline never accepts a selected-only result or foreign context', async () => {
  const args = await fixture();
  for (const edit of [
    r => { r.selection.included_recorded_group_ids = [r.pockets[0].id]; },
    r => { r.binding.selection_revision++; },
    r => { r.binding.context_ref.context_sha256 = '0'.repeat(64); },
  ]) {
    const recommendation = structuredClone(args.recommendation); edit(recommendation);
    assert.throws(() => presentCustomCohortPocketRecommendation({ ...args, recommendation }));
  }
});
