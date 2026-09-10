import { createHash, randomUUID } from 'node:crypto';
import { hasApplicationPermission } from '../../security/applicationAccess.js';
import { decideAssignmentAccess } from '../../security/assignmentAccess.js';
import { snapshotAssignmentSalesCsvBytes } from './parse.js';
import { prepareAssignmentSalesCsv } from './prepare.js';
import { serializePreparedSalesValue, createPreparedSalesDigest, readStoredSalesRows } from './receiptIntegrity.js';
import { proposeAssignmentSalesMatchPage } from './matchProposals.js';
import { readAssignmentSalesMatchCandidates } from './matchCandidates.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 12_000;
const failure = suffix => Object.assign(new Error(`assignment_sales_import_${suffix}`),
  { code: `assignment_sales_import_${suffix}` });

function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw failure('invalid_input');
  return value.toLowerCase();
}

function scopeOf(input, permission, requireReportId = true) {
  if (!input?.auth?.userId) throw Object.assign(new Error('authentication_required'), { code: 'authentication_required' });
  const actorId = uuid(input.auth.userId);
  if (!hasApplicationPermission(input.auth, 'custom_appraisal', permission)) throw failure('access_denied');
  const assignmentId = typeof input.assignmentFileId === 'number' && Number.isSafeInteger(input.assignmentFileId)
    ? String(input.assignmentFileId) : input.assignmentFileId;
  if (typeof assignmentId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(assignmentId)
    || BigInt(assignmentId) > 9223372036854775807n
    || typeof input.accountId !== 'string' || !input.accountId.trim() || input.accountId.length > 128
    || /[\u0000-\u001f\u007f]/.test(input.accountId)) throw failure('invalid_input');
  const auth = { userId: actorId, organizations: (input.auth.organizations || []).map(org => ({
    organizationId: org.organizationId, roles: [...(org.roles || [])],
  })) };
  return { auth, actorId, assignmentId, accountId: input.accountId,
    reportId: requireReportId ? uuid(input.reportFileId) : null, permission };
}

function publicError(error) {
  if (error?.code === 'authentication_required'
    || /^assignment_sales_(?:import|csv)_[a-z_]+$/.test(error?.code || '')) return error;
  return failure(['55P03', '57014', '40001', '40P01'].includes(error?.code) ? 'busy' : 'failed');
}

// Each operation owns its connection. Never begin inside (or commit) someone
// else's transaction. A failed/unknown connection is discarded, not pooled.
async function transaction(pool, readOnly, operation) {
  let client, begun = false, committing = false, problem, result;
  const deadline = performance.now() + 30_000;
  const query = (text, values = []) => {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw failure('busy');
    return client.query({ text, values, query_timeout: Math.min(QUERY_TIMEOUT_MS, remaining) });
  };
  try {
    client = await pool.connect();
    if (client.getTransactionStatus?.() !== 'I') throw failure('transaction_state');
    await query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    begun = true;
    await query(`SET LOCAL statement_timeout = '10s'; SET LOCAL lock_timeout = '1500ms';
      SET LOCAL idle_in_transaction_session_timeout = '15s'; SET LOCAL search_path = pg_catalog`);
    result = await operation(query);
    if (client.getTransactionStatus?.() !== 'T') throw failure('transaction_state');
    committing = true;
    await query('COMMIT');
    if (client.getTransactionStatus?.() !== 'I') throw failure('transaction_state');
    begun = false;
  } catch (error) {
    // A transport failure during COMMIT does not prove that PostgreSQL rolled
    // back. The caller recovers by the same operation ID on a fresh connection.
    problem = committing && !['23503', '23505', '23514', '40001', '40P01'].includes(error?.code)
      ? failure('commit_unknown') : publicError(error);
    if (client && (begun || ['T', 'E'].includes(client.getTransactionStatus?.()))) {
      try { await client.query({ text: 'ROLLBACK', query_timeout: 1500 }); } catch { /* release with error below */ }
    }
  } finally {
    if (client) {
      try { client.release(problem); } catch { problem ||= failure(committing ? 'commit_unknown' : 'failed'); }
    }
  }
  if (problem) throw problem;
  return result;
}

