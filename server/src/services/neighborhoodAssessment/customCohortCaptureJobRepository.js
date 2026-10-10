import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { isProxy } from 'node:util/types';
import { prepareNeighborhoodDiscoveryChoice } from './selectorInputProfile.js';
import { customNeighborhoodPrivateSalesPurpose } from '../../security/customNeighborhoodPrivateSalesPolicy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const ACCOUNT_CONTROL = /[\u0000-\u001f\u007f]/;
const PHASES = new Set(['subject', 'spatial', 'source', 'preparation', 'registration', 'frozen_stock_v1', 'frozen_source_v1', 'frozen_source_refs_v2', 'frozen_verify_refs_v2', 'frozen_geo_verify_refs_v2', 'frozen_identity_refs_v2', 'frozen_stock_traversal_refs_v2', 'frozen_recorded_partition_refs_v2', 'frozen_recorded_catalog_refs_v2', 'frozen_selected_union_refs_v2', 'frozen_verify_v1', 'frozen_geo_verify_v1', 'frozen_identity_v1', 'frozen_typed_v1']);
const STATUSES = new Set(['queued', 'running', 'retry', 'awaiting_selection', 'succeeded', 'failed', 'cancelled']);
export const CAPTURE_JOB_LEASE_SECONDS = Object.freeze({ min: 15, max: 900 });
function fail(reason) { throw new TypeError(`custom_cohort_capture_job_${reason}`); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length
    || !keys.every(key => Object.getOwnPropertyDescriptor(value, key)?.value !== undefined)) fail('invalid_input');
}
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_identifier');
  return value.toLowerCase();
}
function scopeOf(value) {
  exact(value, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id']);
  if (typeof value.assignment_file_id !== 'string' || !/^[1-9]\d{0,18}$/.test(value.assignment_file_id)
    || BigInt(value.assignment_file_id) > 9223372036854775807n
    || typeof value.account_id !== 'string' || !value.account_id
    || value.account_id.length > 64 || value.account_id.trim() !== value.account_id
    || ACCOUNT_CONTROL.test(value.account_id)) fail('invalid_scope');
  return Object.freeze({ organization_id: uuid(value.organization_id),
    report_file_id: uuid(value.report_file_id), assignment_file_id: value.assignment_file_id,
    account_id: value.account_id });
}
function requestOf(value) {
  const discovery = Object.hasOwn(value ?? {}, 'discovery');
  const privateImport = Object.hasOwn(value ?? {}, 'private_sales_import');
  exact(value, ['operation_id', 'observation_period',
    ...(discovery ? ['discovery'] : []), ...(privateImport ? ['private_sales_import'] : [])]);
  exact(value.observation_period, ['start_date', 'end_date']);
  const start_date = assessmentDate(value.observation_period.start_date);
  const end_date = assessmentDate(value.observation_period.end_date);
  if (start_date > end_date) fail('invalid_period');
  let preparedDiscovery;
  if (discovery) preparedDiscovery = prepareNeighborhoodDiscoveryChoice(value.discovery);
  let preparedPrivate;
  if (privateImport) {
    const purpose = customNeighborhoodPrivateSalesPurpose(value.private_sales_import);
    preparedPrivate = { batch_id: purpose.batch_id,
      expected_review_revision: purpose.expected_review_revision };
  }
  return Object.freeze({ operation_id: uuid(value.operation_id),
    observation_period: Object.freeze({ start_date, end_date }),
    ...(discovery ? { discovery: preparedDiscovery } : {}),
    ...(privateImport ? { private_sales_import: Object.freeze(preparedPrivate) } : {}) });
}
function claimOf(value) {
  // Claims are detached DATA, never executable adapters. Check before any
  // reflection: even getPrototypeOf/ownKeys can invoke a Proxy trap.
  if (isProxy(value)) fail('invalid_input');
  exact(value, ['operation_id', 'claim_token', 'attempts']);
  if (!Number.isInteger(value.attempts) || value.attempts < 1 || value.attempts > 5) fail('invalid_claim');
  return [uuid(value.operation_id), uuid(value.claim_token), value.attempts];
}
export function prepareCustomCohortCaptureJobClaim(value) {
  const [operation_id, claim_token, attempts] = claimOf(value);
  return Object.freeze({ operation_id, claim_token, attempts });
}
function scopedClaimOf(claim, options) {
  exact(options, ['scope', 'actorUserId']);
  const scope = scopeOf(options.scope);
  return [...claimOf(claim), scope.organization_id, scope.report_file_id,
    scope.assignment_file_id, scope.account_id, uuid(options.actorUserId)];
}
function lease(value) {
  if (!Number.isInteger(value) || value < CAPTURE_JOB_LEASE_SECONDS.min
    || value > CAPTURE_JOB_LEASE_SECONDS.max) fail('invalid_lease');
  return value;
}
function checkpointOf(value) {
  exact(value, ['phase', 'evidence_refs']);
  if (!PHASES.has(value.phase) || !Array.isArray(value.evidence_refs)
    || value.evidence_refs.length > 64) fail('invalid_checkpoint');
  const refs = value.evidence_refs.map(ref => {
    exact(ref, ['content_sha256', 'canonical_utf8_bytes']);
    if (!SHA.test(ref.content_sha256)
      || typeof ref.canonical_utf8_bytes !== 'string'
      || !/^[1-9]\d{0,8}$/.test(ref.canonical_utf8_bytes)) fail('invalid_checkpoint');
    return Object.freeze({ content_sha256: ref.content_sha256,
      canonical_utf8_bytes: ref.canonical_utf8_bytes });
  });
  const checkpoint = Object.freeze({ phase: value.phase, evidence_refs: Object.freeze(refs) });
  if (Buffer.byteLength(canonicalAssessmentJson(checkpoint), 'utf8') > 65536) fail('invalid_checkpoint');
  return checkpoint;
}
function one(result, reason) {
  if (result?.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1)
    fail(reason);
  return result.rows[0];
}
const FENCE = `operation_id=$1::uuid AND claim_token=$2::uuid AND attempts=$3::integer
  AND status='running' AND lease_expires_at>clock_timestamp()`;
const JOB_FENCE = `job.operation_id=$1::uuid AND job.claim_token=$2::uuid
  AND job.attempts=$3::integer AND job.status='running'
  AND job.lease_expires_at>clock_timestamp()`;
const SCOPED_CHECKPOINT_FENCE = `${FENCE} AND organization_id=$4::uuid
  AND report_file_id=$5::uuid AND assignment_file_id=$6::bigint AND account_id=$7
  AND actor_user_id=$8::uuid AND cancellation_requested_at IS NULL`;

/** Storage/state transition primitive only. The caller owns the transaction,
 * checks current assignment/source rights, and rolls back on any failure.
 * Persist only this allowlisted request; never persist browser tokens or roles.
 */
export function createCustomCohortCaptureJobRepository(client) {
  if (typeof client?.query !== 'function') fail('client_required');
  const transactionId = async () => {
    const row = one(await client.query('/* custom-cohort-job:generation-transaction */ SELECT txid_current()::text AS transaction_id'), 'caller_transaction_required');
    if (typeof row.transaction_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(row.transaction_id)) fail('caller_transaction_required');
    return row.transaction_id;
  };
  /** Pin or reopen an exact prepared version in the caller's live scoped job
   * transaction. Current assignment/source authorization remains with its owner. */
  const preparedGeneration = async (claim, options, preparing) => {
    const values = scopedClaimOf(claim, options);
    const started = await transactionId();
    // Reject autocommit before the first pin write, not after leaving an orphan.
    if (await transactionId() !== started) fail('caller_transaction_required');
    const fence = async () => one(await client.query(`/* custom-cohort-job:generation-fence */
      SELECT operation_id::text FROM app.neighborhood_custom_cohort_capture_jobs
      WHERE ${SCOPED_CHECKPOINT_FENCE} FOR SHARE NOWAIT`, values), 'claim_lost');
    await fence();
    const read = async () => {
      const result = await client.query(`/* custom-cohort-job:generation-read */
        SELECT generation.generation_id::text,generation.status,generation.retirement_started_at,
          to_char(generation.source_observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_observed_at,
          to_char(generation.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
          generation.parcel_count::text,generation.sale_count::text,generation.group_count::text
        FROM app.neighborhood_custom_cohort_prepared_generation_pins pin
        JOIN app.neighborhood_group_generations generation USING(generation_id)
        WHERE pin.operation_id=$1::uuid AND pin.organization_id=$2::uuid AND pin.report_file_id=$3::uuid
          AND pin.assignment_file_id=$4::bigint AND pin.account_id=$5 AND pin.actor_user_id=$6::uuid`,
      [values[0],...values.slice(3)]);
      if (result?.rowCount === 0 && Array.isArray(result.rows) && result.rows.length === 0) return null;
      const row = one(result, 'prepared_generation_corrupt');
      if (!UUID.test(row.generation_id ?? '') || row.status !== 'complete' || row.retirement_started_at !== null
        || ![row.source_observed_at,row.completed_at].every(value => typeof value === 'string'
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))
        || row.completed_at < row.source_observed_at
        || !['parcel_count','sale_count','group_count'].every(key => typeof row[key] === 'string'
          && /^(?:0|[1-9][0-9]{0,18})$/.test(row[key]) && BigInt(row[key]) <= 9223372036854775807n)) fail('prepared_generation_corrupt');
      return Object.freeze({ generation_id: row.generation_id,source_observed_at: row.source_observed_at,
        completed_at: row.completed_at,parcel_count: row.parcel_count,sale_count: row.sale_count,group_count: row.group_count });
    };
    let pinned = await read();
    if (preparing && pinned === null) {
      // The server picks the completed active generation. A browser, checkpoint
      // or replacement worker cannot choose a different generation for this job.
      const candidate = one(await client.query(`/* custom-cohort-job:generation-active */
        SELECT generation.generation_id::text FROM app.neighborhood_group_active active
        JOIN app.neighborhood_group_generations generation USING(generation_id)
        WHERE active.id=true AND generation.status='complete' AND generation.retirement_started_at IS NULL
        FOR KEY SHARE OF generation NOWAIT`), 'prepared_generation_unavailable');
      if (!UUID.test(candidate.generation_id ?? '')) fail('prepared_generation_corrupt');
      await client.query(`/* custom-cohort-job:generation-pin */
        INSERT INTO app.neighborhood_custom_cohort_prepared_generation_pins
          (operation_id,organization_id,report_file_id,assignment_file_id,account_id,actor_user_id,generation_id)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5,$6::uuid,$7::uuid)
        ON CONFLICT(operation_id) DO NOTHING`, [values[0],...values.slice(3),candidate.generation_id]);
      pinned = await read();
      if (!pinned || pinned.generation_id !== candidate.generation_id) fail('prepared_generation_conflict');
    }
    await fence();
    if (await transactionId() !== started) fail('caller_transaction_required');
    return pinned;
  };
  return Object.freeze({
    /** Internal preparation primitive only. Caller supplies a live current-
     * authorized job transaction and rolls back on every failure. Pinning a
     * descriptive index is neither full source acquisition nor source rights. */
    pinPreparedGeneration: (claim, options) => preparedGeneration(claim, options, true),
    /** Reopen the exact pinned generation under the replacement live claim;
     * never consult today's active pointer or silently replace a missing pin. */
    readPreparedGeneration: (claim, options) => preparedGeneration(claim, options, false),
    async readRequest(claim, options) {
      const values = scopedClaimOf(claim, options);
      const row = one(await client.query(`/* custom-cohort-job:request-read */
        SELECT request_payload,request_sha256 FROM app.neighborhood_custom_cohort_capture_jobs
        WHERE ${SCOPED_CHECKPOINT_FENCE}`,values),'claim_lost');
      const request = requestOf(row.request_payload);
      if (request.operation_id !== values[0] || assessmentEvidenceDigest(request) !== row.request_sha256) fail('job_corrupt');
      return request;
    },
    async status(scope, operationId) {
      scope = scopeOf(scope); operationId = uuid(operationId);
      const row = one(await client.query(`/* custom-cohort-job:status */
        SELECT status,attempts,cancellation_requested_at IS NOT NULL AS cancellation_requested,
          context_sha256
        FROM app.neighborhood_custom_cohort_capture_jobs
        WHERE operation_id=$1::uuid AND organization_id=$2::uuid
          AND report_file_id=$3::uuid AND assignment_file_id=$4::bigint AND account_id=$5`,
      [operationId, scope.organization_id, scope.report_file_id,
        scope.assignment_file_id, scope.account_id]), 'operation_unavailable');
      if (!STATUSES.has(row.status) || !Number.isInteger(row.attempts)
        || row.attempts < 0 || row.attempts > 5
        || typeof row.cancellation_requested !== 'boolean'
        || !(row.context_sha256 === null || (typeof row.context_sha256 === 'string'
          && SHA.test(row.context_sha256)))
        || (row.status === 'succeeded') !== (row.context_sha256 !== null)) fail('job_corrupt');
      return Object.freeze({ operation_id: operationId, status: row.status,
        attempts: row.attempts, cancellation_requested: row.cancellation_requested,
        ...(row.context_sha256 === null ? {} : { context_ref: Object.freeze({
          context_id: operationId, context_revision: '1',
          context_sha256: row.context_sha256 }) }) });
    },
    async enqueue({ scope, actorUserId, request }) {
      scope = scopeOf(scope);
      const actor = uuid(actorUserId), admitted = requestOf(request);
      const requestJson = canonicalAssessmentJson(admitted);
      if (Buffer.byteLength(requestJson, 'utf8') > 8192) fail('request_limit');
      const digest = assessmentEvidenceDigest(admitted);
      await client.query(`/* custom-cohort-job:enqueue */
        INSERT INTO app.neighborhood_custom_cohort_capture_jobs
          (operation_id,organization_id,report_file_id,assignment_file_id,account_id,
           actor_user_id,request_sha256,request_payload)
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4::bigint,$5,$6::uuid,$7,$8::jsonb)
        ON CONFLICT (operation_id) DO NOTHING`,
      [admitted.operation_id, scope.organization_id, scope.report_file_id,
        scope.assignment_file_id, scope.account_id, actor, digest, requestJson]);
      const row = one(await client.query(`/* custom-cohort-job:enqueue-readback */
        SELECT operation_id::text,request_sha256,request_payload,status,actor_user_id::text
        FROM app.neighborhood_custom_cohort_capture_jobs
        WHERE operation_id=$1::uuid AND organization_id=$2::uuid
          AND report_file_id=$3::uuid AND assignment_file_id=$4::bigint AND account_id=$5`,
      [admitted.operation_id, scope.organization_id, scope.report_file_id,
        scope.assignment_file_id, scope.account_id]), 'operation_conflict');
      if (row.request_sha256 !== digest || row.actor_user_id !== actor
        || canonicalAssessmentJson(row.request_payload) !== requestJson) fail('operation_conflict');
      return Object.freeze({ operation_id: admitted.operation_id, status: row.status,
        request_sha256: digest });
    },

    async claimDue({ limit = 1, leaseSeconds = 120 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) fail('invalid_limit');
      lease(leaseSeconds);
      // A crashed worker must not strand a cancellation. Skip rows held by
      // another worker and leave unexpired claims untouched.
      await client.query(`/* custom-cohort-job:expire */ WITH expired AS (
          SELECT operation_id FROM app.neighborhood_custom_cohort_capture_jobs
          WHERE status='running' AND lease_expires_at<=clock_timestamp()
            AND (cancellation_requested_at IS NOT NULL OR attempts>=5)
          ORDER BY lease_expires_at,operation_id LIMIT 64 FOR UPDATE SKIP LOCKED
        ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
          SET status=CASE WHEN job.cancellation_requested_at IS NULL THEN 'failed' ELSE 'cancelled' END,
            claim_token=NULL,lease_expires_at=NULL,
            last_error_code=CASE WHEN job.cancellation_requested_at IS NULL
              THEN 'attempts_exhausted' ELSE 'cancelled' END,
            updated_at=clock_timestamp()
          FROM expired WHERE job.operation_id=expired.operation_id`);
      const result = await client.query(`/* custom-cohort-job:claim */ WITH due AS (
          SELECT operation_id FROM app.neighborhood_custom_cohort_capture_jobs job
          WHERE attempts<5 AND cancellation_requested_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM app.neighborhood_custom_cohort_v2_continuations c
              WHERE c.operation_id=job.operation_id AND c.consumed_claim_token IS NULL) AND
            ((status IN ('queued','retry') AND run_after<=clock_timestamp())
              OR (status='running' AND lease_expires_at<=clock_timestamp()))
          ORDER BY run_after,operation_id LIMIT $1 FOR UPDATE SKIP LOCKED
        ) UPDATE app.neighborhood_custom_cohort_capture_jobs job
          SET status='running',attempts=attempts+1,claim_token=gen_random_uuid(),
            lease_expires_at=clock_timestamp()+($2::integer*interval '1 second'),
            updated_at=clock_timestamp()
          FROM due WHERE job.operation_id=due.operation_id
          RETURNING job.operation_id::text,job.organization_id::text,job.report_file_id::text,
            job.assignment_file_id::text,job.account_id,job.actor_user_id::text,
            job.request_sha256,job.request_payload,job.attempts,
            job.claim_token::text,job.lease_expires_at,job.checkpoint`, [limit, leaseSeconds]);
      if (!Array.isArray(result?.rows) || result.rows.length > limit) fail('claim_unavailable');
      const valid = [];
      for (const row of result.rows) {
        try {
          scopeOf({ organization_id: row.organization_id,
            report_file_id: row.report_file_id, assignment_file_id: row.assignment_file_id,
            account_id: row.account_id });
          const admitted = requestOf(row.request_payload);
          if (row.operation_id !== admitted.operation_id || !SHA.test(row.request_sha256)
            || assessmentEvidenceDigest(admitted) !== row.request_sha256
            || !Number.isInteger(row.attempts) || row.attempts < 1 || row.attempts > 5
            || !UUID.test(row.claim_token) || !UUID.test(row.actor_user_id)) fail('job_corrupt');
          // A resume must not trust an unvalidated JSONB checkpoint. The
          // worker still verifies every referenced immutable blob before use.
          const checkpoint = row.checkpoint === null || row.checkpoint === undefined
            ? null : checkpointOf(row.checkpoint);
          valid.push(Object.freeze({ ...row, request_payload: admitted, checkpoint }));
        } catch {
          // The claimed row is locked by the caller's transaction. Retire only
          // this exact claim so a damaged payload cannot block every later job.
          // Do not let validation failure roll back the other valid claims.
          one(await client.query(`/* custom-cohort-job:quarantine */
            UPDATE app.neighborhood_custom_cohort_capture_jobs
              SET status='failed',claim_token=NULL,lease_expires_at=NULL,
                last_error_code='job_corrupt',updated_at=clock_timestamp()
              WHERE operation_id=$1::uuid AND claim_token=$2::uuid
                AND attempts=$3::integer AND status='running'
              RETURNING operation_id::text`,
          [row.operation_id, row.claim_token, row.attempts]), 'job_corrupt');
        }
      }
      return valid;
    },

    async heartbeat(claim, { leaseSeconds = 120, checkpoint = null } = {}) {
      const values = claimOf(claim);
      lease(leaseSeconds);
      let checkpointJson = null;
      if (checkpoint !== null) {
        checkpointJson = canonicalAssessmentJson(checkpointOf(checkpoint));
      }
      const row = one(await client.query(`/* custom-cohort-job:heartbeat */
        UPDATE app.neighborhood_custom_cohort_capture_jobs
          SET lease_expires_at=clock_timestamp()+($4::integer*interval '1 second'),
            checkpoint=COALESCE($5::jsonb,checkpoint),updated_at=clock_timestamp()
          WHERE ${FENCE}
          RETURNING cancellation_requested_at`, [...values, leaseSeconds, checkpointJson]), 'claim_lost');
      return Object.freeze({ cancellation_requested: row.cancellation_requested_at !== null });
    },

    async readCheckpoint(claim, options) {
      const row = one(await client.query(`/* custom-cohort-job:checkpoint-read */
        SELECT checkpoint FROM app.neighborhood_custom_cohort_capture_jobs
        WHERE ${SCOPED_CHECKPOINT_FENCE}`, scopedClaimOf(claim, options)), 'claim_lost');
      return row.checkpoint === null ? null : checkpointOf(row.checkpoint);
    },

    async saveCheckpoint(claim, options, checkpoint) {
      const values = scopedClaimOf(claim, options);
      const checkpointJson = canonicalAssessmentJson(checkpointOf(checkpoint));
      // Share the transaction that retains the original evidence references.
      // Checkpointing does not renew a lease or grant source/assignment access.
      const row = one(await client.query(`/* custom-cohort-job:checkpoint-save */
        UPDATE app.neighborhood_custom_cohort_capture_jobs
          SET checkpoint=$9::jsonb,updated_at=clock_timestamp()
          WHERE ${SCOPED_CHECKPOINT_FENCE} RETURNING checkpoint`,
      [...values, checkpointJson]), 'claim_lost');
      const stored = checkpointOf(row.checkpoint);
      if (canonicalAssessmentJson(stored) !== checkpointJson) fail('job_corrupt');
      return stored;
    },

    async cancel(scope, operationId) {
      scope = scopeOf(scope); operationId = uuid(operationId);
      const result = await client.query(`/* custom-cohort-job:cancel */
        UPDATE app.neighborhood_custom_cohort_capture_jobs
          SET cancellation_requested_at=COALESCE(cancellation_requested_at,clock_timestamp()),
            status=CASE WHEN status IN ('queued','retry','awaiting_selection') THEN 'cancelled' ELSE status END,
            updated_at=clock_timestamp()
          WHERE operation_id=$1::uuid AND organization_id=$2::uuid AND report_file_id=$3::uuid
            AND assignment_file_id=$4::bigint AND account_id=$5 AND status IN ('queued','retry','running','awaiting_selection')
        RETURNING status`, [operationId, scope.organization_id, scope.report_file_id,
        scope.assignment_file_id, scope.account_id]);
      if (result?.rowCount === 1 && result.rows?.length === 1)
        return Object.freeze({ status: result.rows[0].status });
      if (result?.rowCount !== 0 || !Array.isArray(result.rows) || result.rows.length !== 0)
        fail('operation_unavailable');
      // Lost response or repeated cancellation: a terminal job stays terminal.
      // The same exact scope still gates the readback.
      const current = await createCustomCohortCaptureJobRepository(client).status(scope, operationId);
      if (!['succeeded', 'failed', 'cancelled'].includes(current.status)) fail('operation_unavailable');
      return Object.freeze({ status: current.status });
    },

    async failClaim(claim, reason, { retrySeconds = 60 } = {}) {
      const values = claimOf(claim);
      if (typeof reason !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(reason)
        || !Number.isInteger(retrySeconds) || retrySeconds < 1 || retrySeconds > 3600) fail('invalid_failure');
      return one(await client.query(`/* custom-cohort-job:failure */
        UPDATE app.neighborhood_custom_cohort_capture_jobs
          SET status=CASE WHEN cancellation_requested_at IS NOT NULL THEN 'cancelled'
                  WHEN attempts<5 THEN 'retry' ELSE 'failed' END,
            claim_token=NULL,lease_expires_at=NULL,
            run_after=clock_timestamp()+($5::integer*interval '1 second'),
            last_error_code=$4,updated_at=clock_timestamp()
          WHERE ${FENCE} RETURNING status`, [...values, reason, retrySeconds]), 'claim_lost');
    },

    async complete(claim, contextSha256) {
      const values = claimOf(claim);
      if (typeof contextSha256 !== 'string' || !SHA.test(contextSha256)) fail('invalid_context');
      // Must share the transaction that registers this exact immutable context.
      // A job cannot be marked successful for an unrelated report or digest.
      return one(await client.query(`/* custom-cohort-job:complete */
        UPDATE app.neighborhood_custom_cohort_capture_jobs job
          SET status='succeeded',claim_token=NULL,lease_expires_at=NULL,
            context_sha256=$4,updated_at=clock_timestamp()
          FROM app.neighborhood_custom_cohort_contexts context
          WHERE ${JOB_FENCE}
            AND job.cancellation_requested_at IS NULL
            AND context.organization_id=job.organization_id
            AND context.report_file_id=job.report_file_id
            AND context.assignment_file_id=job.assignment_file_id
            AND context.account_id=job.account_id
            AND context.context_id=job.operation_id
            AND context.context_sha256=$4
          RETURNING job.operation_id::text,job.context_sha256`, [...values, contextSha256]),
      'claim_lost_or_context_missing');
    },
  });
}
