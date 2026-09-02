import assert from 'node:assert/strict';

import {
  applyPocketOverrides,
  calculatePocketStatistics,
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

console.log('neighborhood pocket selection tests passed');
