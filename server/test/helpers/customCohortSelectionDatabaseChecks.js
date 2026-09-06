import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortSubjectRepository } from '../../src/services/neighborhoodAssessment/customCohortSubjectRepository.js';
import { createCustomCohortSelectionRepository } from '../../src/services/neighborhoodAssessment/customCohortSelectionRepository.js';
import { customCohortQueryFixture } from '../fixtures/customCohortRepositoryFixture.js';

// Real PostgreSQL storage/transaction checks; query metadata remains explicitly
// synthetic and must never be described as a genuine licensed acquisition.
export async function checkCustomCohortSelectionDatabase(pool, identity) {
  const scope = { organization_id: identity.scope.organization_id, report_file_id: identity.customReportId,
    assignment_file_id: String(identity.customId), account_id: identity.scope.account_id };
  const scopeJson = JSON.stringify(scope);
  await pool.query(`INSERT INTO app.custom_appraisal_workfiles (assignment_file_id,canonical_file_name)
    VALUES ($1,$2)`, [scope.assignment_file_id, `synthetic-selection-${randomUUID()}`]);
  await pool.query(`UPDATE app.appraisal_subject_snapshots SET subject_data=$2::jsonb WHERE id=$1`,
    [identity.scope.subject_snapshot_id, JSON.stringify({ custom_property_snapshot: { account: { account_id: scope.account_id } } })]);
  const client = await pool.connect();
  let subjectRef, selectionRef, query, original;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8s'");
    const subjects = createCustomCohortSubjectRepository(client, scopeJson);
    const selections = createCustomCohortSelectionRepository(client, scopeJson);
    subjectRef = await subjects.capture();
    const subject = await subjects.load(subjectRef);
    const accountIds = [scope.account_id, ...Array.from({ length: 1000 }, (_, i) => `zz-synthetic-${String(i).padStart(5, '0')}`)];
    query = customCohortQueryFixture(subject, { accountIds });
    selectionRef = await selections.retain(subjectRef, query.inputJson);
    original = await selections.load(selectionRef);
    assert.deepEqual(original.query.evidence, query.bundle);
    assert.equal(original.query.authority, 'not_established');
    assert.deepEqual(await selections.retain(subjectRef, query.inputJson), selectionRef);
    const stored = await client.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [scope.organization_id]);
    assert.equal(stored.rows[0].n, 5 + query.bundle.blobs.length + 1);
    await client.query('COMMIT');

    // A fresh client invocation must actually own a transaction for retention;
    // normal read-only history loading does not manufacture one.
    await assert.rejects(selections.retain(subjectRef, query.inputJson), /caller_transaction_required/);
    assert.deepEqual(await selections.load(selectionRef), original);
    await assert.rejects(createCustomCohortSelectionRepository(client, JSON.stringify({ ...scope, organization_id: randomUUID() })).load(selectionRef), /missing_evidence/);
    await assert.rejects(createCustomCohortSelectionRepository(client, JSON.stringify({ ...scope, account_id: identity.accounts[1] })).load(selectionRef), /not_found/);

    await client.query('BEGIN');
    await client.query(`INSERT INTO app.custom_appraisal_sections (assignment_file_id,section_key,section_value)
      VALUES ($1,'report.property_characteristics','{"main_improvement":{"living_area_sqft":3210}}')`, [scope.assignment_file_id]);
    await client.query("UPDATE app.appraisal_cases SET effective_date='2024-07-01' WHERE id=$1", [identity.scope.appraisal_case_id]);
    await client.query("UPDATE app.custom_appraisal_workfiles SET status='archived' WHERE assignment_file_id=$1", [scope.assignment_file_id]);
    assert.deepEqual(await selections.load(selectionRef), original, 'history must keep original subject inputs and period');
    await client.query('ROLLBACK');

    // A changed selection is an inert alternative. Caller rollback removes its
    // newly retained blobs; the original selection and file remain unchanged.
    await client.query('BEGIN');
    const alternative = customCohortQueryFixture(original.subject, { accountIds: [...accountIds, 'zz-synthetic-extra'] });
    const alternativeRef = await selections.retain(subjectRef, alternative.inputJson);
    assert.notEqual(alternativeRef.content_sha256, selectionRef.content_sha256);
    await client.query('ROLLBACK');
    await assert.rejects(selections.load(alternativeRef), /missing_evidence/);
    assert.deepEqual(await selections.load(selectionRef), original);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const reopened = await pool.connect();
  try {
    assert.deepEqual(await createCustomCohortSelectionRepository(reopened, scopeJson).load(selectionRef), original,
      'committed original inputs survive client release and reopen');
  } finally { reopened.release(); }
}
