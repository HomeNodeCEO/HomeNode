import { types } from 'node:util';
import { canonicalAssessmentJson as json } from './contract.js';
import { neighborhoodMemberSetDigest } from './assessmentRepository.js';
import { prepareCustomCohortContextHeader, prepareCustomCohortContextScope } from './customCohortContextContract.js';
import { prepareCustomCohortCaptureInputs, CUSTOM_COHORT_CAPTURE_INPUT_LIMITS } from './customCohortCaptureInputs.js';
import { prepareCustomNeighborhoodWorkspaceCheckpoint } from './customWorkspaceCheckpoint.js';
import { buildCustomCohortObservationPreview } from './customCohortObservationPreview.js';
import { buildCustomCohortSelectionCatalog, customCohortCatalogGroupLimit } from './customCohortPocketCatalog.js';

export const CUSTOM_COHORT_ASSESSMENT_PREPARATION_LIMITS = Object.freeze({
  input_nodes: 2_000_000, input_depth: 40,
  input_string_utf8_bytes: CUSTOM_COHORT_CAPTURE_INPUT_LIMITS.logical_utf8_bytes,
  output_utf8_bytes: 32_768,
});
const L = CUSTOM_COHORT_ASSESSMENT_PREPARATION_LIMITS;
const EVIDENCE = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const UNASSIGNED = 'discovery:unassigned';
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function fail(reason) {
  throw Object.assign(new TypeError(`custom_cohort_assessment_preparation_${reason}`), {
    code: 'CUSTOM_COHORT_ASSESSMENT_PREPARATION_INVALID', reason,
  });
}
function check(ok, reason) { if (!ok) fail(reason); }
function closed(value, keys) {
  check(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'input_shape');
}
// Walk descriptors, not getters/toJSON. Do not stringify/copy a whole retained
// graph: it can legitimately exceed the contract's per-document JSON ceiling.
function plainData(input) {
  const ancestors = new Set(), stack = [[input, 0, false]];
  let nodes = 0, bytes = 0;
  while (stack.length) {
    const [value, depth, leaving] = stack.pop();
    if (leaving) { ancestors.delete(value); continue; }
    check(++nodes <= L.input_nodes && depth <= L.input_depth, 'input_limit');
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value); check(bytes <= L.input_string_utf8_bytes, 'input_limit'); continue;
    }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) continue;
    check(value && typeof value === 'object' && !types.isProxy(value), 'plain_data_required');
    const isArray = Array.isArray(value);
    check(Object.getPrototypeOf(value) === (isArray ? Array.prototype : Object.prototype)
      && !ancestors.has(value), 'plain_data_required');
    if (isArray) check(value.length <= L.input_nodes, 'input_limit');
    const keys = Reflect.ownKeys(value);
    check(nodes + stack.length + keys.length <= L.input_nodes, 'input_limit');
    check(!isArray || keys.length === value.length + 1, 'plain_data_required');
    ancestors.add(value); stack.push([value, depth, true]);
    for (const key of keys) {
      if (isArray && key === 'length') continue;
      check(typeof key === 'string', 'plain_data_required');
      if (isArray) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length, 'plain_data_required');
      bytes += Buffer.byteLength(key); check(bytes <= L.input_string_utf8_bytes, 'input_limit');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), 'plain_data_required');
      stack.push([descriptor.value, depth + 1, false]);
    }
  }
}
const same = (a, b) => json(a) === json(b); // Small closed bindings only.
function counts(all, chosen = null) {
  const stock = chosen === null ? all.stock.members : all.stock.members.filter(row => chosen.has(row.account_id));
  const associated = row => chosen === null || row.associated_account_ids.some(id => chosen.has(id));
  const transactions = all.transactions.members.filter(associated);
  return {
    discovery_accounts: stock.length,
    parcel_objects: stock.reduce((sum, row) => sum + row.parcel_object_ids.length, 0),
    canonical_transactions_in_period: transactions.length,
    transactions_with_multiple_parcel_evidence: transactions.filter(row => row.multiple_parcel_evidence).length,
    source_records_all_dates: all.source_reported.members.filter(associated).length,
  };
}

/** Pure diagnostic admission for an owner-loaded retained Custom capture.
 * Callers still own authorization, provider rights, exact loading and freshness.
 * A valid hash/selection proves neither evidence truth nor issuer authority.
 * This module deliberately has NO supported-facts input or report-ready branch;
 * it does not assemble/publish an assessment, persist, or change accepted data.
 */
