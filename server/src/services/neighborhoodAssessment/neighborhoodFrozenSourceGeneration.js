import { performance } from 'node:perf_hooks';
import { CACHED_SALE_WITNESS_V2_SQL } from './cachedSaleWitnessV2.js';

export const NEIGHBORHOOD_FROZEN_SOURCE_LIMITS = Object.freeze({
  batch_size: 250, rows_per_layer: 2_000_000, page_utf8_bytes: 32_000_000,
  total_utf8_bytes: 8_000_000_000, maximum_runtime_ms: 3_600_000,
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
// Every field and source relation is module-owned. No to_jsonb(source.*), raw
// MLS payload, documents, arbitrary keys, request-selected table or date filter.
// Text projections preserve decimal/date/identifier literals before Node can
// round numbers. A later versioned reader must remap them, never cast this
// saved mirror into the old in-process acquisition receipt.
const layer = (table, alias, key, fields, { account = 'NULL::text', source = 'NULL::bigint', geometry = 'NULL::geometry', keyType = 'bigint' } = {}) => {
  const projection = fields.map(field => {
    const [name, text] = field.split(':');
    return `${alias}.${name}${text ? '::text' : ''} AS ${name}`;
  }).join(',');
  return { table, alias, key: `${alias}.${key}::text`, nativeKey: `${alias}.${key}`,keyType,account,source,geometry,
    payload: `(SELECT to_jsonb(projected) FROM (SELECT ${projection}) projected)` };
};
const layers = Object.freeze({
  parcels: layer('gis.dcad_parcels', 'parcel', 'object_id', [
    'object_id:text','account_id','low_parcel_id','residential_year_built','residential_area_sqft:text',
    'parcel_area_sqft:text','current_market_value:text','land_use_category','classification_confidence',
    'classification_review_reason','subdivision_name','source_record_hash','source_updated_at:text',
    'sync_run_id:text','synced_at:text','class_code','class_description','use_description','structure_type','built_up',
  ], { account: 'parcel.account_id', geometry: 'ST_Multi(parcel.geom)' }),
  accounts: layer('core.accounts', 'account', 'account_id', [
    'account_id','county','subdivision','neighborhood_code','legal_description',
  ], { account: 'account.account_id',keyType:'text' }),
  source_records: layer('core.sales_source_records', 'src', 'id', [
    'id:text','source_name','source_filename','source_sha256','source_record_hash','transaction_fingerprint',
    'listing_key','listing_id','source_system_name','source_modified_at:text','loaded_at:text','updated_at:text',
    'primary_account_id','record_type','close_date:text','listing_contract_date:text','current_price:text',
    'living_area:text','lot_size_area:text','year_built','bedrooms_total','bathrooms_total_integer',
    'bathrooms_full','bathrooms_half','structural_style','housing_type','attachment_type','architectural_style',
    'garage_spaces:text','garage_yn','pool_yn','days_on_market','parcel_number_raw','parcel_number2_raw',
    'match_status','has_multiple_parcel_numbers','multi_parcel_status','has_unresolved_parcel',
    'requires_additional_review','data_quality_flags','mls_status','source_row_number',
  ], { account: 'src.primary_account_id', source: 'src.id' }),
  sales: layer('core.sales', 'sale', 'id', [
    'id:text','source_record_id:text','account_id','closing_date:text','sale_price:text','source','loaded_at:text',
  ], { account: 'sale.account_id', source: 'sale.source_record_id' }),
  sale_links: layer('core.sale_parcels', 'link', 'id', [
    'id:text','source_record_id:text','source_position','parcel_sequence','parcel_role','parcel_number_raw',
    'parcel_number_normalized','account_id','match_method','is_resolved','loaded_at:text',
  ], { account: 'link.account_id', source: 'link.source_record_id' }),
  sync_state: layer('gis.source_sync_state', 'state', 'source_key', [
    'source_key','status','source_vintage','row_count:text','last_attempt_at:text','last_success_at:text',
    'last_source_update_at:text','last_run_id:text','updated_at:text',
  ], {keyType:'text'}),
  sync_runs: layer('gis.source_sync_runs', 'run', 'id', [
    'id:text','source_key','mode','status','records_seen:text','records_written:text','records_deleted:text',
    'started_at:text','completed_at:text',
  ], {keyType:'uuid'}),
});
const SQL = Object.freeze(Object.fromEntries(Object.entries(layers).map(([kind, plan]) => {
  const payload = kind === 'parcels'
    ? `${plan.payload} || jsonb_build_object('stored_geometry_ewkb',encode(ST_AsEWKB(parcel.geom),'hex'))`
    : kind === 'source_records'
      ? `${plan.payload} || jsonb_build_object('source_raw_witness',${CACHED_SALE_WITNESS_V2_SQL})` : plan.payload;
  const nativeOrder = plan.nativeKey;
  return [kind, `/* neighborhood-frozen-source:${kind} */ WITH batch AS MATERIALIZED (
    SELECT ${plan.key} AS row_key,${nativeOrder} AS source_order_key,${plan.account} AS account_id,${plan.source} AS source_record_id,
      ${payload} AS payload,${plan.geometry} AS geom
    FROM ${plan.table} ${plan.alias} WHERE ($2::text='' OR ${nativeOrder}>NULLIF($2,'')::${plan.keyType})
    ORDER BY ${nativeOrder} LIMIT $3::integer
  ), copied AS (
    INSERT INTO app.neighborhood_frozen_source_rows(generation_id,kind,row_key,account_id,source_record_id,payload,geom)
    SELECT $1::uuid,'${kind}',row_key,account_id,source_record_id,payload,geom FROM batch
    RETURNING row_key,octet_length(payload::text) AS bytes
  ) SELECT coalesce((SELECT row_key FROM batch ORDER BY source_order_key DESC LIMIT 1),$2)::text AS cursor,
    count(*)::integer AS copied,coalesce(sum(bytes),0)::text AS payload_utf8_bytes FROM copied`];
})));
const COUNTS = Object.freeze(Object.fromEntries(Object.entries(layers).map(([kind, plan]) => [kind,
  `/* neighborhood-frozen-source:count-${kind} */ SELECT count(*)::text AS row_count,
    coalesce(bool_or(${plan.key} IS NULL OR ${plan.key}='' OR octet_length(${plan.key})>256),false) AS invalid_key
    FROM ${plan.table} ${plan.alias}`])));
const SNAPSHOT = `/* neighborhood-frozen-source:snapshot */ SELECT
  txid_current()::text AS transaction_id,pg_current_snapshot()::text AS source_snapshot,
  current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
  current_setting('TimeZone') AS timezone,
  to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
  pg_backend_pid() AS backend_pid`;
function fail(reason) { throw new TypeError(`neighborhood_frozen_source_${reason}`); }
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) fail('invalid_result');
  return result.rows[0];
}
function snapshot(result) {
  const row = one(result);
  if (row.isolation !== 'repeatable read' || row.read_only !== 'off' || row.timezone !== 'UTC'
    || !/^[1-9][0-9]{0,19}$/.test(row.transaction_id ?? '')
    || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(row.source_snapshot ?? '')
    || row.source_snapshot.length > 65536 || !Number.isInteger(row.backend_pid) || row.backend_pid < 1
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.started_at ?? '')) fail('caller_snapshot_required');
  return row;
}

