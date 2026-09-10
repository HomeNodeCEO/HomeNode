import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { assessmentDate, assessmentEvidenceDigest as digest, buildNeighborhoodAssessment, canonicalAssessmentJson as json } from './contract.js';
import { buildCachedSourceCaptures } from './cachedSourceCaptures.js';
import { neighborhoodMemberContentDigest, neighborhoodMemberSetDigest, prepareNeighborhoodPublication } from './assessmentRepository.js';
import { buildCustomNeighborhoodReportCandidate } from './customReportMapping.js';
import { getCustomCohortSupportedInputsProfile } from './customCohortSupportedInputs.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { customCohortReportGeographyForAssessment } from './customCohortReportGeography.js';

export const CUSTOM_COHORT_REPORT_PREPARATION_LIMITS = Object.freeze({
  source_rows: 100000, members: 100000, source_payload_utf8_bytes: 32 * 1024 * 1024,
  output_utf8_bytes: 64 * 1024 * 1024,
});
const L = CUSTOM_COHORT_REPORT_PREPARATION_LIMITS;
const VERSION = 'custom-reviewed-report-preparation-v1';
const ROLES = ['parcels', 'accounts', 'transactions', 'sale_links'];
const SCOPE = ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...new Set(values)].sort(compare);
const copy = value => JSON.parse(json(value));
const same = (a, b) => json(a) === json(b);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const REASONS = ['report_geography_not_established', 'report_source_period_support_not_established',
  'unpublished_preparation_requires_owner_adoption_and_publication'];
export const CUSTOM_COHORT_REPORT_PREPARATION_PROFILE = freeze({
  id: VERSION, revision: '1', support_basis: 'retained_reviewer_reconstruction', authority: 'not_established',
  identity: 'unpublished_owner_supplied_preparation_not_persisted_assessment_identity',
  sources: 'complete_content_repackaging_only_no_new_source_period_or_provider_authority',
  measures: 'copy_existing_computed_statistics_no_recalculation;report_values_null_until_source_period_support',
  geography: 'unavailable_no_parcel_union_hull_radius_or_cardinal_name_inference',
  required_population_ids: ['reviewed-stock', 'reviewed-transactions'],
  required_statistic_ids: ['reviewed-stock:property-count', 'reviewed-transactions:transaction-count', 'reviewed-transactions:recorded-sale-price:median'],
});
function check(ok, reason) {
  if (!ok) throw Object.assign(new TypeError(`custom_cohort_report_preparation_${reason}`), {
    code: 'CUSTOM_COHORT_REPORT_PREPARATION_INVALID', reason,
  });
}
function closed(value, keys, optional = []) {
  check(value && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype, 'input_shape');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = [...keys, ...optional.filter(key => Object.hasOwn(descriptors, key))];
  check(Reflect.ownKeys(descriptors).length === expected.length && expected.every(key => descriptors[key]?.enumerable
    && Object.hasOwn(descriptors[key], 'value')), 'input_shape');
}
function list(value, maximum = L.source_rows) { check(Array.isArray(value) && value.length <= maximum, 'input_limit'); return value; }
function count(value) { check(Number.isSafeInteger(value) && value >= 0, 'count'); return value; }
function text(value, max = 200) {
  check(typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value), 'text'); return value;
}
function uuid(value) { check(typeof value === 'string' && UUID.test(value), 'identity'); return value; }
function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'timestamp'); return value;
}
function positiveRevision(value) { check(Number.isSafeInteger(value) && value > 0 && value <= 2147483647, 'revision'); return value; }

