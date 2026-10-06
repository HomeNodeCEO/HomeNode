import assert from 'node:assert/strict';
import test from 'node:test';
import { appliedMarketReconciliation, recentStudyChange, reconcileStudyValues, selectedMarketDetermination } from '../src/lib/marketStudyReconciliation.ts';

const area = (key, change, marketing = 30) => ({ market: { key, label: key }, statistics: { annualized_change_percent: change },
  period: { start: '2025-10-01', end: '2026-09-30' },
  series: { monthly: ['2026-03-01', '2026-06-01', '2026-09-01'].map((date, index) => ({ period_start: date, median_sale_price: [200000, 250000, 300000][index] })) },
  recent_periods: [3, 6, 12].map(months => ({ months, median_days_on_market: marketing + months })) });
const response = (...analyses) => ({ analyses, recommendation: { stable_threshold_percent: 1 } });

test('any selected study combination alone determines the trend, without pooling sales', () => {
  const input = response(area('zip', -10), area('exploration', 20), area('radius_1', 80));
  assert.equal(selectedMarketDetermination(input, ['zip']).annual.value, -10);
  assert.equal(selectedMarketDetermination(input, ['zip']).conclusion, 'decreasing');
  assert.equal(selectedMarketDetermination(input, ['zip', 'exploration']).annual.value, 5);
  assert.equal(selectedMarketDetermination(input, ['exploration', 'radius_1']).annual.value, 50);
  assert.equal(selectedMarketDetermination(input, []).annual.value, null);
  assert.equal(selectedMarketDetermination(input, ['not_a_study']).conclusion, 'insufficient');
  assert.equal(input.analyses.length, 3);
});
test('actual six and three month changes use exact monthly endpoints, not an annual-rate fraction', () => {
  const input = area('exploration', 80);
  assert.equal(recentStudyChange(input, 6), 50);
  assert.equal(recentStudyChange(input, 3), 20);
  input.series.monthly.splice(0, 1);
  assert.equal(recentStudyChange(input, 6), null);
  input.series.monthly.at(-1).median_sale_price = 0;
  assert.equal(recentStudyChange(input, 3), null);
});
test('marketing periods reconcile exact per-study medians, not old full-window or monthly averages', () => {
  const input = response(area('zip', 0, 20), area('exploration', 0, 40));
  assert.equal(selectedMarketDetermination(input, ['zip']).marketingYear.value, 32);
  assert.equal(selectedMarketDetermination(input, ['zip', 'exploration']).marketingSixMonths.value, 36);
  assert.equal(selectedMarketDetermination(input, ['exploration']).marketingThreeMonths.value, 43);
  delete input.analyses[0].recent_periods;
  const value = selectedMarketDetermination(input, ['zip', 'exploration']);
  assert.equal(value.marketingYear.count, 1);
  assert.equal(value.marketingYear.value, 52);
});
test('missing values are never zero and explanation follows applied studies and dates', () => {
  assert.deepEqual(reconcileStudyValues([null, undefined, NaN, Infinity]), { average: null, median: null, value: null, count: 0 });
  const input = response(area('zip', 0.5), area('exploration', -20));
  const chosen = appliedMarketReconciliation(input, ['zip']);
  assert.equal(chosen.trendConclusion, 'stable');
  assert.deepEqual(chosen.reliedUponAreaKeys, ['zip']);
  assert.match(chosen.explanation, /zip.*2025-10-01 through 2026-09-30/);
  assert.doesNotMatch(chosen.explanation, /exploration/);
  assert.match(chosen.explanation, /\+50.0%.*\+20.0%/);
});
