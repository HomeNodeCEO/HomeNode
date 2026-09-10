import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const PREPARED_SALES_INTEGRITY_LIMITS = Object.freeze({
  partBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  parts: 10001,
  depth: 32,
  nodesPerPart: 250000,
  pageRows: 100,
  pagePayloadBytes: 4 * 1024 * 1024,
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const error = suffix => Object.assign(new Error(`assignment_sales_import_${suffix}`),
  { code: `assignment_sales_import_${suffix}` });
const invalid = () => { throw error('invalid_receipt'); };
const limited = () => { throw error('preparation_limit'); };

/** Canonical encoding for this installed preparation's generated JSON values,
 * not a general-purpose source interpreter. Numeric measurements are strings;
 * the generated JSON numbers (counts/ordinals/int32 observations) are safe integers.
 * Key ordering is explicit even for integer-looking keys, unlike object rebuilding.
 */
export function serializePreparedSalesValue(value) {
  const pieces = [], ancestors = new Set();
  let bytes = 0, nodes = 0;
  const emit = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > PREPARED_SALES_INTEGRITY_LIMITS.partBytes) limited();
    pieces.push(text);
  };
  const string = text => {
    if (!text.isWellFormed()) invalid();
    if (Buffer.byteLength(text) > PREPARED_SALES_INTEGRITY_LIMITS.partBytes) limited();
    return JSON.stringify(text);
  };
  const visit = (item, depth) => {
    nodes += 1;
    if (depth > PREPARED_SALES_INTEGRITY_LIMITS.depth || nodes > PREPARED_SALES_INTEGRITY_LIMITS.nodesPerPart) limited();
    if (item === null) { emit('null'); return; }
    if (typeof item === 'string') { emit(string(item)); return; }
    if (typeof item === 'boolean') { emit(item ? 'true' : 'false'); return; }
    if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) invalid();
      emit(JSON.stringify(item)); return;
    }
    if (typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) invalid();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) invalid();
    if (array && item.length > PREPARED_SALES_INTEGRITY_LIMITS.nodesPerPart) limited();
    const keys = Reflect.ownKeys(item);
    if (keys.length > PREPARED_SALES_INTEGRITY_LIMITS.nodesPerPart + 1) limited();
    if (array) {
      if (keys.length !== item.length + 1 || keys.some(key => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))) invalid();
    } else if (keys.some(key => typeof key !== 'string')) invalid();
    ancestors.add(item);
    emit(array ? '[' : '{');
    const ordered = array ? Array.from({ length: item.length }, (_, index) => String(index)) : keys.sort();
    for (let index = 0; index < ordered.length; index += 1) {
      const key = ordered[index], descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      if (index) emit(',');
      if (!array) { emit(string(key)); emit(':'); }
      visit(descriptor.value, depth + 1);
    }
    emit(array ? ']' : '}');
    ancestors.delete(item);
  };
  visit(value, 0);
  return pieces.join('');
}

/** Header first, then every logical row in source order. A failed addition poisons
 * the digest so callers cannot omit a bad row and continue with a partial receipt.
 */
export function createPreparedSalesDigest() {
  const hash = createHash('sha256');
  let closed = false, parts = 0, bytes = 0;
  return Object.freeze({
    add(value) {
      if (closed) invalid();
      try {
        if (parts === PREPARED_SALES_INTEGRITY_LIMITS.parts) limited();
        const json = serializePreparedSalesValue(value), size = Buffer.byteLength(json);
        if (bytes + size > PREPARED_SALES_INTEGRITY_LIMITS.totalBytes) limited();
        hash.update(`${size}:`).update(json);
        bytes += size;
        parts += 1;
      } catch (problem) { closed = true; throw problem; }
    },
    digest() {
      if (closed || parts === 0) invalid();
      closed = true;
      return hash.digest('hex');
    },
  });
}

export function digestPreparedSalesParts(header, rows) {
  if (types.isProxy(rows) || !Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) invalid();
  if (rows.length >= PREPARED_SALES_INTEGRITY_LIMITS.parts) limited();
  const digest = createPreparedSalesDigest();
  digest.add(header);
  for (let index = 0; index < rows.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    digest.add(descriptor.value);
  }
  return digest.digest();
}