// The supported-input adapter streams precisely this original canonical object.
// Rehash its arrays per bounded record, never feed a whole broad-area source to
// the generic 1.5MB canonicalizer or silently change its retained content hash.
function checkedDerivedSource(envelope, expectedBinding, target) {
  closed(envelope, ['id', 'content_sha256', 'canonical_utf8_bytes', 'payload']);
  const payload = envelope.payload;
  closed(payload, ['supported_input_source_version', 'support_basis', 'authority', 'binding', 'role',
    'original_capture_at', 'coverage', 'rows', 'evidence']);
  check(payload.supported_input_source_version === 1 && payload.support_basis === 'retained_reviewer_reconstruction'
    && payload.authority === 'not_established' && ROLES.includes(payload.role)
    && same(payload.binding, expectedBinding)
    && payload.coverage === getCustomCohortSupportedInputsProfile().coverage, 'derived_source_binding');
  timestamp(payload.original_capture_at);
  check(payload.original_capture_at <= expectedBinding.derived_at, 'source_clock');
  list(payload.rows); list(payload.evidence);
  const hash = createHash('sha256'); let bytes = 0;
  const write = part => { bytes += Buffer.byteLength(part); check(bytes <= L.source_payload_utf8_bytes, 'source_payload_limit'); hash.update(part); };
  write('{'); Object.keys(payload).sort(compare).forEach((key, index) => {
    if (index) write(','); write(`${JSON.stringify(key)}:`);
    if (key === 'rows' || key === 'evidence') {
      write('['); payload[key].forEach((row, n) => { if (n) write(','); write(json(row)); }); write(']');
    } else write(json(payload[key]));
  }); write('}');
  const content = hash.digest('hex');
  check(envelope.content_sha256 === content && envelope.canonical_utf8_bytes === String(bytes)
    && envelope.id === `reviewed-input:${payload.role}:${content}`, 'derived_source_digest');
  return { id: envelope.id, content, payload, canonical_utf8_bytes: envelope.canonical_utf8_bytes, scope: target.scope };
}

function sourcesFor(supported, target) {
  const roles = new Map();
  for (const envelope of list(supported.derived_source_payloads, 4)) {
    const source = checkedDerivedSource(envelope, supported.binding, target);
    check(!roles.has(source.payload.role), 'duplicate_source_role'); roles.set(source.payload.role, source);
  }
  check(roles.size === 4, 'source_roles');
  const captures = [...roles].map(([role, source]) => {
    const { rows, evidence, ...metadata } = source.payload;
    const records = [...rows.map((value, ordinal) => ({ record_id: `row:${ordinal}`, data: { kind: 'row', ordinal, value } })),
      ...evidence.map((value, ordinal) => ({ record_id: `evidence:${ordinal}`, data: { kind: 'evidence', ordinal, value } }))];
    return { upstream: { id: source.id, key: role, state: records.length ? 'populated' : 'present_empty', complete: true,
      revision: '1', content_sha256: source.content, captured_at: supported.binding.derived_at, visibility: 'assignment_private',
      scope: target.scope, row_count: records.length },
    metadata: { id: `custom-report-reviewed-${role}`, provider: 'Retained reviewer reconstruction; authority not established',
      revision: '1', valid_from: null, valid_to: null, observed_at: supported.binding.derived_at, historical_availability: 'unknown' },
    projection: { id: `${VERSION}:${role}`, revision: '1', definition: { role, original_payload_metadata: metadata,
      original_canonical_utf8_bytes: source.canonical_utf8_bytes,
      interpretation: 'content_repackaging_no_temporal_or_provider_promotion' },
    complete: true, input_row_count: records.length, output_record_count: records.length }, records };
  });
  const capture = buildCachedSourceCaptures({ scope: target.scope, captures });
  check(capture.status === 'ready', 'source_repackaging_incomplete');
  const byOriginal = new Map();
  for (const reference of capture.references) {
    const original = [...roles.values()].find(source => source.id === reference.upstream_source_id);
    const routes = new Map(reference.record_sources.map(row => [row.record_id, row.source_ref])), members = new Map();
    const add = (value, recordId) => {
      const key = ['parcels', 'accounts'].includes(original.payload.role) ? value.account_id : value.canonical_transaction_id;
      text(key, 300); check(routes.has(recordId), 'source_record_route');
      const refs = members.get(key) ?? new Set(); refs.add(routes.get(recordId)); members.set(key, refs);
    };
    original.payload.rows.forEach((value, index) => add(value, `row:${index}`));
    original.payload.evidence.forEach((value, index) => add(value, `evidence:${index}`));
    byOriginal.set(original.id, { role: original.payload.role, members });
  }
  return { capture, roles, byOriginal };
}

