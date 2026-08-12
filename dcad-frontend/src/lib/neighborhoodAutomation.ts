import type { MarketConditionsResponse } from './api';

export type NeighborhoodLocationType = '' | 'urban' | 'suburban' | 'rural';
export type NeighborhoodGrowth = '' | 'rapid' | 'stable' | 'slow';
export type NeighborhoodMarketTrend = '' | 'increasing' | 'stable' | 'declining';
export type NeighborhoodMarketingTime = '' | 'under_3_months' | '3_to_6_months' | 'over_6_months';

type LandUsePercentages = {
  oneUnit: number;
  twoToFourUnit: number;
  multifamily: number;
  commercial: number;
  otherVacant: number;
};

export function locationTypeFromLandUse(values: LandUsePercentages): NeighborhoodLocationType {
  const residential = values.oneUnit + values.twoToFourUnit + values.multifamily;
  if (values.otherVacant >= 75) return 'rural';
  if (values.commercial > 40) return 'urban';
  if (residential >= 40 && values.otherVacant < 75) return 'suburban';
  return '';
}

export function marketTrendFromRecommendation(
  conclusion: MarketConditionsResponse['recommendation']['conclusion'] | null | undefined,
): NeighborhoodMarketTrend {
  if (conclusion === 'increasing') return 'increasing';
  if (conclusion === 'stable') return 'stable';
  if (conclusion === 'decreasing') return 'declining';
  return '';
}

export function reconciledMedianDaysOnMarket(response: MarketConditionsResponse): number | null {
  const weightByKey = new Map(
    response.recommendation.ranked_studies.map((study) => [
      study.key,
      Number(study.reconciliation_weight_percent) || 0,
    ]),
  );
  const values = response.analyses
    .map((analysis) => ({
      value: analysis.summary.median_days_on_market,
      weight: weightByKey.get(analysis.market.key) || 0,
    }))
    .filter((item): item is { value: number; weight: number } =>
      item.value !== null && Number.isFinite(item.value),
    );
  if (!values.length) return null;
  const weighted = values.filter((item) => item.weight > 0);
  if (weighted.length) {
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    return weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  }
  const sorted = values.map((item) => item.value).sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

export function marketingTimeFromMedianDom(value: number | null): NeighborhoodMarketingTime {
  if (value === null || !Number.isFinite(value) || value < 0) return '';
  if (value < 90) return 'under_3_months';
  if (value <= 180) return '3_to_6_months';
  return 'over_6_months';
}

export function growthFromMarket(
  annualizedChangePercent: number | null,
  medianDaysOnMarket: number | null,
  locationType: NeighborhoodLocationType,
): NeighborhoodGrowth {
  if (annualizedChangePercent === null || !Number.isFinite(annualizedChangePercent)) return '';
  const dom = medianDaysOnMarket !== null && Number.isFinite(medianDaysOnMarket)
    ? medianDaysOnMarket
    : null;
  if (annualizedChangePercent > 10 && dom !== null && dom <= 5) return 'rapid';
  if (locationType === 'rural' && annualizedChangePercent < -10) return 'slow';
  if (locationType !== 'rural' && locationType !== '' && dom !== null && dom > 200) return 'slow';
  if (Math.abs(annualizedChangePercent) < 10 && dom !== null && dom > 5) return 'stable';
  return 'stable';
}

function normalized(value: unknown): string {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type UseFamily = 'one_unit' | 'two_to_four' | 'multifamily' | 'commercial' | 'unknown';

function currentUseFamily(value: string): UseFamily {
  const text = normalized(value);
  if (/\b(DUPLEX|TRIPLEX|FOURPLEX|TWO FAMILY|THREE FAMILY|FOUR FAMILY|2 4 UNIT)\b/.test(text)) return 'two_to_four';
  if (/\b(APARTMENT|MULTI FAMILY|MULTIFAMILY|5 OR MORE|FIVE OR MORE)\b/.test(text)) return 'multifamily';
  if (/\b(COMMERCIAL|RETAIL|OFFICE|INDUSTRIAL|WAREHOUSE|HOTEL|MOTEL|RESTAURANT)\b/.test(text)) return 'commercial';
  if (/\b(SINGLE|DETACHED|TOWNHOUSE|TOWNHOME|CONDO|RESIDENTIAL|ONE UNIT|ONE FAMILY)\b/.test(text)) return 'one_unit';
  return 'unknown';
}

export function zoningCompatibility(zoning: string, currentUse: string): boolean | null {
  const zone = normalized(zoning);
  const use = currentUseFamily(currentUse);
  if (!zone || /\b(NOT REPORTED|UNKNOWN|UNZONED)\b/.test(zone) || use === 'unknown') return null;
  if (/\b(PD|PUD|PLANNED DEVELOPMENT|PLANNED UNIT DEVELOPMENT)\b/.test(zone)) return true;
  const commercialZone = /\b(COMMERCIAL|RETAIL|OFFICE|INDUSTRIAL|WAREHOUSE|BUSINESS)\b/.test(zone);
  const multiZone = /\b(MULTI FAMILY|MULTIFAMILY|APARTMENT|DUPLEX|TOWNHOUSE|2 4 UNIT|MF)\b/.test(zone);
  const singleZone = /\b(SINGLE FAMILY|SINGLE-FAMILY|RESIDENTIAL|SF|R[ -]?\d)\b/.test(zone);
  if (use === 'commercial') return commercialZone;
  if (use === 'multifamily' || use === 'two_to_four') return multiZone || (!commercialZone && singleZone && /\b(DUPLEX|MULTI|MF|2 4)\b/.test(zone));
  if (use === 'one_unit') return !commercialZone && (singleZone || multiZone);
  return null;
}

export type HighestBestUseResult = {
  conclusion: 'current_use' | 'investigation_required';
  zoningCompatible: boolean | null;
  flags: string[];
  summary: string;
};

export function determineHighestBestUse(input: {
  zoning: string;
  currentUse: string;
  subjectSmallerThanAllComparisons: boolean;
  comparisonParcelCount: number;
}): HighestBestUseResult {
  const zoningCompatible = zoningCompatibility(input.zoning, input.currentUse);
  const flags: string[] = [];
  if (zoningCompatible === false) {
    flags.push('The reported zoning does not appear to match the subject’s current use. Investigate legally permissible alternative uses.');
  } else if (zoningCompatible === null) {
    flags.push('Zoning compatibility could not be confirmed automatically. Verify the zoning and permitted uses.');
  }
  if (input.subjectSmallerThanAllComparisons) {
    flags.push(`The subject site is smaller than all ${input.comparisonParcelCount.toLocaleString()} same-use parcels analyzed in the defined area. Investigate assemblage, excess-land, and redevelopment considerations.`);
  }
  const conclusion = flags.length ? 'investigation_required' : 'current_use';
  const useLabel = input.currentUse.trim() || 'reported current use';
  const zoningLabel = input.zoning.trim() || 'unreported zoning';
  const summary = conclusion === 'current_use'
    ? `The ${useLabel} use is provisionally concluded to be the highest and best use as improved because it is consistent with ${zoningLabel} zoning. Appraiser verification is required.`
    : `Automated screening identified one or more issues affecting the highest-and-best-use conclusion for the ${useLabel} use under ${zoningLabel} zoning. Complete the flagged investigation before finalizing the appraisal.`;
  return { conclusion, zoningCompatible, flags, summary };
}
