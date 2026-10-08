import { types } from 'node:util';
import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlob, prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';
import { createNeighborhoodFrozenJobStock } from './neighborhoodFrozenJobStock.js';
import { getNeighborhoodFrozenTypedOriginalV1Profile } from './neighborhoodFrozenTypedOriginalV1.js';
import { NEIGHBORHOOD_SHARED_TYPED_SQL } from './neighborhoodSharedTypedGeneration.js';

const METRICS = Object.freeze({ reported_year_built: 'year', reported_residential_area: 'reported_sqft',
  reported_site_area: 'reported_sqft', reported_market_value: null });
const MAX = 2_000_000;
export const NEIGHBORHOOD_FROZEN_STOCK_METRIC_PAGE_LIMITS = Object.freeze({
  accounts: 250, encoded_bytes: 2_100_000, account_bytes: 16_000, queries: 1024, read_bytes: 32_000_000,
});
const L = NEIGHBORHOOD_FROZEN_STOCK_METRIC_PAGE_LIMITS;
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const DEFINITION = freeze({ id: 'neighborhood-frozen-stock-account-metrics-v1', revision: '1',
  typed_original_profile: getNeighborhoodFrozenTypedOriginalV1Profile(), metrics: METRICS, limits: L,
  population: 'one_member_per_exact_geographic_stock_account',
  source_parts: 'all_retained_CAD_parcel_parts_for_each_stock_account_including_parts_outside_geometry',
  numeric: 'PostgreSQL_numeric_exact_decimal_strings_no_JS_Number_no_summing_parts',
  resolution: 'distinct_numeric_values_conflict_equal_replicated_values_count_once',
  priority: ['conflicting_exact_values', 'observed', 'unsupported', 'invalid', 'missing'],
  mixed_records: 'missing_invalid_unsupported_parts_remain_explicit_counts_not_zero_values',
  unknown_unit: 'exact_unsupported_values_retained_never_aggregation_eligible',
  provenance: 'exact_job_generation_original_graph_typed_profile_account_scope_and_part_counts',
  limitations: ['not_verified_GLA_or_historical_stock', 'not_currency_inference', 'not_parcel_level_measurements',
    'no_sales_or_amenity_resolution', 'no_selected_union_statistics', 'no_acquisition_or_source_grant', 'no_report_update'],
});
const definitionText = canonicalAssessmentJson(DEFINITION), definitionRef = prepareNeighborhoodCohortBlob(definitionText);
const PROFILE = freeze({ profile_ref: { id: DEFINITION.id, revision: DEFINITION.revision, content_sha256: definitionRef.content_sha256 },
  definition_blob: { ref: definitionRef, canonical_json: definitionText } });
