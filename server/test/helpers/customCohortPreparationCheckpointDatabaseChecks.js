import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { runCustomCohortCaptureJobOnce } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobWorker.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';

/** Only the verified disposable coordinator CI database calls this helper.
 * Real immutable originals, policies, job fences and context transactions are
 * exercised; no live file, source provider or production database is involved.
 */
export async function runCustomCohortPreparationCheckpointDatabaseChecks({ pool, auth, scope, observationPeriod, grant }) {
  const organization = scope.organization_id, calls = [];
  let fault = null, stagingTransaction = false, allowSource = true;
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), async query(config) {
      calls.push({ sql: config.text, values: config.values ?? [] });
      if (config.text.startsWith('BEGIN ')) stagingTransaction = false;
      if (config.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' && fault?.kind === 'source_crash') {
        fault = null; throw new Error('synthetic crash before source acquisition');
      }
      if (config.text.includes('custom-cohort-job:checkpoint-save')
        && JSON.parse(config.values.at(-1)).phase === 'preparation') {
        stagingTransaction = true;
        if (fault?.kind === 'cancel_preparation') {
          assert.equal((await pool.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
            SET cancellation_requested_at=clock_timestamp() WHERE organization_id=$1
            AND operation_id=$2 AND status='running'`, [organization, fault.operation])).rowCount, 1);
          fault = null;
        }
      }
      if (config.text.includes('custom-cohort-context:insert')) {
        if (fault?.kind === 'registration_crash') {
          fault = null; throw new Error('synthetic crash after whole preparation checkpoint');
        }
        if (fault?.kind === 'cancel_registration') {
          assert.equal((await pool.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
            SET cancellation_requested_at=clock_timestamp() WHERE organization_id=$1
            AND operation_id=$2 AND status='running'`, [organization, fault.operation])).rowCount, 1);
          fault = null;
        }
      }
      const result = await client.query(config);
      if (config.text === 'COMMIT' && stagingTransaction && fault?.kind === 'staging_ack') {
        fault = null; throw new Error('synthetic lost preparation commit acknowledgment');
      }
      return result;
    } };
  } };
  const owner = createCustomCohortContextCapture({ pool: observed,
    authorizeMarketData: async (_client, currentAuth, context) => {
      assert.equal(currentAuth.userId, auth.userId);
      assert.equal(context.scope.organization_id, organization);
      return allowSource ? grant : { allowed: false };
    } });
  const worker = () => runCustomCohortCaptureJobOnce({ pool, cohortService: owner });
  const identity = operationId => ({ auth, accountId: scope.account_id, assignmentFileId: scope.assignment_file_id, operationId });
  const input = operationId => ({ ...identity(operationId), observationPeriod });
  const job = async operation => (await pool.query(`SELECT status,attempts,checkpoint,context_sha256
    FROM app.neighborhood_custom_cohort_capture_jobs WHERE organization_id=$1 AND operation_id=$2`,
  [organization, operation])).rows[0];
  const noContext = async operation => assert.equal((await pool.query(`SELECT count(*)::int AS n
    FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND context_id=$2`,
  [organization, operation])).rows[0].n, 0);
  const makeDue = async operation => assert.equal((await pool.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
    SET run_after=clock_timestamp()-interval '1 second' WHERE organization_id=$1
    AND operation_id=$2 AND status='retry'`, [organization, operation])).rowCount, 1);
  const readHeader = async checkpoint => {
    assert.equal(checkpoint.phase, 'preparation'); assert.equal(checkpoint.evidence_refs.length, 2);
    const ref = checkpoint.evidence_refs[1];
    const rows = (await pool.query(`SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs
      WHERE organization_id=$1 AND content_sha256=$2 AND canonical_utf8_bytes=$3`,
    [organization, ref.content_sha256, ref.canonical_utf8_bytes])).rows;
    assert.equal(rows.length, 1); return prepareCustomCohortContextHeader(rows[0].canonical_utf8);
  };
  const loadOriginal = async header => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const refs = Object.fromEntries(['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input']
        .map(key => [key, header.body[key]]));
      const result = await loadCustomCohortCaptureInputs(client, json(scope), refs);
      await client.query('ROLLBACK'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const interrupt = async (kind = 'registration_crash') => {
    const operation = randomUUID();
    await owner.queueCaptureJob(input(operation)); fault = { kind, operation };
    const result = await worker();
    assert.equal(result.operation_id, operation); assert.equal(result.status, 'retry');
    const saved = await job(operation); assert.equal(saved.attempts, 1);
    const header = await readHeader(saved.checkpoint);
    assert.equal(header.context_ref.context_id, operation); await noContext(operation);
    return { operation, checkpoint: saved.checkpoint, header };
  };
  const resumed = await interrupt();
  const original = await loadOriginal(resumed.header);
  const oldSubdivision = (await pool.query('SELECT subdivision FROM core.accounts WHERE account_id=$1', [scope.account_id])).rows[0].subdivision;
  try {
    assert.equal((await pool.query("UPDATE core.accounts SET subdivision='Later synthetic source sweep' WHERE account_id=$1", [scope.account_id])).rowCount, 1);
    await makeDue(resumed.operation); const from = calls.length;
    const complete = await worker();
    assert.equal(complete.status, 'succeeded'); assert.equal(complete.operation_id, resumed.operation);
    assert.deepEqual(complete.context_ref, resumed.header.context_ref);
    assert.deepEqual((await job(resumed.operation)).checkpoint, resumed.checkpoint);
    assert.deepEqual((await loadOriginal(resumed.header)).retained_inputs, original.retained_inputs);
    assert.ok(!calls.slice(from).some(call => call.sql.includes('neighborhood-cache:')
      || call.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' || call.sql.includes('checkpoint-save')),
    'completed acquisition retries neither consult new source rows nor replace the checkpoint');
  } finally { await pool.query('UPDATE core.accounts SET subdivision=$2 WHERE account_id=$1', [scope.account_id, oldSubdivision]); }

  const uncertain = await interrupt('staging_ack');
  await makeDue(uncertain.operation); const fromUnknown = calls.length;
  const recovered = await worker();
  assert.equal(recovered.status, 'succeeded'); assert.deepEqual(recovered.context_ref, uncertain.header.context_ref);
  assert.deepEqual((await job(uncertain.operation)).checkpoint, uncertain.checkpoint);
  assert.ok(!calls.slice(fromUnknown).some(call => call.sql.includes('neighborhood-cache:') || call.sql.includes('checkpoint-save')),
    'lost staging COMMIT acknowledgment resumes the originals actually committed');

  const denied = await interrupt();
  const sourceHashes = new Set((await pool.query(`SELECT content_sha256,canonical_utf8
    FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1`, [organization])).rows
    .filter(row => { const v = JSON.parse(row.canonical_utf8); return v.schema_version === 1 && v.projection && Array.isArray(v.records); })
    .map(row => row.content_sha256));
  assert.ok(sourceHashes.size > 0, 'fixture must retain source payload blobs for the source-denial assertion');
  try {
    allowSource = false; await makeDue(denied.operation); const from = calls.length;
    const refused = await worker(); assert.equal(refused.status, 'retry'); assert.equal(refused.reason, 'capture_failed');
    assert.deepEqual((await job(denied.operation)).checkpoint, denied.checkpoint); await noContext(denied.operation);
    assert.ok(!calls.slice(from).some(call => call.values.flat().some(value => sourceHashes.has(value))),
      'current source denial refuses before any retained source payload is opened');
  } finally { allowSource = true; await owner.cancelCaptureJob(identity(denied.operation)); }

  const missing = await interrupt();
  const corrupted = { phase: 'preparation', evidence_refs: [missing.checkpoint.evidence_refs[0],
    { ...missing.checkpoint.evidence_refs[1], content_sha256: 'f'.repeat(64) }] };
  assert.equal((await pool.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs SET checkpoint=$3::jsonb
    WHERE organization_id=$1 AND operation_id=$2 AND status='retry'`, [organization, missing.operation, json(corrupted)])).rowCount, 1);
  await makeDue(missing.operation); const fromMissing = calls.length;
  assert.equal((await worker()).status, 'retry'); await noContext(missing.operation);
  assert.deepEqual((await job(missing.operation)).checkpoint, corrupted);
  assert.ok(!calls.slice(fromMissing).some(call => call.sql.includes('neighborhood-cache:') || call.sql.includes('checkpoint-save')));
  await owner.cancelCaptureJob(identity(missing.operation));

  const cancelPreparation = { operation: randomUUID() };
  await owner.queueCaptureJob(input(cancelPreparation.operation));
  fault = { kind: 'source_crash', operation: cancelPreparation.operation };
  assert.equal((await worker()).status, 'retry');
  const subjectCheckpoint = (await job(cancelPreparation.operation)).checkpoint;
  assert.equal(subjectCheckpoint.phase, 'subject'); assert.equal(subjectCheckpoint.evidence_refs.length, 1);
  const blobCount = async () => (await pool.query(`SELECT count(*)::int AS n
    FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1`, [organization])).rows[0].n;
  const beforeCancel = await blobCount();
  await makeDue(cancelPreparation.operation); fault = { kind: 'cancel_preparation', operation: cancelPreparation.operation };
  assert.equal((await worker()).status, 'cancelled');
  assert.deepEqual((await job(cancelPreparation.operation)).checkpoint, subjectCheckpoint);
  assert.equal(await blobCount(), beforeCancel, 'cancelled checkpoint save rolls back all newly staged graph originals');
  await noContext(cancelPreparation.operation);

  const cancelRegistration = await interrupt();
  await makeDue(cancelRegistration.operation); fault = { kind: 'cancel_registration', operation: cancelRegistration.operation };
  assert.equal((await worker()).status, 'cancelled');
  assert.deepEqual((await job(cancelRegistration.operation)).checkpoint, cancelRegistration.checkpoint);
  await noContext(cancelRegistration.operation);
  return { checks: ['whole original acquisition/preparation checkpoint resumes across changed source rows and lost COMMIT acknowledgment; '
    + 'current source denial precedes payload reads; missing originals refuse; cancellation rolls back staged originals or context registration'] };
}
