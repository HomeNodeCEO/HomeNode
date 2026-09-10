import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest } from './contract.js';
import { createCustomCohortDecisionEvidenceResolver } from './customCohortDecisionEvidence.js';
import { buildCustomCohortObservationPreview } from './customCohortObservationPreview.js';
import { buildCustomCohortPocketCatalog } from './customCohortPocketCatalog.js';
import { neighborhoodMemberSetDigest } from './assessmentRepository.js';
import { buildCachedNeighborhoodInputs } from './cachedRecords.js';
import { summarizeNeighborhoodPopulations } from './statistics.js';
import { CUSTOM_COHORT_REVIEW_STATE_LIMITS } from './customCohortReviewRepository.js';

export const CUSTOM_COHORT_SUPPORTED_INPUT_LIMITS = Object.freeze({
  review_nodes: 1_000_000, review_depth: 32, evidence_resolutions: 250_000,
  derived_source_utf8_bytes: 32 * 1024 * 1024, output_utf8_bytes: 64 * 1024 * 1024,
});
const L = CUSTOM_COHORT_SUPPORTED_INPUT_LIMITS, RL = CUSTOM_COHORT_REVIEW_STATE_LIMITS;
const REQUIRED = ['sale_completion', 'closing_date', 'recorded_consideration',
  'economic_property_membership', 'completed_home_at_closing', 'transaction_equivalence'];
