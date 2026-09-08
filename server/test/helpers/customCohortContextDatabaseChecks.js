import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { contextFixture } from '../fixtures/customCohortContextFixture.js';

// Header retention only: synthetic dependency bytes do not establish source
// truth, current authorization, freshness, or fact-issuer authority.
export async function checkCustomCohortContextDatabase(pool, identity) {
  const scope = { organization_id: identity.scope.organization_id, report_file_id: identity.customReportId,
    assignment_file_id: String(identity.customId), account_id: identity.scope.account_id };
  const scopeJson = json(scope), body = contextFixture();
  body.context_id = randomUUID();
  Object.assign(body.target, { organization_id: scope.organization_id, report_file_id: scope.report_file_id,
    workflow_target_id: scope.assignment_file_id, account_id: scope.account_id,
    appraisal_case_id: identity.scope.appraisal_case_id, subject_snapshot_id: identity.scope.subject_snapshot_id });
  const dependencyTexts = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => {
    const text = json({ key, synthetic: true, run_id: body.context_id, retained_text: 'Synthetic Café 🏠' });
    body[key] = { ...prepareNeighborhoodCohortBlob(text) };
    return text;
  });
  const headerJson = json(body), prepared = prepareCustomCohortContextHeader(headerJson);
  const refJson = json(prepared.context_ref), client = await pool.connect();
  const insert = `INSERT INTO app.neighborhood_custom_cohort_contexts
    (organization_id,report_file_id,assignment_file_id,account_id,context_id,context_revision,context_sha256,
      header_content_sha256,header_canonical_utf8_bytes)
    VALUES ($1,$2,$3::bigint,$4,$5,1,$6,$7,$8::integer)`;
  const insertValues = () => [scope.organization_id, scope.report_file_id, scope.assignment_file_id, scope.account_id,
    randomUUID(), prepared.context_ref.context_sha256, prepared.header_blob.ref.content_sha256,
    prepared.header_blob.ref.canonical_utf8_bytes];
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8s'");
    const repo = createCustomCohortContextRepository(client, scopeJson);
    const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
    const rejectsWithinSavepoint = async (operation, expected, message) => {
      await client.query('SAVEPOINT context_rejection');
      try { await assert.rejects(operation, expected, message); }
      finally {
        await client.query('ROLLBACK TO SAVEPOINT context_rejection');
        await client.query('RELEASE SAVEPOINT context_rejection');
      }
    };
    assert.equal(await repo.get(refJson), null);
    await assert.rejects(repo.put(headerJson), /custom_cohort_context_missing_evidence/);
    assert.equal(await blobs.get(prepared.header_blob.ref.content_sha256,
      prepared.header_blob.ref.canonical_utf8_bytes), null, 'missing dependencies must not retain a header');
    for (const text of dependencyTexts) await blobs.put(text);
    assert.deepEqual(await repo.put(headerJson), { status: 'stored', authority: 'not_established', context_ref: prepared.context_ref });
    assert.deepEqual(await repo.get(refJson), prepared);
    assert.deepEqual(await repo.put(headerJson), { status: 'reused', authority: 'not_established', context_ref: prepared.context_ref });
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_contexts
      WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, body.context_id])).rows[0].n, 1);
    const changedJson = json({ ...body, effective_date: '2024-03-01' });
    await rejectsWithinSavepoint(() => repo.put(changedJson), /custom_cohort_context_storage_conflict/);
    await assert.rejects(repo.get(json({ ...prepared.context_ref, context_sha256: '0'.repeat(64) })),
      /custom_cohort_context_storage_conflict/);

    for (const sql of [
      'UPDATE app.neighborhood_custom_cohort_contexts SET context_revision=context_revision WHERE organization_id=$1 AND context_id=$2',
      'DELETE FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND context_id=$2',
      'TRUNCATE app.neighborhood_custom_cohort_contexts',
    ]) {
      await rejectsWithinSavepoint(() => client.query(sql, sql.startsWith('TRUNCATE') ? [] : [scope.organization_id, body.context_id]),
        error => error.code === '55000' && /custom_cohort_context_immutable/.test(error.message));
    }
    assert.deepEqual(await repo.get(refJson), prepared, 'replay and rejected mutations preserve exact retained bytes');

    // Use real existing parent identities so a missing organization/report alone
    // cannot accidentally stand in for the composite tenant/file constraint.
    const otherOrganization = randomUUID(), otherReport = randomUUID();
    await client.query('INSERT INTO app_auth.organizations (id,legal_name,display_name) VALUES ($1,$2,$2)',
      [otherOrganization, 'Synthetic context boundary test']);
    const otherAssignment = (await client.query(`INSERT INTO app.assignment_files
      (organization_id,account_id,file_number,created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING id::text`,
    [scope.organization_id, scope.account_id, `PG-context-${randomUUID()}`, identity.actor_user_id])).rows[0].id;
    await client.query(`INSERT INTO app.report_files
      (id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
      VALUES ($1,$2,$3,'custom_appraisal',$4,$5::bigint,$6,$7)`,
    [otherReport, scope.organization_id, scope.account_id, `PG-context-${randomUUID()}`, otherAssignment,
      identity.scope.appraisal_case_id, identity.scope.subject_snapshot_id]);
    await createNeighborhoodCohortBlobRepository(client, otherOrganization).put(headerJson);
    const otherRepo = createCustomCohortContextRepository(client, json({ ...scope,
      report_file_id: otherReport, assignment_file_id: otherAssignment }));
    assert.equal(await otherRepo.get(refJson), null, 'an existing sibling file cannot read another file context');
    await assert.rejects(otherRepo.put(headerJson), /custom_cohort_context_target_mismatch/);
    await assert.rejects(createCustomCohortContextRepository(client, json({ ...scope,
      organization_id: otherOrganization })).get(refJson), /custom_cohort_context_target_not_found/);
    await assert.rejects(createCustomCohortContextRepository(client, json({ ...scope,
      account_id: identity.accounts[1] })).get(refJson), /custom_cohort_context_target_not_found/);
    for (const [index, value] of [[0, otherOrganization], [1, otherReport], [2, otherAssignment], [3, identity.accounts[1]]]) {
      const values = insertValues(); values[index] = value;
      await rejectsWithinSavepoint(() => client.query(insert, values), error => error.code === '23503',
        `composite context target foreign key must reject mismatched field ${index}`);
    }
    const foreignOnlyHeader = await createNeighborhoodCohortBlobRepository(client, otherOrganization)
      .put(json({ synthetic: true, foreign_only: randomUUID() }));
    const foreignHeaderValues = insertValues();
    foreignHeaderValues[6] = foreignOnlyHeader.content_sha256;
    foreignHeaderValues[7] = foreignOnlyHeader.canonical_utf8_bytes;
    await rejectsWithinSavepoint(() => client.query(insert, foreignHeaderValues), error => error.code === '23503',
      'a header blob from another tenant cannot satisfy the context evidence foreign key');
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }

  const observer = await pool.connect();
  try {
    await observer.query('BEGIN');
    assert.equal(await createCustomCohortContextRepository(observer, scopeJson).get(refJson), null,
      'caller rollback must remove the retained context');
    const blobs = createNeighborhoodCohortBlobRepository(observer, scope.organization_id);
    for (const ref of [prepared.header_blob.ref, ...dependencyTexts.map(prepareNeighborhoodCohortBlob)]) {
      assert.equal(await blobs.get(ref.content_sha256, ref.canonical_utf8_bytes), null,
        'caller rollback must remove header and dependency writes');
    }
  } finally {
    try { await observer.query('ROLLBACK'); } finally { observer.release(); }
  }

  // Commit dependencies first so the two-client conflict is specifically on
  // context identity, not on a shared dependency-blob insert.
  const first = await pool.connect();
  let second;
  try {
    await first.query('BEGIN');
    const blobs = createNeighborhoodCohortBlobRepository(first, scope.organization_id);
    for (const text of dependencyTexts) await blobs.put(text);
    await first.query('COMMIT');
    second = await pool.connect();
    const winnerJson = json({ ...body, context_id: randomUUID() });
    const winner = prepareCustomCohortContextHeader(winnerJson);
    const loserJson = json({ ...winner.body, effective_date: '2024-03-01' });
    const loser = prepareCustomCohortContextHeader(loserJson);
    const firstRepo = createCustomCohortContextRepository(first, scopeJson);
    const secondRepo = createCustomCohortContextRepository(second, scopeJson);
    await first.query('BEGIN');
    await first.query("SET LOCAL statement_timeout='8s'");
    assert.equal((await firstRepo.put(winnerJson)).status, 'stored');
    await second.query('BEGIN');
    await second.query("SET LOCAL statement_timeout='8s'");
    await second.query("SET LOCAL lock_timeout='250ms'");
    await assert.rejects(secondRepo.put(loserJson), error => error.code === '55P03',
      'a second client must contend on the uncommitted context identity');
    await second.query('ROLLBACK');
    await first.query('COMMIT');

    await second.query('BEGIN');
    await second.query("SET LOCAL statement_timeout='8s'");
    await assert.rejects(secondRepo.put(loserJson), /custom_cohort_context_storage_conflict/,
      'after the winner commits, a conflicting header cannot overwrite it');
    assert.deepEqual(await secondRepo.get(json(winner.context_ref)), winner);
    await second.query('ROLLBACK');
    await second.query('BEGIN');
    assert.deepEqual(await secondRepo.put(winnerJson), { status: 'reused', authority: 'not_established', context_ref: winner.context_ref });
    assert.deepEqual(await secondRepo.get(json(winner.context_ref)), winner);
    assert.equal(await createNeighborhoodCohortBlobRepository(second, scope.organization_id)
      .get(loser.header_blob.ref.content_sha256, loser.header_blob.ref.canonical_utf8_bytes), null,
    'rolling back the losing caller must not retain its unreferenced header');
    assert.equal((await second.query(`SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_contexts
      WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, winner.context_ref.context_id])).rows[0].n, 1);
    await second.query('COMMIT');
    await assert.rejects(secondRepo.get(json(winner.context_ref)), /custom_cohort_context_caller_transaction_required/);
    await assert.rejects(secondRepo.put(winnerJson), /custom_cohort_context_caller_transaction_required/);
  } finally {
    try { await first.query('ROLLBACK'); }
    finally {
      first.release();
      if (second) {
        try { await second.query('ROLLBACK'); } finally { second.release(); }
      }
    }
  }
}
