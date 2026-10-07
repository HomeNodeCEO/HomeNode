import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { createCustomCohortCaptureJobRepository, prepareCustomCohortCaptureJobClaim }
  from './customCohortCaptureJobRepository.js';

export const NEIGHBORHOOD_FROZEN_PAGE_LIMITS = Object.freeze({
  // Retention permits 1 MB of PostgreSQL JSON text. Encoding that text again
  // can double its quotes/backslashes. 2.1 MB also covers a 256-byte row key
  // (even with six-byte control escapes), fixed field names and array framing.
  // Thus every valid retained row fits alone; aggregate admission stays in SQL.
  rows: 250, page_utf8_bytes: 2_100_000, operation_utf8_bytes: 32_000_000,
  pages: 64, queries: 2048, operation_ms: 60_000,
});
const KINDS = Object.freeze({ parcels: 'bigint', accounts: 'text', source_records: 'bigint',
  sales: 'bigint', sale_links: 'bigint', sync_state: 'text', sync_runs: 'uuid' });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SNAPSHOT = /^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/;
/** Refuse the page without granting partial-result or acquisition authority. */
function fail(reason) { throw new TypeError(`neighborhood_frozen_pages_${reason}`); }
/** Copy only plain enumerable own data fields, without invoking caller code. */
function data(value, required, optional = []) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
  if (!required.every(key => names.includes(key)) || names.some(key => typeof key !== 'string'
    || ![...required, ...optional].includes(key) || !Object.hasOwn(descriptors[key], 'value')
    || !descriptors[key].enumerable)) fail('invalid_input');
  return Object.fromEntries(names.map(key => [key, descriptors[key].value]));
}
/** Validate exact decimal count text without first rounding it through Number. */
function boundedInteger(value, maximum) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
    && BigInt(value) <= BigInt(maximum);
}
/** Validate the native keyset cursor for one fixed original-source layer. */
function cursor(value, type) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 256 || value.includes('\0')) fail('invalid_cursor');
  if (!value) return value;
  if (type === 'bigint' && (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(value)
    || BigInt(value) < -9223372036854775808n || BigInt(value) > 9223372036854775807n)) fail('invalid_cursor');
  if (type === 'uuid' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) fail('invalid_cursor');
  return value;
}
/** Compare keys using the same numeric or byte order as the SQL page plan. */
function advancing(next, previous, type) {
  if (!next) return false;
  return previous === '' || (type === 'bigint' ? BigInt(next) > BigInt(previous)
    : Buffer.compare(Buffer.from(next), Buffer.from(previous)) > 0);
}
/** Require the single aggregate/header row promised by a fixed SQL plan. */
function one(result) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) fail('invalid_result');
  return result.rows[0];
}
/** Build ordering only from this module's closed kind-to-native-type mapping. */
const order = type => type === 'text' ? 'row_key COLLATE "C"' : `row_key::${type}`;
// Closed fixed plans, not a request-chosen relation, predicate or projection.
// PostgreSQL admits encoded rows by their *actual transport* bytes before any
// payload crosses to Node. The cursor always names the last admitted original.
const SQL = Object.freeze(Object.fromEntries(Object.entries(KINDS).map(([kind, type]) => [kind,
  `/* neighborhood-frozen-pages:${kind} */ WITH candidates AS MATERIALIZED (
    SELECT row_key,${order(type)} AS ordering,
      jsonb_build_object('row_key',row_key,'payload_text',payload::text) AS encoded
    FROM app.neighborhood_frozen_source_rows
    WHERE generation_id=$1::uuid AND kind='${kind}'
      AND ($2::text='' OR ${order(type)}>NULLIF($2,'')::${type}${type === 'text' ? ' COLLATE "C"' : ''})
    ORDER BY ${order(type)} LIMIT $3::integer
  ), sized AS (
    SELECT *,sum(octet_length(encoded::text)+2) OVER(ORDER BY ordering) AS prefix_bytes FROM candidates
  ), admitted AS (
    SELECT * FROM sized WHERE prefix_bytes+2 <= $4::bigint
  ), page AS (
    SELECT coalesce(jsonb_agg(encoded ORDER BY ordering),'[]'::jsonb)::text AS page_json,
      count(*)::integer AS page_count FROM admitted
  ) SELECT page_json,page_count,octet_length(page_json)::integer AS page_utf8_bytes,
    (SELECT count(*)::integer FROM candidates) AS candidate_count,
    coalesce((SELECT row_key FROM admitted ORDER BY ordering DESC LIMIT 1),$2)::text AS next_cursor FROM page`
])));
const HEADER = `/* neighborhood-frozen-pages:header */ SELECT generation_id::text,format_version,status,
  source_snapshot,to_char(source_transaction_started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
  to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
  layer_counts,row_count::text,payload_utf8_bytes::text FROM app.neighborhood_frozen_source_generations
  WHERE generation_id=$1::uuid`;
