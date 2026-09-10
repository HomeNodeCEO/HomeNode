import { assessmentDate } from './contract.js';
import { customCohortObservationMappingVersion, customCohortObservationProjectionMatches } from './customCohortObservationMapping.js';

export const CUSTOM_COHORT_REPORTED_SHARED_SALES_LIMITS = Object.freeze({
  chunks: 1000, records: 100000, selected_accounts: 50000, accounts_per_record: 1000,
  account_links: 250000, output_utf8_bytes: 32000000,
});
const L = CUSTOM_COHORT_REPORTED_SHARED_SALES_LIMITS;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...new Set(values)].sort(compare);
const present = value => value !== null && value !== undefined && !(typeof value === 'string' && !value.trim());
function check(ok, reason) { if (!ok) throw new TypeError(`custom_cohort_reported_shared_sales_${reason}`); }
function bounded(value, maximum, reason) { check(Array.isArray(value) && value.length <= maximum, reason); return value; }
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function account(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 && value.trim() === value
    && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function date(value) { try { return assessmentDate(value, 'reported_close_date'); } catch { return null; } }
function decimal(value, policy) {
  const raw = typeof value === 'string' ? value.trim() : Number.isSafeInteger(value) ? String(value) : '';
  if (raw.length > 128 || !/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
  let [whole, fraction = ''] = raw.replace(/^\+/, '').split('.');
  whole = whole.replace(/^0+/, '') || '0'; fraction = fraction.replace(/0+$/, '');
  if (whole.length + fraction.length > 30 || fraction.length > 12
    || (policy === 'positive' && whole === '0' && !fraction)
    || (['year', 'integer'].includes(policy) && (fraction || BigInt(whole) > 2147483647n))
    || (policy === 'year' && (BigInt(whole) < 1600n || BigInt(whole) > 9999n))) return null;
  return whole + (fraction ? `.${fraction}` : '');
}
const FIELDS = Object.freeze({
  reported_close_price: [null, 'nonnegative', null, 'close_price_not_retained_by_installed_mapping'],
  reported_current_price: ['source_current_price', 'nonnegative', null, 'reported_currency_not_established'],
  reported_living_area: ['source_living_area', 'positive', null, 'reported_area_unit_not_established'],
  reported_site_area: ['source_lot_size_area', 'nonnegative', null, 'reported_area_unit_not_established'],
  reported_year_built: ['source_year_built', 'year', 'year', null],
  reported_days_on_market: ['source_days_on_market', 'integer', 'days', null],
});
function observation(rows, [field, policy, unit, unavailable], mappingVersion) {
  if (field === null && mappingVersion === 3) {
    const missing = rows.every(row => {
      const witness = row.raw.source_raw_witness?.fields?.ClosePrice;
      return ['absent', 'json_null'].includes(witness?.state)
        || (witness?.state === 'scalar' && witness.json_type === 'string' && !witness.value_text.trim());
    });
    return { state: missing ? 'missing' : 'unsupported', exact_value: null, unit: null,
      reason: missing ? 'raw_witness_close_price_missing' : 'raw_witness_close_price_not_interpreted_by_this_profile' };
  }
  const known = new Set(); let invalid = false;
  for (const row of rows) {
    const raw = field === null ? null : row.raw[field];
    if (!present(raw)) continue;
    const parsed = decimal(raw, policy); if (parsed === null) invalid = true; else known.add(parsed);
  }
  const state = known.size > 1 ? 'conflicting' : invalid ? 'invalid' : !known.size ? 'missing' : unit === null ? 'unsupported' : 'observed';
  return { state, exact_value: ['observed', 'unsupported'].includes(state) ? [...known][0] : null, unit,
    reason: state === 'observed' ? null : state === 'unsupported' || field === null ? unavailable : `reported_value_${state}` };
}
const scale = 10n ** 12n;
const scaled = value => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * scale + BigInt(fraction.padEnd(12, '0')); };
function unscale(value, digits = 12) {
  const text = value.toString().padStart(digits + 1, '0'), fraction = text.slice(-digits).replace(/0+$/, '');
  return text.slice(0, -digits) + (fraction ? `.${fraction}` : '');
}
function metric(rows, name, unit) {
  const counts = { observed_count: 0, missing_count: 0, invalid_count: 0, conflicting_count: 0, unsupported_count: 0 }, values = [];
  for (const row of rows) {
    const cell = row.data.observations[name]; counts[`${cell.state}_count`]++;
    if (cell.state === 'observed') values.push(scaled(cell.exact_value));
  }
  values.sort(compare); const n = values.length, middle = Math.floor(n / 2);
  return { unit, ...counts, low: n ? unscale(values[0]) : null, high: n ? unscale(values.at(-1)) : null,
    median: !n ? null : n % 2 ? unscale(values[middle]) : unscale((values[middle - 1] + values[middle]) * 5n, 13) };
}

/** Internal consumer of an owner-admitted, immutable retained Custom graph.
 * These are source RECORDS, not verified transactions/economic properties. The
 * caller owns hash/rights/freshness admission and the historical-stock gate.
 * Typed source values may predate the latest imported raw file (COALESCE); this
 * profile reports their local captured meaning, never original-file chronology.
 * Mapping3 witnesses are deliberately not paired with typed values: a later raw
 * unit/currency could belong to a different observation than a retained value.
 */
export function buildCustomCohortReportedSharedSales({ retained_inputs: input, selected_account_ids } = {}) {
  const acquisition = input?.acquisition, result = acquisition?.capture_result, capture = result?.source_capture;
  check(result?.query_complete === true && capture?.status === 'ready' && input?.spatial?.query_complete === true, 'retained_capture');
  const version = customCohortObservationMappingVersion(acquisition), effective = assessmentDate(input.subject.effective_date, 'effective_date');
  const period = input.study.observation_period, start = assessmentDate(period.start_date, 'start_date'), end = assessmentDate(period.end_date, 'end_date');
  check(start <= end && end <= effective, 'observation_period');
  const capturedAt = result.captured_at;
  check(typeof capturedAt === 'string' && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(capturedAt)
    && date(capturedAt.slice(0, 10)) !== null && Number.isFinite(Date.parse(capturedAt)), 'captured_at');
  const roster = bounded(input.spatial.account_ids, L.selected_accounts, 'roster_limit'), rosterSet = new Set(roster);
  check(roster.every(id => account(id) === id) && rosterSet.size === roster.length, 'roster');
  const request = acquisition.captured_query_request;
  check(JSON.stringify(sorted(bounded(request?.account_ids, L.selected_accounts, 'request_roster'))) === JSON.stringify(sorted(roster)), 'roster_mismatch');
  for (const key of ['organization_id', 'appraisal_case_id', 'subject_snapshot_id', 'account_id']) {
    check(capture.scope?.[key] === input.subject.target[key] && request.scope?.[key] === capture.scope[key], 'scope_mismatch');
  }
  const selected = bounded(selected_account_ids, L.selected_accounts, 'selection_limit');
  check(new Set(selected).size === selected.length && selected.every(id => account(id) === id && rosterSet.has(id)), 'selection');
  const selectedSet = new Set(selected), groups = new Map(), linksBySource = new Map(), seen = new Set(), roles = new Set();
  const snapshots = new Set(bounded(capture.source_snapshots, L.chunks, 'snapshot_limit').map(source => source.id));
  const routes = new Set(); let routeCount = 0;
  for (const route of bounded(capture.references, L.chunks, 'route_limit')) {
    for (const ref of bounded(route.record_sources, L.records, 'route_record_limit')) {
      check(++routeCount <= L.records, 'route_record_limit'); routes.add(`${ref.source_ref}\n${ref.record_id}`);
    }
  }
  let recordCount = 0, legacyCount = 0;
  for (const source of bounded(capture.sources, L.chunks, 'chunk_limit')) {
    const definition = source.payload.projection.definition, role = definition.role;
    check(customCohortObservationProjectionMatches(definition, version), 'mapping_profile');
    check(['selection', 'parcels', 'accounts', 'transactions', 'sale_links', 'gis_sync'].includes(role) && snapshots.has(source.id), 'source_role'); roles.add(role);
    for (const row of bounded(source.payload.records, L.records, 'record_limit')) {
      check(++recordCount <= L.records, 'record_limit');
      const key = `${role}\n${row.record_id}`;
      check(!seen.has(key) && routes.has(`${source.id}\n${row.record_id}`), 'source_routing'); seen.add(key);
      if (!['transactions', 'sale_links'].includes(role)) continue;
      const wrapper = row.data, raw = wrapper?.raw_projection, data = wrapper?.data;
      check(raw && data?.cached_mapping_version === version && Array.isArray(wrapper.capability_gaps), 'row_mapping');
      const sourceId = data.source_record_id;
      check(sourceId === null || (typeof sourceId === 'string' && /^[1-9]\d{0,18}$/.test(sourceId)), 'source_identity');
      if (sourceId === null) { check(role === 'transactions', 'link_identity'); legacyCount++; continue; }
      check(raw.source_record_id === sourceId, 'source_identity');
      const member = { raw, data, gaps: wrapper.capability_gaps, ref: { source_ref: source.id, record_id: row.record_id } };
      const map = role === 'transactions' ? groups : linksBySource;
      if (!map.has(sourceId)) map.set(sourceId, []); map.get(sourceId).push(member);
    }
  }
  check(roles.size === 6, 'source_roles_missing');
  const dispositions = { included: 0, outside_selection: 0, outside_period: 0, nonclosed: 0, unknown_record_type: 0,
    conflicting_record_type: 0, missing_close_date: 0, invalid_close_date: 0, conflicting_close_date: 0,
    associations_unavailable: 0, legacy_source_record_unavailable: legacyCount };
  const rows = []; let outputBytes = 16384, links = 0;
  for (const [id, originals] of [...groups].sort(([a], [b]) => compare(a, b))) {
    const associatedLinks = linksBySource.get(id) ?? [];
    const accounts = sorted([...originals.flatMap(row => [account(row.raw.primary_account_id), account(row.data.primary_account_id)]),
      ...associatedLinks.map(row => account(row.data.account_id))].filter(value => value !== null));
    check(accounts.length <= L.accounts_per_record, 'account_set_limit');
    const types = sorted(originals.map(row => row.raw.record_type).filter(present));
    const rawDates = originals.map(row => row.raw.source_close_date), dates = sorted(rawDates.filter(present).map(date).filter(Boolean));
    const disposition = !accounts.length ? 'associations_unavailable' : !accounts.some(value => selectedSet.has(value)) ? 'outside_selection'
      : types.length > 1 ? 'conflicting_record_type' : types.length === 0 || originals.some(row => !present(row.raw.record_type)) ? 'unknown_record_type'
        : types[0] === 'listing' ? 'nonclosed' : types[0] !== 'closed_sale' ? 'unknown_record_type'
          : dates.length > 1 ? 'conflicting_close_date' : rawDates.some(value => present(value) && date(value) === null) ? 'invalid_close_date'
            : dates.length !== 1 || rawDates.some(value => !present(value)) ? 'missing_close_date'
              : dates[0] < start || dates[0] > end ? 'outside_period' : 'included';
    dispositions[disposition]++; if (disposition !== 'included') continue;
    links += accounts.length; check(links <= L.account_links, 'account_link_limit');
    const member = { id: `core.sales_source_records:${id}`, accounts, data: {
      basis: 'locally_stored_source_reported_observations', source_record_id: id, mapping_version: version,
      record_type: 'closed_sale', reported_close_date: dates[0],
      canonical_transaction_ids: sorted(originals.map(row => row.data.canonical_transaction_id).filter(present)),
      retained_source_references: [...originals, ...associatedLinks].map(row => ({ ...row.ref }))
        .sort((a, b) => compare(a.source_ref, b.source_ref) || compare(a.record_id, b.record_id)),
      observations: Object.fromEntries(Object.entries(FIELDS).map(([name, descriptor]) => [name, observation(originals, descriptor, version)])),
      association_completeness: 'not_established',
      unresolved_link_count: associatedLinks.filter(row => row.data.is_resolved !== true || account(row.data.account_id) === null
        || row.gaps.includes('parcel_link_resolution_unavailable')).length,
      capability_gaps: sorted([...originals, ...associatedLinks].flatMap(row => row.gaps)),
    } };
    outputBytes += Buffer.byteLength(JSON.stringify(member)) + 1;
    check(outputBytes <= L.output_utf8_bytes, 'output_limit'); rows.push(member);
  }
  const output = { captured_at: capturedAt, rows, metrics: Object.fromEntries(Object.entries(FIELDS)
    .map(([name, [, , unit]]) => [name, metric(rows, name, unit)])), disposition_counts: dispositions };
  check(Buffer.byteLength(JSON.stringify(output)) <= L.output_utf8_bytes, 'output_limit'); return freeze(output);
}
