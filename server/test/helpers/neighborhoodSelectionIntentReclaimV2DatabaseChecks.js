import assert from 'node:assert/strict';
import { withCustomCohortJobTransaction } from '../../src/services/neighborhoodAssessment/customCohortJobTransaction.js';
import { createCustomCohortCaptureJobRepository } from '../../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createCustomCohortV2SelectionIntentRepository } from '../../src/services/neighborhoodAssessment/customCohortV2SelectionIntentRepository.js';

/** Exercise the real issued intent's expiry, native mutation guard and generic
 * worker selectors in a guarded disposable database. Roll back every probe;
 * no clock/attempt reset, fixture rebind, source grant or copied parent. */
export async function runNeighborhoodSelectionIntentReclaimV2DatabaseChecks({ pool, scope, operationId, actorUserId, intent, workspaceTarget, expectedJob }) {
  const operation = operationId, rollback = new Error('rollback actual expired-intent probes');
  let originalJob;
  const read = async client => (await client.query(
    'SELECT * FROM app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1', [operation])).rows[0];
  await assert.rejects(withCustomCohortJobTransaction(pool, async client => {
    const identity = (await client.query('SELECT current_database() AS database_name')).rows;
    assert.equal(identity.length, 1); assert.match(identity[0].database_name, /^neighborhood_[a-f0-9]{32}_test$/);
    originalJob = await read(client);
    for (const [key, value] of Object.entries({ ...scope, operation_id: operation, actor_user_id: actorUserId }))
      assert.equal(originalJob[key], value);
    assert.deepEqual(Object.fromEntries(Object.keys(expectedJob).map(key => [key, originalJob[key]])), expectedJob);
    await client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, [operation]);
    const expired = await read(client);
    assert.equal(expired.attempts, expectedJob.attempts); assert.equal(expired.claim_token, expectedJob.claim_token);
    assert.deepEqual(await createCustomCohortCaptureJobRepository(client).claimDue({ limit: 1, leaseSeconds: 120 }), []);
    assert.deepEqual(await read(client), expired, 'neither generic sweep nor claim changes the expired intent tuple');
    for (const set of ['attempts=attempts+1', 'claim_token=gen_random_uuid()',
      'attempts=attempts+1,claim_token=gen_random_uuid()',
      "status='failed',claim_token=NULL,lease_expires_at=NULL,last_error_code='attempts_exhausted'",
      "lease_expires_at=clock_timestamp()+interval '120 seconds'"]) {
      await client.query('SAVEPOINT intent_reclaim_probe');
      await assert.rejects(client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs SET ${set}
        WHERE operation_id=$1`, [operation]), /selection_intent_job_conflict_initial_claim/);
      await client.query('ROLLBACK TO SAVEPOINT intent_reclaim_probe');
      await client.query('RELEASE SAVEPOINT intent_reclaim_probe');
      assert.deepEqual(await read(client), expired);
    }
    await assert.rejects(createCustomCohortV2SelectionIntentRepository(client).resume(operation,
      { scope, actorUserId, intent, workspaceTarget }), /claim_lost/);
    assert.deepEqual(await read(client), expired, 'expired exact replay cannot renew the retained claim');
    assert.deepEqual(await createCustomCohortCaptureJobRepository(client).cancel(scope, operation), { status: 'running' });
    assert.deepEqual(await createCustomCohortCaptureJobRepository(client).claimDue({ limit: 1, leaseSeconds: 120 }), []);
    const cancelled = await read(client);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.claim_token, null);
    assert.equal(cancelled.lease_expires_at, null); assert.equal(cancelled.last_error_code, 'cancelled');
    const retained = row => Object.fromEntries(Object.entries(row).filter(([key]) =>
      !['status', 'claim_token', 'lease_expires_at', 'last_error_code', 'cancellation_requested_at', 'updated_at'].includes(key)));
    assert.deepEqual(retained(cancelled), retained(expired), 'scoped cancellation preserves attempts, roots, schedule and every target');
    // Expected SQL refusals mark the transaction wrapper's connection for
    // discard. Execute a real ROLLBACK before its sentinel exits, so restoration
    // is proven by PostgreSQL rollback rather than merely closing that client.
    await client.query('ROLLBACK');
    throw rollback;
  }), error => error === rollback);
  assert.deepEqual(await read(pool), originalJob, 'actual rollback restores the complete original issued-intent job tuple');
}