async function authorize(query, scope, locking = false) {
  // Lock the same workfile used by signing first. Other owner locks are bounded
  // so an older writer with the opposite lock order cannot freeze the request.
  if (locking) await query(`/* assignment-sales:workfile-lock */ SELECT assignment_file_id
    FROM app.custom_appraisal_workfiles WHERE assignment_file_id = $1 FOR UPDATE`, [scope.assignmentId]);
  const result = await query(`/* assignment-sales:scope */ SELECT a.organization_id, a.account_id, r.id AS report_file_id,
      a.assigned_appraiser_user_id, a.supervisory_appraiser_user_id, w.status, w.signed_at,
      EXISTS (SELECT 1 FROM app.custom_appraisal_signed_snapshots s
        WHERE s.assignment_file_id=a.id) AS has_signed_snapshot
    FROM app.assignment_files a
    JOIN app.report_files r ON r.custom_assignment_file_id = a.id
      AND r.account_id = a.account_id AND r.organization_id = a.organization_id
    JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id = a.id
    WHERE a.id = $1 AND a.account_id = $2 AND ($3::uuid IS NULL OR r.id = $3) AND r.workflow_type = 'custom_appraisal'
      AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL
    ${locking ? 'FOR SHARE OF a, r' : ''}`, [scope.assignmentId, scope.accountId, scope.reportId]);
  const owner = result.rows[0];
  // Identical response for absent and inaccessible scopes avoids disclosing
  // another organization's report, account, or assignment existence.
  if (result.rows.length !== 1 || !hasApplicationPermission(scope.auth, 'custom_appraisal', scope.permission, owner.organization_id)
    || !decideAssignmentAccess(scope.auth, owner, scope.permission)) throw failure('access_denied');
  return owner;
}

const BATCH_COLUMNS = `b.batch_id, b.operation_id, b.report_file_id, b.assignment_file_id::text,
  b.account_id, b.file_name, b.source_sha256, b.source_byte_length, b.preparation_sha256,
  b.preparation_profile, b.preparation_version, b.stored_at, b.actor_user_id, b.row_count,
  b.preparation_header, (SELECT count(*)::int FROM app.assignment_sales_import_rows x
    WHERE x.batch_id = b.batch_id) AS stored_row_count`;

function receiptOf(batch) {
  if (!batch) return null;
  if (batch.row_count !== batch.stored_row_count || !batch.preparation_header
    || Object.values(batch.preparation_header.summary || {}).reduce((a, b) => a + b, 0) !== batch.row_count) {
    throw failure('invalid_receipt');
  }
  const { preparation_header: header, stored_row_count, ...receipt } = batch;
  return { receipt_version: 1, ...receipt, stored_at: new Date(batch.stored_at).toISOString(),
    persisted: true, persistence_status: 'saved', summary: header.summary,
    raw_headers: header.raw_headers, columns: header.columns,
    source_interpretation_status: 'not_reviewed', matching_status: 'not_evaluated', analysis_status: 'not_evaluated' };
}

async function batchByOperation(query, scope, owner, operationId, verify = false) {
  const result = await query(`/* assignment-sales:batch */ SELECT ${BATCH_COLUMNS}
    FROM app.assignment_sales_import_batches b
    WHERE b.organization_id = $1 AND b.report_file_id = $2 AND b.assignment_file_id = $3
      AND b.account_id = $4 AND b.operation_id = $5`,
  [owner.organization_id, scope.reportId, scope.assignmentId, scope.accountId, operationId]);
  const batch = result.rows[0], receipt = receiptOf(batch);
  if (receipt && verify) {
    const digest = createPreparedSalesDigest(); digest.add(batch.preparation_header);
    let after = 0, count = 0, more;
    do {
      const page = await readStoredSalesRows(query, batch.batch_id, after, 100);
      for (const row of page.rows) { digest.add(row.record_data); count += 1; after = row.source_row_number; }
      more = page.hasMore;
    } while (more);
    if (count !== batch.row_count || digest.digest() !== batch.preparation_sha256) throw failure('invalid_receipt');
  }
  return receipt ? { ...receipt, integrity_status: verify ? 'verified' : 'count_checked' } : null;
}

