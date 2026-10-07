import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** Actual current context owner and disposable migrated PostgreSQL. No mock
 * issuer/executor, production target, signature, selection or Apply operation.
 * Catalog-only permission must not disclose whole individual membership. */
export async function runCustomCohortPreparedMembershipOwnerDatabaseChecks({ pool, owner, read, scope, calls,
  protectedState, suspend, expectedAccounts, denyMembers, loseNextMembershipAck,
  cancelNextMembershipInsert, revokeNextMembershipInsert, revokeNextRead }) {
  const checks = [], before = await protectedState();
  const counts = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM app.neighborhood_custom_cohort_prepared_catalog_roots WHERE organization_id=$1) AS roots,
    (SELECT count(*)::int FROM app.neighborhood_custom_cohort_catalog_membership_roots WHERE organization_id=$1) AS members,
    (SELECT count(*)::int FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1) AS blobs,
    (SELECT count(*)::int FROM app.neighborhood_custom_cohort_group_selection_heads WHERE organization_id=$1) AS heads`,
  [scope.organization_id])).rows[0];
  const original = await counts(), from = calls.length;
  assert.equal((await owner.openPreparedRecordedCatalog(read)).status,'available');
  const miss = await owner.reopenPreparedRecordedCatalogMembership(read);
  assert.equal(miss.status,'not_prepared'); assert.equal(miss.membership,null);
  assert.deepEqual(await counts(),original);
  assert.ok(!calls.slice(from).some(sql => /registry:(originals|insert|pins)|membership:insert|blob:insert/.test(sql)));

  denyMembers(true);
  const deniedFrom = calls.length;
  try {
    await assert.rejects(owner.prepareRecordedCatalogMembership(read),/market_data_access_denied/);
    await assert.rejects(owner.reopenPreparedRecordedCatalogMembership(read),/market_data_access_denied/);
    assert.equal((await owner.openPreparedRecordedCatalog(read)).status,'available','display grant does not imply members grant');
  } finally { denyMembers(false); }
  assert.ok(!calls.slice(deniedFrom).some(sql => /prepared-catalog-membership:|registry:(originals|insert)/.test(sql)));
  assert.deepEqual(await counts(),original);
  denyMembers(true,true);
  try { await assert.rejects(owner.prepareRecordedCatalogMembership(read),/market_data_access_denied/); }
  finally { denyMembers(false); }
  assert.deepEqual(await counts(),original,'ending members denial rolls back every new original and root');

  loseNextMembershipAck();
  await assert.rejects(owner.prepareRecordedCatalogMembership(read),/synthetic_membership_ack_failure/);
  assert.deepEqual(await counts(),original,'actual child INSERT lost ACK rolls back the whole graph');
  const controller = new AbortController(); cancelNextMembershipInsert(controller);
  await assert.rejects(owner.prepareRecordedCatalogMembership(read,{ signal:controller.signal }),/cancelled/);
  assert.deepEqual(await counts(),original,'cancellation after actual child INSERT cannot leave a derivative');
  revokeNextMembershipInsert();
  try { await assert.rejects(owner.prepareRecordedCatalogMembership(read),/job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.deepEqual(await counts(),original,'fresh ending DB roles, not stale request roles, fence publication');
  assert.deepEqual(await protectedState(),before);

  const workfile = (await pool.query(`SELECT status,signed_at::text,updated_at::text FROM app.custom_appraisal_workfiles
    WHERE assignment_file_id=$1`,[scope.assignment_file_id])).rows[0];
  try {
    await pool.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp() WHERE assignment_file_id=$1",[scope.assignment_file_id]);
    await assert.rejects(owner.prepareRecordedCatalogMembership(read),/private_source_read_only/);
  } finally {
    await pool.query('UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3,updated_at=$4 WHERE assignment_file_id=$1',
      [scope.assignment_file_id,workfile.status,workfile.signed_at,workfile.updated_at]);
  }
  assert.deepEqual(await counts(),original);
  assert.equal((await owner.prepareRecordedCatalogMembership(read)).status,'prepared');
  assert.equal((await owner.prepareRecordedCatalogMembership(read)).status,'reused');
  const saved = await counts(); assert.equal(saved.roots,original.roots); assert.equal(saved.members,original.members + 1);
  assert.equal(saved.heads,original.heads,'whole membership is never the appraiser-selected head');
  checks.push('native whole membership preparation independently checks catalog and members source grants on both ends, rolls all originals/root bytes back after lost ACK, cancellation or current DB role loss, refuses signed-file preparation and atomically commits a reusable supplemental root');

  const readFrom = calls.length, opened = await owner.reopenPreparedRecordedCatalogMembership(read);
  assert.equal(opened.status,'available'); assert.equal(opened.membership.status,'complete_catalog_membership');
  assert.equal(opened.membership.account_count,expectedAccounts); assert.equal(opened.authority,'not_established');
  assert.equal(Object.hasOwn(opened,'catalog'),false); assert.equal(Object.hasOwn(opened,'selection_ref'),false);
  assert.equal(Object.hasOwn(opened,'summary'),false);
  assert.ok(!calls.slice(readFrom).some(sql => /registry:(originals|insert|pins)|membership:insert|prepared-(catalog|preview):read|blob:read-batch/.test(sql)),
    'fresh current-owner membership read verifies retained originals without dense source replay');
  assert.deepEqual(await counts(),saved); assert.deepEqual(await protectedState(),before);
  denyMembers(true,true);
  try { await assert.rejects(owner.reopenPreparedRecordedCatalogMembership(read),/market_data_access_denied/); }
  finally { denyMembers(false); }
  revokeNextRead();
  try { await assert.rejects(owner.reopenPreparedRecordedCatalogMembership(read),/job_actor_access_revoked/); }
  finally { await suspend('active'); }
  await suspend('suspended');
  try { await assert.rejects(owner.reopenPreparedRecordedCatalogMembership(read),/job_actor_access_revoked/); }
  finally { await suspend('active'); }
  for (const change of [{ accountId:'FOREIGN' },{ assignmentFileId:'9223372036854775807' },
    { contextRef:{ ...read.contextRef,context_id:randomUUID() } },
    { contextRef:{ ...read.contextRef,context_sha256:'0'.repeat(64) } },{ witnessRef:{} },{ projection:'catalog' }])
    await assert.rejects(owner.reopenPreparedRecordedCatalogMembership({ ...read,...change }));
  assert.deepEqual(await counts(),saved); assert.deepEqual(await protectedState(),before);
  checks.push('native whole membership reopens actual complete original pages under fresh current actor/assignment/catalog/member grants without dense replay; cache misses and denied ending policy, current role loss, stale caller roots or foreign targets cannot disclose or alter reports, choices or accepted sections');
  return { checks };
}
