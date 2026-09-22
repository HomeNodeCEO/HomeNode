import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendationFixture } from './fixtures/customCohortDenseRecommendationFixture.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { buildCustomCohortSalesAwareArea } from '../src/services/neighborhoodAssessment/customCohortSalesAwareArea.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { presentCustomCohortPocketCatalog } from '../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { presentCustomCohortPocketRecommendation } from '../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';

function fixture(sales, { competingArea = '1800' } = {}) {
  const f = recommendationFixture({ accounts: ['A', 'B', 'C'], subject: 'A',
    names: { A: 'Subject Subdivision', B: 'Competing Subdivision', C: 'Other Subdivision' }, sales,
    parcels: ['A', 'B', 'C'].map((account_id, index) => ({ object_id: String(index + 1), account_id,
      residential_year_built: 2000, residential_area_sqft: account_id === 'B' ? competingArea : '1800',
      parcel_area_sqft: '6000', current_market_value: '330000', land_use_category: 'one_unit',
      classification_confidence: 'high' })) });
  const preview = buildCustomCohortObservationPreview({ ...f, selection: { revision: 1, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: f.retained_inputs, preview, catalog_version: 2 });
  const recommendation = buildCustomCohortPocketRecommendation({ ...f, catalog_version: 2, observation_preview: preview });
  return { recommendation, catalog, observation_preview: preview };
}
function sale(index, account = 'B', gla = 1800) {
  const months = ['2023-07-15', '2023-10-15', '2024-01-15', '2024-04-15'];
  return { source_record_id: String(index + 1), sale_id: String(index + 1), primary_account_id: account,
    sale_account_id: account, record_type: 'closed_sale', sale_closing_date: months[index % months.length],
    source_close_date: months[index % months.length], sale_price: '330000', source_current_price: '330000',
    source_living_area: String(gla), source_year_built: 2000, source_housing_type: 'Single family', source_days_on_market: 0 };
}

test('50 qualifying transactions and quarter GLA select a compact subject-and-comparable area', () => {
  const input = fixture(Array.from({ length: 56 }, (_, i) => sale(i)));
  const area = buildCustomCohortSalesAwareArea(input);
  assert.equal(area.status, 'meets_targets');
  assert.equal(area.recorded_transaction_count, 56);
  assert.equal(area.selected_account_count, 2);
  assert.equal(area.selected_recorded_group_ids.length, 2);
  assert.equal(area.quarterly_gla.length, 4);
  assert.ok(area.quarterly_gla.every(row => row.within_tolerance));
});

test('an insufficient recorded sale set is not described as meeting targets', () => {
  const input = fixture(Array.from({ length: 12 }, (_, i) => sale(i)));
  const area = buildCustomCohortSalesAwareArea(input);
  assert.equal(area.status, 'insufficient_recorded_sales');
  assert.ok(area.recorded_transaction_count < 50);
});

test('a 50-sale set just outside the GLA tolerance does not pass the quarterly test', () => {
  const area = buildCustomCohortSalesAwareArea(fixture(Array.from({ length: 56 }, (_, i) => sale(i)), { competingArea: '1900' }));
  assert.equal(area.recorded_transaction_count, 56);
  assert.equal(area.status, 'quarterly_gla_mismatch');
  assert.ok(area.quarterly_gla.some(row => !row.within_tolerance));
});

test('a missing quarter is reported as missing, not silently treated as within 5 percent', () => {
  const area = buildCustomCohortSalesAwareArea(fixture(Array.from({ length: 56 }, (_, i) => ({ ...sale(i),
    sale_closing_date: '2024-03-01', source_close_date: '2024-03-01' }))));
  assert.notEqual(area.status, 'meets_targets');
  assert.ok(area.quarterly_gla.some(row => row.transaction_count === 0 && row.median_current_cad_gla_sqft === null));
});

test('current mapping3 public presentation includes a bounded sales-aware suggestion without private transaction rows', async () => {
  const f = await saleWitnessMeaningFixture();
  const retained_inputs = f.input.retained_inputs;
  const selection = { revision: 7, included_recorded_group_ids: [] };
  const preview = buildCustomCohortObservationPreview({ context_ref: f.input.expected.context_ref,
    retained_inputs, selection: { revision: 7, pockets: [] } });
  const expected = { context_ref: f.input.expected.context_ref, selection_revision: 7 };
  const catalog = presentCustomCohortPocketCatalog({ expected, preview,
    catalog: buildCustomCohortPocketCatalog({ retained_inputs, preview, catalog_version: 3 }) });
  const recommendation = buildCustomCohortPocketRecommendation({ context_ref: expected.context_ref,
    retained_inputs, catalog_version: 3, observation_preview: preview, selection });
  const publicResult = presentCustomCohortPocketRecommendation({ expected, catalog, recommendation, observation_preview: preview });
  assert.equal(publicResult.sales_aware_area?.policy.minimum_transactions, 50);
  assert.ok(!JSON.stringify(publicResult.sales_aware_area).includes('canonical_transaction_id'));
});
