import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { createPreparedSalesDigest, readStoredSalesRows, serializePreparedSalesValue }
  from './receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand } from './review.js';

export const ASSIGNMENT_SALES_CAPTURE_LIMITS = Object.freeze({ rows: 10000,
  command_bytes: 262144, current_command_bytes: 16 * 1024 * 1024,
  current_payload_bytes: 64 * 1024 * 1024, supplement_bytes: 64 * 1024 * 1024 });
const L = ASSIGNMENT_SALES_CAPTURE_LIMITS;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const fail = suffix => { throw Object.assign(new Error(`assignment_sales_import_${suffix}`),
  { code: `assignment_sales_import_${suffix}` }); };
const check = (ok, suffix = 'invalid_receipt') => { if (!ok) fail(suffix); };
const hash = value => createHash('sha256').update(value).digest('hex');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = value => typeof value === 'string' && UUID.test(value);
const sha = value => typeof value === 'string' && SHA.test(value);
function exact(value, keys) {
  check(value && typeof value === 'object' && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype, 'invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(descriptors).length === keys.length && keys.every(key =>
    descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value')), 'invalid_input');
}
function targetOf(value) {
  exact(value, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']);
  check(uuid(value.organization_id) && uuid(value.report_file_id)
    && typeof value.assignment_file_id === 'string' && /^[1-9][0-9]{0,18}$/.test(value.assignment_file_id)
    && BigInt(value.assignment_file_id) <= 9223372036854775807n
    && typeof value.account_id === 'string' && value.account_id.length <= 128
    && value.account_id.trim().length > 0 && !/\p{Cc}/u.test(value.account_id), 'invalid_input');
  return { ...value };
}
const params = (target, batchId) => [batchId, target.organization_id, target.report_file_id,
  target.assignment_file_id, target.account_id];
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function detached(value) { return JSON.parse(serializePreparedSalesValue(value)); }
function rowsOf(result, maximum) {
  check(Array.isArray(result?.rows) && result.rows.length <= maximum
    && (result.rowCount === undefined || result.rowCount === result.rows.length));
  return result.rows;
}
function timestamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 23) === value.slice(0, 23));
  return value;
}

// Exact scope is established before any original-row or review payload read.
// Byte metadata is calculated in PostgreSQL; large original CSV bytes never
// travel to Node. The caller owns finite query/deadline and snapshot settings.
export const ASSIGNMENT_SALES_CAPTURE_BATCH_SQL = `/* assignment-sales-capture:batch */
SELECT b.batch_id,b.organization_id,b.report_file_id,b.assignment_file_id::text,b.account_id,
  b.source_sha256,b.source_byte_length,b.preparation_sha256,b.preparation_profile,b.preparation_version,b.row_count,
  pg_catalog.octet_length(b.source_bytes) AS actual_source_bytes,
  CASE WHEN pg_catalog.octet_length(b.source_bytes)<=8388608
    THEN pg_catalog.encode(pg_catalog.sha256(b.source_bytes),'hex') ELSE NULL END AS actual_source_sha256,
  pg_catalog.octet_length(pg_catalog.convert_to(b.preparation_header::text,'UTF8')) AS header_bytes,
  CASE WHEN pg_catalog.octet_length(pg_catalog.convert_to(b.preparation_header::text,'UTF8'))<=2097152
    THEN b.preparation_header ELSE NULL END AS preparation_header,
  m.stored_rows,m.first_row,m.last_row,m.row_bytes,m.invalid_rows,
  h.review_id AS head_review_id,h.revision,s.review_id AS source_review_id,s.revision AS source_revision,
  pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS captured_at
FROM app.assignment_sales_import_batches b
CROSS JOIN LATERAL (SELECT count(*)::integer AS stored_rows,min(source_row_number) AS first_row,
  max(source_row_number) AS last_row,
  coalesce(sum(pg_catalog.octet_length(pg_catalog.convert_to(record_data::text,'UTF8'))),0)::text AS row_bytes,
  count(*) FILTER (WHERE pg_catalog.octet_length(pg_catalog.convert_to(record_data::text,'UTF8'))
    NOT BETWEEN 1 AND 2097152)::integer AS invalid_rows
  FROM app.assignment_sales_import_rows WHERE batch_id=b.batch_id) m
LEFT JOIN LATERAL (SELECT review_id,revision FROM app.assignment_sales_import_reviews
  WHERE batch_id=b.batch_id ORDER BY revision DESC LIMIT 1) h ON true
LEFT JOIN LATERAL (SELECT review_id,revision FROM app.assignment_sales_import_reviews
  WHERE batch_id=b.batch_id AND source_interpretation IS NOT NULL ORDER BY revision DESC LIMIT 1) s ON true
WHERE b.batch_id=$1::uuid AND b.organization_id=$2::uuid AND b.report_file_id=$3::uuid
  AND b.assignment_file_id=$4::bigint AND b.account_id=$5::text`;

