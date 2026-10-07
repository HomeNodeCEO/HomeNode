import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Actual current owner, disposable migrated PostgreSQL and real rollback/CAS.
 * Never production choices, source-provider data, Apply or accepted adoption. */
export async function runCustomCohortPreparedSelectionOwnerDatabaseChecks({ pool, owner, identity, read, scope,
  calls, observationPeriod, protectedOther, suspend, denyMembers, denySource, revokeNextRead,
  cancelNextHead, revokeNextHead, loseNextCommit, failNextHistory }) {
  const checks = [], protectedBefore = await protectedOther();
  const workspace = async () => (await pool.query(`SELECT revision,section_value FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [scope.assignment_file_id])).rows[0];
  const state = async () => ({ workspace: await workspace(),
    heads: (await pool.query(`SELECT context_id,selection_revision FROM app.neighborhood_custom_cohort_group_selection_heads
      WHERE organization_id=$1 ORDER BY context_id`, [scope.organization_id])).rows,
    revisions: (await pool.query(`SELECT context_id,selection_revision,operation_id,request_sha256 FROM app.neighborhood_custom_cohort_group_selections
      WHERE organization_id=$1 ORDER BY context_id,selection_revision`, [scope.organization_id])).rows,
    history: (await pool.query(`SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_section_history
      WHERE assignment_file_id=$1`, [scope.assignment_file_id])).rows[0].n,
    blobs: (await pool.query(`SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1`,
      [scope.organization_id])).rows[0].n });
  const old = await owner.readRecordedGroupSelection(read), original = await state(), from = calls.length;
  const opened = await owner.readPreparedRecordedGroupSelection(read);
  assert.deepEqual(opened, old); assert.equal(opened.authority, 'not_established');
  assert.equal(Object.hasOwn(opened, 'account_ids'), false); assert.equal(Object.hasOwn(opened, 'summary'), false);
  assert.deepEqual(await state(), original);
  assert.ok(!calls.slice(from).some(sql => /registry:(originals|pins|insert)|membership:insert|prepared-(catalog|preview):read/.test(sql)),
    'native prepared reader verifies originals and current head without replaying dense catalog/roster input');
  for (const final of [false, true]) {
    denyMembers(true, final);
    try { await assert.rejects(owner.readPreparedRecordedGroupSelection(read), /market_data_access_denied/); }
    finally { denyMembers(false); }
  }
  revokeNextRead();
  try { await assert.rejects(owner.readPreparedRecordedGroupSelection(read), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  for (const change of [{ accountId: 'FOREIGN' }, { assignmentFileId: '9223372036854775807' },
    { contextRef: { ...read.contextRef, context_id: randomUUID() } }, { witnessRef: {} }, { retainedSelection: {} }])
    await assert.rejects(owner.readPreparedRecordedGroupSelection({ ...read, ...change }));
  assert.deepEqual(await state(), original); assert.deepEqual(await protectedOther(), protectedBefore);
  checks.push('native current-owner retained selection reopening verifies exact legacy-v2 originals and actual selected pages/head without dense replay, independently fences initial/ending catalog/member grants and fresh DB roles, and refuses caller roots/foreign targets without report changes');

  const prior = await workspace(), pending = { operation_id: randomUUID(), observation_period: observationPeriod };
  const started = await owner.startRecordedGroupCapture({ ...identity, expectedWorkspaceRevision: prior.revision,
    expectedWorkspaceCheckpoint: prior.section_value, pendingCapture: pending });
  const captured = await owner.capture({ ...identity, operationId: pending.operation_id, observationPeriod });
  const nextRead = { ...identity, contextRef: captured.context_ref };
  // Capture registration alone does not publish the subdivision catalog.
  // The installed owner writes the neutral catalog only for a recommended
  // catalog request, and writes the neutral indexed preview from an opening.
  // A catalog-only presentation intentionally publishes neither derivative.
  // Exercise that actual opening before supplemental membership preparation;
  // never let a selection command fill this cache miss.
  const catalog = await owner.catalog({ ...nextRead, selection: { revision: 1, pockets: [] }, catalogVersion: 3,
    includeRecommendation: true, initialPreviewMode: 'all_catalog_groups' });
  assert.equal(catalog.catalog.catalog_complete, true);
  const originals = (await pool.query(`SELECT
    (SELECT count(*)::int FROM app.neighborhood_custom_cohort_prepared_catalogs
      WHERE organization_id=$1 AND context_id=$2 AND context_sha256=$3 AND catalog_version=3 AND format_version IN (1,2)) AS catalogs,
    (SELECT count(*)::int FROM app.neighborhood_custom_cohort_prepared_previews
      WHERE organization_id=$1 AND context_id=$2 AND context_sha256=$3 AND format_version=1) AS previews`,
  [scope.organization_id, nextRead.contextRef.context_id, nextRead.contextRef.context_sha256])).rows[0];
  assert.ok(originals.catalogs > 0 && originals.previews === 1,
    'actual opening must retain both original neutral catalog and indexed preview before supplemental preparation');
  const finish = { ...nextRead, operationId: randomUUID(), expectedSelectionRef: null,
    expectedWorkspaceRevision: started.workspace.revision, expectedWorkspaceCheckpoint: started.workspace.value,
    includedRecordedGroupIds: [] };
  const unprepared = await state(), missFrom = calls.length;
  await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), /membership_not_prepared/);
  assert.deepEqual(await state(), unprepared);
  assert.ok(!calls.slice(missFrom).some(sql => /registry:(originals|pins|insert)|membership:insert|prepared-(catalog|preview):read/.test(sql)),
    'prepared command cache miss never compiles a dense fallback or silently creates roots');
  assert.equal((await owner.prepareRecordedCatalogMembership(nextRead)).status, 'prepared');
  const whole = await owner.reopenPreparedRecordedCatalogMembership(nextRead);
  finish.includedRecordedGroupIds = JSON.parse(whole.membership.metadata_json).groups.map(g => g.id);
  const ready = await state();
  for (const final of [false, true]) {
    denyMembers(true, final);
    try { await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), /market_data_access_denied/); }
    finally { denyMembers(false); }
    assert.deepEqual(await state(), ready, 'member-purpose refusal rolls provisional selected graph/head/workspace/history back');
  }
  denySource(true, true);
  try { await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), /market_data_access_denied/); }
  finally { denySource(false); }
  assert.deepEqual(await state(), ready);
  const canceled = new AbortController(); cancelNextHead(canceled);
  await assert.rejects(owner.completePreparedRecordedGroupCapture(finish, { signal: canceled.signal }), /cancelled/);
  assert.deepEqual(await state(), ready);
  revokeNextHead();
  try { await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.deepEqual(await state(), ready);
  failNextHistory();
  await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), /history write acknowledgment failure/);
  assert.deepEqual(await state(), ready);
  const workfile = (await pool.query(`SELECT status,signed_at::text,updated_at::text FROM app.custom_appraisal_workfiles
    WHERE assignment_file_id=$1`, [scope.assignment_file_id])).rows[0];
  try {
    await pool.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp() WHERE assignment_file_id=$1", [scope.assignment_file_id]);
    await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), /private_source_read_only/);
  } finally { await pool.query('UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3,updated_at=$4 WHERE assignment_file_id=$1',
    [scope.assignment_file_id, workfile.status, workfile.signed_at, workfile.updated_at]); }
  assert.deepEqual(await state(), ready);
  checks.push('native prepared V7 completion refuses unprepared membership without dense fallback, independently rechecks current source grants/subject/DB roles, rejects signed writes, and rolls original pages/head/workspace/history back after real head cancellation, role revocation or history failure');

  loseNextCommit();
  await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), error => error.outcome_unknown === true);
  const committed = await state(), finished = await owner.completePreparedRecordedGroupCapture(finish);
  assert.equal(finished.status, 'reused'); assert.deepEqual(await state(), committed);
  assert.equal(finished.workspace.revision, started.workspace.revision + 1);
  assert.deepEqual(finished.workspace.value.active.context_ref, nextRead.contextRef);
  assert.deepEqual(finished.workspace.value.active.selection_ref, finished.selection_ref);
  assert.equal(finished.workspace.value.pending_capture, null);
  const fresh = await owner.readPreparedRecordedGroupSelection(nextRead);
  assert.deepEqual(fresh.selection_ref, finished.selection_ref);
  assert.deepEqual((await owner.readRecordedGroupSelection(nextRead)).selection_ref, finished.selection_ref,
    'unchanged dense v2 verifier independently reopens the exact prepared command-v3 identity');
  const next = { ...nextRead, operationId: randomUUID(), expectedSelectionRef: finished.selection_ref,
    expectedWorkspaceRevision: finished.workspace.revision, includedRecordedGroupIds: [] };
  const saveFrom = calls.length;
  const empty = await owner.selectAndSavePreparedRecordedGroups(next);
  assert.equal(empty.status, 'stored'); assert.deepEqual(empty.included_recorded_group_ids, []);
  assert.deepEqual(empty.workspace.value.active.selection_ref, empty.selection_ref);
  assert.deepEqual((await owner.readPreparedRecordedGroupSelection(nextRead)).included_recorded_group_ids, []);
  assert.ok(!calls.slice(saveFrom).some(sql => /registry:(originals|pins|insert)|membership:insert|prepared-(catalog|preview):read/.test(sql)));
  const afterEmpty = await state();
  await assert.rejects(owner.completePreparedRecordedGroupCapture(finish), /revision_changed/);
  await assert.rejects(owner.selectPreparedRecordedGroups({ ...nextRead, operationId: randomUUID(),
    expectedSelectionRef: empty.selection_ref, includedRecordedGroupIds: [] }), /selection_workspace_workflow_required/);
  assert.deepEqual(await state(), afterEmpty); assert.deepEqual(await protectedOther(), protectedBefore);
  checks.push('native prepared command-v3 completion commits one coherent head/workspace, exact lost COMMIT acknowledgment retry adds no history or revision, fresh readers and the old verifier agree, explicit empty is empty, and stale/legacy writes cannot rewind or detach V7 choices');
  return { checks };
}