export function getNeighborhoodFrozenStockMetricProfile() { return PROFILE; }
function fail(reason) { throw new TypeError(`neighborhood_frozen_stock_metrics_${reason}`); }
function data(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || !keys.every(k => names.includes(k) && ds[k].enumerable && Object.hasOwn(ds[k], 'value'))) fail('invalid_input');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
const same = (a, b) => canonicalAssessmentJson(a) === canonicalAssessmentJson(b);
const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= MAX;
function account(value, empty = false) {
  if (typeof value !== 'string' || (!empty && !value) || value.length > 64 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_account');
  return value;
}
export function prepareNeighborhoodFrozenStockMetricPage(value) {
  const v = data(value, ['cursor', 'rowLimit']); account(v.cursor, true);
  if (!Number.isInteger(v.rowLimit) || v.rowLimit < 1 || v.rowLimit > L.accounts) fail('invalid_page');
  return Object.freeze(v);
}
const one = result => { if (result?.rowCount !== 1 || result.rows?.length !== 1) fail('invalid_result'); return result.rows[0]; };
const READ = `/* neighborhood-frozen-stock-metrics:header */ SELECT binding_sha256,profile_sha256,
  to_char(effective_date,'YYYY-MM-DD') AS effective_date,expected_counts,progress,status
  FROM app.neighborhood_custom_cohort_typed_originals WHERE operation_id=$1::uuid AND generation_id=$2::uuid FOR SHARE NOWAIT`;

// Account PK keysets and the typed (operation,kind,account,row_key) index do all
// association work in SQL. A large account's parts never become a Node array.
// CASE protects numeric casts even if stored cells are malformed. Such cells
// refuse the entire page, rather than being silently dropped from statistics.
// Both projections share the same account resolution and transport contract.
// Only these two fixed internal relations/predicates can supply parts; callers
// cannot choose a SQL source, effective date, profile, or account population.
const stockMetricSql = (partsSql, shared = false) => `/* neighborhood-frozen-${shared ? 'shared-' : ''}stock-metrics:page */
WITH accounts AS MATERIALIZED (
  SELECT account_id,parcel_count FROM app.neighborhood_custom_cohort_stock_accounts
  WHERE operation_id=$1::uuid AND account_id>$3 COLLATE "C" ORDER BY account_id LIMIT $4
), rendered AS MATERIALIZED (
  SELECT a.account_id, jsonb_build_object('account_id',a.account_id,'geographic_parcel_count',a.parcel_count::text,
    'source_part_count',r.part_count::text,'observations',r.cells)::text AS encoded, r.invalid_count
  FROM accounts a CROSS JOIN LATERAL (
    WITH parts AS MATERIALIZED (
      ${partsSql}
    ), cells AS (
      SELECT m.key,m.unit,p.observations->m.key AS cell
      FROM parts p CROSS JOIN (VALUES ('reported_year_built','year'),('reported_residential_area','reported_sqft'),
        ('reported_site_area','reported_sqft'),('reported_market_value',NULL)) AS m(key,unit)
    ), literals AS (
      SELECT *,cell->>'state' AS state,cell->>'exact_value' AS literal,
        coalesce(jsonb_typeof(cell)='object' AND cell ?& ARRAY['state','exact_value','unit','reason','raw']
          AND (cell-ARRAY['state','exact_value','unit','reason','raw'])='{}'::jsonb
          AND cell->>'state' IN ('observed','missing','invalid','unsupported')
          AND CASE WHEN cell->>'state'='observed' THEN m.unit IS NOT NULL AND cell->>'unit'=m.unit
            ELSE cell->'unit'='null'::jsonb END
          AND CASE WHEN cell->>'state' IN ('missing','invalid') THEN cell->'exact_value'='null'::jsonb
            ELSE cell->'exact_value'='null'::jsonb OR jsonb_typeof(cell->'exact_value')='string' END,false) AS valid_shape
      FROM cells m
    ), checked AS (
      SELECT *,coalesce(literal ~ '^(0|[1-9][0-9]{0,29})(\\.[0-9]{1,12})?$'
        AND length(replace(literal,'.',''))<=30
        AND (position('.' in literal)=0 OR right(literal,1)<>'0')
        AND (key<>'reported_residential_area' OR literal<>'0')
        AND (key<>'reported_year_built' OR literal ~ '^[0-9]{4}$' AND literal>='1600' AND literal<=left($5,4)),false) AS valid_numeric
      FROM literals
    ), grouped AS (
      SELECT key,max(unit) AS unit,count(*) AS parts,
        count(*) FILTER(WHERE state='observed') AS observed,
        count(*) FILTER(WHERE state='missing') AS missing,count(*) FILTER(WHERE state='invalid') AS invalid,
        count(*) FILTER(WHERE state='unsupported') AS unsupported,
        count(*) FILTER(WHERE NOT valid_shape OR state='observed' AND NOT valid_numeric
          OR literal IS NOT NULL AND NOT valid_numeric) AS bad,
        min(CASE WHEN valid_numeric THEN literal::numeric END) AS low,
        max(CASE WHEN valid_numeric THEN literal::numeric END) AS high
      FROM checked GROUP BY key
    ), resolved AS (
      SELECT *,CASE WHEN low<>high THEN 'conflicting' WHEN observed>0 THEN 'observed'
        WHEN unsupported>0 THEN 'unsupported' WHEN invalid>0 THEN 'invalid' ELSE 'missing' END AS state
      FROM grouped
    ) SELECT (SELECT count(*) FROM parts) AS part_count,coalesce(sum(bad),0)::integer AS invalid_count,
      coalesce(jsonb_object_agg(key,jsonb_build_object('state',state,
        'exact_value',CASE WHEN state IN ('observed','unsupported') AND low=high THEN low::text ELSE NULL END,
        'unit',CASE WHEN state='observed' THEN unit ELSE NULL END,
        'observed_part_count',observed::text,'missing_part_count',missing::text,'invalid_part_count',invalid::text,
        'unsupported_part_count',unsupported::text,
        'conflict_values',CASE WHEN state='conflicting' THEN jsonb_build_array(low::text,high::text) ELSE '[]'::jsonb END)),
        jsonb_build_object(${Object.keys(METRICS).map(key => `'${key}',jsonb_build_object('state','missing','exact_value',NULL,'unit',NULL,
          'observed_part_count','0','missing_part_count','0','invalid_part_count','0','unsupported_part_count','0','conflict_values','[]'::jsonb)`).join(',')})) AS cells
      FROM resolved
  ) r
), lengths AS (
  SELECT *,octet_length(encoded) AS bytes, sum(octet_length(encoded)+1) OVER(ORDER BY account_id) AS cumulative
  FROM rendered
), admitted AS (SELECT * FROM lengths WHERE cumulative+1<=$6 AND bytes<=$7)
SELECT coalesce('['||string_agg(encoded,',' ORDER BY account_id)||']','[]') AS page_json,
  count(*)::integer AS page_count,(SELECT count(*)::integer FROM accounts) AS candidate_count,
  (SELECT coalesce(sum(invalid_count),0)::integer FROM rendered) AS invalid_count,
  (SELECT count(*)::integer FROM lengths WHERE bytes>$7) AS oversized_count,
  max(account_id) AS next_cursor FROM admitted`;
export const NEIGHBORHOOD_FROZEN_STOCK_METRIC_PAGE_SQL = stockMetricSql(`
      SELECT typed->'observations' AS observations FROM app.neighborhood_custom_cohort_typed_original_rows
      WHERE operation_id=$1::uuid AND generation_id=$2::uuid AND kind='parcels' AND account_id=a.account_id`);
export const NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL = stockMetricSql(`
      SELECT typed->'observations' AS observations FROM app.neighborhood_frozen_typed_rows
      WHERE generation_id=$2::uuid AND profile_sha256=$8 AND effective_date=$5::date
        AND kind='parcels' AND account_id=a.account_id`, true);

function exactDecimal(value) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{1,12})?$/.test(value)
    && value.replace('.','').length <= 30 && (!value.includes('.') || !value.endsWith('0'));
}
function decimalOrder(value) {
  const [whole,fraction=''] = value.split('.'); return BigInt(whole)*1_000_000_000_000n+BigInt(fraction.padEnd(12,'0'));
}
function decodeMember(raw, effective) {
  const row = data(raw, ['account_id', 'geographic_parcel_count', 'source_part_count', 'observations']); account(row.account_id);
  const count = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,6})$/.test(value) && Number(value) <= MAX;
  if (!count(row.geographic_parcel_count) || row.geographic_parcel_count === '0' || !count(row.source_part_count)) fail('invalid_result');
  const observations = data(row.observations, Object.keys(METRICS));
  for (const [key, rawCell] of Object.entries(observations)) {
    const cell = data(rawCell, ['state','exact_value','unit','observed_part_count','missing_part_count',
      'invalid_part_count','unsupported_part_count','conflict_values']);
    if (!['observed','missing','invalid','unsupported','conflicting'].includes(cell.state)
      || !['observed_part_count','missing_part_count','invalid_part_count','unsupported_part_count'].every(k => count(cell[k]))
      || ['observed_part_count','missing_part_count','invalid_part_count','unsupported_part_count']
        .reduce((n,k) => n+Number(cell[k]),0) !== Number(row.source_part_count)
      || (cell.state === 'observed' ? cell.unit !== METRICS[key] || cell.unit === null : cell.unit !== null)
      || cell.exact_value !== null && !exactDecimal(cell.exact_value)
      || (cell.state === 'observed' ? cell.exact_value === null : !['unsupported'].includes(cell.state) && cell.exact_value !== null)
      || !Array.isArray(cell.conflict_values) || cell.conflict_values.length !== (cell.state === 'conflicting' ? 2 : 0)
      || cell.conflict_values.some(v => !exactDecimal(v))) fail('invalid_result');
    const observed = Number(cell.observed_part_count), unsupported = Number(cell.unsupported_part_count), invalid = Number(cell.invalid_part_count);
    if (cell.state === 'conflicting'
      ? observed+unsupported<2 || decimalOrder(cell.conflict_values[0])>=decimalOrder(cell.conflict_values[1])
      : cell.state !== (observed>0?'observed':unsupported>0?'unsupported':invalid>0?'invalid':'missing')) fail('invalid_result');
    const values = [...cell.conflict_values,...(cell.exact_value===null?[]:[cell.exact_value])];
    if (key==='reported_residential_area' && values.includes('0')
      || key==='reported_year_built' && values.some(v=>!/^\d{4}$/.test(v) || v<'1600' || v>effective.slice(0,4))) fail('invalid_result');
  }
  return freeze(row);
}

