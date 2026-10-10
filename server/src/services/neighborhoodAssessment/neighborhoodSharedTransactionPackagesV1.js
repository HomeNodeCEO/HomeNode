import { performance } from 'node:perf_hooks';
import { isProxy } from 'node:util/types';
import { assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob, prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createNeighborhoodFrozenJobSourceSeeds } from './neighborhoodFrozenJobSourceSeeds.js';
import { NEIGHBORHOOD_SHARED_TYPED_V2_SQL, prepareNeighborhoodSharedTypedSource } from './neighborhoodSharedTypedGeneration.js';
import { getNeighborhoodFrozenTypedOriginalV2Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { prepareNeighborhoodTypedTransactionV2 } from './neighborhoodFrozenTypedTransactionV2.js';
import { NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL, NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_LIMITS,
  getNeighborhoodOriginalTransactionPackageV2Profile, reconcileNeighborhoodOriginalTransactionPackageV2 } from './neighborhoodOriginalTransactionPackagesV2.js';
import { getNeighborhoodTransactionTemporalV1Profile, prepareNeighborhoodTransactionRetainedPeriodV1,
  projectNeighborhoodTransactionTemporalV1 } from './neighborhoodTransactionTemporalV1.js';

const KINDS = ['source_records', 'sales', 'sale_links'];
const LAYERS = ['parcels', 'accounts', ...KINDS, 'sync_state', 'sync_runs'];
const TYPED = getNeighborhoodFrozenTypedOriginalV2Profile();
export const NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_LIMITS = Object.freeze({ rows: 250, row_utf8_bytes: 66752,
  packet_utf8_bytes: 2100000, output_utf8_bytes: 2100000, read_utf8_bytes: 32000000,
  queries: 128, step_ms: 60000, query_ms: 5000 });
const L = NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_LIMITS;
/** Refuse closed internal contract violations without exposing retained values. */
function fail(reason) { throw new TypeError(`neighborhood_transaction_package_${reason}`); }
/** Snapshot exact own enumerable DATA properties, never invoking a getter or proxy. */
function data(value, keys) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || !keys.every(k => ds[k]?.enumerable && Object.hasOwn(ds[k], 'value'))) fail('invalid_input');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
/** Compare closed snapshots using the shared canonical encoding. */
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
/** Freeze only validated owned DATA before delivery. */
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Validate an exact native BIGINT key, with empty text admitted only for an initial cursor. */
function key(value, initial = false) {
  if (initial && value === '') return value;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('invalid_key');
  return value;
}
/** Require a single result envelope from every metadata or package query. */
function one(result) { if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('invalid_result'); return result.rows[0]; }
/** Validate a bounded canonical SQL count without floating-point conversion. */
function count(value, maximum) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= BigInt(maximum);
}
/** Admit one package-kind cursor only; callers cannot supply rows, dates, profiles or claims of completeness. */
export function prepareNeighborhoodTransactionPackagePageV1(value) {
  const p = data(value, ['kind', 'cursor']);
  if (!['source_record', 'legacy_sale'].includes(p.kind)) fail('invalid_kind');
  key(p.cursor, true); return freeze(p);
}
const DEFINITION = freeze({ id: 'neighborhood-native-transaction-packages-v1', revision: '1',
  typed_profile: TYPED, temporal_profile: getNeighborhoodTransactionTemporalV1Profile(), limits: L,
  source_record: 'all_exact_native_source_sale_link_rows_for_one_original_stock_seed',
  legacy_sale: 'one_source_less_native_sale_with_exact_original_stock_account',
  order: { source_record: 'native_BIGINT_source_seed_order', legacy_sale: 'native_sale_key_C_text_order' },
  completeness: 'independent_SQL_kind_counts_equal_all_reconciled_rows_no_prefix_or_sample',
  over_limit: 'refuse_entire_package_no_partial_delivery',
  temporal: 'retained_effective_year_and_closing_period_before_association_projection_no_row_discard',
  outside_accounts: 'retain_without_second_hop_discovery_or_CAD_acquisition',
  native_sales: 'keep_each_native_sale_identity_no_cross_source_equivalence_or_duplicate_price_sum',
  links: 'literal_native_resolution_flag_only_not_verified_provider_parcel_membership',
  eligibility: 'not_established', authority: 'not_established',
  limitations: ['no_provider_completeness_or_economic_transaction_equivalence', 'no_price_allocation_or_currency_fallback',
    'no_historical_stock_or_at_sale_GLA', 'no_selection_statistics_publication_source_grant_or_report_update'] });
