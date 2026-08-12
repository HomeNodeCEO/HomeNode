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

export type NeighborhoodValuePositionResult = {
  ready: boolean;
  relationship: 'pending' | 'above_predominant' | 'below_predominant' | 'at_predominant';
  difference: number | null;
  differencePercent: number | null;
  reasons: string[];
  recommendedReview: '' | 'over_improvement' | 'under_improvement';
  narrative: string;
};

function finiteValue(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[$,%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

function count(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(value));
}

function ratingScore(value: unknown, prefix: 'C' | 'Q'): number | null {
  const matches = String(value || '').toUpperCase().match(new RegExp(`${prefix}([1-6])`, 'g')) || [];
  const scores = matches.map((match) => Number(match.slice(1))).filter(Number.isFinite);
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}

function materiallyDifferent(subject: number, predominant: number): boolean {
  if (predominant <= 0) return false;
  return Math.abs(subject - predominant) / predominant >= 0.1;
}

function factorReasons(input: {
  direction: 'above' | 'below' | 'at';
  subjectGla: number | null;
  predominantGla: number | null;
  subjectSiteSize: number | null;
  predominantSiteSize: number | null;
  subjectAge: number | null;
  predominantAge: number | null;
  conditionRating: unknown;
  qualityRating: unknown;
}): string[] {
  const reasons: string[] = [];
  const above = input.direction === 'above';
  const below = input.direction === 'below';
  if (
    input.subjectGla !== null && input.predominantGla !== null &&
    materiallyDifferent(input.subjectGla, input.predominantGla)
  ) {
    if ((above && input.subjectGla > input.predominantGla) || (below && input.subjectGla < input.predominantGla)) {
      reasons.push(`${input.subjectGla > input.predominantGla ? 'larger' : 'smaller'} ${count(input.subjectGla)}-square-foot GLA compared with the ${count(input.predominantGla)}-square-foot predominant GLA`);
    }
  }
  if (
    input.subjectSiteSize !== null && input.predominantSiteSize !== null &&
    materiallyDifferent(input.subjectSiteSize, input.predominantSiteSize)
  ) {
    if ((above && input.subjectSiteSize > input.predominantSiteSize) || (below && input.subjectSiteSize < input.predominantSiteSize)) {
      reasons.push(`${input.subjectSiteSize > input.predominantSiteSize ? 'larger' : 'smaller'} ${count(input.subjectSiteSize)}-square-foot site compared with the ${count(input.predominantSiteSize)}-square-foot predominant site`);
    }
  }
  if (
    input.subjectAge !== null && input.predominantAge !== null &&
    (Math.abs(input.subjectAge - input.predominantAge) >= 5 || materiallyDifferent(input.subjectAge, input.predominantAge))
  ) {
    if ((above && input.subjectAge < input.predominantAge) || (below && input.subjectAge > input.predominantAge)) {
      reasons.push(`${input.subjectAge < input.predominantAge ? 'newer' : 'older'} effective age of ${count(input.subjectAge)} years compared with the ${count(input.predominantAge)}-year predominant age`);
    }
  }
  const condition = ratingScore(input.conditionRating, 'C');
  if (condition !== null && ((above && condition <= 2.5) || (below && condition >= 4))) {
    reasons.push(`${String(input.conditionRating).toUpperCase()} condition, indicating ${condition <= 2.5 ? 'superior updating and market appeal' : 'inferior condition or deferred updating'}`);
  }
  const quality = ratingScore(input.qualityRating, 'Q');
  if (quality !== null && ((above && quality <= 3) || (below && quality >= 5))) {
    reasons.push(`${String(input.qualityRating).toUpperCase()} quality, indicating ${quality <= 3 ? 'superior construction quality' : 'inferior construction quality'}`);
  }
  return reasons;
}

export function determineNeighborhoodValuePosition(input: {
  concludedValue: unknown;
  predominantValue: unknown;
  neighborhoodLowValue?: unknown;
  neighborhoodHighValue?: unknown;
  subjectGla?: unknown;
  predominantGla?: unknown;
  subjectSiteSize?: unknown;
  predominantSiteSize?: unknown;
  subjectAge?: unknown;
  predominantAge?: unknown;
  conditionRating?: unknown;
  qualityRating?: unknown;
  conformsToNeighborhood?: boolean | null;
  nonconformityType?: unknown;
}): NeighborhoodValuePositionResult {
  const concludedValue = finiteValue(input.concludedValue);
  const predominantValue = finiteValue(input.predominantValue);
  if (concludedValue === null || concludedValue <= 0) {
    return {
      ready: false,
      relationship: 'pending',
      difference: null,
      differencePercent: null,
      reasons: [],
      recommendedReview: '',
      narrative: 'Complete the Sales Comparison Approach value conclusion before developing the subject-to-predominant-value analysis.',
    };
  }
  if (predominantValue === null || predominantValue <= 0) {
    return {
      ready: false,
      relationship: 'pending',
      difference: null,
      differencePercent: null,
      reasons: [],
      recommendedReview: '',
      narrative: 'A concluded subject value is available, but the neighborhood predominant value must be developed before the comparison can be completed.',
    };
  }
  const difference = Math.round(concludedValue - predominantValue);
  const differencePercent = Math.round((difference / predominantValue) * 1000) / 10;
  const direction = difference > 0 ? 'above' : difference < 0 ? 'below' : 'at';
  const relationship = difference > 0
    ? 'above_predominant'
    : difference < 0
      ? 'below_predominant'
      : 'at_predominant';
  const reasons = factorReasons({
    direction,
    subjectGla: finiteValue(input.subjectGla),
    predominantGla: finiteValue(input.predominantGla),
    subjectSiteSize: finiteValue(input.subjectSiteSize),
    predominantSiteSize: finiteValue(input.predominantSiteSize),
    subjectAge: finiteValue(input.subjectAge),
    predominantAge: finiteValue(input.predominantAge),
    conditionRating: input.conditionRating,
    qualityRating: input.qualityRating,
  });
  const lowValue = finiteValue(input.neighborhoodLowValue);
  const highValue = finiteValue(input.neighborhoodHighValue);
  const recommendedReview = highValue !== null && concludedValue > highValue
    ? 'over_improvement'
    : lowValue !== null && concludedValue < lowValue
      ? 'under_improvement'
      : '';
  const nonconformityType = String(input.nonconformityType || '').toLowerCase();
  const labelByType: Record<string, string> = {
    over_improvement: 'an over-improvement',
    under_improvement: 'an under-improvement',
    functional_obsolescence: 'affected by functional obsolescence',
    other: 'otherwise nonconforming',
  };
  const comparison = direction === 'at'
    ? `is consistent with the ${money(predominantValue)} median predominant value`
    : `is ${money(Math.abs(difference))} (${Math.abs(differencePercent).toFixed(1)}%) ${direction} the ${money(predominantValue)} median predominant value`;
  const support = reasons.length
    ? ` The difference is supported by the subject's ${reasons.join(', ')}.`
    : direction === 'at'
      ? ' Its physical characteristics and market appeal are generally consistent with the predominant housing in the defined area.'
      : ' The remaining difference reflects other market-recognized characteristics captured in the sales comparison analysis.';
  if (input.conformsToNeighborhood === false && labelByType[nonconformityType]) {
    const redevelopment = ['over_improvement', 'under_improvement'].includes(nonconformityType)
      ? ' Highest-and-best-use analysis should determine whether continued use, modification, redevelopment, or demolition produces the greatest value.'
      : ' The appraisal should explain the market effect of this nonconformity.';
    return {
      ready: true,
      relationship,
      difference,
      differencePercent,
      reasons,
      recommendedReview,
      narrative: `The subject's concluded value of ${money(concludedValue)} ${comparison}. The subject is identified as ${labelByType[nonconformityType]} and does not conform to the neighborhood.${support}${redevelopment}`,
    };
  }
  const rangeReview = recommendedReview
    ? ` The concluded value is outside the observed neighborhood ${recommendedReview === 'over_improvement' ? 'high' : 'low'} and warrants ${recommendedReview === 'over_improvement' ? 'over-improvement' : 'under-improvement'} review before conformity is finalized.`
    : ' The concluded value remains within the observed neighborhood range, and the subject conforms to the area despite its position relative to the median.';
  return {
    ready: true,
    relationship,
    difference,
    differencePercent,
    reasons,
    recommendedReview,
    narrative: `The subject's concluded value of ${money(concludedValue)} ${comparison}.${support}${rangeReview}`,
  };
}