export async function getAssignmentSalesImportByOperation(pool, input) {
  const scope = scopeOf(input, 'read'), operationId = uuid(input.operationId);
  return transaction(pool, true, async query => {
    const owner = await authorize(query, scope);
    return batchByOperation(query, scope, owner, operationId, true);
  });
}

/** Authenticate and authorize the exact destination before parsing a large
 * upload body. commit repeats this under owner locks; this is not a lease. */
export async function authorizeAssignmentSalesImportAccess(pool, input, permission = 'read') {
  if (!['read', 'write'].includes(permission)) throw failure('invalid_input');
  const scope = scopeOf(input, permission);
  await transaction(pool, true, query => authorize(query, scope));
}

/** Resolve the existing canonical report for this exact assignment. This does
 * not create an account/report, select the newest file, or broaden its scope. */
export async function getAssignmentSalesImportTarget(pool, input) {
  const scope = scopeOf(input, 'read', false);
  return transaction(pool, true, async query => {
    const owner = await authorize(query, scope);
    return { account_id: scope.accountId, assignment_file_id: scope.assignmentId, report_file_id: owner.report_file_id,
      workfile_status: owner.status, can_upload: owner.status === 'draft' && owner.signed_at === null && !owner.has_signed_snapshot
        && hasApplicationPermission(scope.auth, 'custom_appraisal', 'write', owner.organization_id)
        && decideAssignmentAccess(scope.auth, owner, 'write') };
  });
}

function matches(receipt, prepared, fileName, actorId) {
  return receipt.actor_user_id === actorId && receipt.file_name === fileName && receipt.source_sha256 === prepared.source_sha256
    && receipt.source_byte_length === prepared.source_byte_length
    && receipt.preparation_sha256 === prepared.preparation_sha256
    && receipt.preparation_profile === prepared.profile_id && receipt.preparation_version === prepared.preparation_version;
}

/** Preserve one immutable private source and every row atomically. This is NOT
 * a shared importer, match resolver, source interpretation, or analysis Apply. */
