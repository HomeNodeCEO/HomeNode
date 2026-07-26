import {
  normalizeUadRating,
  ratingScore,
  type RatingDimension,
} from './conditionQualityRatings';

export type StudyReliability = 'strong' | 'moderate' | 'limited';
export type StudyBasis = 'median' | 'average';

export type ConditionQualityStudyItem = {
  id: string;
  price: number;
  condition: string;
  quality: string;
};

export type ConditionQualityGroup = {
  rating: string;
  score: number;
  sampleSize: number;
  minimumPrice: number;
  maximumPrice: number;
  averagePrice: number;
  medianPrice: number;
};

export type ConditionQualityStudyOption = {
  id: StudyBasis;
  label: string;
  basis: StudyBasis;
  betterGroupPrice: number;
  worseGroupPrice: number;
  rawDifference: number;
  gradeDifference: number;
  amount: number;
  reliability: StudyReliability;
  recommended: boolean;
};

export type ConditionQualityTransition = {
  id: string;
  label: string;
  betterRating: string;
  worseRating: string;
  betterScore: number;
  worseScore: number;
  betterSampleSize: number;
  worseSampleSize: number;
  options: ConditionQualityStudyOption[];
};

export type ConditionQualityDimensionResult = {
  dimension: RatingDimension;
  label: string;
  groups: ConditionQualityGroup[];
  transitions: ConditionQualityTransition[];
};

export type ConditionQualityStudyResult = {
  selectedSaleCount: number;
  ratedSaleCount: number;
  condition: ConditionQualityDimensionResult;
  quality: ConditionQualityDimensionResult;
};

export type AppliedConditionQualityAdjustment = {
  id: string;
  dimension: RatingDimension;
  dimensionLabel: string;
  marketKey: string;
  marketLabel: string;
  transitionId: string;
  transitionLabel: string;
  betterRating: string;
  worseRating: string;
  optionId: StudyBasis;
  optionLabel: string;
  basis: StudyBasis;
  reliability: StudyReliability;
  baseAmount: number;
  factorPercent: number;
  amount: number;
  betterGroupPrice: number;
  worseGroupPrice: number;
  rawDifference: number;
  gradeDifference: number;
  selectedSaleCount: number;
};

export function conditionQualitySaleKey(sale: {
  source_record_id?: string | number | null;
  sale_id?: string | number | null;
  listing_id?: string | null;
  primary_account_id?: string | null;
  closing_date?: string | null;
}): string {
  if (sale.source_record_id != null) return `source-${sale.source_record_id}`;
  if (sale.sale_id != null) return `sale-${sale.sale_id}`;
  if (sale.listing_id) return `listing-${sale.listing_id}`;
  return `account-${sale.primary_account_id || 'unmatched'}-${sale.closing_date || ''}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundCurrency(value: number): number {
  return Math.round(value / 100) * 100;
}

function reliabilityForGroups(
  betterSampleSize: number,
  worseSampleSize: number,
): StudyReliability {
  const minimumSize = Math.min(betterSampleSize, worseSampleSize);
  if (minimumSize >= 5) return 'strong';
  if (minimumSize >= 3) return 'moderate';
  return 'limited';
}

function groupItems(
  items: ConditionQualityStudyItem[],
  dimension: RatingDimension,
): ConditionQualityGroup[] {
  const grouped = new Map<string, number[]>();
  items.forEach((item) => {
    const rating = normalizeUadRating(item[dimension], dimension);
    if (!rating || !Number.isFinite(item.price) || item.price <= 0) return;
    grouped.set(rating, [...(grouped.get(rating) || []), item.price]);
  });

  return [...grouped.entries()]
    .flatMap(([rating, prices]) => {
      const score = ratingScore(rating, dimension);
      if (score === null || !prices.length) return [];
      return [{
        rating,
        score,
        sampleSize: prices.length,
        minimumPrice: Math.min(...prices),
        maximumPrice: Math.max(...prices),
        averagePrice: average(prices),
        medianPrice: median(prices),
      }];
    })
    .sort((left, right) => left.score - right.score);
}

function buildTransition(
  dimension: RatingDimension,
  better: ConditionQualityGroup,
  worse: ConditionQualityGroup,
): ConditionQualityTransition {
  const gradeDifference = worse.score - better.score;
  const reliability = reliabilityForGroups(
    better.sampleSize,
    worse.sampleSize,
  );
  const buildOption = (
    basis: StudyBasis,
    betterGroupPrice: number,
    worseGroupPrice: number,
  ): ConditionQualityStudyOption => {
    const rawDifference = betterGroupPrice - worseGroupPrice;
    return {
      id: basis,
      label: `${basis === 'median' ? 'Median' : 'Average'} price difference`,
      basis,
      betterGroupPrice,
      worseGroupPrice,
      rawDifference,
      gradeDifference,
      amount: gradeDifference > 0
        ? roundCurrency(rawDifference / gradeDifference)
        : 0,
      reliability,
      recommended: basis === 'median',
    };
  };

  return {
    id: `${dimension}:${better.rating}:${worse.rating}`,
    label: `${better.rating} to ${worse.rating}`,
    betterRating: better.rating,
    worseRating: worse.rating,
    betterScore: better.score,
    worseScore: worse.score,
    betterSampleSize: better.sampleSize,
    worseSampleSize: worse.sampleSize,
    options: [
      buildOption('median', better.medianPrice, worse.medianPrice),
      buildOption('average', better.averagePrice, worse.averagePrice),
    ],
  };
}

function buildDimension(
  items: ConditionQualityStudyItem[],
  dimension: RatingDimension,
): ConditionQualityDimensionResult {
  const groups = groupItems(items, dimension);
  return {
    dimension,
    label: dimension === 'condition' ? 'Condition' : 'Quality',
    groups,
    transitions: groups.slice(0, -1).map((group, index) =>
      buildTransition(dimension, group, groups[index + 1])),
  };
}

export function calculateConditionQualityStudy(
  items: ConditionQualityStudyItem[],
): ConditionQualityStudyResult {
  const validItems = items.filter(
    (item) => item.id && Number.isFinite(item.price) && item.price > 0,
  );
  return {
    selectedSaleCount: items.length,
    ratedSaleCount: validItems.length,
    condition: buildDimension(validItems, 'condition'),
    quality: buildDimension(validItems, 'quality'),
  };
}

export function calculateRatingAdjustment(
  rate: number,
  subjectRating: string,
  comparableRating: string,
  dimension: RatingDimension,
): number {
  const subjectScore = ratingScore(subjectRating, dimension);
  const comparableScore = ratingScore(comparableRating, dimension);
  if (
    subjectScore === null ||
    comparableScore === null ||
    !Number.isFinite(rate)
  ) {
    return 0;
  }
  return roundCurrency((comparableScore - subjectScore) * rate);
}

export function factoredStudyAmount(
  amount: number,
  factorPercent: number,
): number {
  if (!Number.isFinite(amount) || !Number.isFinite(factorPercent)) return 0;
  return roundCurrency((amount * factorPercent) / 100);
}
