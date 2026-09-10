import { createHash, randomUUID } from 'node:crypto';
import { withAssignmentSalesImportAccess } from './storage.js';
import { serializePreparedSalesValue } from './receiptIntegrity.js';
import { validateAssignmentSalesReviewCommand, buildAssignmentSalesReviewPayload } from './review.js';
import { proposeAssignmentSalesMatchPage } from './matchProposals.js';
import { readAssignmentSalesMatchCandidates } from './matchCandidates.js';

const fail = suffix => { throw Object.assign(new Error(`assignment_sales_import_${suffix}`),
  { code: `assignment_sales_import_${suffix}` }); };
const hash = value => createHash('sha256').update(value).digest('hex');
function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) fail('invalid_input');
  return value.toLowerCase();
}
function pageBounds(input) {
  const after = input.afterRow ?? 0, limit = input.limit ?? 50;
  if (!Number.isInteger(after) || after < 0 || after > 10001
    || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_input');
  return { after, limit };
}
async function batchOf(query, scope, owner, batchId, lock = false) {
  const result = await query(`/* assignment-sales-review:batch */ SELECT batch_id,source_sha256,preparation_sha256
    FROM app.assignment_sales_import_batches
    WHERE batch_id=$1 AND organization_id=$2 AND report_file_id=$3 AND assignment_file_id=$4 AND account_id=$5
    ${lock ? 'FOR UPDATE' : ''}`, [batchId, owner.organization_id, scope.reportId, scope.assignmentId, scope.accountId]);
  if (result.rows.length !== 1) fail('not_found');
  return result.rows[0];
}
const contextOf = (scope, batch) => ({ review_version: 1, account_id: scope.accountId,
  assignment_file_id: scope.assignmentId, report_file_id: scope.reportId, ...batch,
  matching_status: 'reviewed_separately', analysis_status: 'not_evaluated' });

async function reviewByOperation(query, scope, batch, operationId) {
  const result = await query(`/* assignment-sales-review:operation */ SELECT review_id,operation_id,revision,
    actor_user_id,recorded_at,command_json,command_sha256,payload_json,payload_sha256
    FROM app.assignment_sales_import_reviews WHERE batch_id=$1 AND operation_id=$2`, [batch.batch_id, operationId]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  if (result.rows.length !== 1 || hash(row.command_json) !== row.command_sha256
    || hash(row.payload_json) !== row.payload_sha256) fail('invalid_receipt');
  const command = validateAssignmentSalesReviewCommand(JSON.parse(row.command_json));
  if (serializePreparedSalesValue(command) !== row.command_json || command.expected_revision + 1 !== row.revision) fail('invalid_receipt');
  const { command_json, payload_json, ...metadata } = row;
  return { ...contextOf(scope, batch), ...metadata, command, previous_revision: row.revision - 1,
    recorded_at: new Date(row.recorded_at).toISOString(), persisted: true, replayed: false };
}

export async function getAssignmentSalesImportReviewByOperation(pool, input) {
  const batchId = uuid(input.batchId), operationId = uuid(input.operationId);
  return withAssignmentSalesImportAccess(pool, input, 'read', false, async ({ query, scope, owner }) =>
    reviewByOperation(query, scope, await batchOf(query, scope, owner, batchId), operationId));
}

/** Current review heads are separate from the unchanged upload receipts.
 * Indexed lookups read at most the visible 100 rows, never the whole history. */
export async function getAssignmentSalesImportReviewState(pool, input) {
  const batchId = uuid(input.batchId), { after, limit } = pageBounds(input);
  return withAssignmentSalesImportAccess(pool, input, 'read', false, async ({ query, scope, owner }) => {
    const batch = await batchOf(query, scope, owner, batchId);
    const head = (await query(`/* assignment-sales-review:head */ SELECT review_id,revision
      FROM app.assignment_sales_import_reviews WHERE batch_id=$1 ORDER BY revision DESC LIMIT 1`, [batchId])).rows[0];
    const source = (await query(`/* assignment-sales-review:source */ SELECT review_id,source_interpretation
      FROM app.assignment_sales_import_reviews WHERE batch_id=$1 AND source_interpretation IS NOT NULL
      ORDER BY revision DESC LIMIT 1`, [batchId])).rows[0];
    const page = (await query(`/* assignment-sales-review:state-rows */ WITH visible AS MATERIALIZED (
      SELECT receipt_id,source_row_number FROM app.assignment_sales_import_rows
      WHERE batch_id=$1 AND source_row_number>$2 ORDER BY source_row_number LIMIT $3
    ) SELECT v.receipt_id,v.source_row_number,r.review_id,r.revision,r.decision
      FROM visible v LEFT JOIN LATERAL (
        SELECT review_id,revision,decision FROM app.assignment_sales_import_review_rows
        WHERE batch_id=$1 AND source_row_number=v.source_row_number
        ORDER BY revision DESC LIMIT 1
      ) r ON true ORDER BY v.source_row_number`, [batchId, after, limit + 1])).rows;
    const rows = page.slice(0, limit);
    return { ...contextOf(scope, batch), revision: head?.revision ?? 0, last_review_id: head?.review_id ?? null,
      source_interpretation: source?.source_interpretation ?? null, source_review_id: source?.review_id ?? null,
      row_decisions: rows.filter(row => row.review_id).map(row => ({ ...row.decision,
        review_id: row.review_id, revision: row.revision })),
      next_after_row: page.length > limit ? rows.at(-1).source_row_number : null };
  });
}

async function selectedRows(query, batchId, decisions) {
  if (!decisions.length) return [];
  let ordinals = decisions.map(row => row.source_row_number);
  if (decisions.some(row => row.decision === 'confirm_proposed_match')) {
    const first = Math.min(...ordinals), last = Math.max(...ordinals);
    if (last - first >= 100) fail('invalid_input');
    // Preserve the existing proposal profile's complete page context, including
    // duplicates between selected confirmations. Only selected decisions save.
    ordinals = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  }
  // Meter the immutable selected records before transferring JSON. A large
  // batch cannot make a small review request read its entire uploaded source.
  const result = await query(`/* assignment-sales-review:selected-rows */ WITH wanted AS MATERIALIZED (
    SELECT receipt_id,source_row_number,octet_length(convert_to(record_data::text,'UTF8')) AS bytes
    FROM app.assignment_sales_import_rows WHERE batch_id=$1 AND source_row_number=ANY($2::integer[])
  ), budget AS (SELECT coalesce(sum(bytes),0) AS bytes FROM wanted)
  SELECT w.receipt_id,w.source_row_number,b.bytes::text AS total_bytes,
    CASE WHEN b.bytes<=4194304 THEN r.record_data ELSE NULL END AS record_data
    FROM wanted w CROSS JOIN budget b JOIN app.assignment_sales_import_rows r
      ON r.batch_id=$1 AND r.source_row_number=w.source_row_number ORDER BY w.source_row_number`,
  [batchId, ordinals]);
  if (result.rows.length !== ordinals.length) fail('invalid_input');
  if (result.rows.some(row => BigInt(row.total_bytes) > 4194304n)) fail('preparation_limit');
  return result.rows.map(({ total_bytes, ...row }) => row);
}

/** One explicit appraiser review; identity confirmation is not approval of the
 * source's economic-property membership, duplicate sale, or analysis fitness. */
export async function appendAssignmentSalesImportReview(pool, input) {
  const batchId = uuid(input.batchId), operationId = uuid(input.operationId);
  const command = validateAssignmentSalesReviewCommand(input.command);
  const commandJson = serializePreparedSalesValue(command), commandHash = hash(commandJson);
  if (Buffer.byteLength(commandJson) > 262144) fail('preparation_limit');
  let readback, replayed = false;
  try {
    await withAssignmentSalesImportAccess(pool, input, 'write', true, async ({ query, scope, owner }) => {
      readback = { auth: scope.auth, accountId: scope.accountId, assignmentFileId: scope.assignmentId,
        reportFileId: scope.reportId, batchId, operationId };
      const batch = await batchOf(query, scope, owner, batchId, true);
      const previous = await reviewByOperation(query, scope, batch, operationId);
      if (previous) {
        if (previous.actor_user_id !== scope.actorId || previous.command_sha256 !== commandHash) fail('operation_conflict');
        replayed = true;
        return;
      }
      if (owner.status !== 'draft' || owner.signed_at !== null || owner.has_signed_snapshot) fail('read_only');
      const head = (await query(`/* assignment-sales-review:head */ SELECT review_id,revision
        FROM app.assignment_sales_import_reviews WHERE batch_id=$1 ORDER BY revision DESC LIMIT 1`, [batchId])).rows[0];
      if ((head?.revision ?? 0) !== command.expected_revision) fail('revision_conflict');
      const rows = await selectedRows(query, batchId, command.row_decisions);
      const proposalPage = command.row_decisions.some(row => row.decision === 'confirm_proposed_match')
        ? await proposeAssignmentSalesMatchPage({ batch, rows }, {
          readCandidates: request => readAssignmentSalesMatchCandidates(query, request),
        }) : null;
      const payload = await buildAssignmentSalesReviewPayload({ command, rows, proposalPage });
      const payloadJson = serializePreparedSalesValue(payload);
      if (Buffer.byteLength(payloadJson) > 2097152) fail('preparation_limit');
      await query(`/* assignment-sales-review:insert */ INSERT INTO app.assignment_sales_import_reviews
        (review_id,batch_id,revision,operation_id,actor_user_id,command_json,command_sha256,payload_json,payload_sha256,source_interpretation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [randomUUID(), batchId, command.expected_revision + 1, operationId, scope.actorId, commandJson,
        commandHash, payloadJson, hash(payloadJson), command.source_interpretation === null
          ? null : serializePreparedSalesValue(command.source_interpretation)]);
    });
  } catch (error) {
    if (error.code !== 'assignment_sales_import_commit_unknown' || !readback) throw error;
    replayed = true;
  }
  // A successful COMMIT response alone is not a persisted receipt. Recover an
  // uncertain acknowledgement by the same actor-bound operation on a fresh read.
  try {
    const receipt = await getAssignmentSalesImportReviewByOperation(pool, readback);
    if (!receipt || receipt.actor_user_id !== readback.auth.userId || receipt.command_sha256 !== commandHash) fail('invalid_receipt');
    return { ...receipt, replayed };
  } catch { fail('commit_unknown'); }
}