/** Internal DATA reader, not a source grant or acquisition receipt. The actual
 * capture owner verifies finished original graph/geography/identity/typing and
 * current actor, assignment, subject and source rights at both transaction ends.
 * There is no spatial sweep, source recapture, write, new cap, dense roster,
 * member-page HTTP exposure or report update. Page ends do not prove that a
 * caller traversed the full population. The original graph remains required.
 */
export function createNeighborhoodFrozenJobStockMetricPages(client, rawOptions, rawGraph, effectiveDate) {
  return stockMetricPages(client, rawOptions, rawGraph, effectiveDate, false);
}

/** Read the exact prepared shared cache, never build it on a report/cache miss.
 * The job's already pinned stock and complete verified source graph are still
 * required. The current-authorized owner rechecks all rights at both ends.
 * This avoids per-job typing/copies, not scoped original acquisition or report
 * publication. Exact-date V1 semantics and the old per-job reader are unchanged.
 */
export function createNeighborhoodSharedJobStockMetricPages(client, rawOptions, rawGraph, effectiveDate) {
  return stockMetricPages(client, rawOptions, rawGraph, effectiveDate, true);
}

function stockMetricPages(client, rawOptions, rawGraph, effectiveDate, shared) {
  const options = data(rawOptions, ['claim','scope','actorUserId','geometryInput','discovery','subjectIntent','checkBudget']);
  if (typeof options.checkBudget !== 'function') fail('invalid_input');
  const graph = data(rawGraph, ['root','layer_counts']), ref = data(graph.root, ['content_sha256','canonical_utf8_bytes']);
  const root = prepareNeighborhoodCohortBlobReference(ref.content_sha256,ref.canonical_utf8_bytes);
  const kinds = ['parcels','accounts','source_records','sales','sale_links','sync_state','sync_runs'];
  const counts = data(graph.layer_counts, kinds); if (!kinds.every(k => integer(counts[k]))) fail('invalid_input');
  const effective = assessmentDate(effectiveDate), completeProfile = getNeighborhoodFrozenTypedOriginalV1Profile(), typedProfile = completeProfile.profile_ref;
  const stockStore = createNeighborhoodFrozenJobStock(client, options), check = options.checkBudget;
  let busy = false, queries = 0, bytes = 0;
  const query = async (text, values) => {
    check(); if (++queries > L.queries) fail('query_limit');
    const result = await client.query({ text, values, query_timeout: 5000 }); check(); return one(result);
  };
  return Object.freeze({ async page(rawPage) {
    const page = prepareNeighborhoodFrozenStockMetricPage(rawPage); check(); if (busy) fail('concurrent_operation'); busy = true;
    try {
      const stock = await stockStore.read(); check();
      const binding = { stock, graph: { root, layer_counts: counts }, effective_date: effective, profile_ref: typedProfile };
      const parameters = [stock.operation_id, stock.generation_id];
      const original = stock.original;
      const sharedSource = { generation_id: original.generation_id, format_version: original.source_format_version,
        status: 'complete', source_snapshot: original.source_snapshot, started_at: original.source_transaction_started_at,
        completed_at: original.completed_at, layer_counts: original.layer_counts,
        row_count: original.row_count, payload_utf8_bytes: original.payload_utf8_bytes };
      const sharedBinding = assessmentEvidenceDigest({ source: sharedSource, profile: completeProfile, effective_date: effective });
      const headerSql = shared ? NEIGHBORHOOD_SHARED_TYPED_SQL.read : READ;
      const headerValues = shared ? [stock.generation_id, typedProfile.content_sha256, effective] : parameters;
      const validateHeader = row => {
        if (shared) {
          const h = data(row, ['binding_sha256','source_metadata','definition_json','progress','status','completed_at']);
          const p = data(h.progress, ['format','binding_sha256','kind_index','after','layer_rows','typed_rows','typed_utf8_bytes']);
          const bytes = p.typed_utf8_bytes;
          if (h.status !== 'complete' || h.binding_sha256 !== sharedBinding || !same(h.source_metadata, sharedSource)
            || h.definition_json !== completeProfile.definition_blob.canonical_json
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(h.completed_at ?? '')
            || p.format !== 'shared_frozen_typed_progress_v1' || p.binding_sha256 !== sharedBinding
            || p.kind_index !== 7 || p.after !== '' || p.layer_rows !== 0 || p.typed_rows !== original.row_count
            || typeof bytes !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(bytes)
            || BigInt(bytes) > 8_000_000_000n || BigInt(bytes) < BigInt(p.typed_rows)
            || kinds.some(k => counts[k] > Number(original.layer_counts[k].row_count))) fail('unfinished_or_changed_typing');
          return;
        }
        if (row.status !== 'complete' || row.binding_sha256 !== assessmentEvidenceDigest(binding)
          || row.profile_sha256 !== typedProfile.content_sha256 || row.effective_date !== effective
          || !same(row.expected_counts, counts) || !same(row.progress, { format: 'frozen_job_typed_original_progress_v1',
            binding_sha256: row.binding_sha256, kind_index: 7, after: '', layer_rows: 0 })) fail('unfinished_or_changed_typing');
      };
      validateHeader(await query(headerSql, headerValues));
      const values = [...parameters, page.cursor, page.rowLimit, effective, L.encoded_bytes, L.account_bytes];
      if (shared) values.push(typedProfile.content_sha256);
      const result = await query(shared ? NEIGHBORHOOD_SHARED_STOCK_METRIC_PAGE_SQL : NEIGHBORHOOD_FROZEN_STOCK_METRIC_PAGE_SQL, values);
      if (!Number.isInteger(result.page_count) || !Number.isInteger(result.candidate_count)
        || result.page_count < 0 || result.candidate_count < result.page_count || result.candidate_count > page.rowLimit
        || result.invalid_count !== 0 || result.oversized_count !== 0 || typeof result.page_json !== 'string') fail('invalid_result');
      bytes += Buffer.byteLength(result.page_json);
      if (Buffer.byteLength(result.page_json) > L.encoded_bytes || bytes > L.read_bytes) fail('byte_limit');
      let rows; try { rows = JSON.parse(result.page_json); } catch { fail('invalid_result'); }
      if (!Array.isArray(rows) || rows.length !== result.page_count) fail('invalid_result');
      let previous = page.cursor;
      rows = rows.map(row => { const decoded = decodeMember(row,effective);
        if (Buffer.compare(Buffer.from(decoded.account_id),Buffer.from(previous)) <= 0) fail('invalid_result');
        previous = decoded.account_id; return decoded; });
      if (result.next_cursor !== (rows.length ? previous : null) || rows.length === 0 && result.candidate_count !== 0) fail('invalid_result');
      if (!same(await stockStore.read(), stock)) fail('binding_changed'); check(); validateHeader(await query(headerSql, headerValues));
      return freeze({ status: 'stock_account_metric_page', authority: 'not_established', coverage: 'one_account_page_only',
        profile: PROFILE, typed_original_profile_ref: typedProfile, source_graph_root: root,
        operation_id: stock.operation_id, generation_id: stock.generation_id, spatial_definition_sha256: stock.definition_sha256,
        source_original_sha256: stock.source_original_sha256, effective_date: effective,
        population: stock.population, source_part_population_count: String(counts.parcels),
        cursor: page.cursor, row_limit: page.rowLimit, rows, next_cursor: rows.length ? previous : page.cursor,
        end_of_population: result.candidate_count < page.rowLimit && result.page_count === result.candidate_count,
        ...(shared ? { shared_typed_generation_reference: { shared_typed_reference_version: 1,
          generation_id: stock.generation_id, profile_ref: typedProfile, effective_date: effective,
          binding_sha256: sharedBinding, source_original_sha256: stock.source_original_sha256 } } : {}),
        source_freshness: 'not_established', source_acquisition: 'not_established', report_update: 'none' });
    } finally { busy = false; }
  } });
}
