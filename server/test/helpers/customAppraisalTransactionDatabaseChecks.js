import assert from 'node:assert/strict';
import {
  ensureCustomAppraisalWorkfileSchema,
  getCustomAppraisalWorkfile,
  saveCustomAppraisalWorkfileSectionInTransaction,
} from '../../src/services/customAppraisalWorkfiles.js';

// Called only by the isolated native test harness, using its real synthetic
// assignment identity. This does not exercise or claim neighborhood acceptance.
export async function checkCustomAppraisalTransactionDatabase(pool, identity) {
  await ensureCustomAppraisalWorkfileSchema(pool);
  const assignmentFileId = identity.customId;
  const accountId = identity.scope.account_id;
  const sectionKey = 'neighborhood_characteristics';
  const input = { accountId, assignmentFileId, sectionKey, expectedRevision: 0,
    sectionValue: { synthetic_group: { boundary: 'A', cohort: ['synthetic'], statistics: { count: 1 } } },
    saveReason: 'manual_save', reviewer: 'Synthetic transaction reviewer' };
  const state = async () => (await pool.query(`
    SELECT w.status,w.updated_at::text AS workfile_updated,a.updated_at::text AS assignment_updated,
      (SELECT count(*)::int FROM app.custom_appraisal_workfile_sections s
        WHERE s.assignment_file_id=w.assignment_file_id) AS sections,
      (SELECT count(*)::int FROM app.custom_appraisal_workfile_section_history h
        WHERE h.assignment_file_id=w.assignment_file_id) AS history
    FROM app.custom_appraisal_workfiles w JOIN app.assignment_files a ON a.id=w.assignment_file_id
    WHERE w.assignment_file_id=$1`, [assignmentFileId])).rows[0];
  const original = await state();
  assert.ok(original);
  assert.equal(original.sections, 0);
  assert.equal(original.history, 0);
  const client = await pool.connect();
  const contender = await pool.connect();
  try {
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(client, input),
      error => error.code === '25P01', 'autocommit use must fail at SAVEPOINT before writes');
    assert.deepEqual(await state(), original);

    await client.query('BEGIN');
    const pending = await saveCustomAppraisalWorkfileSectionInTransaction(client, input);
    assert.equal(pending.revision, 1);
    assert.deepEqual(pending.value, input.sectionValue);
    assert.deepEqual(await state(), original, 'other connections cannot see uncommitted values/history');
    // A real SQL failure after saving models failure of a later audit/acceptance
    // write. The owner, not the helper, must abort the entire operation.
    await assert.rejects(client.query('SELECT 1/0'), error => error.code === '22012');
    await client.query('ROLLBACK');
    assert.deepEqual(await state(), original, 'late failure must leave all values/history/timestamps unchanged');

    await client.query('BEGIN');
    const saved = await saveCustomAppraisalWorkfileSectionInTransaction(client, input);
    await client.query('COMMIT');
    assert.equal((await client.query('SELECT 1 AS usable')).rows[0].usable, 1,
      'the caller retains its usable connection');
    const committed = await state();
    assert.equal(committed.sections, 1);
    assert.equal(committed.history, 1);
    const reopened = await getCustomAppraisalWorkfile(pool, { accountId, assignmentFileId });
    assert.deepEqual(reopened.sections[sectionKey].value, input.sectionValue);
    assert.equal(reopened.sections[sectionKey].revision, saved.revision);

    await client.query('BEGIN');
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(client, input),
      error => error.message === 'custom_appraisal_section_revision_conflict' && error.currentRevision === 1);
    await client.query('ROLLBACK');
    assert.deepEqual(await state(), committed);

    await client.query('BEGIN');
    const changed = { ...input, expectedRevision: 1, sectionValue: { synthetic_group: { boundary: 'B' } } };
    await saveCustomAppraisalWorkfileSectionInTransaction(client, changed);
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(client, changed),
      /custom_appraisal_section_revision_conflict/);
    await client.query('ROLLBACK');
    assert.deepEqual(await state(), committed, 'a second failure cannot leave a partial multi-save operation');

    await client.query('BEGIN');
    await saveCustomAppraisalWorkfileSectionInTransaction(client, changed);
    await contender.query('BEGIN');
    await contender.query("SET LOCAL lock_timeout='200ms'");
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(contender, changed),
      error => error.code === '55P03', 'the existing workfile row lock must serialize competing saves');
    await contender.query('ROLLBACK');
    await client.query('ROLLBACK');
    assert.deepEqual(await state(), committed);

    await client.query('BEGIN');
    await client.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=now() WHERE assignment_file_id=$1",
      [assignmentFileId]);
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(client, changed),
      /custom_appraisal_workfile_signed/);
    await client.query('ROLLBACK');
    assert.deepEqual(await state(), committed);

    await client.query('BEGIN');
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(client,
      { ...changed, accountId: 'unrelated-synthetic-account' }), /assignment_file_not_found/);
    await client.query('ROLLBACK');
    assert.deepEqual(await state(), committed);
    assert.deepEqual((await getCustomAppraisalWorkfile(pool, { accountId, assignmentFileId }))
      .sections[sectionKey].value, input.sectionValue);
    return { status: 'passed', checks: ['explicit_transaction_required', 'uncommitted_invisible',
      'late_failure_rolls_back_all', 'commit_and_reopen', 'stale_revision', 'multi_save_rollback',
      'competing_write_lock', 'signed_protection', 'account_scope', 'caller_connection_retained'] };
  } finally {
    try { await contender.query('ROLLBACK'); } catch {}
    try { await client.query('ROLLBACK'); } catch {}
    contender.release();
    client.release();
  }
}