const CURRENT = `WITH current_rows AS MATERIALIZED (
  SELECT v.receipt_id,v.source_row_number,r.review_id,r.revision
  FROM app.assignment_sales_import_rows v LEFT JOIN LATERAL (
    SELECT review_id,revision FROM app.assignment_sales_import_review_rows
    WHERE batch_id=$1::uuid AND source_row_number=v.source_row_number ORDER BY revision DESC LIMIT 1
  ) r ON true WHERE v.batch_id=$1::uuid
), refs AS MATERIALIZED (
  SELECT review_id FROM current_rows WHERE review_id IS NOT NULL
  UNION SELECT $2::uuid UNION SELECT $3::uuid
)`;

// DISTINCT parent commands, not one multi-megabyte historical payload per row.
// Meter the entire current set before transferring any command. Payload digests
// remain checked in the database without transferring private match evidence.
export const ASSIGNMENT_SALES_CAPTURE_REVIEWS_SQL = `/* assignment-sales-capture:reviews */
${CURRENT}, metered AS MATERIALIZED (
  SELECT f.review_id,r.revision,r.command_sha256,r.payload_sha256,
    pg_catalog.octet_length(pg_catalog.convert_to(r.command_json,'UTF8')) AS command_bytes,
    pg_catalog.octet_length(pg_catalog.convert_to(r.payload_json,'UTF8')) AS payload_bytes
  FROM refs f LEFT JOIN app.assignment_sales_import_reviews r ON r.batch_id=$1::uuid AND r.review_id=f.review_id
), budget AS MATERIALIZED (
  SELECT count(*)::integer AS command_count,coalesce(sum(command_bytes),0)::text AS total_command_bytes,
    coalesce(sum(payload_bytes),0)::text AS total_payload_bytes,
    count(*) FILTER (WHERE revision IS NULL OR command_bytes IS NULL OR command_bytes NOT BETWEEN 1 AND 262144
      OR payload_bytes IS NULL OR payload_bytes NOT BETWEEN 1 AND 2097152)::integer AS invalid_commands FROM metered
)
SELECT m.*,b.*,
  CASE WHEN b.invalid_commands=0 AND b.command_count<=10002 AND b.total_command_bytes::bigint<=16777216
    AND b.total_payload_bytes::bigint<=67108864
    THEN r.command_json ELSE NULL END AS command_json,
  CASE WHEN b.invalid_commands=0 AND b.command_count<=10002 AND b.total_command_bytes::bigint<=16777216
    AND b.total_payload_bytes::bigint<=67108864 THEN
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.payload_json,'UTF8')),'hex')=m.payload_sha256
    AND (r.command_json::jsonb->'source_interpretation') IS NOT DISTINCT FROM
      coalesce(r.source_interpretation,'null'::jsonb) ELSE NULL END AS stored_envelope_matches
FROM metered m CROSS JOIN budget b LEFT JOIN app.assignment_sales_import_reviews r
  ON r.batch_id=$1::uuid AND r.review_id=m.review_id ORDER BY m.revision,m.review_id`;

export const ASSIGNMENT_SALES_CAPTURE_DECISIONS_SQL = `/* assignment-sales-capture:decisions */
WITH visible AS MATERIALIZED (SELECT receipt_id,source_row_number FROM app.assignment_sales_import_rows
  WHERE batch_id=$1::uuid AND source_row_number>$2::integer ORDER BY source_row_number LIMIT 100)
SELECT v.receipt_id,v.source_row_number,r.review_id,r.revision,
  pg_catalog.octet_length(pg_catalog.convert_to(r.decision::text,'UTF8')) AS decision_bytes,
  CASE WHEN pg_catalog.octet_length(pg_catalog.convert_to(r.decision::text,'UTF8'))<=8192
    THEN r.decision ELSE NULL END AS decision
FROM visible v LEFT JOIN LATERAL (SELECT review_id,revision,decision FROM app.assignment_sales_import_review_rows
  WHERE batch_id=$1::uuid AND source_row_number=v.source_row_number ORDER BY revision DESC LIMIT 1
) r ON true ORDER BY v.source_row_number`;

