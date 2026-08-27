import type { AppliedGroupedAdjustment } from '@/components/GroupedAdjustmentAnalysis';

export const COMPARABLE_COUNT = 6;
export const SECONDARY_COMPARABLE_COUNT = 6;
export const LISTING_COUNT = 6;

export type SalesAnalysisPeriodMonths = 12 | 24 | 36;

export type CostToCureLine = {
  id: string;
  description: string;
  cost: string;
};

let costToCureLineSequence = 0;

export function createCostToCureLine(
  description = '',
  cost: string | number = '',
): CostToCureLine {
  costToCureLineSequence += 1;
  return {
    id: `repair-${Date.now()}-${costToCureLineSequence}`,
    description,
    cost: cost === '' ? '' : String(cost),
  };
}

export function swapArrayItems<T>(values: T[], from: number, to: number): T[] {
  const next = [...values];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function compactComparableSlots<T>(
  values: T[],
  retainedSlots: number[],
  createEmptyValue: () => T,
): T[] {
  return [
    ...retainedSlots.map((slot) => values[slot]),
    ...Array.from(
      { length: Math.max(0, COMPARABLE_COUNT - retainedSlots.length) },
      createEmptyValue,
    ),
  ];
}

export function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function monthsBeforeDate(value: string, months: SalesAnalysisPeriodMonths): string {
  const date = new Date(`${value}T12:00:00`);
  if (Number.isNaN(date.getTime())) return '';
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - months);
  const finalDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, finalDay));
  return localDateString(date);
}

export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function booleanValue(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', 't', 'yes', 'y', '1'].includes(normalized)) return true;
  if (['false', 'f', 'no', 'n', '0', 'none'].includes(normalized)) return false;
  return null;
}

export function garageSpacesFromArea(value: unknown): number | null {
  const area = finiteNumber(value);
  if (area === null || area <= 0) return null;
  return Math.max(1, Math.min(12, Math.round(area / 225)));
}

export function calculatePoolGroupedAdjustment(
  adjustments: AppliedGroupedAdjustment[],
  subjectValue: boolean | null,
  comparableValue: boolean | null,
): number {
  if (subjectValue === null || comparableValue === null || subjectValue === comparableValue) return 0;
  const poolAdjustment = adjustments
    .filter((adjustment) => adjustment.dimensionKey === 'pool')
    .reduce((total, adjustment) => total + adjustment.amount, 0);
  return subjectValue ? poolAdjustment : -poolAdjustment;
}

export function calculateLivingAreaGroupedAdjustment(
  adjustments: AppliedGroupedAdjustment[],
  subjectValue: number | null,
  comparableValue: number | null,
): number {
  if (subjectValue === null || comparableValue === null || subjectValue === comparableValue) return 0;
  const eligibleAdjustments = adjustments.filter(
    (adjustment) => adjustment.dimensionKey === 'living_area',
  );
  const selectedAdjustment = eligibleAdjustments[eligibleAdjustments.length - 1];
  if (!selectedAdjustment) return 0;
  const signedDifference = (subjectValue - comparableValue) * selectedAdjustment.amount;
  return Math.round(signedDifference / 100) * 100;
}
