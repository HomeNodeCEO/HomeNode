import { assessmentDate } from './contract.js';

// The current Custom neighborhood pilot is confined to North Texas. An
// appraisal effective date is a Texas civil date, not a UTC date: a capture at
// 01:00Z can still have happened on the same Texas appraisal day. Keep this
// conversion explicit and deterministic rather than using the server's zone.
const texasDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
});
export function customCohortTexasCivilDay(instant) {
  const parts = Object.fromEntries(texasDate.formatToParts(new Date(instant))
    .filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Internal exclusion for the currently installed current-mirror stock profiles.
 * The retained acquisition clock is not a field-validity date. A later capture
 * cannot establish the past neighborhood, while an earlier/same-day capture
 * still needs the existing source-period/coverage checks. Never use today's
 * clock: reopening unchanged evidence must not change this decision.
 * This does not filter transaction events by when their CSV was imported.
 */
export function customCohortCurrentStockSupport({ effective_date, retained_capture_at }) {
  assessmentDate(effective_date);
  if (typeof retained_capture_at !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(retained_capture_at)
    || !Number.isFinite(Date.parse(retained_capture_at))
    || new Date(retained_capture_at).toISOString() !== retained_capture_at) {
    throw Object.assign(new TypeError('custom_cohort_temporal_support_invalid_capture_time'), {
      code: 'CUSTOM_COHORT_TEMPORAL_SUPPORT_INVALID', reason: 'capture_time',
    });
  }
  return Object.freeze({
    status: effective_date < customCohortTexasCivilDay(retained_capture_at)
      ? 'historical_stock_evidence_required' : 'not_established',
    effective_date, retained_capture_at, stock_basis: 'current_mirror', historical_coverage: 'not_established',
  });
}
