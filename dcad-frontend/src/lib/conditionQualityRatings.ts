export const UAD_CONDITION_RATINGS = [
  'C1',
  'C2-C1',
  'C2',
  'C3-C2',
  'C3',
  'C4-C3',
  'C4',
  'C5-C4',
  'C5',
  'C6-C5',
  'C6',
] as const;

export const UAD_QUALITY_RATINGS = [
  'Q1',
  'Q2-Q1',
  'Q2',
  'Q3-Q2',
  'Q3',
  'Q4-Q3',
  'Q4',
  'Q5-Q4',
  'Q5',
  'Q6-Q5',
  'Q6',
] as const;

export type RatingDimension = 'condition' | 'quality';

export type RatingPriceItem = {
  id: string;
  price: number;
};

export type RatedPriceItem = RatingPriceItem & {
  condition: string;
  quality: string;
};

export type AutoRatingSuggestion = {
  id: string;
  condition: string;
  quality: string;
};

export type AutoRatingResult = {
  suggestions: AutoRatingSuggestion[];
  conditionSplitFound: boolean;
  qualitySplitFound: boolean;
};

export type DerivedRatingAdjustment = {
  id: string;
  conditionAdjustment: number;
  qualityAdjustment: number;
};

export type RatingAdjustmentResult = {
  adjustments: DerivedRatingAdjustment[];
  conditionRate: number;
  qualityRate: number;
  conditionBaselineMedian: number | null;
  postConditionQualityMedian: number | null;
  conditionEvidenceGroups: number;
  qualityEvidenceGroups: number;
  lowConfidence: boolean;
};

const MINIMUM_GROUP_SIZE = 2;
const MINIMUM_PRICE_GAP = 15_000;
const MINIMUM_PRICE_GAP_PERCENT = 0.075;

export function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

export function normalizeUadRating(
  value: unknown,
  dimension: RatingDimension,
): string {
  const normalized = String(value ?? '').trim().toUpperCase();
  const ratings = dimension === 'condition'
    ? UAD_CONDITION_RATINGS
    : UAD_QUALITY_RATINGS;
  return ratings.includes(normalized as never) ? normalized : '';
}

export function ratingScore(value: unknown, dimension: RatingDimension): number | null {
  const normalized = normalizeUadRating(value, dimension);
  if (!normalized) return null;
  const numbers = (normalized.match(/[1-6]/g) || [])
    .map((part) => Number(part))
    .filter(Number.isFinite);
  if (!numbers.length) return null;
  return numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
}

export function shiftRating(
  value: string,
  dimension: RatingDimension,
  gradeDifference: number,
): string {
  const score = ratingScore(value, dimension);
  if (score === null) return '';
  const targetScore = Math.max(1, Math.min(6, score + gradeDifference));
  const ratings = dimension === 'condition'
    ? UAD_CONDITION_RATINGS
    : UAD_QUALITY_RATINGS;
  return ratings.reduce((closest, rating) => {
    const ratingValue = ratingScore(rating, dimension) ?? 6;
    const closestValue = ratingScore(closest, dimension) ?? 6;
    return Math.abs(ratingValue - targetScore) < Math.abs(closestValue - targetScore)
      ? rating
      : closest;
  }, ratings[0]);
}

function findMeaningfulSplit(items: RatingPriceItem[]): {
  lower: RatingPriceItem[];
  upper: RatingPriceItem[];
} | null {
  if (items.length < MINIMUM_GROUP_SIZE * 2) return null;
  const sorted = [...items].sort((a, b) => a.price - b.price);
  const center = median(sorted.map((item) => item.price)) ?? 0;
  const requiredGap = Math.max(
    MINIMUM_PRICE_GAP,
    Math.abs(center) * MINIMUM_PRICE_GAP_PERCENT,
  );

  let splitIndex = -1;
  let largestGap = -Infinity;
  for (
    let index = MINIMUM_GROUP_SIZE - 1;
    index <= sorted.length - MINIMUM_GROUP_SIZE - 1;
    index += 1
  ) {
    const gap = sorted[index + 1].price - sorted[index].price;
    if (gap >= requiredGap && gap > largestGap) {
      largestGap = gap;
      splitIndex = index;
    }
  }

  if (splitIndex < 0) return null;
  return {
    lower: sorted.slice(0, splitIndex + 1),
    upper: sorted.slice(splitIndex + 1),
  };
}

/**
 * Produce editable placeholder ratings from the selected comparable prices.
 *
 * The lower-price cluster is treated as subject-equivalent. A meaningful
 * premium first produces a one-grade condition improvement. A second
 * meaningful premium within that superior-condition cluster produces a
 * one-grade quality improvement.
 */
export function inferAutoRatings(
  items: RatingPriceItem[],
  subjectCondition: string,
  subjectQuality: string,
): AutoRatingResult {
  const normalizedCondition = normalizeUadRating(subjectCondition, 'condition');
  const normalizedQuality = normalizeUadRating(subjectQuality, 'quality');
  const validItems = items.filter(
    (item) => item.id && Number.isFinite(item.price) && item.price > 0,
  );

  const suggestions = new Map(
    validItems.map((item) => [
      item.id,
      {
        id: item.id,
        condition: normalizedCondition,
        quality: normalizedQuality,
      },
    ]),
  );

  if (!normalizedCondition || !normalizedQuality) {
    return {
      suggestions: [...suggestions.values()],
      conditionSplitFound: false,
      qualitySplitFound: false,
    };
  }

  const conditionSplit = findMeaningfulSplit(validItems);
  const conditionSuperiorItems = conditionSplit?.upper ?? validItems;
  if (conditionSplit) {
    const superiorCondition = shiftRating(
      normalizedCondition,
      'condition',
      -1,
    );
    conditionSuperiorItems.forEach((item) => {
      const suggestion = suggestions.get(item.id);
      if (suggestion) suggestion.condition = superiorCondition;
    });
  }

  const qualitySplit = findMeaningfulSplit(conditionSuperiorItems);
  if (qualitySplit) {
    const superiorQuality = shiftRating(normalizedQuality, 'quality', -1);
    qualitySplit.upper.forEach((item) => {
      const suggestion = suggestions.get(item.id);
      if (suggestion) suggestion.quality = superiorQuality;
    });
  }

  return {
    suggestions: [...suggestions.values()],
    conditionSplitFound: Boolean(conditionSplit),
    qualitySplitFound: Boolean(qualitySplit),
  };
}