/** Validate all seven layer totals and the exact pinned snapshot identity. */
function metadata(result, generationId) {
  const row = one(result);
  if (row.generation_id !== generationId || row.format_version !== 1 || row.status !== 'complete'
    || typeof row.source_snapshot !== 'string' || row.source_snapshot.length > 65536 || !SNAPSHOT.test(row.source_snapshot)
    || !DATE.test(row.started_at ?? '') || !DATE.test(row.completed_at ?? '') || row.completed_at < row.started_at
    || !boundedInteger(row.row_count, 14_000_000) || !boundedInteger(row.payload_utf8_bytes, 8_000_000_000)) fail('header_corrupt');
  const counts = data(row.layer_counts, Object.keys(KINDS)); let totalRows = 0, totalBytes = 0;
  for (const kind of Object.keys(KINDS)) {
    const item = data(counts[kind], ['row_count', 'payload_utf8_bytes']);
    if (!boundedInteger(item.row_count, 2_000_000) || !boundedInteger(item.payload_utf8_bytes, 8_000_000_000)
      || (item.row_count === '0' ? item.payload_utf8_bytes !== '0' : Number(item.payload_utf8_bytes) < Number(item.row_count))) fail('header_corrupt');
    counts[kind] = Object.freeze(item); totalRows += Number(item.row_count); totalBytes += Number(item.payload_utf8_bytes);
  }
  if (String(totalRows) !== row.row_count || String(totalBytes) !== row.payload_utf8_bytes) fail('header_corrupt');
  return Object.freeze({ source_format_version: 1, generation_id: generationId,
    source_snapshot: row.source_snapshot, source_transaction_started_at: row.started_at, completed_at: row.completed_at,
    row_count: row.row_count, payload_utf8_bytes: row.payload_utf8_bytes, layer_counts: Object.freeze(counts) });
}

/** Internal storage primitive, not current assignment/source authorization.
 * The owner must independently recheck current actor, assignment, subject and
 * source-purpose rights at both ends in its caller-owned transaction. This
 * reader only reopens an ALREADY pinned exact live scoped job, never creates a
 * pin, follows an active pointer, commits, acquires mutable sources, or mints
 * legacy acquisition/membership/statistics/report authority. Pages preserve
 * original JSON text (including decimal literals) and never claim whole-study
 * coverage. A later acquisition owner must verify complete original lineage.
 * Every failure requires caller rollback/settled client cleanup; no HTTP mount.
 */