// Limit keys BEFORE metering toasted JSONB. MATERIALIZED boundaries retain only
// keys/byte metadata until a <=4MiB prefix has been chosen. Lookahead is metadata,
// not an extra large payload transferred to Node. All table identifiers are fixed.
export const STORED_SALES_ROWS_SQL = `/* assignment-sales:bounded-rows */
WITH candidate_keys AS MATERIALIZED (
  SELECT receipt_id, source_row_number
  FROM app.assignment_sales_import_rows
  WHERE batch_id = $1::uuid AND source_row_number > $2::integer
  ORDER BY source_row_number LIMIT ($3::integer + 1)
), metered AS MATERIALIZED (
  SELECT k.receipt_id, k.source_row_number,
    pg_catalog.octet_length(pg_catalog.convert_to(r.record_data::text, 'UTF8')) AS payload_bytes
  FROM candidate_keys k JOIN app.assignment_sales_import_rows r
    ON r.batch_id = $1::uuid AND r.source_row_number = k.source_row_number AND r.receipt_id = k.receipt_id
), ranked AS MATERIALIZED (
  SELECT *, row_number() OVER (ORDER BY source_row_number) AS ordinal,
    sum(payload_bytes) OVER (ORDER BY source_row_number ROWS UNBOUNDED PRECEDING) AS cumulative_bytes
  FROM metered
), selected_keys AS MATERIALIZED (
  SELECT receipt_id, source_row_number, payload_bytes FROM ranked
  WHERE ordinal <= $3::integer AND payload_bytes BETWEEN 1 AND 2097152
    AND cumulative_bytes <= 4194304
), summary AS MATERIALIZED (
  SELECT (SELECT count(*)::integer FROM candidate_keys) AS candidate_count,
    (SELECT count(*)::integer FROM metered) AS metered_count,
    (SELECT count(*)::integer FROM metered WHERE payload_bytes IS NULL OR payload_bytes < 1 OR payload_bytes > 2097152) AS invalid_count,
    (SELECT count(*)::integer FROM selected_keys) AS returned_count,
    COALESCE((SELECT sum(payload_bytes)::integer FROM selected_keys), 0) AS returned_payload_bytes,
    (SELECT payload_bytes FROM ranked WHERE ordinal = (SELECT count(*) + 1 FROM selected_keys)) AS next_payload_bytes
)
SELECT s.*, s.candidate_count > s.returned_count AS has_more,
  k.receipt_id, k.source_row_number, k.payload_bytes,
  CASE WHEN s.invalid_count = 0 THEN r.record_data ELSE NULL END AS record_data
FROM summary s
LEFT JOIN selected_keys k ON s.invalid_count = 0
LEFT JOIN app.assignment_sales_import_rows r
  ON r.batch_id = $1::uuid AND r.source_row_number = k.source_row_number AND r.receipt_id = k.receipt_id
ORDER BY k.source_row_number`;

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** Caller owns the already-authorized, stable transaction and exact batch scope.
 * This does not acquire a pool connection, authorize a batch, or mark it verified.
 */
export async function readStoredSalesRows(query, batchId, afterRow, limit) {
  if (typeof query !== 'function' || typeof batchId !== 'string' || !UUID.test(batchId)
    || !boundedInteger(afterRow, 0, 10001) || !boundedInteger(limit, 1, PREPARED_SALES_INTEGRITY_LIMITS.pageRows)) invalid();
  const result = await query(STORED_SALES_ROWS_SQL, [batchId, afterRow, limit]);
  if (!Array.isArray(result?.rows) || result.rows.length < 1 || result.rows.length > limit
    || (result.rowCount !== undefined && result.rowCount !== result.rows.length)) invalid();
  const first = result.rows[0];
  const metadata = ['candidate_count', 'metered_count', 'returned_count', 'invalid_count',
    'returned_payload_bytes', 'next_payload_bytes', 'has_more'];
  if (!boundedInteger(first.candidate_count, 0, limit + 1) || first.metered_count !== first.candidate_count
    || first.invalid_count !== 0 || !boundedInteger(first.returned_count, 0, limit)
    || first.returned_count > first.candidate_count
    || !boundedInteger(first.returned_payload_bytes, 0, PREPARED_SALES_INTEGRITY_LIMITS.pagePayloadBytes)
    || typeof first.has_more !== 'boolean' || first.has_more !== (first.candidate_count > first.returned_count)
    || (first.next_payload_bytes !== null && !boundedInteger(first.next_payload_bytes, 1, PREPARED_SALES_INTEGRITY_LIMITS.partBytes))) invalid();
  if (result.rows.some(row => metadata.some(key => row[key] !== first[key]))) invalid();
  if (first.returned_count === 0) {
    if (first.candidate_count !== 0 || result.rows.length !== 1 || first.returned_payload_bytes !== 0
      || first.next_payload_bytes !== null || ['receipt_id', 'source_row_number', 'payload_bytes', 'record_data'].some(key => first[key] !== null)) invalid();
    return { rows: [], hasMore: false };
  }
  if (result.rows.length !== first.returned_count || first.has_more !== (first.next_payload_bytes !== null)) invalid();
  const ids = new Set(), rows = [];
  let expectedOrdinal = Math.max(2, afterRow + 1), bytes = 0;
  for (const row of result.rows) {
    if (typeof row.receipt_id !== 'string' || !UUID.test(row.receipt_id) || ids.has(row.receipt_id)
      || row.source_row_number !== expectedOrdinal || !boundedInteger(row.source_row_number, 2, 10001)
      || !boundedInteger(row.payload_bytes, 1, PREPARED_SALES_INTEGRITY_LIMITS.partBytes)) invalid();
    ids.add(row.receipt_id);
    expectedOrdinal += 1;
    bytes += row.payload_bytes;
    const canonical = serializePreparedSalesValue(row.record_data);
    if (!row.record_data || typeof row.record_data !== 'object' || Array.isArray(row.record_data)
      || row.record_data.source_row_number !== row.source_row_number || Buffer.byteLength(canonical) > row.payload_bytes) invalid();
    rows.push({ receipt_id: row.receipt_id, source_row_number: row.source_row_number, record_data: row.record_data });
  }
  if (bytes !== first.returned_payload_bytes || bytes > PREPARED_SALES_INTEGRITY_LIMITS.pagePayloadBytes) invalid();
  // A count-short page is permitted only when the next actual payload would
  // exceed the byte budget; no convenient records may be silently omitted.
  if (first.returned_count < Math.min(first.candidate_count, limit)
    && bytes + first.next_payload_bytes <= PREPARED_SALES_INTEGRITY_LIMITS.pagePayloadBytes) invalid();
  return { rows, hasMore: first.has_more };
}
