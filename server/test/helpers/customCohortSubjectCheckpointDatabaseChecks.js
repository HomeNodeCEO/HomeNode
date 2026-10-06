import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture }
  from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { runCustomCohortCaptureJobOnce }
  from '../../src/services/neighborhoodAssessment/customCohortCaptureJobWorker.js';
import { canonicalAssessmentJson as json }
  from '../../src/services/neighborhoodAssessment/contract.js';

/** Called only with the coordinator's verified disposable CI database and
 * synthetic fixture. This exercises actual job, subject, original blob and
 * context repositories, including a crash between subject and source stages.
 */
export async function runCustomCohortSubjectCheckpointDatabaseChecks({ pool,
  auth, scope, snapshotId, observationPeriod, grant }) {
  const actor = auth.userId, organization = scope.organization_id;
  await pool.query(`INSERT INTO app_auth.organization_memberships(organization_id,user_id)
    VALUES($1,$2)`, [organization, actor]);
  await pool.query(`INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code)
    VALUES($1,$2,'appraiser')`, [organization, actor]);
  const calls = [];
  let interruptSource = false, cancelAtCheckpoint = null;
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), async query(config) {
      calls.push(config.text);
      if (cancelAtCheckpoint && config.text.includes('custom-cohort-job:checkpoint-save')) {
        assert.equal((await pool.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
          SET cancellation_requested_at=clock_timestamp() WHERE organization_id=$1
          AND operation_id=$2 AND status='running'`, [organization, cancelAtCheckpoint])).rowCount, 1);
        cancelAtCheckpoint = null;
      }
      if (interruptSource && config.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
        interruptSource = false;
        throw new Error('synthetic crash after committed subject checkpoint');
      }
      return client.query(config);
    } };
  } };
  let allowSource = true;
  const policy = async (_client, currentAuth, context) => {
    assert.equal(currentAuth.userId, actor);
    assert.equal(context.scope.organization_id, organization);
    return allowSource ? grant : { allowed: false };
  };
  const owner = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: policy });
  const worker = () => runCustomCohortCaptureJobOnce({ pool, cohortService: owner });
  const input = operationId => ({ auth, accountId: scope.account_id,
    assignmentFileId: scope.assignment_file_id, operationId, observationPeriod });
  const job = async operation => (await pool.query(`SELECT status,attempts,checkpoint,context_sha256
    FROM app.neighborhood_custom_cohort_capture_jobs WHERE organization_id=$1 AND operation_id=$2`,
  [organization, operation])).rows[0];
  const original = async checkpoint => {
    assert.equal(checkpoint.phase, 'subject'); assert.equal(checkpoint.evidence_refs.length, 1);
    const ref = checkpoint.evidence_refs[0];
    const body = (await pool.query(`SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes=$3`,
    [organization, ref.content_sha256, ref.canonical_utf8_bytes])).rows;
    assert.equal(body.length, 1); return JSON.parse(body[0].canonical_utf8);
  };
  const makeRetryDue = async operation => assert.equal((await pool.query(`UPDATE
    app.neighborhood_custom_cohort_capture_jobs SET run_after=clock_timestamp()-interval '1 second'
    WHERE organization_id=$1 AND operation_id=$2 AND status='retry'`, [organization, operation])).rowCount, 1);
  const noContext = async operation => assert.equal((await pool.query(`SELECT count(*)::int AS n
    FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND context_id=$2`,
  [organization, operation])).rows[0].n, 0);
  const protectedState = async () => {
    const sections = (await pool.query(`SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s
      WHERE assignment_file_id=$1 ORDER BY section_key`, [scope.assignment_file_id])).rows;
    const acceptances = (await pool.query(`SELECT to_jsonb(a) AS value FROM app.custom_neighborhood_acceptances a
      WHERE assignment_file_id=$1 ORDER BY id`, [scope.assignment_file_id])).rows;
    return { sections, acceptances };
  };
  const before = await protectedState();
  const suspend = status => pool.query(`UPDATE app_auth.organization_memberships SET status=$3
    WHERE organization_id=$1 AND user_id=$2`, [organization, actor, status]);
  const interrupted = async () => {
    const operation = randomUUID();
    assert.equal((await owner.queueCaptureJob(input(operation))).status, 'queued');
    interruptSource = true;
    const result = await worker();
    assert.equal(result.operation_id, operation); assert.equal(result.status, 'retry');
    const stored = await job(operation); assert.equal(stored.attempts, 1);
    const intent = await original(stored.checkpoint);
    assert.equal(intent.operation_id, operation); assert.equal(intent.actor_user_id, actor);
    assert.equal(intent.target.report_file_id, scope.report_file_id);
    assert.equal(intent.target.assignment_file_id, scope.assignment_file_id);
    await noContext(operation);
    return { operation, checkpoint: stored.checkpoint, intent };
  };

  const cancelledOperation = randomUUID();
  await owner.queueCaptureJob(input(cancelledOperation));
  const blobCount = async () => (await pool.query(`SELECT count(*)::int AS n
    FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1`, [organization])).rows[0].n;
  const beforeCancelledBlobs = await blobCount();
  cancelAtCheckpoint = cancelledOperation;
  const cancelled = await worker();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.operation_id, cancelledOperation);
  assert.equal((await job(cancelledOperation)).checkpoint, null);
  assert.equal(await blobCount(), beforeCancelledBlobs,
    'cancelled subject checkpoint rolls back newly retained originals in the same transaction');
  await noContext(cancelledOperation);

  const first = await interrupted();
  await makeRetryDue(first.operation);
  const resumedFrom = calls.length;
  const completed = await worker();
  assert.equal(completed.status, 'succeeded'); assert.equal(completed.operation_id, first.operation);
  assert.equal((await job(first.operation)).attempts, 2);
  assert.deepEqual((await job(first.operation)).checkpoint, first.checkpoint);
  assert.deepEqual(await original(first.checkpoint), first.intent);
  const resumedCalls = calls.slice(resumedFrom);
  assert.ok(resumedCalls.some(sql => sql.includes('checkpoint-read')));
  assert.ok(!resumedCalls.some(sql => sql.includes('checkpoint-save')),
    'retry reads the original intent instead of writing a replacement');
  const sourceBegin = resumedCalls.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(sourceBegin > 0);
  assert.ok(!resumedCalls.slice(0, sourceBegin).some(sql => sql.includes('neighborhood-cohort-blob:insert')),
    'resumed subject stage retains no new original subject or intent blobs');
  assert.equal((await job(first.operation)).context_sha256, completed.context_ref.context_sha256);

  const changed = await interrupted();
  const snapshot = (await pool.query('SELECT subject_data FROM app.appraisal_subject_snapshots WHERE id=$1',
    [snapshotId])).rows[0].subject_data;
  try {
    assert.equal((await pool.query(`UPDATE app.appraisal_subject_snapshots SET
      subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2999')
      WHERE id=$1`, [snapshotId])).rowCount, 1);
    await makeRetryDue(changed.operation);
    const from = calls.length, refused = await worker();
    assert.equal(refused.status, 'retry'); assert.equal(refused.reason, 'subject_changed');
    assert.deepEqual((await job(changed.operation)).checkpoint, changed.checkpoint);
    await noContext(changed.operation);
    assert.ok(!calls.slice(from).some(sql => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
      'changed subject refuses before a fresh source capture');
  } finally {
    assert.equal((await pool.query('UPDATE app.appraisal_subject_snapshots SET subject_data=$2::jsonb WHERE id=$1',
      [snapshotId, json(snapshot)])).rowCount, 1);
    assert.equal((await owner.cancelCaptureJob(input(changed.operation))).status, 'cancelled');
  }

  const revoked = await interrupted();
  try {
    await suspend('inactive'); await makeRetryDue(revoked.operation);
    const from = calls.length, refused = await worker();
    assert.equal(refused.status, 'retry'); assert.equal(refused.reason, 'access_revoked');
    assert.equal(calls.length, from, 'revoked actor is refused before any coordinator checkpoint/original read');
    assert.deepEqual((await job(revoked.operation)).checkpoint, revoked.checkpoint);
    await noContext(revoked.operation);
  } finally { await suspend('active'); }
  // A stored checkpoint is not a source-data grant, even after current actor
  // membership is restored. Re-run the independent source policy on retry.
  try {
    allowSource = false; await makeRetryDue(revoked.operation);
    const refused = await worker();
    assert.equal(refused.status, 'retry'); assert.equal(refused.reason, 'capture_failed');
    assert.deepEqual((await job(revoked.operation)).checkpoint, revoked.checkpoint);
    await noContext(revoked.operation);
  } finally {
    allowSource = true;
    assert.equal((await owner.cancelCaptureJob(input(revoked.operation))).status, 'cancelled');
  }
  assert.deepEqual(await protectedState(), before,
    'successful or refused job retries never apply/change accepted boundaries or report sections');
  return { checks: ['real worker/coordinator cancelled checkpoint rolls back its originals; '
    + 'crash retry reuses the committed original subject and intent; '
    + 'changed subject, revoked actor and revoked source rights refuse without context/report publication'] };
}