function groupMedians<T>(
  items: T[],
  scoreForItem: (item: T) => number | null,
  priceForItem: (item: T) => number,
): Map<number, { median: number; count: number }> {
  const groups = new Map<number, number[]>();
  items.forEach((item) => {
    const score = scoreForItem(item);
    const price = priceForItem(item);
    if (score === null || !Number.isFinite(price)) return;
    groups.set(score, [...(groups.get(score) || []), price]);
  });

  return new Map(
    [...groups.entries()].flatMap(([score, prices]) => {
      const groupMedian = median(prices);
      return groupMedian === null
        ? []
        : [[score, { median: groupMedian, count: prices.length }] as const];
    }),
  );
}

function derivePerGradeRate(
  groups: Map<number, { median: number; count: number }>,
  subjectScore: number,
): {
  rate: number;
  baselineMedian: number | null;
  evidenceGroups: number;
  lowConfidence: boolean;
} {
  const baseline = groups.get(subjectScore);
  if (!baseline) {
    return {
      rate: 0,
      baselineMedian: null,
      evidenceGroups: 0,
      lowConfidence: true,
    };
  }

  const rates: number[] = [];
  let lowConfidence = baseline.count < MINIMUM_GROUP_SIZE;
  groups.forEach((group, score) => {
    if (score === subjectScore) return;
    const gradeDifference = subjectScore - score;
    const priceDifference = group.median - baseline.median;
    // Better ratings have lower numbers and should carry higher prices.
    if (!gradeDifference || priceDifference * gradeDifference <= 0) return;
    rates.push(Math.abs(priceDifference / gradeDifference));
    if (group.count < MINIMUM_GROUP_SIZE) lowConfidence = true;
  });

  return {
    rate: Math.round(median(rates) || 0),
    baselineMedian: baseline.median,
    evidenceGroups: rates.length,
    lowConfidence,
  };
}

/**
 * Derive one consistent per-grade condition rate, then one consistent
 * per-grade quality rate from the remaining price premium.
 */
export function deriveRatingAdjustments(
  items: RatedPriceItem[],
  subjectCondition: string,
  subjectQuality: string,
): RatingAdjustmentResult {
  const conditionScore = ratingScore(subjectCondition, 'condition');
  const qualityScore = ratingScore(subjectQuality, 'quality');
  const validItems = items.filter(
    (item) => item.id && Number.isFinite(item.price) && item.price > 0,
  );

  const emptyResult: RatingAdjustmentResult = {
    adjustments: validItems.map((item) => ({
      id: item.id,
      conditionAdjustment: 0,
      qualityAdjustment: 0,
    })),
    conditionRate: 0,
    qualityRate: 0,
    conditionBaselineMedian: null,
    postConditionQualityMedian: null,
    conditionEvidenceGroups: 0,
    qualityEvidenceGroups: 0,
    lowConfidence: true,
  };
  if (conditionScore === null || qualityScore === null) return emptyResult;

  const conditionGroups = groupMedians(
    validItems.filter(
      (item) => ratingScore(item.quality, 'quality') === qualityScore,
    ),
    (item) => ratingScore(item.condition, 'condition'),
    (item) => item.price,
  );
  const conditionEvidence = derivePerGradeRate(conditionGroups, conditionScore);

  const conditionAdjustedItems = validItems.map((item) => {
    const comparableScore = ratingScore(item.condition, 'condition');
    const conditionAdjustment = comparableScore === null
      ? 0
      : Math.round(
        (comparableScore - conditionScore) * conditionEvidence.rate,
      );
    return {
      ...item,
      conditionAdjustment,
      postConditionPrice: item.price + conditionAdjustment,
    };
  });

  const qualityGroups = groupMedians(
    conditionAdjustedItems,
    (item) => ratingScore(item.quality, 'quality'),
    (item) => item.postConditionPrice,
  );
  const qualityEvidence = derivePerGradeRate(qualityGroups, qualityScore);

  return {
    adjustments: conditionAdjustedItems.map((item) => {
      const comparableScore = ratingScore(item.quality, 'quality');
      return {
        id: item.id,
        conditionAdjustment: item.conditionAdjustment,
        qualityAdjustment: comparableScore === null
          ? 0
          : Math.round(
            (comparableScore - qualityScore) * qualityEvidence.rate,
          ),
      };
    }),
    conditionRate: conditionEvidence.rate,
    qualityRate: qualityEvidence.rate,
    conditionBaselineMedian: conditionEvidence.baselineMedian,
    postConditionQualityMedian: qualityEvidence.baselineMedian,
    conditionEvidenceGroups: conditionEvidence.evidenceGroups,
    qualityEvidenceGroups: qualityEvidence.evidenceGroups,
    lowConfidence: conditionEvidence.lowConfidence || qualityEvidence.lowConfidence,
  };
}