function size(value, maximum) {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value));
  const number = Number(value);
  check(Number.isSafeInteger(number)); check(number <= maximum, 'preparation_limit');
  return number;
}
function checkedBatch(row, target, batchId, expected) {
  check(row.batch_id === batchId && Object.keys(target).every(key => row[key] === target[key]));
  check(integer(row.row_count, 0, L.rows) && row.row_count === row.stored_rows && row.invalid_rows === 0
    && (row.row_count ? row.first_row === 2 && row.last_row === row.row_count + 1
      : row.first_row === null && row.last_row === null));
  check(integer(row.source_byte_length, 1, 8388608) && row.source_byte_length === row.actual_source_bytes
    && sha(row.source_sha256) && row.source_sha256 === row.actual_source_sha256 && sha(row.preparation_sha256)
    && row.preparation_profile === 'private_sales_csv_preparation_v1' && row.preparation_version === 1);
  size(row.row_bytes, L.supplement_bytes);
  check(integer(row.header_bytes, 1, 2097152), 'preparation_limit');
  const header = detached(row.preparation_header);
  check(Buffer.byteLength(serializePreparedSalesValue(header)) <= row.header_bytes && header
    && header.profile_id === row.preparation_profile && header.preparation_version === 1
    && header.source_sha256 === row.source_sha256 && header.source_byte_length === row.source_byte_length
    && header.row_count === row.row_count);
  check(row.revision !== null && row.source_review_id !== null, 'source_not_reviewed');
  check(integer(row.revision, 1, 2147483647) && uuid(row.head_review_id)
    && uuid(row.source_review_id) && integer(row.source_revision, 1, row.revision));
  check(row.revision === expected, 'revision_conflict');
  timestamp(row.captured_at);
  return header;
}

function checkedReviews(rows, batch) {
  check(rows.length > 0);
  const first = rows[0];
  check(first.command_count === rows.length && first.invalid_commands === 0);
  const total = size(first.total_command_bytes, L.current_command_bytes);
  const payloadTotal = size(first.total_payload_bytes, L.current_payload_bytes);
  const parents = new Map(), revisions = new Set(); let bytes = 0, payloadBytes = 0;
  for (const row of rows) {
    check(row.command_count === first.command_count && row.total_command_bytes === first.total_command_bytes
      && row.total_payload_bytes === first.total_payload_bytes
      && row.invalid_commands === 0 && uuid(row.review_id) && !parents.has(row.review_id)
      && integer(row.revision, 1, batch.revision) && !revisions.has(row.revision)
      && integer(row.command_bytes, 1, L.command_bytes) && integer(row.payload_bytes, 1, 2097152)
      && sha(row.command_sha256) && sha(row.payload_sha256) && row.stored_envelope_matches === true
      && typeof row.command_json === 'string' && Buffer.byteLength(row.command_json) === row.command_bytes
      && hash(row.command_json) === row.command_sha256);
    let command;
    try { command = validateAssignmentSalesReviewCommand(JSON.parse(row.command_json)); }
    catch { fail('invalid_receipt'); }
    check(serializePreparedSalesValue(command) === row.command_json && command.expected_revision + 1 === row.revision);
    parents.set(row.review_id, { revision: row.revision, command,
      decisions: new Map(command.row_decisions.map(decision => [decision.source_row_number, decision])) });
    revisions.add(row.revision); bytes += row.command_bytes; payloadBytes += row.payload_bytes;
  }
  check(bytes === total && payloadBytes === payloadTotal && parents.get(batch.head_review_id)?.revision === batch.revision
    && parents.get(batch.source_review_id)?.revision === batch.source_revision);
  const source = parents.get(batch.source_review_id).command.source_interpretation;
  check(source !== null, 'source_not_reviewed');
  check(source.source_use_confirmed === true, 'source_use_not_confirmed');
  // A source-changing current command after the claimed source head cannot be
  // hidden by its projection. Latest explicit unknowns remain declarations.
  for (const parent of parents.values()) check(parent.command.source_interpretation === null
    || parent.revision <= batch.source_revision);
  return { parents, source };
}