export function prepareCustomCohortAssessmentPreparation(input) {
  plainData(input);
  closed(input, ['context_header_json', 'expected', 'retained_inputs', 'selection',
    ...(Object.hasOwn(input, 'catalog_version') ? ['catalog_version'] : [])]);
  const catalogVersion = Object.hasOwn(input, 'catalog_version') ? input.catalog_version : 1;
  customCohortCatalogGroupLimit(catalogVersion);
  closed(input.expected, ['context_ref', 'target', 'observation_period']);
  const { expected, retained_inputs: retained } = input;
  const header = prepareCustomCohortContextHeader(input.context_header_json);
  const target = prepareCustomCohortContextScope(json(expected.target));
  const active = prepareCustomNeighborhoodWorkspaceCheckpoint({ workspace_version: catalogVersion === 2 ? 5 : 1,
    active: { context_ref: expected.context_ref, observation_period: expected.observation_period, selection: input.selection },
    pending_capture: null }).active;
  check(same(header.context_ref, active.context_ref), 'context_mismatch');
  const h = header.body;
  check(same(target, { organization_id: h.target.organization_id, report_file_id: h.target.report_file_id,
    assignment_file_id: h.target.workflow_target_id, account_id: h.target.account_id }), 'target_mismatch');
  // Rebuild the retained graph's four dependencies; merely trusting a caller's
  // copied refs would allow current CAD rows to be substituted under an old hash.
  const prepared = prepareCustomCohortCaptureInputs(retained);
  for (const key of EVIDENCE) check(same(h[key], prepared.refs[key]), 'retained_evidence_mismatch');
  check(h.context_id === retained.acquisition_intent.body.operation_id, 'capture_identity_mismatch');
  const subjectTarget = retained.subject.target;
  check(same(h.target, { organization_id: subjectTarget.organization_id, report_file_id: subjectTarget.report_file_id,
    workflow_type: 'custom_appraisal', workflow_target_id: subjectTarget.assignment_file_id,
    account_id: subjectTarget.account_id, appraisal_case_id: subjectTarget.appraisal_case_id,
    subject_snapshot_id: subjectTarget.subject_snapshot_id, snapshot_version: subjectTarget.snapshot_version }), 'subject_target_mismatch');
  check(h.effective_date === retained.subject.effective_date, 'effective_date_mismatch');
  check(same(active.observation_period, retained.study.observation_period), 'observation_period_mismatch');

  // One baseline computation; group changes resolve the exact account union.
  // Diagnostics count existing member rows, never recompute/report an alternate
  // statistic or assign a package's whole price to individual selected parcels.
  const preview = buildCustomCohortObservationPreview({ context_ref: active.context_ref,
    retained_inputs: retained, selection: { revision: active.selection.revision, pockets: [] } });
  const catalog = buildCustomCohortSelectionCatalog({ retained_inputs: retained, preview, catalog_version: catalogVersion });
  const groups = new Map(catalog.pockets.map(pocket => [pocket.id, pocket.account_ids]));
  if (catalog.unassigned.member_count > 0) groups.set(UNASSIGNED, catalog.unassigned.account_ids);
  const selected = new Set();
  for (const id of active.selection.included_recorded_group_ids) {
    check(groups.has(id), 'unknown_recorded_group');
    for (const accountId of groups.get(id)) selected.add(accountId);
  }
  const result = {
    preparation_version: 1, status: 'incomplete', purpose: 'assessment_preparation_diagnostic', authority: 'not_established',
    binding: { context_ref: active.context_ref, target, selection: active.selection,
      selected_account_set_sha256: neighborhoodMemberSetDigest([...selected]) },
    effective_date: h.effective_date, observation_period: active.observation_period, captured_at: preview.captured_at,
    selection_resolution: { status: 'resolved', basis: 'retained_recorded_label_catalog',
      catalog_complete: catalog.catalog_complete, catalog_status: catalog.status,
      selected_account_count: selected.size, subject_included: selected.has(target.account_id),
      legal_subdivision_identity: 'not_established', housing_and_competitive_eligibility: 'not_established' },
    observations: { basis: 'retained_observations_not_supported_assessment_populations',
      transaction_period_basis: 'stored_canonical_closing_date',
      stock_temporal_basis: 'current_mirror_observation', source_temporal_basis: 'all_dates_retained_source_rows',
      all: counts(preview.all), selected: counts(preview.all, selected) },
    runtime_requirements: { authorization: 'not_checked', provider_rights: 'not_checked', subject_freshness: 'not_checked' },
    support_gaps: [...preview.support_gaps], unavailable_metrics: { ...preview.unavailable_metrics },
    assessment: null, publication: null,
    apply: { status: 'blocked', reasons: ['supported_fact_resolver_unavailable',
      ...(selected.size ? [] : ['empty_selection']), ...(catalog.catalog_complete ? [] : ['recorded_group_catalog_incomplete']),
      ...preview.support_gaps] },
  };
  check(Buffer.byteLength(json(result)) <= (catalogVersion === 2 ? 131_072 : L.output_utf8_bytes), 'output_limit');
  return freeze(result);
}