/** Explicit OFF-by-default nightly writer companion. The caller owns one
 * repeatable-read transaction and publishes the matching descriptive index
 * only after this succeeds. No COMMIT, global pool, authorization, original
 * acquisition/selection/statistics/report receipt or new HTTP path is provided.
 * Only aggregate counts cross into Node; complete source rows stay in SQL.
 */
export async function materializeNeighborhoodFrozenSourceGeneration(client, {
  generationId, batchSize = 100, maximumRuntimeMs = NEIGHBORHOOD_FROZEN_SOURCE_LIMITS.maximum_runtime_ms,
  signal, checkBudget = () => {},
} = {}) {
  const limits = NEIGHBORHOOD_FROZEN_SOURCE_LIMITS;
  if (typeof client?.query !== 'function' || typeof generationId !== 'string' || !UUID.test(generationId)
    || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > limits.batch_size
    || !Number.isInteger(maximumRuntimeMs) || maximumRuntimeMs < 1 || maximumRuntimeMs > limits.maximum_runtime_ms
    || typeof checkBudget !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) fail('invalid_input');
  const deadline = performance.now() + maximumRuntimeMs;
  const check = () => { if (signal?.aborted) fail('cancelled'); checkBudget();
    if (signal?.aborted) fail('cancelled'); if (performance.now() >= deadline) fail('runtime_limit'); };
  const query = async (text, values) => { check(); const result = await client.query({ text, values,
    query_timeout: Math.max(1, Math.min(120000, Math.ceil(deadline - performance.now()))) }); check(); return result; };
  // Both probes precede writes. Autocommit or a pool that changes backend/tx
  // cannot leave a misleading source header or partially committed pages.
  const start = snapshot(await query(SNAPSHOT));
  if (JSON.stringify(start) !== JSON.stringify(snapshot(await query(SNAPSHOT)))) fail('caller_snapshot_changed');
  const generation = one(await query(`/* neighborhood-frozen-source:generation */
    SELECT generation_id::text,status FROM app.neighborhood_group_generations
    WHERE generation_id=$1::uuid FOR UPDATE NOWAIT`, [generationId]));
  if (generation.generation_id !== generationId || generation.status !== 'building') fail('building_generation_required');
  const expectedCounts = {};
  // Independently count every row in this same snapshot, including null-account
  // parcels and unresolved/all-date sales links. Empty keys cannot disappear
  // behind a keyset predicate and turn a partial sweep into a complete version.
  for (const [kind, sql] of Object.entries(COUNTS)) {
    const row = one(await query(sql));
    if (row.invalid_key !== false || !/^(?:0|[1-9][0-9]{0,7})$/.test(row.row_count ?? '')
      || Number(row.row_count) > limits.rows_per_layer) fail('source_population_invalid');
    expectedCounts[kind] = Number(row.row_count);
  }
  await query(`/* neighborhood-frozen-source:header */ INSERT INTO app.neighborhood_frozen_source_generations
    (generation_id,format_version,status,source_snapshot,source_transaction_started_at)
    VALUES($1::uuid,1,'building',$2,$3::timestamptz)`, [generationId,start.source_snapshot,start.started_at]);
  const counts = {}; let rows = 0, bytes = 0;
  for (const [kind, sql] of Object.entries(SQL)) {
    let cursor = '', count = 0, layerBytes = 0;
    for (;;) {
      const row = one(await query(sql,[generationId,cursor,batchSize]));
      if (!Number.isInteger(row.copied) || row.copied < 0 || row.copied > batchSize
        || typeof row.cursor !== 'string' || Buffer.byteLength(row.cursor) > 256
        || !/^(?:0|[1-9][0-9]{0,10})$/.test(row.payload_utf8_bytes ?? '')) fail('invalid_page');
      const pageBytes = Number(row.payload_utf8_bytes);
      if (pageBytes > limits.page_utf8_bytes || (row.copied === 0 ? row.cursor !== cursor || pageBytes !== 0
        : !row.cursor || !advances(row.cursor,cursor,layers[kind].keyType) || pageBytes < row.copied)) fail('invalid_page');
      count += row.copied; rows += row.copied; layerBytes += pageBytes; bytes += pageBytes;
      if (count > limits.rows_per_layer || bytes > limits.total_utf8_bytes) fail('population_limit');
      if (row.copied === 0) break;
      cursor = row.cursor;
    }
    if (count !== expectedCounts[kind]) fail('source_population_incomplete');
    counts[kind] = Object.freeze({ row_count: String(count), payload_utf8_bytes: String(layerBytes) });
  }
  if (JSON.stringify(start) !== JSON.stringify(snapshot(await query(SNAPSHOT)))) fail('caller_snapshot_changed');
  const result = await query(`/* neighborhood-frozen-source:complete */ UPDATE app.neighborhood_frozen_source_generations
    SET status='complete',completed_at=clock_timestamp(),layer_counts=$2::jsonb,
      row_count=$3::bigint,payload_utf8_bytes=$4::bigint WHERE generation_id=$1::uuid AND status='building'`,
  [generationId,JSON.stringify(counts),String(rows),String(bytes)]);
  if (result?.rowCount !== 1) fail('completion_lost');
  return Object.freeze({ status: 'materialized', authority: 'not_established', format_version: 1,
    generation_id: generationId,source_snapshot: start.source_snapshot,
    source_transaction_started_at: start.started_at,row_count: String(rows),payload_utf8_bytes: String(bytes),
    layer_counts: Object.freeze(counts) });
}

export const NEIGHBORHOOD_FROZEN_SOURCE_SQL = SQL;

function advances(next, prior, type) {
  if (type==='bigint') {
    if (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(next)) return false;
    const number=BigInt(next);
    return number>=-9223372036854775808n && number<=9223372036854775807n
      && (prior==='' || number>BigInt(prior));
  }
  if (type==='uuid' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(next)) return false;
  // Text source keys use their original primary-key collation in SQL, not a
  // JS locale or a new cast that makes every batch rescan/sort the whole city.
  // The fixed strict SQL keyset, unique inserts and independent complete count
  // establish progress/order; Node never guesses the database's text collation.
  return prior==='' || (type==='text' ? next!==prior : Buffer.compare(Buffer.from(next),Buffer.from(prior))>0);
}