/** Internal reader only: caller supplies an authorized, exclusive finite-budget
 * REPEATABLE READ snapshot. No transaction, authorization or source-use rights
 * are created here. Original rows are not re-normalized or selected away.
 */
export async function captureAssignmentSalesCsv(query, input) {
  check(typeof query === 'function', 'invalid_input');
  exact(input, ['target', 'batchId', 'expectedReviewRevision']);
  const target = targetOf(input.target), batchId = input.batchId, expected = input.expectedReviewRevision;
  check(uuid(batchId) && integer(expected, 1, 2147483647), 'invalid_input');
  await query('SAVEPOINT assignment_sales_capture_read');
  const state = rowsOf(await query(`/* assignment-sales-capture:transaction */
    SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
      pg_catalog.current_setting('transaction_read_only') AS read_only`), 1);
  check(state.length === 1 && state[0].isolation === 'repeatable read' && state[0].read_only === 'on', 'transaction_state');
  const batchRows = rowsOf(await query(ASSIGNMENT_SALES_CAPTURE_BATCH_SQL, params(target, batchId)), 1);
  check(batchRows.length === 1, 'not_found');
  const batch = batchRows[0], header = checkedBatch(batch, target, batchId, expected);
  const reviews = rowsOf(await query(ASSIGNMENT_SALES_CAPTURE_REVIEWS_SQL,
    [batchId, batch.head_review_id, batch.source_review_id]), L.rows + 2);
  const { parents, source } = checkedReviews(reviews, batch);
  const digest = createPreparedSalesDigest(); digest.add(header);
  const rows = [], receiptIds = new Set(), usedParents = new Set([batch.head_review_id, batch.source_review_id]);
  let after = 0, more;
  do {
    const page = await readStoredSalesRows(query, batchId, after, 100);
    // Decisions use independent bounded pages because large original records
    // may produce a count-short (byte-full) preparation page.
    for (const row of page.rows) {
      check(rows.length < batch.row_count && !receiptIds.has(row.receipt_id));
      receiptIds.add(row.receipt_id); digest.add(row.record_data);
      rows.push({ ...row, record_data: detached(row.record_data), review: null });
      after = row.source_row_number;
    }
    more = page.hasMore;
  } while (more);
  check(rows.length === batch.row_count && digest.digest() === batch.preparation_sha256);
  for (let offset = 0; offset < rows.length; offset += 100) {
    const decisions = rowsOf(await query(ASSIGNMENT_SALES_CAPTURE_DECISIONS_SQL,
      [batchId, offset === 0 ? 0 : rows[offset - 1].source_row_number]), 100);
    check(decisions.length === Math.min(100, rows.length - offset));
    for (let index = 0; index < decisions.length; index += 1) {
      const current = decisions[index], row = rows[offset + index];
      check(current.receipt_id === row.receipt_id && current.source_row_number === row.source_row_number);
      if (current.review_id === null) {
        check(current.revision === null && current.decision === null && current.decision_bytes === null);
        continue;
      }
      const parent = parents.get(current.review_id), decision = parent?.decisions.get(row.source_row_number);
      check(parent && parent.revision === current.revision && decision?.receipt_id === row.receipt_id
        && integer(current.decision_bytes, 1, 8192)
        && serializePreparedSalesValue(current.decision) === serializePreparedSalesValue(decision));
      usedParents.add(current.review_id);
      row.review = { review_id: current.review_id, revision: current.revision, decision: decision.decision,
        account_ids: [...decision.account_ids], note: decision.note };
    }
  }
  check(usedParents.size === parents.size);
  // Every retained parent decision must be represented by that decision or a
  // newer one; null/older projections cannot silently hide a retained command.
  for (const parent of parents.values()) for (const decision of parent.command.row_decisions) {
    const row = rows[decision.source_row_number - 2];
    check(row?.receipt_id === decision.receipt_id && row.review?.revision >= parent.revision);
  }
  const result = { private_sales_capture_version: 1, profile_id: 'assignment-private-reviewed-sales-v1', target,
    batch: { batch_id: batchId, source_sha256: batch.source_sha256, preparation_sha256: batch.preparation_sha256 },
    review: { revision: batch.revision, head_review_id: batch.head_review_id, source_review_id: batch.source_review_id },
    source_interpretation: detached(source), captured_at: batch.captured_at, rows };
  // All children are detached bounded generated values; this counts the entire
  // wrapper too, without a global canonicalizer's per-part limit or truncation.
  check(Buffer.byteLength(JSON.stringify(result)) <= L.supplement_bytes, 'preparation_limit');
  await query('RELEASE SAVEPOINT assignment_sales_capture_read');
  return freeze(result);
}

