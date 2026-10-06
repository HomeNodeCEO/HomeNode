import assert from 'node:assert/strict';
import { runCustomCohortCaptureJobOnce } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobWorker.js';

/** The caller has already verified its disposable database, synthetic CSV
 * originals and independent source policy. All mutations remain in that fixture.
 */
export async function runCustomCohortPrivateCheckpointDatabaseChecks({ pool, target, auth,
  makeOwner, captureInput, appendReview, revokeRights, restoreRights }) {
  await pool.query(`INSERT INTO app_auth.organization_memberships(organization_id,user_id)
    VALUES($1,$2)`, [target.organization_id, auth.userId]);
  await pool.query(`INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code)
    VALUES($1,$2,'appraiser')`, [target.organization_id, auth.userId]);
  const row = async operation => (await pool.query(`SELECT status,checkpoint,context_sha256
    FROM app.neighborhood_custom_cohort_capture_jobs WHERE organization_id=$1 AND operation_id=$2`,
  [target.organization_id, operation])).rows[0];
  const makeDue = async operation => assert.equal((await pool.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
    SET run_after=clock_timestamp()-interval '1 second' WHERE organization_id=$1
    AND operation_id=$2 AND status='retry'`, [target.organization_id, operation])).rowCount, 1);
  const noContext = async operation => assert.equal((await pool.query(`SELECT count(*)::int AS n
    FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND context_id=$2`,
  [target.organization_id, operation])).rows[0].n, 0);
  const interrupted = async (sourceMode = 'cad4') => {
    let crash = true;
    const { calls, owner } = makeOwner({ sourceMode, after: async ({ text }) => {
      if (crash && text.includes('custom-cohort-context:insert')) {
        crash = false; throw new Error('synthetic private checkpoint registration crash');
      }
    } });
    const input = captureInput(), operation = input.operationId;
    const worker = () => runCustomCohortCaptureJobOnce({ pool, cohortService: owner });
    await owner.queueCaptureJob(input);
    assert.equal((await worker()).status, 'retry'); await noContext(operation);
    const checkpoint = (await row(operation)).checkpoint;
    assert.equal(checkpoint.phase, 'preparation'); assert.equal(checkpoint.evidence_refs.length, 2);
    const cancel = () => owner.cancelCaptureJob({ auth, accountId: target.account_id,
      assignmentFileId: target.assignment_file_id, operationId: operation });
    return { operation, input, checkpoint, calls, worker, cancel };
  };
  for (const sourceMode of ['cad4', 'combined-witness2-v1']) {
    const f = await interrupted(sourceMode); await makeDue(f.operation); const from = f.calls.length;
    const complete = await f.worker();
    assert.equal(complete.status, 'succeeded'); assert.equal(complete.operation_id, f.operation);
    assert.deepEqual((await row(f.operation)).checkpoint, f.checkpoint);
    assert.ok(!f.calls.slice(from).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)
      || sql.includes('assignment-sales-capture:batch') || sql.includes('checkpoint-save')),
    'private retry reopens originals, never a replacement shared or private acquisition');
    assert.ok(f.calls.slice(from).some(sql => sql.includes('assignment-sales-capture:recheck-lock')),
      'current exact private review is fenced again at registration');
  }
  const changed = await interrupted();
  try {
    await appendReview(); await makeDue(changed.operation);
    const refused = await changed.worker();
    assert.equal(refused.status, 'retry'); assert.equal(refused.reason, 'capture_failed');
    assert.deepEqual((await row(changed.operation)).checkpoint, changed.checkpoint);
    await noContext(changed.operation);
  } finally { await changed.cancel(); }

  const revoked = await interrupted();
  try {
    await revokeRights(); await makeDue(revoked.operation); const from = revoked.calls.length;
    const refused = await revoked.worker();
    assert.equal(refused.status, 'retry'); assert.equal(refused.reason, 'capture_failed');
    assert.deepEqual((await row(revoked.operation)).checkpoint, revoked.checkpoint);
    await noContext(revoked.operation);
    assert.ok(!revoked.calls.slice(from).some(sql => sql.includes('neighborhood-cohort-blob:read-batch')),
      'independent private source denial precedes full graph/original row-page reads');
  } finally { await restoreRights(); await revoked.cancel(); }
  return { checks: ['real private CSV preparation checkpoints resume both CAD4 and combined-witness modes without new acquisition; '
    + 'changed CSV review and revoked independent private rights prevent registration'] };
}
