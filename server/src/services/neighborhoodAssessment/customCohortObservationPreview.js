import { assessmentDate, canonicalAssessmentJson } from './contract.js';
import { prepareCustomCohortContextReference } from './customCohortContextContract.js';
import { exactDistribution, finiteNumberOrNull } from './statistics.js';

export const CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS = Object.freeze({
  source_chunks: 1000, source_records: 100000, accounts: 50000, pockets: 128,
  pocket_memberships: 100000, measurement_work: 2000000, member_work: 500000,
  output_utf8_bytes: 32000000,
});
const L = CUSTOM_COHORT_OBSERVATION_PREVIEW_LIMITS;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...new Set(values)].sort(compare);
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
function fail(reason) { throw new TypeError(`custom_cohort_observation_preview_${reason}`); }
function check(ok, reason) { if (!ok) fail(reason); }
function bounded(value, maximum, field) {
  check(Array.isArray(value) && value.length <= maximum, `${field}_limit`); return value;
}
function text(value, field, maximum = 200) {
  check(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), field); return value;
}
const present = value => value !== null && value !== undefined && !(typeof value === 'string' && !value.trim());
const refs = rows => {
  const map = new Map();
  for (const row of rows) for (const ref of row.source_references) map.set(`${ref.source_ref}\n${ref.record_id}`, ref);
  return [...map.values()].sort((a, b) => compare(a.source_ref, b.source_ref) || compare(a.record_id, b.record_id));
};
const groupBy = (rows, key) => {
  const result = new Map();
  for (const row of rows) {
    const id = key(row); if (id === null || id === undefined) continue;
    if (!result.has(id)) result.set(id, []); result.get(id).push(row);
  }
  return result;
};

// Decimal keys detect disagreements that IEEE-754 conversion would hide. Exact
// retained primitives stay available beside the Number used by exactDistribution.
function decimal(value, policy) {
  const number = finiteNumberOrNull(value), input = typeof value === 'number' ? String(value) : value?.trim?.();
  if (number === null || typeof input !== 'string' || input.length > 128
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(input) || number < 0
    || (policy === 'positive' && number === 0)
    || (['integer', 'year'].includes(policy) && !Number.isSafeInteger(number))
    || (policy === 'year' && (number < 1600 || number > 9999))) return null;
  let [whole, fraction = ''] = input.replace(/^[+-]/, '').split('.');
  whole = whole.replace(/^0+/, '') || '0'; fraction = fraction.replace(/0+$/, '');
  const magnitude = whole + (fraction ? `.${fraction}` : '');
  return { number, key: input.startsWith('-') && magnitude !== '0' ? `-${magnitude}` : magnitude };
}
function observation(values, policy = 'nonnegative') {
  const known = new Map(); let missing = 0, invalid = 0;
  for (const raw of values) {
    if (!present(raw)) { missing++; continue; }
    const parsed = decimal(raw, policy);
    if (!parsed) { invalid++; continue; }
    if (!known.has(parsed.key)) known.set(parsed.key, parsed.number);
  }
  const entries = [...known].sort(([a], [b]) => compare(a, b));
  const state = entries.length > 1 ? 'conflicting' : invalid ? 'invalid' : entries.length ? 'observed' : 'missing';
  return { state, value: state === 'observed' ? entries[0][1] : null,
    exact_value: state === 'observed' ? entries[0][0] : null,
    raw_values: [...new Map(values.map(value => [JSON.stringify(value ?? null), structuredClone(value ?? null)])).values()],
    observed_record_count: values.length - missing - invalid, missing_record_count: missing, invalid_record_count: invalid };
}