const HOUSING = ['single_family_detached', 'single_family_attached', 'condominium_unit',
  'manufactured_home', 'two_to_four_units', 'nonresidential', 'vacant_land', 'other'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => json(a) === json(b);
const sorted = values => [...new Set(values)].sort(compare);
const refKey = ref => json(ref);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const PROFILE_BODY = freeze({
  profile_id: 'custom-retained-reviewer-reconstruction-v1', profile_revision: '1',
  support_basis: 'retained_reviewer_reconstruction', authority: 'not_established',
  housing_catalog: { id: 'custom-reviewed-housing-v1', revision: '1', codes: HOUSING },
  eligible_housing: 'exact_current_reviewed_subject_housing_code',
  residential_subject_codes: HOUSING.slice(0, 5),
  cad_provider_key: 'local:gis.dcad_parcels', jurisdiction: 'exact_retained_account_county',
  required_fitness_fact_kinds: REQUIRED,
  fitness_meaning: 'compatible_is_retained_reviewer_assertion_of_completed_named_study_fitness_and_condition_review',
  conditions: 'all_current_condition_heads_exactly_referenced_known_absent;empty_history_is_not_independent_absence_evidence',
  equivalence: 'explicit_consistent_full_retained_candidate_classes_including_original_canonical_groups',
  consideration: 'reviewed_recorded_total_sale_price_USD_exact_retained_canonical_amount',
  interests: 'complete_one_to_one_retained_CAD_accounts_no_fractional_or_unmapped_interests',
  temporal: 'field_specific_validity;observed_at_not_after_captured_at;available_at_is_declared_availability_not_local_capture;all_not_after_derivation',
  dependencies: 'current_exact_head_refs_only;latest_unknown_masks_older_claims',
  nonfitness_dependencies: 'no_interpretation_installed;additional_decision_dependencies_remain_unavailable',
  optional_fields: 'physical_CAD_value_tax_year_GLA_at_sale_allocation_all_null',
  coverage: 'full_retained_selected_roster_and_all_date_candidates_not_real_world_provider_completeness',
  actor_meaning: 'retained_actor_identity_only_not_licensure_or_signing_authority',
  base_source_interpretation: 'not_installed;reviews_are_sparse_overrides_not_a_population_limit',
  report_apply: 'blocked_pending_owner_adoption_and_publication',
});
const PROFILE = freeze({ ...PROFILE_BODY, profile_sha256: sha(json(PROFILE_BODY)) });
export function getCustomCohortSupportedInputsProfile() { return PROFILE; }
function fail(reason) {
  throw Object.assign(new TypeError(`custom_cohort_supported_inputs_${reason}`), {
    code: 'CUSTOM_COHORT_SUPPORTED_INPUTS_INVALID', reason,
  });
}
function check(ok, reason) { if (!ok) fail(reason); }
function closed(value, keys) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'input_shape');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value')), 'input_shape');
}
function plainReview(value) {
  const stack = [[value, 0, false]], ancestors = new Set(); let nodes = 0, bytes = 0;
  while (stack.length) {
    const [v, depth, leave] = stack.pop();
    if (leave) { ancestors.delete(v); continue; }
    check(++nodes <= L.review_nodes && depth <= L.review_depth, 'review_limit');
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); check(bytes <= RL.output_utf8_bytes, 'review_limit'); continue; }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) continue;
    check(v && typeof v === 'object' && !types.isProxy(v), 'plain_data_required');
    const array = Array.isArray(v), keys = Reflect.ownKeys(v);
    check(Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype)
      && !ancestors.has(v) && (!array || keys.length === v.length + 1), 'plain_data_required');
    check(nodes + stack.length + keys.length <= L.review_nodes, 'review_limit');
    ancestors.add(v); stack.push([v, depth, true]);
    for (const key of keys) {
      if (array && key === 'length') continue;
      check(typeof key === 'string' && (!array || /^(0|[1-9][0-9]*)$/.test(key)), 'plain_data_required');
      const d = Object.getOwnPropertyDescriptor(v, key);
      check(d.enumerable && Object.hasOwn(d, 'value'), 'plain_data_required');
      bytes += Buffer.byteLength(key); check(bytes <= RL.output_utf8_bytes, 'review_limit');
      stack.push([d.value, depth + 1, false]);
    }
  }
}
function integer(value) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= 9223372036854775807n, 'review_generation');
  return BigInt(value);
}
function readState(state, expected, resolver) {
  plainReview(state);
  closed(state, ['review_state_version', 'status', 'authority', 'durability', 'binding', 'head_count', 'heads', 'state_sha256']);
  closed(state.binding, ['target', 'context_ref', 'generation']);
  check(state.review_state_version === 1 && state.status === 'current' && state.authority === 'not_established'
    && state.durability === 'caller_transaction' && same(state.binding.target, expected.target)
    && same(state.binding.context_ref, expected.context_ref), 'review_binding');
  const generation = integer(state.binding.generation);
  check(Array.isArray(state.heads) && state.heads.length <= RL.heads && state.head_count === state.heads.length, 'review_limit');
  const digest = createHash('sha256').update(`{"binding":${json(state.binding)},"domain":"custom-cohort-review-state-v1","heads":[`);
  const bySlot = new Map(), byRef = new Map(), bySubject = new Map(), generations = new Set();
  let previous = '', maximum = 0n, bytes = 0, work = 0;
  for (const head of state.heads) {
    closed(head, ['fact_key_sha256', 'decision_ref', 'generation', 'record']);
    closed(head.decision_ref, ['decision_id', 'decision_sha256']);
    const r = head.record;
    closed(r, ['review_record_version', 'purpose', 'authority', 'actor_user_id', 'generation', 'fact_key_sha256', 'command', 'claim_observation']);
    const text = json(r), size = Buffer.byteLength(text); bytes += size;
    check(size <= RL.record_utf8_bytes && bytes <= RL.aggregate_record_utf8_bytes, 'review_limit');
    const n = integer(head.generation);
    check(n > 0n && n <= generation && !generations.has(head.generation), 'review_generation');
    generations.add(head.generation); if (n > maximum) maximum = n;
    check(r.review_record_version === 1 && r.purpose === 'retained_reviewer_command' && r.authority === 'not_established'
      && typeof r.actor_user_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.actor_user_id)
      && r.generation === head.generation && r.fact_key_sha256 === head.fact_key_sha256
      && head.decision_ref.decision_sha256 === sha(text), 'review_record');
    const bound = resolver.bindCommand(json(r.command)), command = bound.command;
    const key = assessmentEvidenceDigest({ domain: 'custom-cohort-review-fact-slot-v1',
      subject_ref: command.subject_ref, kind: command.claim.kind, qualifier: command.claim.qualifier });
    check(key === head.fact_key_sha256 && key > previous && head.decision_ref.decision_id === command.operation_id
      && integer(command.expected_generation) + 1n === n, 'review_record');
    previous = key; work += command.evidence_refs.length;
    check(work <= L.evidence_resolutions, 'review_limit');
    if (bySlot.size) digest.update(',');
    digest.update(json({ fact_key_sha256: key, decision_ref: head.decision_ref, generation: head.generation }));
    const entry = { command, observation: bound.claim_observation, decision_ref: { ...head.decision_ref },
      actor_user_id: r.actor_user_id, generation: head.generation };
    check(!byRef.has(command.operation_id), 'review_record'); bySlot.set(key, entry); byRef.set(command.operation_id, entry);
    const subject = json(command.subject_ref), list = bySubject.get(subject) ?? [];
    list.push(entry); bySubject.set(subject, list);
  }
  check(maximum === generation && digest.update(']}').digest('hex') === state.state_sha256, 'review_digest');
  // Dependencies are deliberately NOT assumed current just because they were
  // current at append. getCurrent preserves old dependency refs verbatim.
  for (const entry of byRef.values()) entry.dependencies_current = entry.command.claim.decision_refs.every(ref => {
    const other = byRef.get(ref.decision_id);
    return other && other.command.claim.state === 'known' && same(other.decision_ref, ref) && BigInt(other.generation) < BigInt(entry.generation)
      && same(other.command.subject_ref, entry.command.subject_ref);
  });
  return { byRef, bySubject };
}
function decimal(value) {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
  if (text === null || text.length > 200 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.'), tail = fraction.replace(/0+$/, '');
  return tail ? `${whole}.${tail}` : whole;
}
function safePrice(text) {
  const exact = decimal(text), value = exact === null ? NaN : Number(exact);
  // The existing statistics kernel is Number based. Refuse magnitude/decimal
  // collapse rather than silently rounding retained exact consideration.
  return Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER
    && decimal(String(value)) === exact ? value : null;
}
const blankPhysical = () => ({ year_built: null, gla_sqft: null, site_area_sqft: null,
  assessed_value: null, assessment_tax_year: null, subdivision_key: null });
const instantKey = value => {
  const m = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.([0-9]{1,9}))?Z$/.exec(value);
  return m ? `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}Z` : null;
};