const definitionText = canonicalAssessmentJson(DEFINITION), blob = prepareNeighborhoodCohortBlob(definitionText);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: '1', content_sha256: blob.content_sha256 },
  definition_blob: { ref: blob, canonical_json: definitionText } });
/** Return the immutable exact native-association profile, never source or publication authority. */
export function getNeighborhoodTransactionPackageV1Profile() { return PROFILE; }

// Only fixed SQL fragments are interpolated. Counts use the installed source/key
// indexes; payloads are materialized only when the complete package fits the cap.
const SOURCE_CHOSEN = `SELECT source_record_id::text AS package_key FROM app.neighborhood_custom_cohort_source_seeds
  WHERE operation_id=$1::uuid AND generation_id=$2::uuid
    AND source_record_id>coalesce(nullif($4::text,''),'0')::bigint ORDER BY source_record_id LIMIT 1`;
const LEGACY_CHOSEN = `SELECT t.row_key AS package_key FROM app.neighborhood_frozen_typed_v2_rows t
  WHERE t.generation_id=$2::uuid AND t.profile_sha256=$3 AND t.kind='sales' AND t.source_record_id IS NULL
    AND t.row_key>$4::text COLLATE "C" AND EXISTS(SELECT 1 FROM app.neighborhood_custom_cohort_stock_accounts a
      WHERE a.operation_id=$1::uuid AND a.account_id=t.account_id) ORDER BY t.row_key LIMIT 1`;
/** Build two closed indexed plans; no caller text, date filter or inferred association enters SQL. */
function packageSql(legacy) {
  const predicate = legacy ? "t.kind='sales' AND t.source_record_id IS NULL AND t.row_key=(SELECT package_key FROM chosen)"
    : 't.source_record_id=(SELECT package_key::bigint FROM chosen)';
  const scoped = `t.generation_id=$2::uuid AND t.profile_sha256=$3 AND ${predicate}`;
  const totals = KINDS.map(kind => `SELECT '${kind}' AS kind,count(*)::text AS n
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE ${scoped} AND t.kind='${kind}'`).join('\nUNION ALL\n');
  const members = KINDS.map(kind => `SELECT t.kind,t.row_key,jsonb_build_object('row',jsonb_build_object(
      'kind',t.kind,'row_key',t.row_key,'account_id',t.account_id,'source_record_id',t.source_record_id::text,
      'original_payload_sha256',t.original_payload_sha256,'typed',t.typed),
      'stock_member',CASE WHEN t.account_id IS NULL THEN NULL ELSE EXISTS(SELECT 1
        FROM app.neighborhood_custom_cohort_stock_accounts a WHERE a.operation_id=$1::uuid AND a.account_id=t.account_id) END)::text AS encoded
    FROM app.neighborhood_frozen_typed_v2_rows t WHERE ${scoped} AND t.kind='${kind}'
      AND (SELECT sum(n::bigint) FROM totals)<=$5::integer`).join('\nUNION ALL\n');
  return `/* neighborhood-native-transaction-package-v1:${legacy ? 'legacy' : 'source'} */
WITH chosen AS MATERIALIZED (${legacy ? LEGACY_CHOSEN : SOURCE_CHOSEN}),
totals AS MATERIALIZED (${totals}), members AS MATERIALIZED (${members}),
sized AS MATERIALIZED (SELECT *,octet_length(encoded) AS bytes FROM members)
SELECT (SELECT package_key FROM chosen) AS package_key,
  (SELECT jsonb_object_agg(kind,n) FROM totals) AS counts,count(*)::integer AS row_count,
  coalesce(max(bytes),0)>$7::integer OR coalesce(sum(bytes+1),0)+2>$6::integer AS packet_oversize,
  CASE WHEN coalesce(max(bytes),0)<=$7::integer AND coalesce(sum(bytes+1),0)+2<=$6::integer
    THEN coalesce('['||string_agg(encoded,',' ORDER BY kind COLLATE "C",row_key COLLATE "C")||']','[]') ELSE '[]' END AS packet_json
FROM sized`;
}
export const NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL = Object.freeze({ source_record: packageSql(false), legacy_sale: packageSql(true) });

