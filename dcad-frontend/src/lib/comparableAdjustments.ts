export type NumericGroupedAdjustment = {
  dimensionKey: string;
  fromGroupValue: number | boolean;
  toGroupValue: number | boolean;
  amount: number;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert the application's full/half-bath notation to equivalent full baths.
 *
 * Examples:
 *   2 full + 1 half (2.1 display notation) = 2.5 equivalent baths
 *   2 full + 2 half (2.2 display notation) = 3 equivalent baths
 */
export function bathroomEquivalentValue(
  totalInteger: unknown,
  fullBaths: unknown,
  halfBaths: unknown,
  cadBathCount?: unknown,
): number | null {
  const full = finiteNumber(fullBaths);
  const half = finiteNumber(halfBaths);
  if (full !== null || half !== null) {
    return Math.max(0, Math.round(full || 0) + (Math.round(half || 0) * 0.5));
  }

  // CAD stores bath counts as full.halfCount rather than a decimal value.
  // For example, 2.2 means two full and two half baths, which equals 3.0.
  const cadCount = finiteNumber(cadBathCount);
  if (cadCount !== null && cadCount >= 0) {
    const whole = Math.floor(cadCount);
    const halfCount = Math.round((cadCount - whole) * 10);
    return whole + (Math.max(0, halfCount) * 0.5);
  }

  // The MLS total is the least detailed fallback because it cannot identify
  // how many of its reported bathrooms are half baths.
  const explicitTotal = finiteNumber(totalInteger);
  return explicitTotal !== null && explicitTotal >= 0 ? Math.round(explicitTotal) : null;
}

/**
 * Apply the currently selected grouped study as one universal per-unit rate.
 *
 * The transition that produced the study (for example, 1-to-2 baths) is market
 * evidence for the rate, not a restriction on where the rate can be used.
 * Fractional bathroom differences receive the same fractional share of that
 * selected full-bath rate, while the sign follows appraisal convention:
 * add for an inferior comparable and subtract for a superior comparable.
 */
export function calculateNumericGroupedAdjustment(
  adjustments: NumericGroupedAdjustment[],
  dimensionKey: string,
  subjectValue: number | null,
  comparableValue: number | null,
): number {
  if (subjectValue === null || comparableValue === null || subjectValue === comparableValue) return 0;

  const eligibleAdjustments = adjustments.filter((adjustment) => (
    adjustment.dimensionKey === dimensionKey &&
    typeof adjustment.fromGroupValue === 'number' &&
    typeof adjustment.toGroupValue === 'number'
  ));
  const selectedAdjustment = eligibleAdjustments[eligibleAdjustments.length - 1];
  if (!selectedAdjustment) return 0;

  const signedDifference = (
    subjectValue - comparableValue
  ) * selectedAdjustment.amount;
  const roundedDifference = Math.round(signedDifference);
  return roundedDifference === 0 ? 0 : roundedDifference;
}