/** Internal computation only. Owner must load the exact retained graph and
 * locked current review state, authorize source use, and supply its actual
 * clock. Hashes/actors are provenance, not permission, provider truth, licensure
 * or Apply authority. No database, latest-source fallback, or report writes.
 */
export function buildCustomCohortSupportedInputs(input) {
  closed(input, ['preparation_input', 'review_state', 'derived_at']);
  const { preparation_input: p, review_state: state, derived_at: derivedAt } = input;
  check(typeof derivedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(derivedAt)
    && Number.isFinite(Date.parse(derivedAt)) && new Date(derivedAt).toISOString() === derivedAt, 'derived_at');
  // This is the actual full retained/header/subject/study/selection admission.
  const resolver = createCustomCohortDecisionEvidenceResolver(p), retained = p.retained_inputs;
  const capture = retained.acquisition.capture_result;
  check(instantKey(derivedAt) >= instantKey(capture.captured_at)
    && instantKey(derivedAt) >= instantKey(retained.completed_at), 'derived_before_capture');
  const reviews = readState(state, p.expected, resolver);
  const preview = buildCustomCohortObservationPreview({ context_ref: p.expected.context_ref,
    retained_inputs: retained, selection: { revision: p.selection.revision, pockets: [] } });
  const catalog = buildCustomCohortPocketCatalog({ retained_inputs: retained, preview });
  const groups = new Map(catalog.pockets.map(group => [group.id, group.account_ids]));
  if (catalog.unassigned.member_count) groups.set('discovery:unassigned', catalog.unassigned.account_ids);
  const selected = sorted(p.selection.included_recorded_group_ids.flatMap(id => groups.get(id)));
  const selectedSet = new Set(selected);
  // Preparation has already rejected unknown group IDs, including explicit empty selection.
  const selection = { revision: p.selection.revision, included_recorded_group_ids: [...p.selection.included_recorded_group_ids].sort(compare),
    account_ids: selected, account_set_sha256: neighborhoodMemberSetDigest(selected) };
  const binding = { context_ref: { ...p.expected.context_ref }, target: { ...p.expected.target },
    review_generation: state.binding.generation, review_state_sha256: state.state_sha256,
    selection_revision: selection.revision, selection_sha256: sha(json({ revision: selection.revision,
      included_recorded_group_ids: selection.included_recorded_group_ids, account_set_sha256: selection.account_set_sha256 })),
    profile_sha256: PROFILE.profile_sha256, derived_at: derivedAt };
  const records = new Map(), candidates = new Map(), canonical = new Map(), accountRows = new Map(), parcelAccounts = new Set(), links = [];
  for (const source of capture.source_capture.sources) for (const row of source.payload.records) {
    const role = source.payload.projection.definition.role;
    if (!['parcels', 'accounts', 'transactions', 'sale_links'].includes(role)) continue;
    const ref = resolver.deriveEvidenceRef(source.id, row.record_id);
    const entry = { ref, role, raw: row.data.raw_projection, normalized: row.data.data, id: row.record_id };
    records.set(refKey(ref), entry);
    if (role === 'transactions') {
      candidates.set(entry.id, entry);
      const id = entry.normalized.canonical_transaction_id;
      if (id !== null) { const list = canonical.get(id) ?? []; list.push(entry.id); canonical.set(id, list); }
    }
    if (role === 'accounts') {
      const id = entry.raw.account_id, rows = accountRows.get(id) ?? [];
      rows.push(entry); accountRows.set(id, rows);
    }
    if (role === 'parcels') parcelAccounts.add(entry.raw.account_id);
    if (role === 'sale_links') links.push(entry);
  }
  const entries = (kind, key) => reviews.bySubject.get(json({ kind, key })) ?? [];
  const fact = (kind, key, claimKind, qualifier = null) => entries(kind, key).find(e => e.command.claim.kind === claimKind
    && (qualifier === null || same(e.command.claim.qualifier, qualifier))) ?? null;
  const usable = entry => Boolean(entry?.dependencies_current && entry.command.claim.state === 'known'
    && (entry.command.claim.kind === 'study_fitness_review' || entry.command.claim.decision_refs.length === 0));
  const hasRef = (refs, ref) => refs.some(value => same(value, ref));
  const recordOf = ref => records.get(refKey(ref));
  const temporal = (support, date, applies) => support.valid_from !== null && support.valid_from <= date
    && (support.valid_through === null || support.valid_through >= date)
    && support.evidence_refs.some(ref => applies(recordOf(ref)))
    && ['observed_at', 'captured_at', 'available_at'].every(key => support[key] !== null
      && instantKey(support[key]) <= instantKey(derivedAt))
    && instantKey(support.observed_at) <= instantKey(support.captured_at)
    && (support.basis === 'reconstructed'
      || (support.basis === 'contemporaneous' && support.observed_at.slice(0, 10) <= date)
      || (support.basis === 'current_only' && support.observed_at.slice(0, 10) === date));
  const projectedTime = date => ({ historical_support: 'reconstructed', valid_from: date, valid_to: date, observed_at: derivedAt });
  const unavailableTime = () => ({ historical_support: 'unknown', valid_from: null, valid_to: null, observed_at: derivedAt });
  const evidence = used => ({ decision_refs: used.map(e => e.decision_ref).sort((a, b) => compare(a.decision_id, b.decision_id)),
    actor_user_ids: sorted(used.map(e => e.actor_user_id)),
    evidence_refs: [...new Map(used.flatMap(e => e.command.evidence_refs).map(ref => [refKey(ref), ref])).values()].sort((a, b) => compare(refKey(a), refKey(b))),
    temporal_support: used.filter(e => e.command.claim.state === 'known' && e.command.claim.value.temporal_support)
      .map(e => ({ decision_ref: e.decision_ref, value: e.command.claim.value.temporal_support })) });
  const gaps = [], stockEvidence = [], transactionEvidence = [];
  const gap = (kind, key, reason) => gaps.push({ subject_ref: { kind, key }, reason });
  const effectiveDate = retained.subject.effective_date;
  function housing(account) {
    const head = fact('stock_member', account, 'housing_at_date', { basis: 'evaluated_date', evaluated_on: effectiveDate });
    if (!usable(head)) return { head, code: null, reason: head?.command.claim.state === 'unknown'
      ? `housing_unknown:${head.command.claim.unknown_reason}` : head ? 'housing_dependency_unavailable' : 'housing_review_missing' };
    const v = head.command.claim.value;
    if (v.housing_catalog_id !== PROFILE.housing_catalog.id || v.housing_catalog_revision !== '1'
      || !HOUSING.includes(v.housing_code) || v.evaluated_on !== effectiveDate) return { head, code: null, reason: 'housing_catalog_or_date_unsupported' };
    if (!temporal(v.temporal_support, effectiveDate, row => row && ['parcels', 'accounts'].includes(row.role)
      && row.raw.account_id === account)) return { head, code: null, reason: 'housing_temporal_support_unavailable' };
    return { head, code: v.housing_code, reason: null };
  }
  const subject = housing(p.expected.target.account_id);
  const subjectCode = PROFILE.residential_subject_codes.includes(subject.code) ? subject.code : null;
  if (!subjectCode) gap('stock_member', p.expected.target.account_id, subject.reason ?? 'subject_housing_not_supported_residential');
  const stockRows = selected.map(account_id => {
    const value = housing(account_id);
    if (value.reason) gap('stock_member', account_id, value.reason);
    stockEvidence.push({ account_id, housing_code: value.code, ...evidence(value.head ? [value.head] : []) });
    return { account_id, ...blankPhysical(), housing_type: value.code,
      ...(value.code ? projectedTime(effectiveDate) : unavailableTime()) };
  });
  const linksBySource = new Map();
  for (const row of links) { const key = row.raw.source_record_id, list = linksBySource.get(key) ?? []; list.push(row); linksBySource.set(key, list); }
  const observedAccounts = candidate => sorted([candidate.raw.primary_account_id, candidate.raw.sale_account_id,
    ...(linksBySource.get(candidate.raw.source_record_id) ?? []).map(row => row.raw.account_id)].filter(id => typeof id === 'string' && id.length));
  function membership(candidate, head, consideration = null) {
    if (!usable(head) || (consideration !== null && !usable(consideration))) return null;
    const v = head.command.claim.value, interest = v.interest_members;
    if (!hasRef(v.completeness_evidence_refs, candidate.ref)) return null;
    const sourceLinks = linksBySource.get(candidate.raw.source_record_id) ?? [];
    if (sourceLinks.some(row => !row.raw.account_id || !hasRef(v.completeness_evidence_refs, row.ref))) return null;
    const accounts = [], interestScopes = [];
    for (const item of interest) {
      const map = item.cad_link, source = recordOf(item.source_ref), mapping = map && recordOf(map.mapping_evidence_ref);
      if (!map || map.provider_key !== PROFILE.cad_provider_key || !mapping || mapping.role !== 'accounts'
        || mapping.raw.account_id !== map.account_id || typeof mapping.raw.county !== 'string' || !mapping.raw.county.trim()
        || map.jurisdiction_key !== mapping.raw.county || !parcelAccounts.has(map.account_id)) return null;
      if ((accountRows.get(map.account_id) ?? []).some(row => row.raw.county !== map.jurisdiction_key)) return null;
      const accountFromSource = source?.role === 'sale_links' && source.raw.source_record_id === candidate.raw.source_record_id
        ? source.raw.account_id : source?.role === 'transactions' && source.id === candidate.id
          && [candidate.raw.primary_account_id, candidate.raw.sale_account_id].includes(map.account_id) ? map.account_id : null;
      if (accountFromSource !== map.account_id || accounts.includes(map.account_id)) return null;
      accounts.push(map.account_id); interestScopes.push({ interest_key: item.interest_key, source_ref: item.source_ref });
    }
    if (!same(sorted(accounts), observedAccounts(candidate))) return null;
    if (consideration !== null) {
      const supplied = consideration.command.claim.value.interest_scope_refs;
      if (!same(interestScopes.map(json).sort(compare), supplied.map(json).sort(compare))) return null;
    }
    return { economic_property_key: v.economic_property_key, account_ids: accounts.sort(compare) };
  }
  const classByCandidate = new Map(), eventSets = new Map(), invalidClasses = new Set();
  for (const candidate of candidates.values()) {
    const head = fact('capture_candidate', candidate.id, 'transaction_equivalence');
    if (!usable(head)) continue;
    const v = head.command.claim.value, ids = sorted(v.candidate_keys), classKey = json(ids);
    const original = canonical.get(candidate.normalized.canonical_transaction_id) ?? [candidate.id];
    if (ids.length !== v.candidate_keys.length || !ids.includes(candidate.id) || ids.some(id => !candidates.has(id))
      || original.some(id => !ids.includes(id)) || ids.some(id => !hasRef(v.equivalence_evidence_refs, candidates.get(id)?.ref))) {
      invalidClasses.add(candidate.id); continue;
    }
    classByCandidate.set(candidate.id, { head, ids, classKey, event: v.canonical_event_key });
    const existing = eventSets.get(v.canonical_event_key);
    if (existing && existing !== classKey) { invalidClasses.add(candidate.id); invalidClasses.add(`event:${v.canonical_event_key}`); }
    eventSets.set(v.canonical_event_key, classKey);
  }
  for (const [id, value] of classByCandidate) for (const member of value.ids) {
    const other = classByCandidate.get(member);
    if (!other || other.classKey !== value.classKey || other.event !== value.event
      || invalidClasses.has(member) || invalidClasses.has(`event:${value.event}`)) {
      invalidClasses.add(id); invalidClasses.add(member);
    }
  }
  function candidateFacts(candidate) {
    const heads = Object.fromEntries(REQUIRED.map(kind => [kind, fact('capture_candidate', candidate.id, kind)]));
    const conditions = entries('capture_candidate', candidate.id).filter(e => e.command.claim.kind === 'material_condition');
    const fitness = fact('capture_candidate', candidate.id, 'study_fitness_review');
    const used = [...Object.values(heads).filter(Boolean), ...conditions, ...(fitness ? [fitness] : [])];
    let reason = null;
    if (REQUIRED.some(kind => !usable(heads[kind]))) reason = 'required_current_fact_unavailable';
    else if (invalidClasses.has(candidate.id) || !classByCandidate.has(candidate.id)) reason = 'equivalence_closure_unavailable';
    const date = usable(heads.closing_date) && heads.closing_date.observation.status === 'matched'
      ? heads.closing_date.command.claim.value.date : null;
    if (!date) reason ??= 'closing_date_unmatched';
    const priceHead = heads.recorded_consideration, price = usable(priceHead) ? priceHead.command.claim.value : null;
    const rawAmount = decimal(candidate.raw.sale_price), exactAmount = price && decimal(price.amount_decimal);
    const priceNumber = price && safePrice(price.amount_decimal);
    if (!price || price.currency !== 'USD' || price.meaning !== 'recorded_total_sale_price'
      || rawAmount === null || rawAmount !== exactAmount || priceNumber === null) reason ??= 'recorded_USD_consideration_unavailable';
    if (usable(heads.sale_completion) && (heads.sale_completion.command.claim.value.completed !== true
      || !hasRef(heads.sale_completion.command.claim.value.event_evidence_refs, candidate.ref))) reason ??= 'completed_sale_unavailable';
    const home = usable(heads.completed_home_at_closing) && heads.completed_home_at_closing.command.claim.value;
    if (!home || !date || home.completed_home !== true || home.closing_date !== date
      || !temporal(home.temporal_support, date, row => row?.role === 'transactions' && row.id === candidate.id)) reason ??= 'completed_home_at_closing_unavailable';
    const member = membership(candidate, heads.economic_property_membership, priceHead);
    if (!member) reason ??= 'economic_membership_unavailable';
    const requiredRefs = Object.values(heads).filter(Boolean).map(e => refKey(e.decision_ref)).sort(compare);
    const conditionRefs = conditions.map(e => refKey(e.decision_ref)).sort(compare);
    const fit = usable(fitness) && fitness.command.claim.value;
    if (!fit || fit.conclusion !== 'compatible'
      || !same(fit.required_fact_refs.map(refKey).sort(compare), requiredRefs)
      || !same(fit.condition_review_refs.map(refKey).sort(compare), conditionRefs)
      || !same(fitness.command.claim.decision_refs.map(refKey).sort(compare), [...requiredRefs, ...conditionRefs].sort(compare))) reason ??= 'fitness_current_fact_coverage_unavailable';
    if (conditions.some(head => !usable(head) || head.command.claim.value.present !== false
      || !hasRef(head.command.claim.value.condition_evidence_refs, candidate.ref))) reason ??= 'material_condition_unavailable';
    return { candidate, heads, used, reason, date, exactAmount, priceNumber, member,
      membership_only: membership(candidate, heads.economic_property_membership) };
  }
  const evaluated = new Map([...candidates.values()].map(row => [row.id, candidateFacts(row)]));
  // Audit unresolved classes as complete connected sets too. A broken review
  // must not split an original canonical group and hide its unknown sibling.
  const parents = new Map([...candidates.keys()].map(id => [id, id]));
  const root = id => { let key = id; while (parents.get(key) !== key) key = parents.get(key);
    while (parents.get(id) !== id) { const next = parents.get(id); parents.set(id, key); id = next; } return key; };
  const unite = (a, b) => { const left = root(a), right = root(b); if (left !== right) parents.set(right, left); };
  for (const ids of canonical.values()) for (const id of ids) unite(ids[0], id);
  for (const candidate of candidates.values()) {
    const head = fact('capture_candidate', candidate.id, 'transaction_equivalence');
    if (usable(head)) for (const id of head.command.claim.value.candidate_keys) if (candidates.has(id)) unite(candidate.id, id);
  }
  const components = new Map();
  for (const id of sorted(candidates.keys())) { const key = root(id), ids = components.get(key) ?? []; ids.push(id); components.set(key, ids); }
  const transactionRows = [], linkRows = [];
  for (const ids of components.values()) {
    const id = ids[0], cls = classByCandidate.get(id), facts = ids.map(key => evaluated.get(key));
    const first = facts[0]; let reason = facts.find(value => value.reason)?.reason ?? null;
    if (!cls || !same(cls.ids, ids)) reason ??= 'equivalence_closure_unavailable';
    if (!reason && facts.some(value => value.date !== first.date || value.exactAmount !== first.exactAmount
      || !same(value.member, first.member))) reason = 'equivalent_candidate_facts_conflict';
    const identity = !reason ? `reviewed-event:${sha(json({ context_ref: binding.context_ref, event_key: cls.event, candidate_keys: ids }))}`
      : `unresolved-candidate:${sha(json(ids))}`;
    const associated = sorted(facts.flatMap(value => observedAccounts(value.candidate)));
    const date = facts.every(value => value.date === first.date) ? first.date : null;
    const outside = date !== null && (date < retained.study.observation_period.start_date || date > retained.study.observation_period.end_date);
    const disjoint = facts.every(value => value.membership_only !== null && same(value.membership_only, first.membership_only))
      && first.membership_only.account_ids.every(account => !selectedSet.has(account));
    if (reason && !outside && !disjoint) ids.forEach(key => gap('capture_candidate', key, reason));
    const accepted = !reason;
    const row = { canonical_transaction_id: identity, source_record_id: null,
      sale_date: date, sale_price: accepted ? first.priceNumber : null, record_type: accepted ? 'closed_sale' : null,
      market_eligible: accepted ? true : null, primary_account_id: null, primary_account_verified: null,
      parcel_links_complete: accepted ? true : null, parcel_count: accepted ? first.member.account_ids.length : null,
      gla_sqft_at_sale: null, ...(accepted ? projectedTime(date) : unavailableTime()) };
    if (!disjoint) transactionRows.push(row);
    if (accepted && !disjoint) for (const account_id of first.member.account_ids) linkRows.push({ canonical_transaction_id: identity,
      source_record_id: null, account_id, verified: true, allocated_sale_price: null, allocation_verified: false,
      allocation_evidence_ref: null, gla_sqft_at_sale: null, ...projectedTime(date) });
    transactionEvidence.push({ canonical_transaction_id: identity, candidate_keys: ids, associated_account_ids: associated,
      status: disjoint ? 'outside_selection' : outside ? 'outside_observation_period' : accepted ? 'reconstructed' : 'unavailable',
      reason: disjoint ? 'complete_current_reviewed_membership_disjoint_from_selection' : reason,
      recorded_consideration: accepted ? { currency: 'USD', amount_decimal: first.exactAmount,
        meaning: 'recorded_total_sale_price' } : null,
      economic_membership: accepted ? first.member : disjoint ? first.membership_only : null,
      candidate_fact_states: facts.map(value => ({ candidate_key: value.candidate.id,
        facts: REQUIRED.map(kind => ({ kind, state: value.heads[kind]?.command.claim.state ?? 'missing',
          unknown_reason: value.heads[kind]?.command.claim.unknown_reason ?? null,
          dependency_support: usable(value.heads[kind]) ? 'current_profile_admitted' : 'unavailable' })) })),
      ...evidence(facts.flatMap(value => value.used)) });
  }
  const scope = { ...capture.scope }, payloads = [], sources = {};
  const rowSets = { parcels: stockRows, accounts: [], transactions: transactionRows, sale_links: linkRows };
  for (const [role, rows] of Object.entries(rowSets)) {
    const payload = { supported_input_source_version: 1, support_basis: PROFILE.support_basis,
      authority: 'not_established', binding, role, original_capture_at: capture.captured_at,
      coverage: PROFILE.coverage, rows, evidence: role === 'parcels' ? stockEvidence
        : role === 'transactions' ? transactionEvidence : [] };
    // Stream a canonical array body: whole broad-area sources may legitimately
    // exceed the generic canonicalizer's per-document bound. Each row is bounded.
    const { rows: omittedRows, evidence: omittedEvidence, ...metadata } = payload;
    const orderedKeys = Object.keys(payload).sort(compare), hash = createHash('sha256'); let byteCount = 0;
    const write = text => { byteCount += Buffer.byteLength(text); check(byteCount <= L.derived_source_utf8_bytes, 'derived_source_limit'); hash.update(text); };
    write('{'); orderedKeys.forEach((key, index) => {
      if (index) write(','); write(`${JSON.stringify(key)}:`);
      if (key === 'rows' || key === 'evidence') {
        write('['); payload[key].forEach((item, n) => { if (n) write(','); write(json(item)); }); write(']');
      } else write(json(metadata[key]));
    }); write('}');
    const contentSha = hash.digest('hex'), id = `reviewed-input:${role}:${contentSha}`;
    payloads.push({ id, content_sha256: contentSha, canonical_utf8_bytes: String(byteCount), payload });
    sources[role] = { id, state: rows.length ? 'populated' : 'present_empty', complete: capture.query_complete === true,
      revision: PROFILE.profile_revision, content_sha256: contentSha, captured_at: derivedAt,
      visibility: 'assignment_private', scope, rows };
  }
  if (!catalog.catalog_complete) gap('stock_member', p.expected.target.account_id, 'recorded_group_catalog_incomplete');
  if (!selected.length) gap('stock_member', p.expected.target.account_id, 'empty_selection');
  const cached = subjectCode ? buildCachedNeighborhoodInputs({ scope, population_id: `reviewed-stock:${binding.selection_sha256}`,
    effective_date: effectiveDate, observation_period: retained.study.observation_period,
    selection: { account_ids: selected, eligible_housing_types: [subjectCode], subject_subdivision_key: null }, sources }) : null;
  const statistics = cached ? summarizeNeighborhoodPopulations(cached.statistics_input) : null;
  const result = { supported_inputs_version: 1, status: cached?.status === 'ready' && gaps.length === 0 ? 'computed' : 'incomplete',
    support_basis: PROFILE.support_basis, authority: 'not_established', profile: PROFILE, binding, selection,
    subject_housing: { account_id: p.expected.target.account_id, code: subjectCode, ...evidence(subject.head ? [subject.head] : []) },
    cached_inputs: cached, statistics, derived_source_payloads: payloads, support_gaps: gaps,
    coverage: { selected_account_count: selected.length, retained_candidate_count: candidates.size,
      derived_transaction_count: transactionRows.length, provider_completeness: 'not_established',
      review_head_count: state.head_count, review_cap_is_population_limit: false },
    disclosure: { original_source_semantics: 'unchanged_current_mirror_observations',
      actor_authority: 'not_established', fitness_basis: PROFILE.fitness_meaning,
      optional_physical_value_allocation_fields: 'unavailable', statistics_state_is_not_report_readiness: true },
    assessment: null, publication: null, apply: { status: 'blocked', reason: 'owner_adoption_and_publication_required' } };
  check(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes, 'output_limit');
  return freeze(result);
}
