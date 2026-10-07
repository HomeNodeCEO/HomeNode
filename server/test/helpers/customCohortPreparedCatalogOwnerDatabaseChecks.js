import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { prepareCustomCohortPreparedCatalogRequest as request, presentCustomCohortPreparedCatalogResponse as present }
  from '../../src/services/neighborhoodAssessment/customCohortPreparedCatalogTransport.js';

/** Invoked from the actual current-owner fixture after a real capture/catalog.
 * Guarded disposable migrated PostgreSQL only. No fake source compiler,
 * injected owner authorization, live file, worker or production activation. */
export async function runCustomCohortPreparedCatalogOwnerDatabaseChecks({ pool, owner, read, scope, calls,
  protectedState, suspend, denySource, revokeNextRead, cancelNextRead, loseNextRegistryAck }) {
  const before = await protectedState(), checks = [];
  const retained = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM app.neighborhood_custom_cohort_prepared_catalog_roots WHERE organization_id=$1) AS roots,
    (SELECT count(*)::int FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1) AS blobs,
    (SELECT count(*)::int FROM app.neighborhood_custom_cohort_group_selection_heads WHERE organization_id=$1) AS heads`,
  [scope.organization_id])).rows[0];
  const original = await retained(), first = calls.length;
  const missing = await owner.openPreparedRecordedCatalog(read);
  assert.equal(missing.status, 'not_prepared'); assert.equal(missing.catalog, null);
  assert.ok(!calls.slice(first).some(sql => /registry:(originals|pins|insert)|prepared-(catalog|preview):read|blob:read-batch/.test(sql)));
  assert.deepEqual(await retained(), original); assert.deepEqual(await protectedState(), before);

  denySource(true);
  const deniedFrom = calls.length;
  try { await assert.rejects(owner.prepareRecordedCatalog(read), /market_data_access_denied/); }
  finally { denySource(false); }
  assert.ok(!calls.slice(deniedFrom).some(sql => sql.includes('prepared-catalog-registry:')));
  loseNextRegistryAck();
  await assert.rejects(owner.prepareRecordedCatalog(read), /synthetic_registry_ack_failure/);
  assert.deepEqual(await retained(), original, 'actual roots and all staged originals roll back after lost insert ACK');
  revokeNextRead();
  try { await assert.rejects(owner.prepareRecordedCatalog(read), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.deepEqual(await retained(), original, 'fresh ending DB role denial rolls back real preparation');
  const controller = new AbortController(); cancelNextRead(controller);
  await assert.rejects(owner.prepareRecordedCatalog(read, { signal: controller.signal }), /cancelled/);
  assert.deepEqual(await retained(), original);
  assert.equal((await owner.prepareRecordedCatalog(read)).status, 'prepared');
  assert.equal((await owner.prepareRecordedCatalog(read)).status, 'reused');
  const saved = await retained(); assert.equal(saved.roots, original.roots + 1);
  checks.push('native prepared catalog owner verifies current original-context rights, rolls staged roots/pages back on lost ACK, cancellation and ending DB role revocation, then atomically commits one reusable derivative');

  const from = calls.length, directory = await owner.openPreparedRecordedCatalog(read);
  const body = request({ assignment_file_id: read.assignmentFileId, context_ref: read.contextRef });
  assert.deepEqual(present(directory, body, read.accountId), directory);
  const root = JSON.parse(directory.catalog.manifest_json), metadata = JSON.parse(directory.catalog.metadata_json);
  let groups = 0;
  for (let index = 0; index < root.pages.length; index++) {
    const page = await owner.pagePreparedRecordedCatalog({ ...read, pageIndex: index });
    assert.deepEqual(present(page, request({ ...body, page_index: index }, true), read.accountId, true), page);
    groups += JSON.parse(page.catalog.page_json).groups.length;
  }
  assert.equal(groups, metadata.group_count);
  assert.ok(!calls.slice(from).some(sql => /registry:(originals|pins|insert)|prepared-(catalog|preview):read|blob:read-batch/.test(sql)),
    'authenticated reopens read only bounded metadata/derivatives and source SQL pins, not dense source/preview/member arrays');
  assert.ok(!JSON.stringify(directory).includes('"account_ids":'));
  assert.deepEqual(await retained(), saved); assert.deepEqual(await protectedState(), before);

  const application = express(); application.use((req, _res, next) => { req.mobileAuth = read.auth; next(); });
  application.use(createCustomNeighborhoodCohortRouter({ cohortService: owner, preparedRecordedCatalogReads: true, logger: {} }));
  const server = await new Promise(resolve => { const s = application.listen(0, '127.0.0.1', () => resolve(s)); });
  const post = (action, data) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/${encodeURIComponent(read.accountId)}/neighborhood-cohort/${action}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15_000) });
  try {
    const opened = await post('prepared-catalog', body);
    assert.equal(opened.status, 200); assert.equal(opened.headers.get('cache-control'), 'no-store'); assert.deepEqual(await opened.json(), directory);
    const paged = await post('prepared-catalog-page', { ...body, page_index: 0 });
    assert.equal(paged.status, 200); assert.deepEqual(await paged.json(), await owner.pagePreparedRecordedCatalog({ ...read, pageIndex: 0 }));
    denySource(true);
    try { const denied = await post('prepared-catalog', body); assert.equal(denied.status, 403);
      assert.deepEqual(await denied.json(), { error: 'neighborhood_access_denied' }); } finally { denySource(false); }
    assert.equal((await post('prepared-catalog', { ...body, account_ids: [] })).status, 400);
    assert.equal((await post('prepare-recorded-catalog', body)).status, 404);
  } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
  assert.deepEqual(await retained(), saved); assert.deepEqual(await protectedState(), before);
  checks.push('native optional HTTP directory/page commands use actual current authenticated owner, no-store/closed envelopes, and reject source denial and member injection; preparation remains unmounted');

  // Suspended membership and removed current role must defeat stale request
  // claims; fresh DB role loading is tested, not a mocked executor grant.
  await suspend('suspended');
  try { await assert.rejects(owner.openPreparedRecordedCatalog(read), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  await pool.query("DELETE FROM app_auth.membership_roles WHERE organization_id=$1 AND user_id=$2 AND role_code='appraiser'",
    [scope.organization_id, read.auth.userId]);
  try { await assert.rejects(owner.openPreparedRecordedCatalog(read), /job_actor_access_revoked/); }
  finally { await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')",
    [scope.organization_id, read.auth.userId]); }
  denySource(true, true);
  try { await assert.rejects(owner.openPreparedRecordedCatalog(read), /market_data_access_denied/); }
  finally { denySource(false); }
  revokeNextRead();
  try { await assert.rejects(owner.pagePreparedRecordedCatalog({ ...read, pageIndex: 0 }), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  for (const change of [{ accountId: 'FOREIGN' }, { assignmentFileId: '9223372036854775807' },
    { contextRef: { ...read.contextRef, context_id: randomUUID() } },
    { contextRef: { ...read.contextRef, context_sha256: '0'.repeat(64) } }])
    await assert.rejects(owner.openPreparedRecordedCatalog({ ...read, ...change }));
  assert.deepEqual(await retained(), saved); assert.deepEqual(await protectedState(), before);
  checks.push('native directory/all pages pass closed transport with no dense-source replay, preserve report/acceptance/selection state, and reject initial/ending source denial, revoked current roles/membership and foreign targets despite stale request claims');
  return { checks };
}
