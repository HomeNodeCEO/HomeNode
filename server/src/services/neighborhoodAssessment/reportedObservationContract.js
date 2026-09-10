import { types } from 'node:util';

export const REPORTED_OBSERVATION_PROFILE_ID = 'custom-reported-observations-v2';
export const REPORTED_OBSERVATION_PROFILE = Object.freeze({ profile_id: REPORTED_OBSERVATION_PROFILE_ID,
  profile_revision: 1, report_basis: 'reported_observations_not_verified_market_facts' });
const RAW_KEYS = ['contract_version', 'id', 'revision', 'scope', 'effective_date', 'data_cutoff', 'generated_at',
  'observation_period', 'subject_facts', 'methodology', 'source_snapshots', 'discovery', 'selection',
  'geographic_neighborhood', 'populations', 'statistics', 'required_statistic_ids', 'required_population_ids',
  'development_evidence', 'diagnostics'];
const DERIVED_KEYS = ['input_signature_sha256', 'application_group', 'evidence_digest_sha256'];
const COUNT_KEYS = ['observed_count', 'missing_count', 'invalid_count', 'conflicting_count', 'unsupported_count'];
const ACCOUNT = 'account_observations', RECORD = 'source_record_observations';
const definitions = {
  account_count: { kind: ACCOUNT, units: ['accounts'], count: true },
  source_record_count: { kind: RECORD, units: ['source_records'], count: true },
  current_cad_living_area: { kind: ACCOUNT, units: ['ft2'] },
  current_cad_parcel_area: { kind: ACCOUNT, units: ['ft2'] },
  current_cad_year_built: { kind: ACCOUNT, units: ['year'] },
  current_cad_calendar_age: { kind: ACCOUNT, units: ['years'] },
  reported_close_price: { kind: RECORD, units: ['USD', null] },
  reported_current_price: { kind: RECORD, units: ['USD', null] },
  reported_living_area: { kind: RECORD, units: ['sqft', 'sqm', null] },
  reported_site_area: { kind: RECORD, units: ['sqft', 'sqm', 'acre', null] },
  reported_year_built: { kind: RECORD, units: ['year'] },
  reported_days_on_market: { kind: RECORD, units: ['days'] },
};
export const REPORTED_OBSERVATION_MEASUREMENTS = Object.freeze(Object.fromEntries(Object.entries(definitions)
  .map(([key, value]) => [key, Object.freeze({ ...value, units: Object.freeze(value.units) })])));

function fail(reason) { throw new TypeError(`invalid_neighborhood_assessment:reported_observations.${reason}`); }
function check(condition, reason) { if (!condition) fail(reason); }

/** Inspect the version without invoking a caller getter or Proxy trap. The
 * actual v1 JSON vocabulary and canonical output remain owned by contract.js. */
export function neighborhoodAssessmentInputVersion(value) {
  check(value !== null && typeof value === 'object' && !types.isProxy(value), 'input');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'contract_version');
  check(!descriptor || Object.hasOwn(descriptor, 'value'), 'version_descriptor');
  return descriptor?.value;
}

// Bound descriptor traversal before shared canonicalization reads any values.
function plain(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    check(++nodes <= 100000 && depth <= 40, 'json_limit');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { check(Number.isFinite(item), 'nonfinite'); return; }
    if (typeof item === 'string') { check(item.isWellFormed() && !item.includes('\0'), 'string_encoding'); return; }
    check(typeof item === 'object' && !types.isProxy(item), 'plain_data');
    const array = Array.isArray(item), ds = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(ds);
    check(Object.getPrototypeOf(item) === (array ? Array.prototype : Object.prototype), 'plain_data');
    if (array) check(keys.length === item.length + 1 && item.length <= 100000, 'array');
    for (const key of keys) {
      if (array && key === 'length') continue;
      check(typeof key === 'string' && ds[key].enumerable && Object.hasOwn(ds[key], 'value'), 'data_descriptor');
      if (array) check(/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < item.length, 'array');
      visit(ds[key].value, depth + 1);
    }
  };
  visit(value, 0);
}
function closed(value, keys, optional = []) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'object');
  const actual = Object.keys(value);
  check(keys.every(key => Object.hasOwn(value, key)) && actual.every(key => keys.includes(key) || optional.includes(key)), 'fields');
}
const instantKey = value => `${value.slice(0, 19)}.${(value.split('.')[1]?.slice(0, -1) ?? '').padEnd(9, '0')}Z`;
const decimal = value => typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value)
  && value.replace('.', '').length <= 31 && (value.split('.')[1]?.length ?? 0) <= 13;

