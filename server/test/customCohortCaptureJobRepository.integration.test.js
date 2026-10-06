import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { prepareNeighborhoodCiDatabase, NEIGHBORHOOD_CI_IDENTITY_SQL,
  verifyNeighborhoodCiConnection } from './helpers/neighborhoodCiDatabase.js';
import { createCustomCohortCaptureJobRepository }
  from '../src/services/neighborhoodAssessment/customCohortCaptureJobRepository.js';
import { createNeighborhoodCohortBlobRepository }
  from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { withCustomCohortJobTransaction }
  from '../src/services/neighborhoodAssessment/customCohortJobTransaction.js';

test('Custom capture jobs fence retries, cancellation and atomic context completion in PostgreSQL', {
  skip: !process.env.DATABASE_URL, timeout: 180_000,
}, async () => {
  const target = await prepareNeighborhoodCiDatabase();
  const { Client, Pool } = createRequire(import.meta.url)('pg');
  const client = new Client({ connectionString: target.connectionString,
    connectionTimeoutMillis: 3000, statement_timeout: 8000,
    application_name: 'custom_cohort_capture_job_ci_test' });
  try {
    await client.connect();
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection?.stream?.remoteAddress, target.databaseName);
    const organization = randomUUID(), actor = randomUUID(), account = 'CAPTURE-JOB-SYNTHETIC';
    const report = randomUUID();
    await client.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic job','Synthetic job')", [organization]);
    await client.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic job actor')",
      [actor, `${actor}@example.test`]);
    await client.query("INSERT INTO core.accounts(account_id,county,address,city) VALUES($1,'Dallas','Synthetic only','Synthetic')", [account]);
    const assignment = (await client.query(`INSERT INTO app.assignment_files
      (organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,$2,$3,$4,$4) RETURNING id::text`,
    [organization, account, `JOB-${randomUUID()}`, actor])).rows[0].id;
    await client.query(`INSERT INTO app.report_files
      (id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id)
      VALUES($1,$2,$3,'custom_appraisal',$4,$5)`,
    [report, organization, account, `JOB-${randomUUID()}`, assignment]);
    const scope = { organization_id: organization, report_file_id: report,
      assignment_file_id: assignment, account_id: account };
    const repository = createCustomCohortCaptureJobRepository(client);
    const makeRequest = operation_id => ({ operation_id, observation_period: {
      start_date: '2024-01-01', end_date: '2024-12-31' } });
    const firstOperation = randomUUID();
    const first = await repository.enqueue({ scope, actorUserId: actor, request: makeRequest(firstOperation) });
    assert.equal(first.status, 'queued');
    assert.deepEqual(await repository.enqueue({ scope, actorUserId: actor,
      request: makeRequest(firstOperation) }), first, 'same exact operation replays');
    await assert.rejects(repository.enqueue({ scope, actorUserId: actor,
      request: { ...makeRequest(firstOperation), observation_period: {
        start_date: '2023-01-01', end_date: '2024-12-31' } } }), /operation_conflict/);
    const [claimed] = await repository.claimDue();
    assert.equal(claimed.operation_id, firstOperation);
    assert.equal(claimed.checkpoint, null, 'new jobs have no resumable checkpoint');
    const claim = { operation_id: claimed.operation_id, claim_token: claimed.claim_token,
      attempts: claimed.attempts };
    assert.deepEqual(await repository.heartbeat(claim), { cancellation_requested: false });
    assert.equal((await repository.cancel(scope, firstOperation)).status, 'running');
    assert.deepEqual(await repository.heartbeat(claim), { cancellation_requested: true });
    assert.equal((await repository.failClaim(claim, 'cancelled')).status, 'cancelled');
    await assert.rejects(repository.heartbeat(claim), /claim_lost/);

    const secondOperation = randomUUID();
    await repository.enqueue({ scope, actorUserId: actor, request: makeRequest(secondOperation) });
    const [second] = await repository.claimDue();
    assert.equal(second.operation_id, secondOperation);
    assert.equal(second.checkpoint, null);
    const secondClaim = { operation_id: second.operation_id, claim_token: second.claim_token,
      attempts: second.attempts };
    await assert.rejects(repository.complete(secondClaim, 'b'.repeat(64)),
      /claim_lost_or_context_missing/, 'no context means no successful job');
    await client.query('BEGIN');
    try {
      const header = await createNeighborhoodCohortBlobRepository(client, organization).put('{"synthetic":true}');
      await client.query(`INSERT INTO app.neighborhood_custom_cohort_contexts
        (organization_id,report_file_id,assignment_file_id,account_id,context_id,
          context_revision,context_sha256,header_content_sha256,header_canonical_utf8_bytes)
        VALUES($1,$2,$3,$4,$5,1,$6,$7,$8)`,
      [organization, report, assignment, account, secondOperation, 'b'.repeat(64),
        header.content_sha256, Number(header.canonical_utf8_bytes)]);
      const completed = await repository.complete(secondClaim, 'b'.repeat(64));
      assert.equal(completed.context_sha256, 'b'.repeat(64));
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    const persisted = await client.query(`SELECT status,context_sha256 FROM
      app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1`, [secondOperation]);
    assert.deepEqual(persisted.rows[0], { status: 'succeeded', context_sha256: 'b'.repeat(64) });
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM
      app.neighborhood_custom_cohort_capture_jobs WHERE status='cancelled'`)).rows[0].count, 1);

    const retryOperation = randomUUID();
    await repository.enqueue({ scope, actorUserId: actor, request: makeRequest(retryOperation) });
    const [initial] = await repository.claimDue();
    assert.equal(initial.operation_id, retryOperation);
    await client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, [retryOperation]);
    const [reclaimed] = await repository.claimDue();
    assert.equal(reclaimed.operation_id, retryOperation);
    assert.equal(reclaimed.attempts, 2);
    await assert.rejects(repository.heartbeat({ operation_id: retryOperation,
      claim_token: initial.claim_token, attempts: 1 }), /claim_lost/,
    'a stale worker cannot extend the replacement claim');
    await repository.failClaim({ operation_id: retryOperation,
      claim_token: reclaimed.claim_token, attempts: 2 }, 'synthetic_retry');

    const abandonedOperation = randomUUID();
    await repository.enqueue({ scope, actorUserId: actor, request: makeRequest(abandonedOperation) });
    const due = await repository.claimDue();
    assert.equal(due.length, 1);
    // The retry above is due in 60 seconds, so this claim belongs to the new job.
    assert.equal(due[0].operation_id, abandonedOperation);
    await repository.cancel(scope, abandonedOperation);
    await client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
      SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1`, [abandonedOperation]);
    assert.equal((await repository.claimDue()).length, 0);
    assert.equal((await client.query(`SELECT status FROM app.neighborhood_custom_cohort_capture_jobs
      WHERE operation_id=$1`, [abandonedOperation])).rows[0].status, 'cancelled',
    'a crashed worker must not strand a cancelled claim');

    const corruptOperation = randomUUID(), healthyOperation = randomUUID();
    await repository.enqueue({ scope, actorUserId: actor, request: makeRequest(corruptOperation) });
    await client.query(`UPDATE app.neighborhood_custom_cohort_capture_jobs
      SET request_payload=jsonb_set(request_payload,'{observation_period,start_date}',
        to_jsonb('2023-01-01'::text)) WHERE operation_id=$1`, [corruptOperation]);
    await repository.enqueue({ scope, actorUserId: actor, request: makeRequest(healthyOperation) });
    const recovered = await repository.claimDue({ limit: 2 });
    assert.deepEqual(recovered.map(row => row.operation_id), [healthyOperation],
      'corrupt first job must not roll back a later valid claim');
    assert.deepEqual((await client.query(`SELECT status,last_error_code FROM
      app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1`,
    [corruptOperation])).rows[0], { status: 'failed', last_error_code: 'job_corrupt' });

    // Exercise the actual short-transaction owner against this verified,
    // isolated CI database; never against a production appraisal database.
    const jobPool = new Pool({ connectionString: target.connectionString, max: 1,
      connectionTimeoutMillis: 3000, statement_timeout: 8000,
      application_name: 'custom_cohort_job_transaction_ci_test' });
    try {
      const probe = await jobPool.connect();
      try {
        verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
          probe.connection?.stream?.remoteAddress, target.databaseName);
      } finally { probe.release(); }
      const ownedOperation = randomUUID();
      await withCustomCohortJobTransaction(jobPool, ownedClient =>
        createCustomCohortCaptureJobRepository(ownedClient).enqueue({ scope,
          actorUserId: actor, request: makeRequest(ownedOperation) }));
      const rollback = new Error('synthetic owned rollback');
      await assert.rejects(withCustomCohortJobTransaction(jobPool, async ownedClient => {
        const [owned] = await createCustomCohortCaptureJobRepository(ownedClient).claimDue();
        assert.equal(owned.operation_id, ownedOperation);
        throw rollback;
      }), rollback);
      assert.deepEqual((await client.query(`SELECT status,attempts FROM
        app.neighborhood_custom_cohort_capture_jobs WHERE operation_id=$1`,
      [ownedOperation])).rows[0], { status: 'queued', attempts: 0 });
      const ownedClaim = await withCustomCohortJobTransaction(jobPool, async ownedClient => {
        const settings = (await ownedClient.query(`SELECT current_setting('statement_timeout') AS statement_limit,
          current_setting('lock_timeout') AS lock_limit`)).rows[0];
        assert.deepEqual(settings, { statement_limit: '5s', lock_limit: '1s' });
        const [owned] = await createCustomCohortCaptureJobRepository(ownedClient).claimDue();
        assert.equal(owned.operation_id, ownedOperation);
        return { operation_id: owned.operation_id, claim_token: owned.claim_token, attempts: owned.attempts };
      });
      await withCustomCohortJobTransaction(jobPool, async ownedClient => {
        const owned = createCustomCohortCaptureJobRepository(ownedClient);
        assert.equal((await owned.cancel(scope, ownedOperation)).status, 'running');
        assert.equal((await owned.failClaim(ownedClaim, 'cancelled')).status, 'cancelled');
      });
    } finally { await jobPool.end(); }
  } finally { await client.end(); }
});
