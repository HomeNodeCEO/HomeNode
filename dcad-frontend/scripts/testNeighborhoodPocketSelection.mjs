import assert from 'node:assert/strict';

import {
  applyPocketOverrides,
  calculatePocketStatistics,
  recommendPocketSelection,
  summarizePockets,
} from '../src/lib/neighborhoodPocketSelection.ts';

const candidates = [
  { parcel_object_id: 1, pocket_id: 'analysis:selected:1', cluster_id: 'analysis:selected:1', system_selected: true, primary_population: true, excluded: false, score: 90, year_built: 1980, site_area_sqft: 8000, gla_sqft: 1500, market_value: 300000, sale_price: 350000, sales: [{ sale_price: 350000, sale_date: '2026-01-01' }, { sale_price: 300000, sale_date: '2025-01-01' }] },
  { parcel_object_id: 2, pocket_id: 'analysis:selected:1', cluster_id: 'analysis:selected:1', system_selected: true, primary_population: true, excluded: false, score: 80, year_built: 1990, site_area_sqft: 10000, gla_sqft: 2000, market_value: 500000, sale_price: 400000, sales: [{ sale_price: 400000, sale_date: '2026-01-01' }] },
  { parcel_object_id: 3, pocket_id: 'analysis:review:3', cluster_id: 'analysis:review:3', system_selected: false, primary_population: false, excluded: false, score: 50, year_built: 2000, site_area_sqft: 12000, gla_sqft: 2500, market_value: 600000, sale_price: 500000, sales: [{ sale_price: 500000, sale_date: '2026-01-01' }] },
];

const statistics = calculatePocketStatistics(candidates);
assert.equal(statistics.included_property_count, 2);
assert.equal(statistics.included_sale_count, 3);
assert.equal(statistics.sales_profile.sale_price.median, 350000);
assert.equal(statistics.sales_profile.price_per_square_foot.median, 200);
assert.equal(statistics.property_profile.market_value.median, 400000);
assert.equal(statistics.property_profile.value_per_square_foot.median, 225);

const assessment = {
  summary: {},
  visualization: candidates,
};
const removed = applyPocketOverrides(assessment, ['analysis:selected:1'], []);
assert.equal(removed.summary.relevant_statistics.included_property_count, 0);
const added = applyPocketOverrides(assessment, [], ['analysis:review:3']);
assert.equal(added.summary.relevant_statistics.included_property_count, 3);
assert.equal(added.visualization.at(-1).appraiser_override, 'included');

const pockets = summarizePockets(added.visualization);
assert.equal(pockets.length, 2);
assert.equal(pockets.find((pocket) => pocket.id === 'analysis:review:3').currentlyIncluded, true);

function recommendationCandidates({
  pocket,
  count,
  score,
  subjectSubdivision = false,
  noisy = false,
}) {
  return Array.from({ length: count }, (_, index) => ({
    parcel_object_id: Number(`${pocket}${String(index + 1).padStart(3, '0')}`),
    pocket_id: `analysis:selected:${pocket}`,
    cluster_id: `analysis:selected:${pocket}`,
    system_selected: true,
    primary_population: true,
    excluded: false,
    same_subject_neighborhood: subjectSubdivision,
    score,
    year_built: noisy ? (index % 2 ? 1940 : 2020) : 1980 + (index % 10),
    site_area_sqft: noisy ? (index % 2 ? 3500 : 30000) : 8000 + (index % 8) * 250,
    gla_sqft: noisy ? (index % 2 ? 800 : 4200) : 1600 + (index % 7) * 40,
    market_value: noisy ? (index % 2 ? 120000 : 900000) : 300000 + (index % 8) * 5000,
    sales: index < Math.ceil(count * 0.4)
      ? [{
          sale_price: noisy ? (index % 2 ? 100000 : 850000) : 305000 + index * 1500,
          sale_date: '2026-01-01',
        }]
      : [],
  }));
}

const recommendationAssessment = {
  summary: {},
  visualization: [
    ...recommendationCandidates({ pocket: 1, count: 30, score: 92, subjectSubdivision: true }),
    ...recommendationCandidates({ pocket: 2, count: 40, score: 82 }),
    ...recommendationCandidates({ pocket: 3, count: 30, score: 56, noisy: true }),
  ],
};
const recommendation = recommendPocketSelection(recommendationAssessment);
assert.deepEqual(recommendation.recommendedPocketIds, [
  'analysis:selected:1',
  'analysis:selected:2',
]);
assert.deepEqual(recommendation.removedSystemPocketIds, ['analysis:selected:3']);
assert.equal(recommendation.containsSubjectSubdivision, true);
assert.ok(recommendation.propertyCoveragePercent >= 60);
assert.ok(recommendation.saleCoveragePercent >= 60);
assert.ok(recommendation.recommendedReliabilityScore > recommendation.baselineReliabilityScore);

const protectedRecommendation = recommendPocketSelection({
  summary: {},
  visualization: [
    ...recommendationCandidates({ pocket: 4, count: 60, score: 56, subjectSubdivision: true, noisy: true }),
    ...recommendationCandidates({ pocket: 5, count: 40, score: 90 }),
  ],
});
assert.ok(protectedRecommendation.recommendedPocketIds.includes('analysis:selected:4'));

console.log('neighborhood pocket selection tests passed');
