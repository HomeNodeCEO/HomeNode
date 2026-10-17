// Closed operational vocabulary only. Never log raw errors, source values,
// request bodies, identities, SQL, or arbitrary validator field paths.
const CHECKS = new Set([
  'unsupported_representation', 'member_kind', 'population_ownership', 'member_count_mismatch',
  'member_index', 'member_disposition', 'invalid_shape', 'array_limit', 'text_limit',
  'invalid_count', 'invalid_number', 'unsupported_value', 'unsupported_metrics',
  'unsupported_preview', 'context_mismatch', 'selection_mismatch', 'duplicate_pocket',
  'pocket_membership_limit', 'invalid_period', 'denominator_mismatch', 'invalid_coverage',
  'unsupported_semantics', 'output_bytes_limit', 'measurement_work_limit', 'member_work_limit',
  'observation_period', 'duplicate_account', 'roster_mismatch', 'scope_mismatch',
  'selection_revision', 'pocket_membership', 'mapping_profile_mismatch', 'source_role',
  'source_records_limit', 'source_chunks_limit', 'source_routing', 'source_roles_missing',
  'selection_source_mismatch', 'mapping_v2_required', 'mapping_v3_required', 'mapping_v4_required', 'mapping_v5_required',
  'effective_date', 'start_date', 'end_date', 'json_limit', 'json_type', 'json_number', 'json_bytes',
  'invalid_input', 'invalid_account', 'invalid_assignment', 'invalid_operation', 'invalid_period',
  'invalid_selection', 'period_after_effective_date', 'invalid_private_sales_import',
  'invalid_reported_input', 'invalid_discovery', 'invalid_identity', 'invalid_reference',
  'invalid_version', 'invalid_workflow', 'input_limit',
  'record_limit', 'route_record_limit', 'catalog_incomplete', 'metric_denominator',
]);
const FAMILIES = [
  ['custom_cohort_observation_preview_', 'observations'],
  ['custom_cohort_preview_presentation_', 'presentation'],
  ['invalid_neighborhood_assessment:', 'contract'],
  ['custom_cohort_reported_shared_sales_', 'reported_sales'],
  ['custom_cohort_reported_assessment_', 'reported_assessment'],
];
const VIEWPORT_INTERRUPTS = new Map([
  ['55P03', 'lock_unavailable'], ['57014', 'query_cancelled'],
  ['40001', 'serialization_failure'], ['40P01', 'deadlock_detected'],
  ['custom_cohort_execution_busy', 'admission_busy'],
  ['custom_cohort_execution_interrupted', 'admission_interrupted'],
]);
export function customCohortReadDiagnostic(action, error) {
  if (!['catalog', 'preview', 'members', 'reported-proposal', 'viewport', 'selection-viewport'].includes(action)
    || !(error instanceof Error)) return null;
  if (action === 'viewport' || action === 'selection-viewport') {
    const check = VIEWPORT_INTERRUPTS.get(error.code);
    if (check) return { action, family: 'interrupted', check };
    if (['cancelled', 'deadline_exceeded', 'connection_timeout', 'policy_timeout'].includes(error.reason))
      return { action, family: 'interrupted', check: error.reason };
    // Keep the viewport diagnostic deliberately closed. The response owner
    // still decides status/recovery; source data and SQL never enter logs.
    return null;
  }
  if (action === 'reported-proposal' && !error.outcome_unknown && error.code === 'CUSTOM_COHORT_CAPTURE_FAILED'
    && ['deadline_exceeded', 'cancelled'].includes(error.reason)) {
    return { action, family: 'coordinator', check: error.reason };
  }
  if (action === 'reported-proposal' && ['neighborhood_publication_bytes', 'neighborhood_publication_storage_bytes',
    'neighborhood_member_row_bytes', 'neighborhood_member_row_storage_bytes'].includes(error.code)) {
    return { action, family: 'publication', check: error.code.slice('neighborhood_'.length) };
  }
  if (error.code === 'CUSTOM_COHORT_CAPTURE_FAILED' && CHECKS.has(error.reason)) {
    return { action, family: 'coordinator', check: error.reason };
  }
  if (typeof error.code === 'string' && error.code.startsWith('custom_cohort_context_')) {
    const reason = error.code.slice('custom_cohort_context_'.length);
    return { action, family: 'context', check: CHECKS.has(reason) ? reason : 'unclassified' };
  }
  for (const [prefix, family] of error instanceof TypeError ? FAMILIES : []) {
    if (!error.message.startsWith(prefix)) continue;
    const reason = error.message.slice(prefix.length);
    return { action, family, check: CHECKS.has(reason) ? reason : 'unclassified' };
  }
  if (CHECKS.has(error.reason)) return { action, family: 'validator', check: error.reason };
  return null;
}