/** Reconcile a complete bounded SQL packet into native associations. This pure
 * DATA helper does not authenticate the count envelope or issue population proof;
 * only the actual owner may deliver it after all issued/current-rights fences. */
export function projectNeighborhoodTransactionPackageV1(raw, pageValue, graphCounts, effectiveDate, observationPeriod) {
  const page = prepareNeighborhoodTransactionPackagePageV1(pageValue), period = prepareNeighborhoodTransactionRetainedPeriodV1(observationPeriod, effectiveDate);
  const packet = data(raw, ['package_key', 'counts', 'row_count', 'packet_oversize', 'packet_json']);
  const counts = data(packet.counts, KINDS), maximums = data(graphCounts, LAYERS);
  if (LAYERS.some(k => !Number.isInteger(maximums[k]) || maximums[k] < 0 || maximums[k] > 2000000)
    || KINDS.some(k => !count(counts[k], maximums[k]))) fail('invalid_counts');
  const total = KINDS.reduce((sum, k) => sum + Number(counts[k]), 0);
  if (total > L.rows) fail('package_row_limit');
  if (!Number.isInteger(packet.row_count) || packet.row_count !== total || typeof packet.packet_oversize !== 'boolean'
    || typeof packet.packet_json !== 'string') fail('invalid_result');
  if (packet.packet_oversize || Buffer.byteLength(packet.packet_json) > L.packet_utf8_bytes) fail('package_byte_limit');
  if (packet.package_key === null) {
    if (total !== 0 || packet.packet_json !== '[]') fail('invalid_result');
    return freeze({ package: null, next_cursor: page.cursor, end_of_kind: true });
  }
  const id = key(packet.package_key);
  if (page.cursor && (page.kind === 'source_record' ? BigInt(id) <= BigInt(page.cursor)
    : Buffer.compare(Buffer.from(id), Buffer.from(page.cursor)) <= 0)) fail('invalid_order');
  if (page.kind === 'source_record' ? counts.source_records !== '1'
    : counts.source_records !== '0' || counts.sale_links !== '0' || counts.sales !== '1') fail('incomplete_native_package');
  let input; try { input = JSON.parse(packet.packet_json); } catch { fail('invalid_result'); }
  if (!Array.isArray(input) || input.length !== total) fail('invalid_result');
  const seen = Object.fromEntries(KINDS.map(k => [k, 0])), positions = new Set(), stockAccounts = new Set(), outsideAccounts = new Set();
  const memberships = new Map();
  let previous = '', unresolvedLinks = 0, reportedResolvedLinks = 0, missingAccounts = 0;
  const rows = input.map(envelope => {
    const e = data(envelope, ['row', 'stock_member']), row = prepareNeighborhoodTypedTransactionV2(e.row);
    const order = `${row.kind}:${row.row_key}`;
    if (Buffer.compare(Buffer.from(order), Buffer.from(previous)) <= 0 || Buffer.byteLength(canonicalAssessmentJson(envelope)) > L.row_utf8_bytes)
      fail('invalid_order_or_row');
    previous = order; seen[row.kind]++;
    if (page.kind === 'source_record' ? row.source_record_id !== id : row.kind !== 'sales' || row.row_key !== id || row.source_record_id !== null)
      fail('foreign_native_association');
    if (row.account_id === null ? e.stock_member !== null : typeof e.stock_member !== 'boolean') fail('invalid_stock_membership');
    if (row.account_id !== null) {
      if (memberships.has(row.account_id) && memberships.get(row.account_id) !== e.stock_member) fail('conflicting_stock_membership');
      memberships.set(row.account_id, e.stock_member);
    }
    if (row.account_id === null) missingAccounts++;
    else (e.stock_member ? stockAccounts : outsideAccounts).add(row.account_id);
    // Retained-year and period rules run before association interpretation.
    const projected = projectNeighborhoodTransactionTemporalV1(row, effectiveDate, period);
    if (row.kind === 'sale_links') {
      const m = projected.markers;
      for (const field of ['source_position', 'parcel_sequence']) if (m[field].state !== 'scalar' || m[field].json_type !== 'number'
        || !/^[1-9][0-9]{0,4}$/.test(m[field].value_text ?? '') || BigInt(m[field].value_text) > 32767n) fail('invalid_link_position');
      const position = `${m.source_position.value_text}:${m.parcel_sequence.value_text}`;
      if (positions.has(position)) fail('duplicate_link_position'); positions.add(position);
      if (row.account_id !== null && m.is_resolved.state === 'scalar' && m.is_resolved.json_type === 'boolean' && m.is_resolved.value_text === 'true')
        reportedResolvedLinks++;
      else unresolvedLinks++;
    }
    return { stock_member: e.stock_member, projection: projected };
  });
  if (KINDS.some(k => seen[k] !== Number(counts[k])) || stockAccounts.size === 0) fail('incomplete_or_unanchored_package');
  const result = { package_version: 1, kind: page.kind, native_key: id, counts, rows,
    retained_effective_date: effectiveDate, retained_observation_period: period,
    associations: { native_sale_state: counts.sales === '0' ? 'absent' : counts.sales === '1' ? 'unique_native_id' : 'multiple_native_ids_unresolved',
      reported_resolved_link_count: reportedResolvedLinks, unresolved_link_count: unresolvedLinks,
      stock_account_count: stockAccounts.size, outside_account_count: outsideAccounts.size, missing_account_row_count: missingAccounts,
      native_row_coverage: 'complete_for_this_package_only', provider_parcel_membership: 'not_established',
      economic_transaction_equivalence: 'not_established', price_allocation: 'not_established' },
    authority: 'not_established', transaction_eligibility: 'not_established', source_acquisition: 'not_established', report_update: 'none' };
  if (Buffer.byteLength(canonicalAssessmentJson(result)) > L.output_utf8_bytes) fail('output_byte_limit');
  return freeze({ package: result, next_cursor: id, end_of_kind: false });
}