function computationSources(supported, target, binding) {
  const stats = supported.statistics, priceRows = list(stats.sales.property_price_members);
  const hash = createHash('sha256'); let bytes = 0;
  const write = part => { bytes += Buffer.byteLength(part); check(bytes <= L.source_payload_utf8_bytes, 'source_payload_limit'); hash.update(part); };
  write('{'); Object.keys(stats).sort(compare).forEach((key, i) => {
    if (i) write(','); write(`${JSON.stringify(key)}:`);
    if (key !== 'sales') write(json(stats[key]));
    else {
      write('{'); Object.keys(stats.sales).sort(compare).forEach((field, n) => {
        if (n) write(','); write(`${JSON.stringify(field)}:`);
        if (field !== 'property_price_members') write(json(stats.sales[field]));
        else { write('['); priceRows.forEach((row, p) => { if (p) write(','); write(json(row)); }); write(']'); }
      }); write('}');
    }
  }); write('}');
  const statisticsHash = hash.digest('hex');
  const header = copy({ ...stats, sales: { ...stats.sales, property_price_members: [] } });
  const records = [{ record_id: 'statistics:header', data: { kind: 'statistics_header', value: header } },
    ...priceRows.map((value, ordinal) => ({ record_id: `price-member:${ordinal}`, data: { kind: 'property_price_member', ordinal, value } })),
    ...list(supported.support_gaps).map((value, ordinal) => ({ record_id: `support-gap:${ordinal}`, data: { kind: 'support_gap', ordinal, value } }))];
  const metadata = { report_computation_version: 1, profile: CUSTOM_COHORT_REPORT_PREPARATION_PROFILE, binding,
    original_statistics_sha256: statisticsHash, original_statistics_canonical_utf8_bytes: String(bytes),
    split_field: 'original_statistics.sales.property_price_members', property_price_member_count: priceRows.length,
    support_gap_count: supported.support_gaps.length, cached_input_sha256: supported.cached_inputs.captured_input_sha256,
    subject_housing: copy(supported.subject_housing), selection: copy({ ...supported.selection, account_ids: [] }),
    selected_account_ids_location: 'original_derived_parcels_rows', coverage: copy(supported.coverage), disclosure: copy(supported.disclosure),
    note: 'Exact original computed values retained; report measures null until source-period support' };
  const capture = buildCachedSourceCaptures({ scope: target.scope, captures: [{
    upstream: { id: `existing-statistics:${statisticsHash}`, key: 'existing_statistics', state: 'populated', complete: true,
      revision: '1', content_sha256: statisticsHash, captured_at: binding.derived_at, visibility: 'assignment_private',
      scope: target.scope, row_count: records.length },
    metadata: { id: 'custom-report-existing-statistics', provider: 'Existing supported-input statistics, unchanged', revision: '1',
      valid_from: null, valid_to: null, observed_at: binding.derived_at, historical_availability: 'unknown' },
    projection: { id: `${VERSION}:statistics`, revision: '1', definition: metadata, complete: true,
      input_row_count: records.length, output_record_count: records.length }, records,
  }] });
  check(capture.status === 'ready', 'source_repackaging_incomplete');
  return capture;
}

/** INTERNAL owner-computed supportedInputs consumer, not a public fact validator.
 * The owner supplies the actual report/section revision and rechecks all fences
 * after this CPU stage. Hash/profile checks preserve provenance, not authority.
 * No I/O, publication, signing, authorization, source inference or statistics
 * recomputation. A missing report geography remains missing in every result.
 */