const CAD = Object.freeze({
  year_built: ['residential_year_built', 'year', 'Current CAD reported year built', 'year'],
  gla_sqft: ['residential_area_sqft', 'positive', 'Current CAD reported living area', 'ft2'],
  site_area_sqft: ['parcel_area_sqft', 'nonnegative', 'Current CAD reported parcel area', 'ft2'],
  assessed_value: ['current_market_value', 'nonnegative', 'Current CAD assessed value; tax year and currency unverified', null],
});
const SOURCE = Object.freeze({
  living_area: ['source_living_area', 'positive', 'Source-reported living area; units and GLA at sale not verified', null],
  lot_size_area: ['source_lot_size_area', 'nonnegative', 'Source-reported lot area; units not retained', null],
  year_built: ['source_year_built', 'year', 'Source-reported year built', 'year'],
  bedrooms_total: ['source_bedrooms_total', 'nonnegative', 'Source-reported bedrooms', 'count'],
  bathrooms_total_integer: ['source_bathrooms_total_integer', 'integer', 'Source-reported total bathrooms', 'count'],
  bathrooms_full: ['source_bathrooms_full', 'integer', 'Source-reported full bathrooms', 'count'],
  bathrooms_half: ['source_bathrooms_half', 'integer', 'Source-reported half bathrooms', 'count'],
  garage_spaces: ['source_garage_spaces', 'nonnegative', 'Source-reported garage spaces', 'count'],
  days_on_market: ['source_days_on_market', 'integer', 'Source-reported days on market', 'days'],
  current_price: ['source_current_price', 'nonnegative', 'Source current/listing price; not recorded closing consideration', null],
});
const GAPS = Object.freeze([
  'historical_applicability_not_established', 'housing_and_competitive_eligibility_not_established',
  'real_world_source_coverage_not_established', 'sale_completion_and_consideration_not_verified',
  'currency_and_source_area_units_not_established', 'transaction_equivalence_not_verified', 'economic_property_membership_not_verified',
  'price_allocation_and_gla_at_sale_not_verified', 'assessment_tax_year_unavailable',
  'geographic_neighborhood_and_cardinal_boundaries_not_supplied',
]);

/** Pure numeric consumer of loadCustomCohortCaptureInputs(...).retained_inputs.
 * The caller must authorize and load the exact context on its own transaction.
 * This is NOT an admission API: no hashes, observations or selections establish
 * authority, historical truth, market eligibility, or a report-ready assessment.
 * No source reads, persistence, geometry parsing or partial/sampled results.
 */