export function createNeighborhoodFrozenSourcePages(client, rawOptions) {
  if (typeof client?.query !== 'function') fail('client_required');
  const options = data(rawOptions, ['claim', 'scope', 'actorUserId'], ['signal', 'checkBudget']);
  const claim = prepareCustomCohortCaptureJobClaim(data(options.claim, ['operation_id', 'claim_token', 'attempts']));
  const scope = Object.freeze(data(options.scope, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']));
  const { actorUserId, signal } = options, checkBudget = options.checkBudget ?? (() => {});
  if (typeof actorUserId !== 'string' || !UUID.test(actorUserId) || typeof checkBudget !== 'function'
    || (signal !== undefined && !(signal instanceof AbortSignal))) fail('invalid_input');
  const limits = NEIGHBORHOOD_FROZEN_PAGE_LIMITS, deadline = performance.now() + limits.operation_ms;
  let busy = false, pages = 0, queries = 0, bytes = 0;
  const check = () => { if (signal?.aborted) fail('cancelled'); checkBudget();
    if (signal?.aborted) fail('cancelled'); if (performance.now() >= deadline) fail('deadline'); };
  const port = { async query(text, values) {
    check(); if (++queries > limits.queries) fail('operation_limit');
    const config = typeof text === 'string' ? { text, values } : text;
    const result = await client.query({ ...config,
      query_timeout: Math.max(1, Math.min(3000, Math.ceil(deadline - performance.now()))) });
    check(); return result;
  } };
  const jobs = createCustomCohortCaptureJobRepository(port), jobOptions = Object.freeze({ scope, actorUserId });
  return Object.freeze({ async page(rawPage) {
    const input = data(rawPage, ['kind', 'cursor'], ['rowLimit']);
    if (typeof input.kind !== 'string' || !Object.hasOwn(KINDS, input.kind)) fail('invalid_kind');
    const type = KINDS[input.kind], previous = cursor(input.cursor, type), rowLimit = input.rowLimit ?? 100;
    if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > limits.rows) fail('invalid_limit');
    check(); if (busy) fail('concurrent_read'); if (++pages > limits.pages) fail('operation_limit'); busy = true;
    try {
      const pin = await jobs.readPreparedGeneration(claim, jobOptions);
      if (!pin) fail('pin_unavailable');
      const start = metadata(await port.query(HEADER, [pin.generation_id]), pin.generation_id);
      const row = one(await port.query(SQL[input.kind], [pin.generation_id, previous, rowLimit, limits.page_utf8_bytes]));
      if (!Number.isInteger(row.page_count) || row.page_count < 0 || row.page_count > rowLimit
        || !Number.isInteger(row.candidate_count) || row.candidate_count < row.page_count || row.candidate_count > rowLimit
        || typeof row.page_json !== 'string' || !Number.isInteger(row.page_utf8_bytes)
        || row.page_utf8_bytes !== Buffer.byteLength(row.page_json) || row.page_utf8_bytes > limits.page_utf8_bytes) fail('page_corrupt');
      bytes += row.page_utf8_bytes; if (bytes > limits.operation_utf8_bytes) fail('operation_limit');
      let rows; try { rows = JSON.parse(row.page_json); } catch { fail('page_corrupt'); }
      if (!Array.isArray(rows) || rows.length !== row.page_count || rows.length > Number(start.layer_counts[input.kind].row_count)) fail('page_corrupt');
      let last = previous;
      rows = rows.map(raw => {
        const item = data(raw, ['row_key', 'payload_text']); cursor(item.row_key, type);
        if (!advancing(item.row_key, last, type) || typeof item.payload_text !== 'string'
          || Buffer.byteLength(item.payload_text) > 1_000_000) fail('page_corrupt');
        let payload; try { payload = JSON.parse(item.payload_text); } catch { fail('page_corrupt'); }
        if (!payload || Array.isArray(payload) || typeof payload !== 'object') fail('page_corrupt');
        last = item.row_key; return Object.freeze(item);
      });
      if (row.next_cursor !== last || (rows.length === 0 && row.candidate_count !== 0)
        || (previous === '' && rows.length === 0 && start.layer_counts[input.kind].row_count !== '0')) fail('page_unavailable');
      const end = metadata(await port.query(HEADER, [pin.generation_id]), pin.generation_id);
      if (JSON.stringify(end) !== JSON.stringify(start)
        || JSON.stringify(await jobs.readPreparedGeneration(claim, jobOptions)) !== JSON.stringify(pin)) fail('source_changed');
      check();
      return Object.freeze({ status: 'original_page', authority: 'not_established', coverage: 'page_only',
        original: start, kind: input.kind, after: previous, next_cursor: last, rows: Object.freeze(rows),
        end_of_layer: row.candidate_count < rowLimit && rows.length === row.candidate_count,
        page_utf8_bytes: row.page_utf8_bytes });
    } finally { busy = false; }
  } });
}

export const NEIGHBORHOOD_FROZEN_PAGE_SQL = SQL;