/** Internal validator profile for the ONE shared assessment assembly path.
 * This validates descriptive data and hashes, never authorization, an actual
 * spatial oracle, source rights, or independently supported historical facts. */
export function createReportedObservationValidators(input, shared) {
  plain(input); closed(input, RAW_KEYS, DERIVED_KEYS);
  const { assessmentDate, string, choice, strings, list, clone, refs, checkedDigest,
    polygonGeometry, sourceSnapshot, canonicalAssessmentJson } = shared;
  // The shared byte/depth budget is unchanged. No profile bypass or huge copy.
  canonicalAssessmentJson(input);
  closed(input.scope, ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']);
  closed(input.observation_period, ['start_date', 'end_date', 'date_basis']);
  check(input.observation_period.date_basis === 'closing_date', 'study_basis');
  closed(input.methodology, ['version', 'geometry_version', 'configuration']);
  check(input.methodology.version === 'reported-observations-v2'
    && input.methodology.geometry_version === 'appraiser-defined-observation-boundary-v1'
    && canonicalAssessmentJson(input.methodology.configuration) === canonicalAssessmentJson(REPORTED_OBSERVATION_PROFILE), 'contract_version_profile');
  closed(input.subject_facts, ['basis', 'authority']);
  check(input.subject_facts.basis === 'retained_subject_reference' && input.subject_facts.authority === 'not_established', 'subject_basis');
  closed(input.discovery, ['complete', 'basis', 'provider_coverage']);
  check(input.discovery.basis === 'complete_retained_roster' && input.discovery.provider_coverage === 'not_established', 'discovery_basis');
  closed(input.selection, ['revision', 'pocket_ids', 'overrides']);
  check(typeof input.selection.revision === 'string' && /^[1-9][0-9]*$/.test(input.selection.revision)
    && Number.isSafeInteger(Number(input.selection.revision)), 'selection_revision');
  for (const override of list(input.selection.overrides, 'selection.overrides', 5000)) closed(override, ['pocket_id', 'included']);
  closed(input.development_evidence, ['status', 'reasons']);
  check(input.development_evidence.status === 'not_established' && strings(input.development_evidence.reasons, 'development.reasons').length > 0, 'development');
  closed(input.diagnostics, ['authority', 'limitations']);
  check(input.diagnostics.authority === 'not_established' && strings(input.diagnostics.limitations, 'diagnostics.limitations').length > 0, 'authority');

  function timestamp(value, field = 'timestamp') {
    check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value), field);
    assessmentDate(value.slice(0, 10), field);
    check(Number(value.slice(11, 13)) <= 23 && Number(value.slice(14, 16)) <= 59 && Number(value.slice(17, 19)) <= 59, field);
    return value;
  }
  const generated = timestamp(input.generated_at, 'generated_at');
  function source(value, scope) {
    closed(value, ['id', 'revision', 'provider', 'content_sha256', 'visibility', 'scope', 'valid_from', 'valid_to', 'observed_at', 'historical_availability']);
    if (value.scope !== null) closed(value.scope, ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']);
    check(value.valid_from === null && value.valid_to === null && value.historical_availability === 'unknown', 'source_historical_claim');
    const result = sourceSnapshot(value, scope, timestamp);
    check(instantKey(result.observed_at) <= instantKey(generated), 'future_source');
    return result;
  }
  function count(value, maximum = 100000) { check(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'count'); return value; }
  function period(value, effective, cutoff, kind, study, captured) {
    closed(value, ['start_date', 'end_date', 'date_basis']);
    const start = assessmentDate(value.start_date), end = assessmentDate(value.end_date);
    check(start <= end && end <= cutoff && end <= effective, 'period');
    if (kind === ACCOUNT) check(value.date_basis === 'capture_date' && captured !== null
      && start === captured.slice(0, 10) && end === start, 'account_capture_period');
    else check(value.date_basis === 'closing_date' && start >= study.start_date && end <= study.end_date, 'reported_closing_period');
    return { start_date: start, end_date: end, date_basis: value.date_basis };
  }
  function population(value, effective, cutoff, study, sources) {
    closed(value, ['id', 'revision', 'kind', 'member_unit', 'definition', 'observation_period', 'captured_at', 'capture_source_ref',
      'temporal_basis', 'membership_basis', 'completeness_basis', 'provider_coverage', 'member_count', 'unique_account_count',
      'account_link_count', 'member_set_sha256', 'members_resource_id', 'pocket_ids', 'completeness', 'reasons', 'source_refs']);
    const kind = choice(value.kind, [ACCOUNT, RECORD], 'population.kind'), account = kind === ACCOUNT;
    check(value.member_unit === (account ? 'account' : 'source_record'), 'population_unit');
    check((account ? value.membership_basis === 'retained_cad_accounts'
      : ['reviewed_source_record_matches', 'retained_source_account_associations'].includes(value.membership_basis))
      && value.temporal_basis === (account ? 'current_cad_capture_reference' : 'reported_closing_dates_observed_at_capture')
      && value.completeness_basis === 'complete_retained_roster' && value.provider_coverage === 'not_established', 'population_basis');
    const sourceRefs = refs(value.source_refs, sources, 'population.source_refs');
    const captured = value.captured_at === null ? null : timestamp(value.captured_at, 'captured_at');
    if (captured === null) check(value.capture_source_ref === null, 'capture_binding');
    else check(sourceRefs.includes(value.capture_source_ref) && sources.get(value.capture_source_ref)?.observed_at === captured, 'capture_binding');
    if (account && captured !== null) check(captured.slice(0, 10) <= effective, 'historical_stock_evidence_required');
    const n = value.member_count === null ? null : count(value.member_count);
    const unique = value.unique_account_count === null ? null : count(value.unique_account_count, 250000);
    const links = value.account_link_count === null ? null : count(value.account_link_count, 250000);
    if (n !== null && links !== null) check(account ? n === links : links >= n && links <= Math.min(n * 1000, 250000), 'account_links');
    if (unique !== null && links !== null) check(unique <= links && (links !== 0 || unique === 0), 'account_unique');
    if (unique !== null && n !== null) check(account ? unique === n : n === 0 ? unique === 0 : unique > 0, 'account_unique');
    const completeness = choice(value.completeness, ['complete', 'incomplete', 'unknown'], 'population.completeness');
    const reasons = strings(value.reasons, 'population.reasons');
    const digest = value.member_set_sha256 === null ? null : checkedDigest(value.member_set_sha256);
    if (completeness === 'complete') check(!reasons.length && n !== null && unique !== null && links !== null
      && digest !== null && captured !== null && sourceRefs.length > 0, 'population_incomplete');
    else check(reasons.length > 0, 'population_reason');
    return { id: string(value.id, 'population.id'), revision: string(value.revision, 'population.revision'), kind,
      member_unit: value.member_unit, definition: string(value.definition, 'population.definition', 2000),
      observation_period: period(value.observation_period, effective, cutoff, kind, study, captured), captured_at: captured,
      capture_source_ref: value.capture_source_ref, temporal_basis: value.temporal_basis, membership_basis: value.membership_basis,
      completeness_basis: value.completeness_basis, provider_coverage: value.provider_coverage,
      member_count: n, unique_account_count: unique, account_link_count: links, member_set_sha256: digest,
      members_resource_id: string(value.members_resource_id, 'population.members_resource_id'),
      pocket_ids: strings(value.pocket_ids, 'population.pocket_ids', 5000), completeness, reasons, source_refs: sourceRefs };
  }
  function statistic(value, populations, sources) {
    closed(value, ['id', 'population_id', 'measurement', 'unit', 'estimator', 'estimator_parameters', 'value', 'status', 'reason',
      ...COUNT_KEYS, 'denominator_count', 'denominator_basis', 'source_refs'], ['observation_period']);
    const p = populations.get(value.population_id), definition = REPORTED_OBSERVATION_MEASUREMENTS[value.measurement];
    check(p && Object.hasOwn(REPORTED_OBSERVATION_MEASUREMENTS, value.measurement) && definition.kind === p.kind
      && definition.units.includes(value.unit), 'measurement_unit');
    const state = choice(value.status, ['ready', 'incomplete', 'unsupported'], 'statistic.status');
    const estimator = choice(value.estimator, definition.count ? ['count', 'unsupported']
      : ['exact_median', 'exact_quantile', 'unsupported'], 'statistic.estimator');
    if (estimator === 'exact_quantile') {
      closed(value.estimator_parameters, ['convention', 'probability']);
      check(value.estimator_parameters.convention === 'type_7' && [0, 1].includes(value.estimator_parameters.probability), 'estimator');
    } else closed(value.estimator_parameters, []);
    const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, count(value[key])]));
    const denominator = count(value.denominator_count);
    check(value.denominator_basis === 'population_members' && Object.values(counts).reduce((a, b) => a + b, 0) === denominator
      && (p.member_count === null || p.member_count === denominator), 'denominator');
    const sourceRefs = refs(value.source_refs, sources, 'statistic.source_refs');
    check(sourceRefs.every(id => p.source_refs.includes(id)), 'statistic_source_population');
    if (value.value !== null) check(definition.count ? Number.isSafeInteger(value.value) && value.value >= 0
      : decimal(value.value), 'decimal_value');
    if (state === 'ready') check(value.value !== null && value.reason === null && value.unit !== null
      && estimator !== 'unsupported' && p.completeness === 'complete' && sourceRefs.length > 0
      && sourceRefs.includes(p.capture_source_ref) && (definition.count ? value.value === denominator && counts.observed_count === denominator
        : counts.observed_count > 0), 'statistic_incomplete');
    else check(value.value === null && typeof value.reason === 'string', 'unavailable_value');
    if (estimator === 'unsupported') check(state === 'unsupported' && value.value === null, 'unsupported_value');
    if (Object.hasOwn(value, 'observation_period')) check(canonicalAssessmentJson(value.observation_period)
      === canonicalAssessmentJson(p.observation_period), 'statistic_period');
    return { id: string(value.id, 'statistic.id'), population_id: p.id, measurement: value.measurement, unit: value.unit,
      estimator, estimator_parameters: clone(value.estimator_parameters), value: value.value, status: state,
      reason: value.reason === null ? null : string(value.reason, 'statistic.reason', 2000), ...counts,
      denominator_count: denominator, denominator_basis: value.denominator_basis,
      observation_period: p.observation_period, source_refs: sourceRefs };
  }
  function geography(value, sources) {
    closed(value, ['basis', 'manual_source', 'status', 'reasons', 'revision', 'crs', 'geometry', 'perimeter', 'validation', 'cardinal_summaries']);
    check(value.basis === 'appraiser_defined_observation_boundary' && value.manual_source === 'appraiser_defined_area_manual_v2', 'manual_geography_basis');
    const status = choice(value.status, ['ready', 'incomplete', 'unsupported'], 'geography.status');
    const reasons = strings(value.reasons, 'geography.reasons'), geometry = polygonGeometry(value.geometry);
    const perimeter = list(value.perimeter, 'geography.perimeter', 5000).map(edge => {
      closed(edge, ['edge_id', 'from_node', 'to_node', 'name', 'source_refs']);
      const sourceRefs = refs(edge.source_refs, sources, 'perimeter.source_refs');
      check(edge.from_node !== edge.to_node && sourceRefs.length > 0, 'perimeter_edge');
      return { edge_id: string(edge.edge_id, 'perimeter.edge_id'), from_node: string(edge.from_node, 'perimeter.from_node'),
        to_node: string(edge.to_node, 'perimeter.to_node'), name: edge.name === null ? null : string(edge.name, 'perimeter.name'), source_refs: sourceRefs };
    });
    check(new Set(perimeter.map(edge => edge.edge_id)).size === perimeter.length, 'perimeter_duplicate');
    closed(value.validation, ['valid', 'connected', 'covers_recorded_subject_point', 'engine', 'revision']);
    const validation = clone(value.validation);
    for (const key of ['valid', 'connected', 'covers_recorded_subject_point']) check(validation[key] === null || typeof validation[key] === 'boolean', 'oracle');
    for (const key of ['engine', 'revision']) if (validation[key] !== null) string(validation[key], `oracle.${key}`);
    closed(value.cardinal_summaries, ['north', 'east', 'south', 'west']);
    const cardinal = Object.fromEntries(Object.entries(value.cardinal_summaries).map(([key, text]) =>
      [key, text === null ? null : string(text, `cardinal.${key}`, 2000)]));
    if (status === 'ready') {
      check(geometry !== null && !reasons.length && perimeter.length >= 3 && validation.valid === true && validation.connected === true
        && validation.covers_recorded_subject_point === true && validation.engine !== null && validation.revision !== null
        && Object.values(cardinal).every(text => text !== null), 'geography_incomplete');
      check(perimeter.every((edge, i) => edge.to_node === perimeter[(i + 1) % perimeter.length].from_node), 'perimeter_gap');
    } else check(reasons.length > 0, 'geography_reason');
    return { basis: value.basis, manual_source: value.manual_source, status, reasons,
      revision: string(value.revision, 'geography.revision'), crs: choice(value.crs, ['EPSG:4326'], 'geography.crs'),
      geometry, perimeter, validation, cardinal_summaries: cardinal };
  }
  function result(value) {
    for (const key of DERIVED_KEYS) if (Object.hasOwn(input, key)) check(canonicalAssessmentJson(input[key])
      === canonicalAssessmentJson(value[key]), 'changed_derived_value');
  }
  return { timestamp, sourceSnapshot: source, population, statistic, geography, result };
}