export function buildCustomCohortObservationPreview({ context_ref, retained_inputs: input, selection } = {}) {
  const context = prepareCustomCohortContextReference(canonicalAssessmentJson(context_ref));
  const capture = input?.acquisition?.capture_result?.source_capture;
  check(input?.acquisition?.capture_result?.query_complete === true && capture?.status === 'ready'
    && input?.spatial?.query_complete === true, 'retained_capture_required');
  const effectiveDate = assessmentDate(input.subject.effective_date, 'effective_date');
  const period = { start_date: assessmentDate(input.study.observation_period.start_date, 'start_date'),
    end_date: assessmentDate(input.study.observation_period.end_date, 'end_date') };
  check(period.start_date <= period.end_date && period.end_date <= effectiveDate, 'observation_period');
  const roster = bounded(input.spatial.account_ids, L.accounts, 'accounts').map(id => text(id, 'account_id', 100));
  check(new Set(roster).size === roster.length, 'duplicate_account');
  const request = input.acquisition.captured_query_request;
  check(JSON.stringify(sorted(roster)) === JSON.stringify(sorted(request.account_ids)), 'roster_mismatch');
  for (const key of ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']) {
    check(capture.scope[key] === input.subject.target[key] && request.scope[key] === capture.scope[key], 'scope_mismatch');
  }
  check(selection && Number.isSafeInteger(selection.revision) && selection.revision > 0, 'selection_revision');
  const rosterSet = new Set(roster), pocketIds = new Set(); let memberships = 0;
  const pockets = bounded(selection.pockets, L.pockets, 'pockets').map(pocket => {
    const id = text(pocket.id, 'pocket_id'), label = text(pocket.label, 'pocket_label');
    check(!pocketIds.has(id), 'duplicate_pocket'); pocketIds.add(id);
    const ids = bounded(pocket.account_ids, L.accounts, 'pocket_accounts').map(account => text(account, 'account_id', 100));
    check(new Set(ids).size === ids.length && ids.every(account => rosterSet.has(account)), 'pocket_membership');
    memberships += ids.length; check(memberships <= L.pocket_memberships, 'pocket_membership_limit');
    return { id, label, account_ids: sorted(ids) };
  }).sort((a, b) => compare(a.id, b.id));

  const roleRows = new Map(), sourceSnapshots = new Map(capture.source_snapshots.map(source => [source.id, source]));
  const routes = new Map(capture.references.flatMap(route => route.record_sources.map(ref => [`${ref.source_ref}\n${ref.record_id}`, ref])));
  let sourceRecords = 0, measurementWork = 0, memberWork = 0, outputBytes = 0;
  const memberBytes = new WeakMap();
  const chargeOutput = value => {
    let bytes = memberBytes.get(value);
    if (bytes === undefined) { bytes = Buffer.byteLength(JSON.stringify(value)); memberBytes.set(value, bytes); }
    outputBytes += bytes + 1; check(outputBytes <= L.output_utf8_bytes, 'output_bytes_limit');
  };
  const meter = (field, amount) => {
    if (field === 'measurement') { measurementWork += amount; check(measurementWork <= L.measurement_work, 'measurement_work_limit'); }
    else { memberWork += amount; check(memberWork <= L.member_work, 'member_work_limit'); }
  };
  const seen = new Set();
  for (const source of bounded(capture.sources, L.source_chunks, 'source_chunks')) {
    const role = source.payload.projection.definition.role;
    check(['selection', 'parcels', 'accounts', 'transactions', 'sale_links', 'gis_sync'].includes(role)
      && sourceSnapshots.has(source.id), 'source_role');
    if (!roleRows.has(role)) roleRows.set(role, []);
    for (const row of bounded(source.payload.records, L.source_records, 'source_records')) {
      check(++sourceRecords <= L.source_records, 'source_records_limit');
      const key = `${role}\n${row.record_id}`, refKey = `${source.id}\n${row.record_id}`;
      check(!seen.has(key) && routes.has(refKey), 'source_routing'); seen.add(key);
      if (['parcels', 'accounts', 'transactions', 'sale_links'].includes(role)) {
        check(row.data?.data?.cached_mapping_version === 2 && row.data.raw_projection
          && Array.isArray(row.data.capability_gaps), 'mapping_v2_required');
      }
      roleRows.get(role).push({ raw: row.data.raw_projection ?? {}, data: row.data.data ?? row.data,
        capability_gaps: row.data.capability_gaps ?? [], source_references: [{ source_ref: source.id, record_id: row.record_id }] });
    }
  }
  check(roleRows.size === 6, 'source_roles_missing');
  check(JSON.stringify(sorted(roleRows.get('selection').map(row => row.data.account_id))) === JSON.stringify(sorted(roster)), 'selection_source_mismatch');
  const parcelRows = groupBy(roleRows.get('parcels'), row => row.data.account_id);
  const accountRows = groupBy(roleRows.get('accounts'), row => row.data.account_id);
  const selectedRows = groupBy(roleRows.get('selection'), row => row.data.account_id);
  const spatialRows = groupBy(bounded(input.spatial.parcels, L.source_records, 'spatial_parcels'), row => row.account_id);
  const stock = sorted(roster).map(account_id => {
    const rows = parcelRows.get(account_id) ?? [];
    meter('measurement', Math.max(1, rows.length) * Object.keys(CAD).length);
    return { account_id, parcel_object_ids: sorted((spatialRows.get(account_id) ?? []).map(row => row.object_id)),
      observations: Object.fromEntries(Object.entries(CAD).map(([key, [field, policy]]) => [key, observation(rows.map(row => row.raw[field]), policy)])),
      source_references: refs([...rows, ...accountRows.get(account_id) ?? [], ...selectedRows.get(account_id) ?? []]) };
  });
  const transactionRows = roleRows.get('transactions'), linkRows = groupBy(roleRows.get('sale_links'), row => row.data.source_record_id);
  const linksFor = rows => sorted(rows.map(row => row.data.source_record_id).filter(present)).flatMap(id => {
    const links = linkRows.get(id) ?? []; meter('member', links.length); return links;
  });
  const associations = (rows, links) => sorted([...rows.flatMap(row => [row.data.primary_account_id, row.raw.primary_account_id]),
    ...links.map(row => row.data.account_id)].filter(present));
  const canonical = [...groupBy(transactionRows, row => row.data.canonical_transaction_id)].sort(([a], [b]) => compare(a, b)).map(([id, rows]) => {
    const links = linksFor(rows), dates = sorted(rows.map(row => row.data.sale_date).filter(present));
    const sale_date = dates.length === 1 && rows.every(row => row.data.sale_date === dates[0]) ? dates[0] : null;
    const disposition = dates.length > 1 ? 'conflicting_date' : sale_date === null ? 'missing_date'
      : sale_date < period.start_date || sale_date > period.end_date ? 'outside_period' : 'in_period';
    meter('measurement', rows.length);
    const associated_account_ids = associations(rows, links);
    return { canonical_transaction_id: id, sale_date, disposition,
      recorded_total_price: observation(rows.map(row => row.raw.sale_price)), currency: null,
      associated_account_ids, source_record_ids: sorted(rows.map(row => row.data.source_record_id).filter(present)),
      record_types: sorted(rows.map(row => row.data.record_type).filter(present)),
      multiple_parcel_evidence: associated_account_ids.length > 1 || rows.some(row => row.raw.has_multiple_parcel_numbers === true
        || ['possible', 'confirmed'].includes(row.raw.multi_parcel_status) || present(row.raw.parcel_number2_raw)),
      unresolved_link_count: links.filter(row => row.data.is_resolved !== true || row.data.account_id === null).length,
      membership_complete: null, market_eligible: null,
      capability_gaps: sorted([...rows, ...links].flatMap(row => row.capability_gaps)), source_references: refs([...rows, ...links]) };
  });
  const sourceMembers = [...groupBy(transactionRows, row => row.data.source_record_id)].sort(([a], [b]) => compare(a, b)).map(([id, rows]) => {
    const links = linksFor(rows); meter('measurement', rows.length * Object.keys(SOURCE).length);
    return { source_record_id: id, canonical_transaction_ids: sorted(rows.map(row => row.data.canonical_transaction_id).filter(present)),
      associated_account_ids: associations(rows, links), source_names: sorted(rows.map(row => row.raw.source_name).filter(present)),
      record_types: sorted(rows.map(row => row.data.record_type).filter(present)),
      observations: Object.fromEntries(Object.entries(SOURCE).map(([key, [field, policy]]) => [key, observation(rows.map(row => row.raw[field]), policy)])),
      capability_gaps: sorted(rows.flatMap(row => row.capability_gaps)), source_references: refs([...rows, ...links]) };
  });
  function distribution(members, getCell, label, unit) {
    meter('measurement', members.length);
    const cells = members.map(getCell), result = exactDistribution(cells.map(cell => cell.value));
    return { label, unit, currency: null, interpretation: 'captured_observations_only',
      denominator_basis: 'population_members', ...result,
      conflicting_count: cells.filter(cell => cell.state === 'conflicting').length,
      invalid_count: cells.filter(cell => cell.state === 'invalid').length,
      absent_count: cells.filter(cell => cell.state === 'missing').length,
      partially_observed_count: cells.filter(cell => cell.state === 'observed' && cell.missing_record_count > 0).length,
      cod_interpretation: 'descriptive_dispersion_not_reliability' };
  }
  const intersects = (ids, set) => ids.some(id => set.has(id));
  function population(id, ids, all = false) {
    const chosen = new Set(ids), accounts = stock.filter(row => chosen.has(row.account_id));
    const considered = canonical.filter(row => all || intersects(row.associated_account_ids, chosen));
    const events = considered.filter(row => row.disposition === 'in_period');
    const sources = sourceMembers.filter(row => all || intersects(row.associated_account_ids, chosen));
    meter('member', accounts.length + considered.length + sources.length);
    // Charge association/reference traversal as well as top-level rows, so a
    // large package repeated through many overlapping pockets stays bounded.
    meter('member', [...accounts, ...considered, ...sources].reduce((n, row) => n + row.source_references.length
      + (row.associated_account_ids?.length ?? 0), 0));
    for (const row of [...accounts, ...considered, ...sources]) chargeOutput(row);
    const result = { id, account_ids: ids,
      stock: { definition: 'Selected retained parcel-backed accounts; current CAD observations, not proven housing stock at the effective date',
        member_unit: 'account', member_count: accounts.length, unique_account_count: accounts.length,
        parcel_object_count: accounts.reduce((n, row) => n + row.parcel_object_ids.length, 0),
        temporal_basis: 'current_mirror_observation', assessment_tax_year: null, housing_eligible_count: null,
        members: accounts, metrics: Object.fromEntries(Object.entries(CAD).map(([key, [, , label, unit]]) =>
          [key, distribution(accounts, row => row.observations[key], label, unit)])) },
      transactions: { definition: 'In-period stored canonical transactions; associated accounts are observed identities, not verified economic-property membership',
        member_unit: 'canonical_transaction', member_count: events.length, observation_period: { ...period, date_basis: 'stored_canonical_closing_date' },
        unique_associated_account_count: new Set(events.flatMap(row => row.associated_account_ids)).size,
        unique_selected_associated_account_count: new Set(events.flatMap(row => row.associated_account_ids.filter(account => chosen.has(account)))).size,
        package_evidence_transaction_count: events.filter(row => row.multiple_parcel_evidence).length,
        market_eligible_count: null, members: events,
        omitted: considered.filter(row => row.disposition !== 'in_period'),
        metrics: { recorded_total_price: distribution(events, row => row.recorded_total_price,
          'Stored canonical total price; package totals remain whole and consideration/currency are unverified', null) } },
      source_reported: { definition: 'All-date retained MLS/source records associated with these accounts; one member per source record, not per sale or property',
        member_unit: 'source_record', member_count: sources.length, temporal_basis: 'all_dates_retained_source_rows',
        without_canonical_transaction_count: sources.filter(row => row.canonical_transaction_ids.length === 0).length,
        members: sources, metrics: Object.fromEntries(Object.entries(SOURCE).map(([key, [, , label, unit]]) =>
          [key, distribution(sources, row => row.observations[key], label, unit)])) } };
    // Members are charged incrementally above, including every occurrence in
    // overlapping pockets. Only small aggregate metadata is encoded here.
    chargeOutput({ ...result, stock: { ...result.stock, members: [] },
      transactions: { ...result.transactions, members: [], omitted: [] }, source_reported: { ...result.source_reported, members: [] } });
    return result;
  }
  const union = sorted(pockets.flatMap(pocket => pocket.account_ids));
  const all = population('all_captured_accounts', sorted(roster), true), selected = population('selected_pocket_union', union);
  const pocketMembershipCounts = new Map();
  for (const pocket of pockets) for (const id of pocket.account_ids) pocketMembershipCounts.set(id, (pocketMembershipCounts.get(id) ?? 0) + 1);
  const pocketResults = pockets.map(pocket => ({ ...pocket, disposition: 'needs_review',
    overlap_account_count: pocket.account_ids.filter(id => pocketMembershipCounts.get(id) > 1).length,
    result: population(pocket.id, pocket.account_ids) }));
  const snapshots = capture.source_snapshots.map(source => ({ ...source, scope: { ...source.scope } }));
  snapshots.forEach(chargeOutput);
  chargeOutput({ context, target: input.subject.target, pockets: pockets.map(pocket => ({ ...pocket, result: null })), support_gaps: GAPS });
  // Small top-level keys/notices and separators; this is a conservative output
  // ceiling, not a promise that a browser may display all private member rows.
  outputBytes += 8000; check(outputBytes <= L.output_utf8_bytes, 'output_bytes_limit');
  return freeze({ preview_version: 1, status: 'observations_only', authority: 'not_established', context_ref: context,
    target: { ...input.subject.target }, effective_date: effectiveDate, observation_period: period,
    captured_at: input.acquisition.capture_result.captured_at, selection_revision: selection.revision,
    all, selected, pockets: pocketResults,
    source_snapshots: snapshots,
    support_gaps: [...GAPS], unavailable_metrics: {
      property_sale_price: 'economic_property_membership_and_allocation_not_verified',
      sale_price_per_square_foot: 'property_sale_price_and_gla_at_sale_not_verified',
      age_at_sale: 'at_sale_physical_facts_not_established', age_at_effective_date: 'historical_physical_facts_not_established',
      predominant_value: 'median_is_not_predominant_no_modal_policy_supplied',
      market_trend: 'raw_price_distributions_do_not_establish_underlying_market_change',
      reliability: 'dispersion_and_capture_coverage_do_not_establish_reliability' },
    apply: { status: 'blocked', reasons: ['observation_preview_is_not_a_supported_neighborhood_assessment', ...GAPS] },
    work: { source_records: sourceRecords, measurement_values: measurementWork, member_work: memberWork, output_utf8_bytes_bound: outputBytes } });
}
