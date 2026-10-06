import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';

/** Invoked only by the verified disposable PostgreSQL fixture. No live accounts,
 * source provider, user report choices, accepted sections or shared database.
 */
export async function runCustomCohortRecordedGroupOwnerDatabaseChecks({ pool, auth, scope, grant, observationPeriod }) {
  const calls = [], checks = [];
  let loseCommitAck = false, cancelAtHead = null, revokeAtHead = false, denyPolicy = false, denyFinalPolicy = false;
  let policyCalls = 0;
  const suspend = status => pool.query(`UPDATE app_auth.organization_memberships SET status=$3
    WHERE organization_id=$1 AND user_id=$2`, [scope.organization_id, auth.userId, status]);
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), async query(config) {
      calls.push(config.text);
      const result = await client.query(config);
      if (/custom-cohort-group-selection:head-(insert|update)/.test(config.text)) {
        cancelAtHead?.abort(); cancelAtHead = null;
        if (revokeAtHead) { revokeAtHead = false; await suspend('suspended'); }
      }
      if (loseCommitAck && config.text === 'COMMIT') {
        loseCommitAck = false; throw new Error('synthetic lost selection COMMIT acknowledgment');
      }
      return result;
    } };
  } };
  const policy = async () => { policyCalls++; return denyPolicy || (denyFinalPolicy && policyCalls > 1) ? { allowed: false } : grant; };
  const owner = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: policy });
  const identity = { auth, accountId: scope.account_id, assignmentFileId: scope.assignment_file_id };
  const context = await owner.capture({ ...identity, operationId: randomUUID(), observationPeriod });
  const read = { ...identity, contextRef: context.context_ref };
  const catalog = await owner.catalog({ ...read, selection: { revision: 1, pockets: [] },
    catalogVersion: 3, includeRecommendation: true, initialPreviewMode: 'all_catalog_groups' });
  assert.equal(catalog.catalog.catalog_complete, true);
  const ids = catalog.catalog.pockets.map(p => p.id);
  if (catalog.catalog.unassigned.member_count) ids.push('discovery:unassigned');
  assert.ok(ids.length > 0);
  const protectedState = async () => ({
    sections: (await pool.query(`SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s
      WHERE assignment_file_id=$1 ORDER BY section_key`, [scope.assignment_file_id])).rows,
    acceptances: (await pool.query(`SELECT to_jsonb(a) AS value FROM app.custom_neighborhood_acceptances a
      WHERE assignment_file_id=$1 ORDER BY id`, [scope.assignment_file_id])).rows,
    assignment: (await pool.query(`SELECT assignment_details FROM app.assignment_files WHERE id=$1`, [scope.assignment_file_id])).rows,
    report: (await pool.query(`SELECT to_jsonb(r) AS value FROM app.report_files r WHERE id=$1`, [scope.report_file_id])).rows,
  });
  const before = await protectedState();
  assert.equal((await owner.readRecordedGroupSelection(read)).status, 'absent');
  const select = { ...read, operationId: randomUUID(), expectedSelectionRef: null, includedRecordedGroupIds: ids };
  const from = calls.length;
  const first = await owner.selectRecordedGroups(select);
  assert.equal(first.status, 'stored'); assert.equal(first.selection_ref.selection_revision, 1);
  assert.deepEqual((await owner.readRecordedGroupSelection(read)).included_recorded_group_ids, [...ids].sort());
  assert.deepEqual(await owner.selectRecordedGroups(select), { ...first, status: 'reused' });
  assert.ok(!calls.slice(from).some(sql => sql.includes('neighborhood-cohort-blob:read-batch')),
    'prepared selection reads complete catalog/roster without replaying source pages');
  assert.ok(!calls.slice(from).some(sql => sql.includes('compressed_map')),
    'selection persistence must not transfer full geometry');
  checks.push('native server-derived recorded-group selection retains actor intent and exact pages, reopens current head, and reuses lost-ACK operation without source/map replay');

  const emptyInput = { ...select, operationId: randomUUID(), expectedSelectionRef: first.selection_ref, includedRecordedGroupIds: [] };
  loseCommitAck = true;
  await assert.rejects(owner.selectRecordedGroups(emptyInput), error => error.outcome_unknown === true);
  const empty = await owner.selectRecordedGroups(emptyInput);
  assert.equal(empty.status, 'reused'); assert.equal(empty.selection_ref.selection_revision, 2);
  assert.deepEqual((await owner.readRecordedGroupSelection(read)).included_recorded_group_ids, []);
  await assert.rejects(owner.selectRecordedGroups(select), /selection_changed/);
  await assert.rejects(owner.selectRecordedGroups({ ...emptyInput, includedRecordedGroupIds: ids }), /operation_conflict/);
  checks.push('native lost selection COMMIT acknowledgment reopens exactly once; empty stays empty and stale/changed replay cannot rewind or replace');

  const head = async () => (await pool.query(`SELECT selection_revision FROM app.neighborhood_custom_cohort_group_selection_heads
    WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, read.contextRef.context_id])).rows[0].selection_revision;
  const blobs = async () => (await pool.query(`SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=$1`, [scope.organization_id])).rows[0].n;
  const originalCount = await blobs();
  const next = () => ({ ...select, operationId: randomUUID(), expectedSelectionRef: empty.selection_ref });
  const cancelled = new AbortController(); cancelAtHead = cancelled;
  await assert.rejects(owner.selectRecordedGroups(next(), { signal: cancelled.signal }), /cancelled/);
  assert.equal(await head(), 2); assert.equal(await blobs(), originalCount);
  policyCalls = 0; denyFinalPolicy = true;
  try { await assert.rejects(owner.selectRecordedGroups(next()), /market_data_access_denied/); }
  finally { denyFinalPolicy = false; }
  assert.equal(await head(), 2); assert.equal(await blobs(), originalCount);
  revokeAtHead = true;
  try { await assert.rejects(owner.selectRecordedGroups(next()), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.equal(await head(), 2); assert.equal(await blobs(), originalCount);
  checks.push('native cancellation, final source-policy refusal and mid-operation membership revocation roll back staged originals and head together');

  await suspend('suspended');
  const revokedFrom = calls.length;
  try { await assert.rejects(owner.readRecordedGroupSelection(read), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.ok(!calls.slice(revokedFrom).some(sql => sql.includes('blob:') || sql.includes('group-selection:')
    || sql.includes('prepared-catalog:read')), 'revoked actor cannot open cached facts or saved selection');
  denyPolicy = true;
  try { await assert.rejects(owner.readRecordedGroupSelection(read), /market_data_access_denied/); }
  finally { denyPolicy = false; }
  const workfile = (await pool.query(`SELECT status,signed_at::text,updated_at::text FROM app.custom_appraisal_workfiles
    WHERE assignment_file_id=$1`, [scope.assignment_file_id])).rows[0];
  try {
    await pool.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp() WHERE assignment_file_id=$1", [scope.assignment_file_id]);
    await assert.rejects(owner.selectRecordedGroups(next()), /private_source_read_only/);
  } finally {
    await pool.query('UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3,updated_at=$4 WHERE assignment_file_id=$1',
      [scope.assignment_file_id, workfile.status, workfile.signed_at, workfile.updated_at]);
  }
  assert.equal(await head(), 2); assert.equal(await blobs(), originalCount);
  assert.deepEqual(await protectedState(), before);
  checks.push('native saved selection rechecks current actor, source license and signing state while report sections, assignment geometry and acceptances remain byte-identical');
  return { checks };
}
