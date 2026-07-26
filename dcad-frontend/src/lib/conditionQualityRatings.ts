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

/**
 * UAD ranges represent half grades. Lower scores indicate better ratings:
 * C3-C2 = 2.5, C4-C3 = 3.5, Q4 = 4, and so on.
 */
export function ratingScore(
  value: unknown,
  dimension: RatingDimension,
): number | null {
  const normalized = normalizeUadRating(value, dimension);
  if (!normalized) return null;
  const numbers = (normalized.match(/[1-6]/g) || [])
    .map((part) => Number(part))
    .filter(Number.isFinite);
  if (!numbers.length) return null;
  return numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
}
