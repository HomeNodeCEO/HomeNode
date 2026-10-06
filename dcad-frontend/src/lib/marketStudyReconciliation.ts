import type { MarketConditionsAnalysis, MarketConditionsResponse, MarketConditionsStudyAreaKey } from './api';
import type { MarketConditionsReconciliation } from './marketConditionsDraft';

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const round = (value: number | null) => value === null ? null : Math.round(value * 100) / 100;

/** Reconcile independent estimates, never pool overlapping sale populations or
 * claim that an average of study medians is a pooled population median. */
function fullPrecisionStudyValues(values: Array<number | null | undefined>) {
  const sorted = values.filter(valid).sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const average = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  const median = sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
  return { average, median, value: average === null || median === null ? null : (average + median) / 2, count: sorted.length };
}
export function reconcileStudyValues(values: Array<number | null | undefined>) {
  const estimate = fullPrecisionStudyValues(values);
  return { average: round(estimate.average), median: round(estimate.median), value: round(estimate.value), count: estimate.count };
}

/** Actual change between end-month median and the median exactly N months
 * earlier. Missing endpoints remain unavailable; annual rates are not divided. */
export function recentStudyChange(analysis: MarketConditionsAnalysis, months: 3 | 6) {
  const end = analysis.period.end?.slice(0, 7);
  if (!end || !/^\d{4}-\d{2}$/.test(end)) return null;
  const [year, month] = end.split('-').map(Number);
  const baseline = new Date(Date.UTC(year, month - 1 - months, 1)).toISOString().slice(0, 7);
  const first = analysis.series.monthly.find(point => point.period_start?.slice(0, 7) === baseline)?.median_sale_price;
  const last = analysis.series.monthly.find(point => point.period_start?.slice(0, 7) === end)?.median_sale_price;
  return valid(first) && valid(last) && first > 0 && last > 0 ? round((last / first - 1) * 100) : null;
}

export function selectedMarketDetermination(response: MarketConditionsResponse, keys: MarketConditionsStudyAreaKey[]) {
  const analyses = response.analyses.filter(analysis => keys.includes(analysis.market.key));
  const annualRaw = fullPrecisionStudyValues(analyses.map(analysis => analysis.statistics.annualized_change_percent));
  const annual = { average: round(annualRaw.average), median: round(annualRaw.median), value: round(annualRaw.value), count: annualRaw.count };
  const sampleLimitedStudies = analyses.filter(analysis => analysis.statistics.sample_sufficient === false).map(analysis => analysis.market.label);
  const recent = (months: 3 | 6) => reconcileStudyValues(analyses.map(analysis => recentStudyChange(analysis, months)));
  const marketing = (months: 3 | 6 | 12) => reconcileStudyValues(analyses.map(analysis =>
    analysis.recent_periods?.find(period => period.months === months)?.median_days_on_market));
  const threshold = response.recommendation.stable_threshold_percent;
  // Rounding a 0.995% estimate to 1.00% must not cross the 1% stability cutoff.
  const conclusion = annualRaw.value === null ? 'insufficient' : Math.abs(annualRaw.value) < threshold ? 'stable'
    : annualRaw.value > 0 ? 'increasing' : 'decreasing';
  return { analyses, annual, sixMonths: recent(6), threeMonths: recent(3),
    marketingYear: marketing(12), marketingSixMonths: marketing(6), marketingThreeMonths: marketing(3), conclusion, sampleLimitedStudies } as const;
}

const percent = (value: number | null) => value === null ? 'unavailable' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
const days = (value: number | null) => value === null ? 'unavailable' : `${value.toFixed(1)} days`;

export function appliedMarketReconciliation(response: MarketConditionsResponse, keys: MarketConditionsStudyAreaKey[]): MarketConditionsReconciliation {
  const selected = selectedMarketDetermination(response, keys);
  const actualKeys = selected.analyses.map(analysis => analysis.market.key);
  const labels = selected.analyses.map(analysis => analysis.market.label).join(', ');
  const periods = [...new Set(selected.analyses.map(analysis => `${analysis.period.start} through ${analysis.period.end}`))].join('; ');
  const unavailable = [selected.annual.count, selected.sixMonths.count, selected.threeMonths.count,
    selected.marketingYear.count, selected.marketingSixMonths.count, selected.marketingThreeMonths.count].some(count => count < actualKeys.length);
  return { trendConclusion: selected.conclusion, reliedUponAreaKeys: actualKeys,
    explanation: `Greatest weight is given to ${labels || 'no selected studies'} (${periods || 'no observation period'}). `
      + `The selected independent studies indicate ${selected.conclusion} conditions with a ${percent(selected.annual.value)} reconciled annualized change. `
      + `Past six-month change is ${percent(selected.sixMonths.value)}; past three-month change is ${percent(selected.threeMonths.value)}. `
      + `Reconciled study median marketing times for the past year, six months, and three months are ${days(selected.marketingYear.value)}, ${days(selected.marketingSixMonths.value)}, and ${days(selected.marketingThreeMonths.value)}, respectively. `
      + 'Changes use monthly median endpoints; marketing times reconcile separate study medians, not pooled overlapping sales. '
      + (selected.sampleLimitedStudies.length ? `Provisional estimate: ${selected.sampleLimitedStudies.join(', ')} have insufficient sales samples. ` : '')
      + (unavailable ? 'Some selected studies lack period evidence; available-study counts are shown in HomeNode. ' : '')
      + 'The selected populations and their COD/CV consistency were considered in this reconciliation.' };
}