export function buildCustomCohortReportPreparation(input) {
  closed(input, ['supported_inputs', 'target', 'preparation_identity'], ['report_geography']);
  const { supported_inputs: supported, target: rawTarget, preparation_identity: rawIdentity } = input;
  closed(rawTarget, ['scope', 'report_file_id', 'custom_assignment_file_id', 'editor_revision', 'effective_date', 'data_cutoff']);
  closed(rawTarget.scope, SCOPE);
  closed(rawIdentity, ['assessment_id', 'assessment_revision', 'attachment_id', 'attachment_revision']);
  for (const key of SCOPE) key === 'account_id' ? text(rawTarget.scope[key], 100) : uuid(rawTarget.scope[key]);
  uuid(rawTarget.report_file_id);
  check(Number.isSafeInteger(rawTarget.custom_assignment_file_id) && rawTarget.custom_assignment_file_id > 0, 'assignment_identity');
  check(Number.isInteger(rawTarget.editor_revision) && rawTarget.editor_revision >= 0 && rawTarget.editor_revision <= 2147483647, 'editor_revision');
  assessmentDate(rawTarget.effective_date); assessmentDate(rawTarget.data_cutoff);
  check(rawTarget.data_cutoff <= rawTarget.effective_date, 'data_cutoff');
  uuid(rawIdentity.assessment_id); uuid(rawIdentity.attachment_id);
  positiveRevision(rawIdentity.assessment_revision); positiveRevision(rawIdentity.attachment_revision);
  check(supported?.supported_inputs_version === 1 && ['computed', 'incomplete'].includes(supported.status)
    && supported.authority === 'not_established' && supported.support_basis === 'retained_reviewer_reconstruction'
    && same(supported.profile, getCustomCohortSupportedInputsProfile()) && supported.apply?.status === 'blocked', 'supported_input_profile');
  const b = supported.binding;
  prepareCustomCohortContextReference(json(b.context_ref)); timestamp(b.derived_at);
  check(b.profile_sha256 === supported.profile.profile_sha256 && SHA.test(b.review_state_sha256) && SHA.test(b.selection_sha256)
    && typeof b.review_generation === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(b.review_generation), 'supported_binding');
  check(same(b.target, { organization_id: rawTarget.scope.organization_id, report_file_id: rawTarget.report_file_id,
    assignment_file_id: String(rawTarget.custom_assignment_file_id), account_id: rawTarget.scope.account_id }), 'target_mismatch');
  const target = copy(rawTarget), identity = copy(rawIdentity), selection = supported.selection;
  check(selection.revision === b.selection_revision && selection.account_set_sha256 === neighborhoodMemberSetDigest(selection.account_ids)
    && b.selection_sha256 === digest({ revision: selection.revision, included_recorded_group_ids: selection.included_recorded_group_ids,
      account_set_sha256: selection.account_set_sha256 }), 'selection_binding');
  const binding = { context_ref: copy(b.context_ref), review_generation: b.review_generation, review_state_sha256: b.review_state_sha256,
    selection_sha256: b.selection_sha256, derived_at: b.derived_at, target, preparation_identity: identity };
  const suppliedGeography = Object.hasOwn(input, 'report_geography');
  const reportGeography = suppliedGeography
    ? customCohortReportGeographyForAssessment(input.report_geography, { target, binding }) : null;
  const output = (assessment, publication_bundle, candidate, extra = []) => freeze({
    report_preparation_version: 1, status: 'incomplete', authority: 'not_established', identity_status: 'unpublished_preparation',
    binding, assessment, publication_bundle, candidate,
    ...(suppliedGeography ? { report_geography: input.report_geography } : {}),
    issues: sorted([...REASONS, ...extra]).map(code => ({ code })), apply: { status: 'blocked', reasons: [...REASONS, ...extra] },
  });
  if (target.editor_revision === 2147483647) return output(null, null, null, ['report_editor_revision_exhausted']);
  if (supported.cached_inputs === null || supported.statistics === null) return output(null, null, null, ['supported_computation_unavailable']);
  try {
  const cached = supported.cached_inputs, stats = supported.statistics, si = cached.statistics_input;
  check(same(cached.scope, target.scope) && si.effective_date === target.effective_date && stats.effective_date === target.effective_date
    && si.population_id === stats.population_id && si.observation_period.start_date === stats.observation_period.start_date
    && si.observation_period.end_date === stats.observation_period.end_date, 'computation_scope');
  if (target.data_cutoff !== target.effective_date) return output(null, null, null, ['stock_effective_date_after_data_cutoff']);
  const prepared = sourcesFor(supported, target), { capture, byOriginal } = prepared;
  const snapshots = list(cached.source_snapshots, 4);
  check(snapshots.length === 4 && new Set(snapshots.map(s => s.key)).size === 4, 'cached_sources');
  for (const snapshot of snapshots) {
    const source = prepared.roles.get(snapshot.key);
    check(source && snapshot.id === source.id && snapshot.content_sha256 === source.content && snapshot.captured_at === b.derived_at
      && same(snapshot.scope, target.scope) && snapshot.row_count === source.payload.rows.length, 'cached_source_binding');
  }
  const remap = (refs, identity) => sorted(list(refs, 1000).flatMap(ref => {
    const source = byOriginal.get(ref); check(source, 'member_source');
    const key = ['parcels', 'accounts'].includes(source.role) ? identity.account_id : identity.canonical_transaction_id;
    const routed = source.members.get(key); check(routed?.size > 0, 'member_source_route');
    return [...routed];
  }));
  const stock = list(si.stock), sales = list(si.sales), priceRows = list(stats.sales.property_price_members);
  const stockIds = new Set(stock.map(row => text(row.account_id, 100)));
  check(stockIds.size === stock.length && stock.length === count(stats.stock.property_count), 'stock_membership');
  const saleIds = new Set(), selectedSales = [];
  for (const sale of sales) {
    text(sale.canonical_transaction_id, 300); check(!saleIds.has(sale.canonical_transaction_id), 'duplicate_transaction'); saleIds.add(sale.canonical_transaction_id);
    const accounts = list(sale.parcels, 1000).map(parcel => { check(parcel.verified === true, 'unresolved_transaction_member'); return text(parcel.account_id, 100); });
    check(accounts.length > 0 && new Set(accounts).size === accounts.length && sale.market_eligible === true
      && accounts.length === sale.parcel_count, 'transaction_membership');
    check(sale.sale_date >= si.observation_period.start_date && sale.sale_date <= si.observation_period.end_date, 'transaction_period');
    // Membership routing only, not a second calculation/eligibility resolver.
    // This is the same explicit stock intersection named by the existing result.
    if (accounts.some(id => stockIds.has(id))) selectedSales.push(sale);
  }
  check(selectedSales.length === count(stats.sales.transaction_count), 'transaction_count');
  check(priceRows.length === count(stats.sales.property_price_observation_count), 'price_member_count');
  const computedCapture = computationSources(supported, target, binding);
  const members = [], populations = [], allSourceRefs = [...capture.source_snapshots, ...computedCapture.source_snapshots].map(s => s.id);
  function membersFor(id, rows, unit, memberOf, definition, period) {
    const added = rows.map(value => {
      const { member_id, account_ids, source_refs, data } = memberOf(value);
      return { population_id: id, member_id, member_unit: unit, account_ids: sorted(account_ids),
        member_data: { source_refs, computed_input: copy(data), authority: 'not_established' } };
    });
    check(members.length + added.length <= L.members, 'member_limit'); members.push(...added);
    const ids = added.map(m => m.member_id), accounts = new Set(added.flatMap(m => m.account_ids));
    const captureId = `${id}:member-capture`, memberSource = { capture_type: 'neighborhood_population_members_v1', population_id: id,
      member_unit: unit, member_content_sha256: neighborhoodMemberContentDigest(added), binding };
    const source = { id: captureId, payload: memberSource }, sourceSnapshot = { id: captureId, revision: '1',
      provider: 'Exact prepared computation members; not adopted report facts', content_sha256: digest(memberSource),
      visibility: 'assignment', scope: target.scope, valid_from: null, valid_to: null, observed_at: b.derived_at, historical_availability: 'unknown' };
    populations.push({ id, revision: '1', kind: unit === 'property' ? 'competitive_stock' : 'transactions', member_unit: unit,
      definition, observation_period: period, member_count: added.length, unique_property_count: accounts.size,
      property_link_count: added.reduce((n, row) => n + row.account_ids.length, 0), member_set_sha256: neighborhoodMemberSetDigest(ids),
      members_resource_id: `unpublished:${identity.assessment_id}:${id}`, pocket_ids: [...selection.included_recorded_group_ids],
      completeness: 'incomplete', reasons: ['report_source_period_support_not_established'], source_refs: [...allSourceRefs, captureId] });
    return { source, sourceSnapshot };
  }
  const stockPeriod = { start_date: target.effective_date, end_date: target.effective_date, date_basis: 'effective_date' };
  const salePeriod = { ...si.observation_period, date_basis: 'closing_date' };
  const memberCaptures = [membersFor('reviewed-stock', stock, 'property', row => ({ member_id: row.account_id, account_ids: [row.account_id],
    source_refs: remap(row.source_references, row), data: row }), 'Selected stock admitted by the retained reviewer reconstruction profile; report support incomplete', stockPeriod),
  membersFor('reviewed-transactions', selectedSales, 'canonical_transaction', row => ({ member_id: row.canonical_transaction_id,
    account_ids: row.parcels.map(p => p.account_id), source_refs: remap(row.source_references, row), data: row }),
  'Recorded canonical transaction totals intersecting selected eligible stock; complete co-parcel links retained; no property allocation', salePeriod)];
  const bySale = new Map(selectedSales.map(row => [row.canonical_transaction_id, row])), priceIds = new Set();
  memberCaptures.push(membersFor('reviewed-single-property-prices', priceRows, 'canonical_transaction', row => {
    const sale = bySale.get(row.canonical_transaction_id);
    check(sale && !priceIds.has(row.canonical_transaction_id) && sale.parcels.length === 1 && sale.parcels[0].account_id === row.account_id
      && row.price_basis === 'recorded_single_parcel' && row.sale_price === sale.sale_price && row.sale_date === sale.sale_date
      && row.gla_sqft_at_sale === null, 'price_member_profile');
    priceIds.add(row.canonical_transaction_id);
    return { member_id: row.canonical_transaction_id, account_ids: [row.account_id], source_refs: remap(row.source_references, row), data: row };
  }, 'Recorded single-parcel property-price observations from the existing computation; package totals are not allocated', salePeriod));
  const statistics = [], popById = new Map(populations.map(p => [p.id, p]));
  function measure(id, population, measurement, unit, estimator, observed, missing, parameters = {}, reason = REASONS[1]) {
    const p = popById.get(population); count(observed); count(missing);
    check(observed + missing === p.member_count, 'statistic_denominator');
    statistics.push({ id, population_id: population, measurement, unit, estimator, estimator_parameters: parameters,
      value: null, status: estimator === 'unsupported' ? 'unsupported' : 'incomplete', reason,
      observed_count: observed, missing_count: missing, denominator_count: p.member_count, denominator_basis: 'population_members',
      assessment_tax_year: null, uncertainty: { status: 'not_estimated', reason: 'preparatory_computation_not_adopted_report_evidence' },
      source_refs: [...p.source_refs] });
  }
  function distribution(prefix, population, measurement, unit, value) {
    check(value && value.member_count === popById.get(population).member_count && ['ready', 'insufficient', 'incomplete'].includes(value.state)
      && value.estimator === 'exact_member_type_7_quantiles' && count(value.count) + count(value.missing_count) === value.member_count, 'distribution_shape');
    for (const [name, estimator, probability] of [['low', 'exact_quantile', 0], ['q1', 'exact_quantile', .25], ['median', 'exact_median'],
      ['q3', 'exact_quantile', .75], ['high', 'exact_quantile', 1], ['mean', 'arithmetic_mean']]) {
      check(value[name] === null || (typeof value[name] === 'number' && Number.isFinite(value[name])), 'distribution_value');
      measure(`${prefix}:${name}`, population, measurement, unit, estimator, value.count, value.missing_count,
        estimator === 'exact_quantile' ? { convention: 'type_7', probability } : {});
    }
    measure(`${prefix}:cod`, population, 'cod_percent', 'percent', 'coefficient_of_dispersion', value.count, value.missing_count);
  }
  measure('reviewed-stock:property-count', 'reviewed-stock', 'property_count', 'properties', 'count', stats.stock.property_count, 0);
  measure('reviewed-transactions:transaction-count', 'reviewed-transactions', 'transaction_count', 'transactions', 'count', stats.sales.transaction_count, 0);
  for (const [field, measurement, unit] of [['year_built', 'year_built', 'year'], ['age_at_effective_date', 'age_at_effective_date', 'years'],
    ['gla_sqft', 'gla', 'ft2'], ['site_area_sqft', 'site_area', 'ft2']]) distribution(`reviewed-stock:${field}`, 'reviewed-stock', measurement, unit, stats.stock[field]);
  check(stats.stock.assessed_values_by_tax_year.length === 0, 'assessment_value_profile');
  distribution('reviewed-transactions:recorded-sale-price', 'reviewed-transactions', 'recorded_sale_price', 'USD', stats.sales.recorded_transaction_price);
  distribution('reviewed-single-property-prices:price', 'reviewed-single-property-prices', 'recorded_sale_price', 'USD', stats.sales.property_sale_price);
  distribution('reviewed-single-property-prices:ppsf', 'reviewed-single-property-prices', 'sale_price_per_square_foot', 'USD/ft2', stats.sales.sale_price_per_sqft);
  check(stats.predominant_value.state === 'unsupported' && stats.predominant_value.value === null, 'predominant_profile');
  measure('reviewed-transactions:predominant', 'reviewed-transactions', 'predominant_sale_price', 'USD', 'unsupported',
    stats.sales.recorded_transaction_price.count, stats.sales.recorded_transaction_price.missing_count, {}, stats.predominant_value.reason);
  const assessment = buildNeighborhoodAssessment({ contract_version: 1, id: identity.assessment_id, revision: identity.assessment_revision,
    scope: target.scope, effective_date: target.effective_date, data_cutoff: target.data_cutoff, generated_at: b.derived_at,
    observation_period: salePeriod, subject_facts: { housing_type: supported.subject_housing.code, support_basis: supported.support_basis,
      authority: 'not_established', physical_characteristics: 'unavailable_in_installed_profile' },
    methodology: { version: VERSION, geometry_version: reportGeography ? 'saved-editor-manual-geography-v1' : 'unavailable',
      configuration: { profile: CUSTOM_COHORT_REPORT_PREPARATION_PROFILE,
        ...(reportGeography ? { manual_geography: 'saved_editor_assertion_native_validity_only_no_report_applicability' } : {}) } },
    source_snapshots: [...capture.source_snapshots, ...memberCaptures.map(c => c.sourceSnapshot), ...computedCapture.source_snapshots,
      ...(reportGeography ? [reportGeography.source_snapshot] : [])],
    discovery: { complete: null, reason: 'retained_query_completeness_not_geographic_neighborhood_or_provider_coverage' },
    selection: { revision: String(selection.revision), pocket_ids: [...selection.included_recorded_group_ids], overrides: [],
      housing_eligibility: 'retained_reviewer_reconstruction_not_adopted_report_facts' },
    geographic_neighborhood: reportGeography?.geography ?? { status: 'incomplete', reasons: [REASONS[0]], revision: 'unavailable', crs: 'EPSG:4326', geometry: null, perimeter: [],
      validation: { valid: null, connected: null, contains_subject: null, engine: null, revision: null },
      cardinal_summaries: { north: null, east: null, south: null, west: null } },
    populations, statistics, required_population_ids: CUSTOM_COHORT_REPORT_PREPARATION_PROFILE.required_population_ids,
    required_statistic_ids: CUSTOM_COHORT_REPORT_PREPARATION_PROFILE.required_statistic_ids,
    development_evidence: { status: 'incomplete', reasons: ['development_evidence_not_established'] },
    diagnostics: { binding, original_statistics_source_refs: computedCapture.source_snapshots.map(s => s.id), original_computation_state: stats.state,
      report_values: 'unavailable_no_report_source_period_support', source_authority: 'not_established', identity_status: 'unpublished_preparation',
      ...(reportGeography ? { manual_geography: reportGeography.diagnostic } : {}) } });
  const publication = prepareNeighborhoodPublication(assessment, members, [...capture.sources, ...memberCaptures.map(c => c.source), ...computedCapture.sources,
    ...(reportGeography ? [reportGeography.source] : [])]);
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment: publication.assessment, target: { ...target,
    attachment_id: identity.attachment_id, attachment_revision: identity.attachment_revision,
    workflow_type: 'custom_appraisal', uad_workfile_id: null, specification_release: null } });
  const result = output(publication.assessment, publication, candidate);
  check(Buffer.byteLength(JSON.stringify(result)) <= L.output_utf8_bytes, 'output_limit');
  return result;
  } catch (error) {
    if (error.code === 'NEIGHBORHOOD_CAPTURE_LIMIT'
      || (error.code === 'CUSTOM_COHORT_REPORT_PREPARATION_INVALID' && ['source_payload_limit', 'output_limit', 'member_limit'].includes(error.reason))
      || /^invalid_neighborhood_assessment:json_(limit|bytes)$/.test(error.message)
      || /^neighborhood_(publication_limit|publication_bytes|publication_storage_bytes|member_links_limit|member_row_bytes|member_row_storage_bytes)$/.test(error.message)) {
      return output(null, null, null, ['report_preparation_capacity_exceeded']);
    }
    throw error;
  }
}
