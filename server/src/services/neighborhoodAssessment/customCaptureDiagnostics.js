// Operational metadata only. Never log the Error itself, SQL, credentials,
// source rows, account IDs, source filenames, policy text or request bodies.
const STAGES = new Map([
  ['spatial_incomplete', 'spatial'], ['selector_incomplete', 'selector'],
  ['transaction_identity_incomplete', 'transaction_identity'], ['source_incomplete', 'source'],
]);
const CAPACITY = new Set(['account_limit', 'parcel_limit', 'record_limit', 'identity_limit',
  'byte_limit', 'row_bytes_limit', 'query_limit', 'query_evidence_limit', 'capture_budget_limit',
  'account_roster_canonical_byte_limit']);
const INTERRUPTED = new Set(['duration_limit', 'capture_cancelled', 'connection_timeout']);
const CHECKS = new Set([...CAPACITY, ...INTERRUPTED, 'source_query_unavailable',
  'duplicate_source_identity', 'source_identity_missing', 'transaction_association_drift',
  'capture_time_unavailable', 'historical_knowledge_capture_required', 'cached_geometry_ineligible',
  'parcel_provenance_incomplete', 'parcel_account_unresolved', 'identity_closure_invalid',
  'parcels:origin_run_unknown', 'parcels:selected_accounts_not_covered', 'parcels:sync_state_unknown',
  'parcels:last_run_unknown', 'parcels:sync_not_complete', 'parcels:sync_success_unverifiable',
  'parcels:sync_count_contradiction', 'parcels:origin_run_not_complete']);
const COUNTERS = ['queries', 'records', 'bytes', 'accounts', 'parcels', 'source_records', 'identity_records'];

export function customCaptureDiagnostic(error) {
  if (error?.code !== 'CUSTOM_COHORT_CAPTURE_FAILED' || !STAGES.has(error.reason)) return null;
  const values = Array.isArray(error.detail) ? error.detail : [error.detail];
  const checks = [...new Set(values.slice(0, 16).map(value => CHECKS.has(value) ? value : 'unclassified'))].sort();
  if (values.length > 16 && !checks.includes('unclassified')) checks.push('unclassified');
  const counts = {};
  for (const key of COUNTERS) {
    const value = error.capture_counts?.[key];
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value;
  }
  // Mixed/incomplete source problems keep the conservative unavailable code.
  const category = checks.length && checks.every(check => CAPACITY.has(check)) ? 'capacity'
    : checks.length && checks.every(check => INTERRUPTED.has(check)) ? 'interrupted' : 'unavailable';
  return { stage: STAGES.get(error.reason), category, checks, counts };
}