export async function commitAssignmentSalesImport(pool, input) {
  const scope = scopeOf(input, 'write'), operationId = uuid(input.operationId);
  const fileName = input.fileName;
  if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255
    || /[\u0000-\u001f\u007f-\u009f\\/]/.test(fileName)) throw failure('invalid_input');
  const readbackInput = { auth: scope.auth, accountId: scope.accountId, assignmentFileId: scope.assignmentId,
    reportFileId: scope.reportId, operationId };
  // Snapshot before the first await: the bytes hashed, parsed and stored cannot
  // diverge if a caller changes its original Buffer during authorization.
  const content = snapshotAssignmentSalesCsvBytes(input.content);
  await transaction(pool, true, query => authorize(query, scope));
  const preparation = prepareAssignmentSalesCsv(content);
  const { rows, ...header } = preparation;
  const headerJson = serializePreparedSalesValue(header), rowJson = rows.map(serializePreparedSalesValue);
  if (Buffer.byteLength(headerJson) > MAX_RECORD_BYTES
    || rowJson.some(row => Buffer.byteLength(row) > MAX_RECORD_BYTES)
    || rowJson.reduce((sum, row) => sum + Buffer.byteLength(row), Buffer.byteLength(headerJson)) > MAX_JSON_BYTES) {
    throw failure('preparation_limit');
  }
  // Length-framed JSON sequence with a pinned preparation version/profile. This
  // binds every prepared receipt without repeatedly copying a 32 MiB document.
  const digest = createHash('sha256');
  for (const json of [headerJson, ...rowJson]) digest.update(`${Buffer.byteLength(json)}:`).update(json);
  const prepared = { ...header, preparation_sha256: digest.digest('hex') };
  let replayed = false;
  try {
    await transaction(pool, false, async query => {
      const owner = await authorize(query, scope, true);
      const existing = await batchByOperation(query, scope, owner, operationId);
      if (existing) {
        if (!matches(existing, prepared, fileName, scope.actorId)) throw failure('operation_conflict');
        replayed = true;
        return;
      }
      if (owner.status !== 'draft' || owner.signed_at !== null || owner.has_signed_snapshot) throw failure('read_only');
      const batchId = randomUUID();
      await query(`/* assignment-sales:insert-batch */ INSERT INTO app.assignment_sales_import_batches
        (batch_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,operation_id,
          file_name,source_bytes,source_sha256,source_byte_length,preparation_profile,preparation_version,
          preparation_sha256,preparation_header,row_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`,
      [batchId, owner.organization_id, scope.reportId, scope.assignmentId, scope.accountId, scope.actorId,
        operationId, fileName, content, prepared.source_sha256, prepared.source_byte_length,
        prepared.profile_id, prepared.preparation_version, prepared.preparation_sha256, headerJson, rows.length]);
      for (let offset = 0; offset < rows.length; offset += 100) {
        const chunk = `[${rowJson.slice(offset, offset + 100).join(',')}]`;
        await query(`/* assignment-sales:insert-rows */ INSERT INTO app.assignment_sales_import_rows
          (batch_id,source_row_number,record_data)
          SELECT $1, (item->>'source_row_number')::integer, item
          FROM pg_catalog.jsonb_array_elements($2::jsonb) AS item`, [batchId, chunk]);
      }
    });
  } catch (error) {
    if (error.code !== 'assignment_sales_import_commit_unknown') throw error;
    // Only a fresh, authorized, committed read can turn uncertain acknowledgement
    // into success. An absent receipt still requires retrying this exact ID.
    try {
      const recovered = await getAssignmentSalesImportByOperation(pool, readbackInput);
      if (recovered && matches(recovered, prepared, fileName, scope.actorId)) return { ...recovered, replayed: true };
    } catch { /* Return uncertainty without inventing success or raw DB errors. */ }
    throw error;
  }
  try {
    const receipt = await getAssignmentSalesImportByOperation(pool, readbackInput);
    if (!receipt || !matches(receipt, prepared, fileName, scope.actorId)) throw failure('invalid_receipt');
    return { ...receipt, replayed };
  } catch { throw failure('commit_unknown'); }
}

export async function listAssignmentSalesImportRows(pool, input) {
  const scope = scopeOf(input, 'read'), batchId = uuid(input.batchId);
  const limit = input.limit ?? 50, after = input.afterRow ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isInteger(after) || after < 0 || after > 10001) throw failure('invalid_input');
  return transaction(pool, true, async query => {
    const owner = await authorize(query, scope);
    const batch = await query(`/* assignment-sales:row-scope */ SELECT batch_id FROM app.assignment_sales_import_batches
      WHERE batch_id=$1 AND organization_id=$2 AND report_file_id=$3 AND assignment_file_id=$4 AND account_id=$5`,
    [batchId, owner.organization_id, scope.reportId, scope.assignmentId, scope.accountId]);
    if (!batch.rows.length) throw failure('not_found');
    const page = await readStoredSalesRows(query, batchId, after, limit);
    const rows = page.rows.map(row => ({ ...row.record_data, source_row_number: row.source_row_number,
      receipt_id: row.receipt_id, persisted: true, matching_status: 'not_evaluated', analysis_status: 'not_evaluated' }));
    return { batch_id: batchId, rows,
      next_after_row: page.hasMore ? rows.at(-1).source_row_number : null };
  });
}

/** Read-only proposals from one exact saved page and one PostgreSQL snapshot.
 * No intake receipt, account alias, shared sale or accepted capture is changed. */