export const ASSIGNMENT_SALES_CAPTURE_LOCK_SQL = `/* assignment-sales-capture:recheck-lock */
SELECT batch_id,source_sha256,preparation_sha256,row_count FROM app.assignment_sales_import_batches
WHERE batch_id=$1::uuid AND organization_id=$2::uuid AND report_file_id=$3::uuid
  AND assignment_file_id=$4::bigint AND account_id=$5::text FOR SHARE NOWAIT`;
export const ASSIGNMENT_SALES_CAPTURE_HEAD_SQL = `/* assignment-sales-capture:recheck-head */
SELECT h.review_id AS head_review_id,h.revision,s.review_id AS source_review_id
FROM (SELECT review_id,revision FROM app.assignment_sales_import_reviews WHERE batch_id=$1::uuid
  ORDER BY revision DESC LIMIT 1) h LEFT JOIN LATERAL (
  SELECT review_id FROM app.assignment_sales_import_reviews WHERE batch_id=$1::uuid
    AND source_interpretation IS NOT NULL ORDER BY revision DESC LIMIT 1) s ON true`;

/** Final registration fence, NOT authentication. Caller owns an explicit READ
 * COMMITTED transaction and holds its workfile lock BEFORE this batch lock,
 * matching review writers. The lock is held until the CALLER commits/rolls back.
 * An unchanged repeatable-read snapshot cannot supply a fresh revision check.
 */
export async function recheckAssignmentSalesCsvCapture(query, capture) {
  check(typeof query === 'function', 'invalid_input');
  exact(capture, ['private_sales_capture_version', 'profile_id', 'target', 'batch', 'review',
    'source_interpretation', 'captured_at', 'rows']);
  const target = targetOf(capture.target);
  exact(capture.batch, ['batch_id', 'source_sha256', 'preparation_sha256']);
  exact(capture.review, ['revision', 'head_review_id', 'source_review_id']);
  check(capture.private_sales_capture_version === 1 && capture.profile_id === 'assignment-private-reviewed-sales-v1'
    && uuid(capture.batch.batch_id) && sha(capture.batch.source_sha256) && sha(capture.batch.preparation_sha256)
    && integer(capture.review.revision, 1, 2147483647) && uuid(capture.review.head_review_id)
    && uuid(capture.review.source_review_id) && Array.isArray(capture.rows) && !types.isProxy(capture.rows)
    && integer(capture.rows.length, 0, L.rows), 'invalid_input');
  const batch = { ...capture.batch }, review = { ...capture.review }, rowCount = capture.rows.length;
  await query('SAVEPOINT assignment_sales_capture_recheck');
  const state = rowsOf(await query(`/* assignment-sales-capture:recheck-transaction */
    SELECT pg_catalog.current_setting('transaction_isolation') AS isolation,
      pg_catalog.current_setting('transaction_read_only') AS read_only`), 1);
  check(state.length === 1 && state[0].isolation === 'read committed' && state[0].read_only === 'off', 'transaction_state');
  const batches = rowsOf(await query(ASSIGNMENT_SALES_CAPTURE_LOCK_SQL, params(target, batch.batch_id)), 1);
  check(batches.length === 1 && Object.keys(batch).every(key => batches[0][key] === batch[key])
    && batches[0].row_count === rowCount, 'capture_changed');
  const heads = rowsOf(await query(ASSIGNMENT_SALES_CAPTURE_HEAD_SQL, [batch.batch_id]), 1);
  check(heads.length === 1 && Object.keys(review).every(key => heads[0][key] === review[key]), 'capture_changed');
  await query('RELEASE SAVEPOINT assignment_sales_capture_recheck');
  return true;
}