/** Read one whole bounded native package after actual issued V2 prerequisites.
 * Caller owns the transaction/current actor/source checks and supplies only the
 * retained dates. Both-end stock/seed/source/cache fences repeat here. No cache
 * miss preparation, source payload read/copy, checkpoint/head write or activation. */
export function createNeighborhoodSharedTransactionPackagesV1(client, rawOptions, rawGraph, effectiveDate, observationPeriod) {
  const options = data(rawOptions, ['claim', 'scope', 'actorUserId', 'geometryInput', 'discovery', 'subjectIntent', 'checkBudget']);
  if (typeof client?.query !== 'function' || typeof options.checkBudget !== 'function') fail('invalid_input');
  const period = prepareNeighborhoodTransactionRetainedPeriodV1(observationPeriod, effectiveDate);
  const g = data(rawGraph, ['root', 'layer_counts']), ref = data(g.root, ['content_sha256', 'canonical_utf8_bytes']);
  const graph = freeze({ root: prepareNeighborhoodCohortBlobReference(ref.content_sha256, ref.canonical_utf8_bytes), layer_counts: data(g.layer_counts, LAYERS) });
  if (Object.values(graph.layer_counts).some(n => !Number.isInteger(n) || n < 0 || n > 2000000)) fail('invalid_input');
  let used = false, queries = 0, bytes = 0, started;
  /** Apply the same live cancellation/budget and fixed deadline to every nested query. */
  function check() { options.checkBudget(); if (performance.now() - started > L.step_ms) fail('deadline'); }
  /** Charge all nested stock/seed result transport; no helper owns a separate uncounted lane. */
  async function execute(text, values) {
    check(); if (++queries > L.queries) fail('query_limit');
    const config = typeof text === 'string' ? { text, values, query_timeout: L.query_ms } : { ...text, query_timeout: L.query_ms };
    const result = await client.query(config); if (!Array.isArray(result?.rows)) fail('invalid_result');
    let encoded; try { encoded = JSON.stringify(result.rows); } catch { fail('invalid_result'); }
    bytes += Buffer.byteLength(encoded); if (bytes > L.read_utf8_bytes) fail('byte_limit'); check(); return result;
  }
  const seeds = createNeighborhoodFrozenJobSourceSeeds({ query: execute }, options);
  /** Both fixed consumers share one single-use aggregate budget and identical fences. */
  async function readPackage(rawPage, originalReplay) {
      const page = prepareNeighborhoodTransactionPackagePageV1(rawPage); if (used) fail('single_use'); used = true; started = performance.now();
      const seed = await seeds.read(), stock = seed.stock, original = stock.original;
      const source = prepareNeighborhoodSharedTypedSource(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source, [stock.generation_id]), stock.generation_id);
      const expected = { generation_id: original.generation_id, format_version: original.source_format_version, status: 'complete',
        source_snapshot: original.source_snapshot, started_at: original.source_transaction_started_at, completed_at: original.completed_at,
        layer_counts: original.layer_counts, row_count: original.row_count, payload_utf8_bytes: original.payload_utf8_bytes };
      if (!same(source, expected) || Object.entries(graph.layer_counts).some(([k, n]) => n > Number(source.layer_counts[k].row_count))) fail('source_mismatch');
      const binding = assessmentEvidenceDigest({ source, profile: TYPED }), values = [stock.generation_id, TYPED.profile_ref.content_sha256];
      /** Require exact complete immutable cache metadata, not a caller DONE claim. */
      function validate(raw) {
        const h = data(raw, ['binding_sha256', 'source_metadata', 'definition_json', 'progress', 'status', 'completed_at']);
        const p = data(h.progress, ['format', 'binding_sha256', 'kind_index', 'after', 'layer_rows', 'typed_rows', 'typed_utf8_bytes']);
        if (h.binding_sha256 !== binding || !same(h.source_metadata, source) || h.definition_json !== TYPED.definition_blob.canonical_json || h.status !== 'complete'
          || typeof h.completed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(h.completed_at)
          || p.format !== 'shared_frozen_typed_progress_v2' || p.binding_sha256 !== binding || p.kind_index !== 7 || p.after !== '' || p.layer_rows !== 0
          || p.typed_rows !== source.row_count || !count(p.typed_utf8_bytes, 8000000000) || BigInt(p.typed_utf8_bytes) < BigInt(p.typed_rows)) fail('cache_unavailable');
      }
      const header = one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read, values)); validate(header);
      const originalLimits=NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_LIMITS;
      const raw = one(await execute((originalReplay?NEIGHBORHOOD_ORIGINAL_TRANSACTION_PACKAGE_V2_SQL:NEIGHBORHOOD_TRANSACTION_PACKAGE_V1_SQL)[page.kind],
        [stock.operation_id, stock.generation_id, TYPED.profile_ref.content_sha256, page.cursor, L.rows,
          ...(originalReplay?[originalLimits.packet_utf8_bytes,originalLimits.row_utf8_bytes,originalLimits.original_utf8_bytes,originalLimits.output_utf8_bytes]
            :[L.packet_utf8_bytes,L.row_utf8_bytes])]));
      const reconciled=originalReplay?reconcileNeighborhoodOriginalTransactionPackageV2(raw,page,check):null;
      let projected = projectNeighborhoodTransactionPackageV1(reconciled?reconciled.packet:raw, page, graph.layer_counts, effectiveDate, period); check();
      if(reconciled&&!projected.package)projected={...projected,next_cursor:reconciled.next_scan_cursor,end_of_kind:reconciled.empty_scan_terminal};
      if (!same(await seeds.read(), seed) || !same(prepareNeighborhoodSharedTypedSource(
        await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.source, [stock.generation_id]), stock.generation_id), source)) fail('source_changed');
      const ending = one(await execute(NEIGHBORHOOD_SHARED_TYPED_V2_SQL.read, values)); validate(ending);
      if (!same(header, ending)) fail('source_changed'); check();
      return freeze({ status: originalReplay?'original_reconciled_native_transaction_package_page':'complete_native_transaction_package_page', graph, stock, seed_index: seed, source_metadata: source,
        typed_profile: TYPED, package_profile: PROFILE, ...projected,
        ...(originalReplay?{original_package_profile:getNeighborhoodOriginalTransactionPackageV2Profile(),
          original_reconciliation:'every_package_original_recompiled_before_retained_projection',scanned_original_count:reconciled.scanned_original_count}:{}),
        authority: 'not_established', coverage: 'one_complete_native_package_not_whole_population',
        source_acquisition: 'not_established', transaction_eligibility: 'not_established', report_update: 'none' });
  }
  return Object.freeze({
    /** A delivered last package needs a fresh empty probe; no cursor proves earlier consumption. */
    page: rawPage=>readPackage(rawPage,false),
    /** Fixed original-rooted replay, never a caller-selected reader or cache-count shortcut. */
    originalPage: rawPage=>readPackage(rawPage,true),
  });
}
