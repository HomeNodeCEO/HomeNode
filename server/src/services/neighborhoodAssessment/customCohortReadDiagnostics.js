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
  'selection_source_mismatch', 'mapping_v2_required', 'mapping_v3_required', 'mapping_v4_required',
  'effective_date', 'start_date', 'end_date', 'json_limit', 'json_type', 'json_number', 'json_bytes',
  'invalid_input', 'invalid_account', 'invalid_assignment', 'invalid_operation', 'invalid_period',
  'invalid_selection', 'period_after_effective_date', 'invalid_private_sales_import',
  'invalid_reported_input', 'invalid_discovery', 'invalid_identity', 'invalid_reference',
  'invalid_version', 'invalid_workflow', 'input_limit',
]);
const FAMILIES = [
  ['custom_cohort_observation_preview_', 'observations'],
  ['custom_cohort_preview_presentation_', 'presentation'],
  ['invalid_neighborhood_assessment:', 'contract'],
];
export function customCohortReadDiagnostic(action, error) {
  if (!['catalog', 'preview', 'members'].includes(action) || !(error instanceof Error)) return null;
  if (error.code === 'CUSTOM_COHORT_CAPTURE_FAILED' && CHECKS.has(error.reason)) {
    return { action, family: 'coordinator', check: error.reason };
  }
  if (typeof error.code === 'string' && error.code.startsWith('custom_cohort_context_')) {
    const reason = error.code.slice('custom_cohort_context_'.length);
    return { action, family: 'context', check: CHECKS.has(reason) ? reason : 'unclassified' };
  }
  if (!(error instanceof TypeError)) return null;
  for (const [prefix, family] of FAMILIES) {
    if (!error.message.startsWith(prefix)) continue;
    const reason = error.message.slice(prefix.length);
    return { action, family, check: CHECKS.has(reason) ? reason : 'unclassified' };
  }
  return null;
}
