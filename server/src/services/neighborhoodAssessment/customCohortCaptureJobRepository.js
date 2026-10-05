import { assessmentDate, assessmentEvidenceDigest, canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodDiscoveryChoice } from './selectorInputProfile.js';
import { customNeighborhoodPrivateSalesPurpose } from '../../security/customNeighborhoodPrivateSalesPolicy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const ACCOUNT_CONTROL = /[\u0000-\u001f\u007f]/;
const PHASES = new Set(['subject', 'spatial', 'source', 'preparation', 'registration']);
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
  exact(value, ['operation_id', 'claim_token', 'attempts']);
  if (!Number.isInteger(value.attempts) || value.attempts < 1 || value.attempts > 5) fail('invalid_claim');
  return [uuid(value.operation_id), uuid(value.claim_token), value.attempts];
}
function lease(value) {
  if (!Number.isInteger(value) || value < 15 || value > 900) fail('invalid_lease');
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

/** Storage/state transition primitive only. The caller owns the transaction,
 * checks current assignment/source rights, and rolls back on any failure.
 * Persist only this allowlisted request; never persist browser tokens or roles.
 */
export function createCustomCohortCaptureJobRepository(client) {
  if (typeof client?.query !== 'function') fail('client_required');
  return Object.freeze({
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
          SELECT operation_id FROM app.neighborhood_custom_cohort_capture_jobs
          WHERE attempts<5 AND cancellation_requested_at IS NULL AND
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
      return result.rows.map(row => {
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
          return Object.freeze({ ...row, request_payload: admitted, checkpoint });
        } catch { fail('job_corrupt'); }
      });
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

    async cancel(scope, operationId) {
      scope = scopeOf(scope); operationId = uuid(operationId);
      const row = one(await client.query(`/* custom-cohort-job:cancel */
        UPDATE app.neighborhood_custom_cohort_capture_jobs
          SET cancellation_requested_at=COALESCE(cancellation_requested_at,clock_timestamp()),
            status=CASE WHEN status IN ('queued','retry') THEN 'cancelled' ELSE status END,
            updated_at=clock_timestamp()
          WHERE operation_id=$1::uuid AND organization_id=$2::uuid AND report_file_id=$3::uuid
            AND assignment_file_id=$4::bigint AND account_id=$5 AND status IN ('queued','retry','running')
          RETURNING status`, [operationId, scope.organization_id, scope.report_file_id,
        scope.assignment_file_id, scope.account_id]), 'operation_unavailable');
      return Object.freeze({ status: row.status });
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
