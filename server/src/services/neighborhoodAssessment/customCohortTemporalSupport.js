import { assessmentDate } from './contract.js';

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
    status: effective_date < retained_capture_at.slice(0, 10)
      ? 'historical_stock_evidence_required' : 'not_established',
    effective_date, retained_capture_at, stock_basis: 'current_mirror', historical_coverage: 'not_established',
  });
}
