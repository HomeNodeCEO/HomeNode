import type { CustomWorkspaceObservationPeriod } from './customWorkspaceCheckpoint';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parsedIsoDate(value: string | null | undefined): Date | null {
  const match = ISO_DATE.exec(String(value || '').trim());
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day ? parsed : null;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Inclusive rolling window ending on the appraisal effective date. The day
 * after the same calendar date N months earlier is the first included day.
 * This matches the report contract's 2023-07-01 through 2024-06-30 example.
 */
export function customWorkspaceDefaultObservationPeriod(
  effectiveDate: string | null | undefined,
  months = 24,
): CustomWorkspaceObservationPeriod | null {
  const end = parsedIsoDate(effectiveDate);
  if (!end || !Number.isSafeInteger(months) || months < 1 || months > 120) return null;
  const targetMonth = end.getUTCMonth() - months;
  const targetYear = end.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastTargetDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const start = new Date(Date.UTC(targetYear, normalizedMonth, Math.min(end.getUTCDate(), lastTargetDay)));
  start.setUTCDate(start.getUTCDate() + 1);
  return Object.freeze({ start_date: isoDate(start), end_date: isoDate(end) });
}
