import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNeighborhoodPocketDetails, summarizePocketValues } from '../src/lib/neighborhoodPocketDetails.ts';

const property = (id, overrides = {}) => ({
  parcel_object_id: id, account_id: String(id), pocket_id: 'one', cluster_id: null,
  primary_population: true, subdivision_name: 'Monica Park', land_use_category: 'single_family',
  gla_sqft: 1500, year_built: 2000, site_area_sqft: 7500, market_value: 310000, score: 85,
  sale_price: null, sale_date: null, sales: [], ...overrides,
});
const assessment = (properties) => ({
  generated_at: '2026-09-07T12:00:00Z', summary: { sale_history_months: 24 }, visualization: properties,
});

test('empty, unknown, negative and malformed values never become zero; real zero is preserved where appropriate', () => {
  assert.deepEqual(summarizePocketValues([null, undefined, '', ' ', false, {}, NaN, Infinity, -2]), {
    count: 0, missing: 9, low: null, median: null, high: null,
  });
  assert.deepEqual(summarizePocketValues([0, '10', 20, null], true), {
    count: 3, missing: 1, low: 0, median: 10, high: 20,
  });
});

test('inspection includes excluded properties in just the clicked pocket without mutating the assessment', () => {
  const input = assessment([property(1), property(2, { primary_population: false, year_built: 2026 }), property(3, { pocket_id: 'other' })]);
  const before = structuredClone(input);
  const result = buildNeighborhoodPocketDetails(input, 'one');
  assert.equal(result.properties.length, 2);
  assert.equal(result.includedCount, 1);
  assert.equal(result.metrics.age.median, 13);
  assert.equal(result.metrics.yearBuilt.median, 2013);
  assert.equal(result.metrics.salePrice.count, 0);
  assert.deepEqual(input, before);
  assert.equal(buildNeighborhoodPocketDetails(input, 'absent'), null);
});

test('all supplied sales count, CAD values stay separate, and marketing-time zero is not missing', () => {
  const result = buildNeighborhoodPocketDetails(assessment([property(1, { sales: [
    { sale_price: '240000', sale_date: '2025-05-01', days_on_market: 0 },
    { sale_price: 300000, sale_date: '2026-05-01', days_on_market: 12 },
    { sale_price: 0, sale_date: '2026-05-02', days_on_market: 20 },
  ] })]), 'one');
  assert.equal(result.metrics.salePrice.count, 2);
  assert.equal(result.metrics.salePrice.median, 270000);
  assert.equal(result.metrics.cadValue.median, 310000);
  assert.equal(result.metrics.salePpsf.median, 180);
  assert.equal(result.metrics.marketingDays.median, 6);
  assert.equal(result.monthlySales.length, 2);
});

test('calendar closing dates keep first-of-month transactions in the original month', () => {
  const result = buildNeighborhoodPocketDetails(assessment([property(1, { sales: [
    { sale_price: 240000, sale_date: '2026-02-28' },
    { sale_price: 280000, sale_date: '2026-03-01' },
    { sale_price: 300000, sale_date: '2026-03-31' },
  ] })]), 'one');
  assert.deepEqual(result.monthlySales.map(({ month, count, median }) => ({ month, count, median })), [
    { month: '2026-02', count: 1, median: 240000 },
    { month: '2026-03', count: 2, median: 290000 },
  ]);
});

test('mixed subdivisions and land uses stay distinct, unknown evidence stays unknown', () => {
  const result = buildNeighborhoodPocketDetails(assessment([
    property(1), property(2, { subdivision_name: ' monica   park ', land_use_category: null }),
    property(3, { subdivision_name: 'Other', land_use_category: 'multi_family', year_built: 2028 }),
  ]), 'one');
  assert.deepEqual(result.subdivisions, [{ label: 'MONICA PARK', count: 2 }, { label: 'OTHER', count: 1 }]);
  assert.equal(result.propertyTypes.length, 3);
  assert.equal(result.metrics.age.missing, 1);
  assert.equal(result.metrics.marketingDays.median, null);
});

test('invalid assessment dates do not turn year built into a claimed age', () => {
  const result = buildNeighborhoodPocketDetails({ ...assessment([property(1)]), generated_at: 'invalid' }, 'one');
  assert.equal(result.asOfYear, null);
  assert.equal(result.metrics.age.median, null);
  assert.equal(result.metrics.yearBuilt.median, 2000);
});

test('a broad CAD neighborhood match is not represented as verified subdivision membership', () => {
  const result = buildNeighborhoodPocketDetails(assessment([
    property(1, { subdivision_name: 'A different subdivision', same_subject_neighborhood: true }),
  ]), 'one');
  assert.equal(result.containsSubjectNeighborhood, true);
  assert.equal(Object.hasOwn(result, 'containsSubjectSubdivision'), false);
  assert.equal(result.subdivisions[0].label, 'A DIFFERENT SUBDIVISION');
});