export async function getAssignmentSalesImportMatchProposals(pool, input) {
  const scope = scopeOf(input, 'read'), batchId = uuid(input.batchId);
  const limit = input.limit ?? 50, after = input.afterRow ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isInteger(after) || after < 0 || after > 10001) throw failure('invalid_input');
  return transaction(pool, true, async query => {
    const owner = await authorize(query, scope);
    const found = await query(`/* assignment-sales:match-scope */ SELECT ${BATCH_COLUMNS}
      FROM app.assignment_sales_import_batches b
      WHERE b.batch_id=$1 AND b.organization_id=$2 AND b.report_file_id=$3 AND b.assignment_file_id=$4 AND b.account_id=$5`,
    [batchId, owner.organization_id, scope.reportId, scope.assignmentId, scope.accountId]);
    if (found.rows.length !== 1) throw failure('not_found');
    const receipt = receiptOf(found.rows[0]);
    if (receipt.preparation_profile !== 'private_sales_csv_preparation_v1' || receipt.preparation_version !== 1) {
      throw failure('invalid_receipt');
    }
    const page = await readStoredSalesRows(query, batchId, after, limit);
    const binding = { batch_id: batchId, source_sha256: receipt.source_sha256, preparation_sha256: receipt.preparation_sha256 };
    const proposed = await proposeAssignmentSalesMatchPage({ batch: binding, rows: page.rows }, {
      readCandidates: request => readAssignmentSalesMatchCandidates(query, request),
    });
    const { rows, lookups, ...header } = proposed;
    const context = { account_id: scope.accountId, assignment_file_id: scope.assignmentId, report_file_id: scope.reportId,
      next_after_row: page.hasMore ? page.rows.at(-1).source_row_number : null };
    // Versioned length-framed canonical pieces bind original stored row data,
    // the exact scope, and every current candidate observation. This is an
    // observation receipt, not signing authority or a persisted match decision.
    const digest = createPreparedSalesDigest(); digest.add({ ...context, ...header });
    for (const { record_data, ...rowIdentity } of page.rows) { digest.add(rowIdentity); digest.add(record_data); }
    for (const row of rows) digest.add(row);
    for (const lookup of lookups) digest.add(lookup);
    return { ...context, ...proposed, proposal_page_sha256: digest.digest() };
  });
}

export async function listAssignmentSalesImports(pool, input) {
  const scope = scopeOf(input, 'read');
  const before = input.beforeBatchId === undefined ? null : uuid(input.beforeBatchId);
  return transaction(pool, true, async query => {
    const owner = await authorize(query, scope);
    const result = await query(`/* assignment-sales:list */ WITH candidates AS MATERIALIZED (
      SELECT b.batch_id,b.stored_at,pg_catalog.octet_length(pg_catalog.convert_to(b.preparation_header::text,'UTF8')) AS bytes
      FROM app.assignment_sales_import_batches b
      WHERE b.organization_id=$1 AND b.report_file_id=$2 AND b.assignment_file_id=$3 AND b.account_id=$4
        AND ($5::uuid IS NULL OR (b.stored_at,b.batch_id) < (SELECT c.stored_at,c.batch_id
          FROM app.assignment_sales_import_batches c WHERE c.batch_id=$5 AND c.organization_id=$1
            AND c.report_file_id=$2 AND c.assignment_file_id=$3 AND c.account_id=$4))
      ORDER BY b.stored_at DESC,b.batch_id DESC LIMIT 21
    ), ranked AS MATERIALIZED (
      SELECT *,row_number() OVER (ORDER BY stored_at DESC,batch_id DESC) AS ordinal,
        sum(bytes) OVER (ORDER BY stored_at DESC,batch_id DESC ROWS UNBOUNDED PRECEDING) AS cumulative_bytes FROM candidates
    ), selected AS MATERIALIZED (
      SELECT batch_id,stored_at FROM ranked WHERE ordinal<=20 AND cumulative_bytes<=4194304
    ) SELECT ${BATCH_COLUMNS}, (SELECT count(*) FROM candidates)>(SELECT count(*) FROM selected) AS list_has_more
      FROM selected k JOIN app.assignment_sales_import_batches b ON b.batch_id=k.batch_id
      ORDER BY k.stored_at DESC,k.batch_id DESC`, [owner.organization_id, scope.reportId, scope.assignmentId, scope.accountId, before]);
    const imports = result.rows.map(({ list_has_more, ...row }) => ({ ...receiptOf(row), integrity_status: 'count_checked' }));
    return { imports, next_before_batch_id: result.rows[0]?.list_has_more ? imports.at(-1).batch_id : null };
  });
}
