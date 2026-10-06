import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomNeighborhoodCohortRouter } from '../../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { runCustomCohortPreparedViewportTileJob } from '../../src/services/neighborhoodAssessment/customCohortPreparedViewportTileJob.js';

/** Invoked only by the verified disposable PostgreSQL fixture. No live accounts,
 * source provider, user report choices, accepted sections or shared database.
 */
export async function runCustomCohortRecordedGroupOwnerDatabaseChecks({ pool, auth, scope, grant, observationPeriod }) {
  const calls = [], checks = [];
  let loseCommitAck = false, cancelAtHead = null, revokeAtHead = false, revokeAtRead = false;
  let denyPolicy = false, denyFinalPolicy = false, denySummary = false, denyFinalSummary = false;
  let policyCalls = 0, summaryPolicyCalls = 0, pauseAtWorkfile = null, missPreparedCatalog = false;
  const suspend = status => pool.query(`UPDATE app_auth.organization_memberships SET status=$3
    WHERE organization_id=$1 AND user_id=$2`, [scope.organization_id, auth.userId, status]);
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), async query(config) {
      calls.push(config.text);
      const result = await client.query(config);
      // Inject only a cache-miss boundary after the real SQL query. All fallback
      // context/source/membership rows are read from actual PostgreSQL originals;
      // immutable cache/source/history triggers remain enabled and untouched.
      if (missPreparedCatalog && config.text.includes('custom-cohort-prepared-catalog:read')) {
        assert.equal(result.rowCount, 1, 'miss witness must hide a real prepared row, not start vacuously absent');
        return { rowCount: 0, rows: [] };
      }
      if (config.text.includes('custom-cohort-capture:private-workfile') && pauseAtWorkfile) {
        const pause = pauseAtWorkfile; pauseAtWorkfile = null;
        pause.entered(config.text); await pause.release;
      }
      if (/custom-cohort-group-selection:head-(insert|update)/.test(config.text)) {
        cancelAtHead?.abort(); cancelAtHead = null;
        if (revokeAtHead) { revokeAtHead = false; await suspend('suspended'); }
      }
      if (revokeAtRead && config.text.includes('/* custom-cohort-group-selection:head */')) {
        revokeAtRead = false; await suspend('suspended');
      }
      if (loseCommitAck && config.text === 'COMMIT') {
        loseCommitAck = false; throw new Error('synthetic lost selection COMMIT acknowledgment');
      }
      return result;
    } };
  } };
  const policy = async (_client, _auth, _context, _purpose, { exposure }) => {
    policyCalls++;
    if (exposure === 'report_observation_summary') summaryPolicyCalls++;
    return denyPolicy || (denyFinalPolicy && policyCalls > 1)
      || (exposure === 'report_observation_summary' && (denySummary || (denyFinalSummary && summaryPolicyCalls > 1)))
      ? { allowed: false } : grant;
  };
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
  let entered, release;
  const holding = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  pauseAtWorkfile = { entered, release: released };
  const firstRead = owner.readRecordedGroupSelection(read);
  // Keep rejection handled even when the bounded gate itself fails.
  firstRead.catch(() => {});
  let gateTimer;
  try {
    const heldSql = await Promise.race([holding, new Promise((_, reject) => {
      gateTimer = setTimeout(() => reject(new Error('native reader did not hold workfile')), 3000);
    })]);
    assert.match(heldSql, /FOR UPDATE NOWAIT/);
    const competitorFrom = calls.length;
    await assert.rejects(owner.readRecordedGroupSelection(read), error => error.code === '55P03');
    assert.ok(!calls.slice(competitorFrom).some(sql => /custom-cohort-subject:assignment|prepared-catalog:read|group-selection:head/.test(sql)),
      'competing reader must refuse at the first parent lock, before subject-lock upgrade or cached facts');
  } finally { clearTimeout(gateTimer); pauseAtWorkfile = null; release(); }
  assert.equal((await firstRead).status, 'absent', 'first native reader must complete after the competing reader refuses');
  assert.equal((await owner.readRecordedGroupSelection(read)).status, 'absent', 'a later normal read succeeds after the lock is released');
  assert.deepEqual(await protectedState(), before);
  checks.push('actual concurrent owner reads serialize at the first workfile UPDATE NOWAIT lock; the loser refuses before facts and the original reader completes without a SHARE-to-UPDATE upgrade');
  const select = { ...read, operationId: randomUUID(), expectedSelectionRef: null, includedRecordedGroupIds: ids };
  const from = calls.length;
  const first = await owner.selectRecordedGroups(select);
  assert.equal(first.status, 'stored'); assert.equal(first.selection_ref.selection_revision, 1);
  assert.deepEqual((await owner.readRecordedGroupSelection(read)).included_recorded_group_ids, [...ids].sort());
  assert.deepEqual(await owner.selectRecordedGroups(select), { ...first, status: 'reused' });
  const summary = await owner.previewRecordedGroupSelection({ ...read, selectionRef: first.selection_ref });
  assert.deepEqual(summary.selection_ref, first.selection_ref);
  assert.deepEqual(summary.summary, catalog.initial_preview.summary,
    'server-owned exact population must match the original whole-union summary, including medians/CODs and dates');
  assert.equal(summary.authority, 'not_established'); assert.equal(summary.apply.status, 'blocked');
  assert.equal(Object.hasOwn(summary, 'account_ids'), false);
  assert.equal(summary.parcel_map.status, 'omitted');
  assert.ok(!calls.slice(from).some(sql => sql.includes('neighborhood-cohort-blob:read-batch')),
    'prepared selection reads complete catalog/roster without replaying source pages');
  assert.ok(!calls.slice(from).some(sql => sql.includes('compressed_map')),
    'selection persistence must not transfer full geometry');
  checks.push('native server-derived recorded-group selection retains actor intent and exact pages, reopens current head, and reuses lost-ACK operation without source/map replay');

  const cacheKey = [scope.organization_id, read.contextRef.context_id];
  const cacheSnapshot = async () => (await pool.query(`SELECT selection_revision,operation_id,request_sha256,
    selection_sha256,manifest_content_sha256,manifest_canonical_utf8_bytes
    FROM app.neighborhood_custom_cohort_group_selections WHERE organization_id=$1 AND context_id=$2
    ORDER BY selection_revision`, cacheKey)).rows;
  const selectionsBefore = await cacheSnapshot();
  const fallbackFrom = calls.length;
  missPreparedCatalog = true;
  try {
    assert.deepEqual((await owner.readRecordedGroupSelection(read)).selection_ref, first.selection_ref);
    assert.deepEqual(await owner.selectRecordedGroups(select), { ...first, status: 'reused' });
    assert.deepEqual(await cacheSnapshot(), selectionsBefore, 'fallback must not rewrite retained selection history');
    assert.ok(calls.slice(fallbackFrom).some(sql => sql.includes('neighborhood-cohort-blob:read-batch')),
      'fallback witness must open actual complete retained source rows, not reuse cached presentation');
  } finally { missPreparedCatalog = false; }
  assert.deepEqual(await protectedState(), before);
  checks.push('native owner reopens and replays the same complete selection through real original-row fallback after an injected cache miss; immutable triggers/history/report data remain unchanged');

  const emptyInput = { ...select, operationId: randomUUID(), expectedSelectionRef: first.selection_ref, includedRecordedGroupIds: [] };
  loseCommitAck = true;
  await assert.rejects(owner.selectRecordedGroups(emptyInput), error => error.outcome_unknown === true);
  const empty = await owner.selectRecordedGroups(emptyInput);
  assert.equal(empty.status, 'reused'); assert.equal(empty.selection_ref.selection_revision, 2);
  assert.deepEqual((await owner.readRecordedGroupSelection(read)).included_recorded_group_ids, []);
  const emptySummary = await owner.previewRecordedGroupSelection({ ...read, selectionRef: empty.selection_ref });
  const emptyLegacy = await owner.present({ ...read, selection: { revision: 2, pockets: [] } }, { includeMap: false });
  assert.deepEqual(emptySummary.summary, emptyLegacy.summary);
  assert.equal(emptySummary.summary.selected.account_count, 0);
  await assert.rejects(owner.previewRecordedGroupSelection({ ...read, selectionRef: first.selection_ref }), /selection_changed/);
  await assert.rejects(owner.selectRecordedGroups(select), /selection_changed/);
  await assert.rejects(owner.selectRecordedGroups({ ...emptyInput, includedRecordedGroupIds: ids }), /operation_conflict/);
  checks.push('native lost selection COMMIT acknowledgment reopens exactly once; empty stays empty and stale/changed replay cannot rewind or replace');

  const head = async () => (await pool.query(`SELECT selection_revision FROM app.neighborhood_custom_cohort_group_selection_heads
    WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, read.contextRef.context_id])).rows[0].selection_revision;
  const blobs = async () => (await pool.query(`SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=$1`, [scope.organization_id])).rows[0].n;
  const originalCount = await blobs();
  denySummary = true;
  const summaryDeniedFrom = calls.length;
  try { await assert.rejects(owner.previewRecordedGroupSelection({ ...read, selectionRef: empty.selection_ref }), /market_data_access_denied/); }
  finally { denySummary = false; }
  assert.ok(!calls.slice(summaryDeniedFrom).some(sql => sql.includes('prepared-catalog:read')
    || sql.includes('prepared-preview:read') || sql.includes('custom-cohort-group-selection:head')),
  'catalog access alone cannot open prepared numeric facts or selection originals under denied summary rights');
  summaryPolicyCalls = 0; denyFinalSummary = true;
  try { await assert.rejects(owner.previewRecordedGroupSelection({ ...read, selectionRef: empty.selection_ref }), /market_data_access_denied/); }
  finally { denyFinalSummary = false; }
  assert.ok(summaryPolicyCalls >= 2, 'summary exposure is separately fenced again before delivery');
  revokeAtRead = true;
  try { await assert.rejects(owner.previewRecordedGroupSelection({ ...read, selectionRef: empty.selection_ref }), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.equal(await head(), 2); assert.equal(await blobs(), originalCount);
  checks.push('native exact-reference summary matches complete original medians/CODs/dates, preserves explicit empty, rejects stale references and separately checks initial/final summary rights and current actor before delivery');
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
  const application = express();
  application.use((req, _res, next) => { req.mobileAuth = auth; next(); });
  application.use(createCustomNeighborhoodCohortRouter({ cohortService: owner, logger: {} }));
  const server = await new Promise(resolve => { const s = application.listen(0, '127.0.0.1', () => resolve(s)); });
  const request = (action, body) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/${encodeURIComponent(scope.account_id)}/neighborhood-cohort/${action}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const readBody = { assignment_file_id: scope.assignment_file_id, context_ref: read.contextRef };
  const writeBody = { ...readBody, operation_id: randomUUID(), expected_selection_ref: empty.selection_ref,
    included_recorded_group_ids: [...ids].reverse() };
  // Exact synthetic subject/other parcel window, not an empty ocean viewport.
  const viewport = { west: -96.701, south: 32.799, east: -96.69, north: 32.803 };
  try {
    const reopened = await request('group-selection', readBody);
    assert.equal(reopened.status, 200); assert.equal(reopened.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await reopened.json()).included_recorded_group_ids, []);
    const numericEmpty = await request('selection-preview', { ...readBody, selection_ref: empty.selection_ref });
    assert.equal(numericEmpty.status, 200); assert.equal(numericEmpty.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await numericEmpty.json(), emptySummary);
    const emptyMap = await request('selection-viewport', { ...readBody, selection_ref: empty.selection_ref, viewport });
    assert.equal(emptyMap.status, 200);
    const emptyView = await emptyMap.json();
    assert.deepEqual(emptyView.viewport_map, await owner.viewport({ ...read, selection: { revision: 2, pockets: [] } }, viewport));
    assert.deepEqual(emptyView.selection_ref, empty.selection_ref);
    assert.equal(emptyView.viewport_map.status, 'available');
    assert.ok(emptyView.viewport_map.geojson.features.length > 0, 'empty selection still displays actual captured parcels');
    assert.ok(emptyView.viewport_map.geojson.features.every(f => !f.properties.selected));
    loseCommitAck = true;
    const uncertain = await request('select-groups', writeBody);
    assert.equal(uncertain.status, 409);
    assert.deepEqual(await uncertain.json(), { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true });
    const retry = await request('select-groups', writeBody);
    assert.equal(retry.status, 200);
    const receipt = await retry.json();
    assert.equal(receipt.status, 'reused'); assert.equal(receipt.selection_ref.selection_revision, 3);
    assert.deepEqual(receipt.included_recorded_group_ids, [...ids].sort());
    assert.equal(Object.hasOwn(receipt, 'account_ids'), false);
    assert.equal(Object.hasOwn(receipt, 'catalog'), false);
    const numericBody = { ...readBody, selection_ref: receipt.selection_ref };
    const numeric = await request('selection-preview', numericBody);
    assert.equal(numeric.status, 200);
    assert.deepEqual(await numeric.json(), await owner.previewRecordedGroupSelection({ ...read, selectionRef: receipt.selection_ref }));
    const mapBody = { ...numericBody, viewport };
    const map = await request('selection-viewport', mapBody);
    assert.equal(map.status, 200); assert.equal(map.headers.get('cache-control'), 'no-store');
    const view = await map.json();
    assert.deepEqual(view, await owner.viewportRecordedGroupSelection({ ...read, selectionRef: receipt.selection_ref, viewport }));
    assert.equal(view.viewport_map.selection_sha256, receipt.selection_ref.selection_sha256);
    assert.equal(view.viewport_map.selection_revision, 3);
    assert.equal(Object.hasOwn(view, 'summary'), false);
    assert.equal(Object.hasOwn(view, 'account_ids'), false);
    assert.equal(view.viewport_map.status, 'available');
    assert.ok(view.viewport_map.geojson.features.length > 0);
    assert.ok(view.viewport_map.geojson.features.some(f => f.properties.selected), 'nonempty selection geometry witness cannot be vacuous');
    // Only this verified disposable fixture database: exercise the real bounded
    // offline tile worker before proving the same exact-reference fast read.
    await runCustomCohortPreparedViewportTileJob(pool, { maximumContexts: 100, maximumRuntimeMinutes: 1, logger: {} });
    assert.equal((await pool.query(`SELECT status FROM app.neighborhood_custom_cohort_prepared_tile_manifests
      WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, read.contextRef.context_id])).rows[0]?.status, 'available');
    const tiledFrom = calls.length;
    const tiled = await request('selection-viewport', mapBody);
    assert.equal(tiled.status, 200); assert.deepEqual(await tiled.json(), view);
    assert.ok(calls.slice(tiledFrom).some(sql => sql.includes('custom-cohort-prepared-tiles:read-cells')));
    assert.ok(!calls.slice(tiledFrom).some(sql => (sql.includes('/* custom-cohort-prepared-preview:read */') && sql.includes('compressed_map'))
      || sql.includes('neighborhood-cohort-blob:read-batch')), 'prepared tiled read does not replay full source/map blobs');
    const staleNumeric = await request('selection-preview', { ...readBody, selection_ref: empty.selection_ref });
    assert.equal(staleNumeric.status, 409); assert.deepEqual(await staleNumeric.json(), { error: 'neighborhood_selection_changed' });
    const staleMap = await request('selection-viewport', { ...mapBody, selection_ref: empty.selection_ref });
    assert.equal(staleMap.status, 409); assert.deepEqual(await staleMap.json(), { error: 'neighborhood_selection_changed' });
    const stale = await request('select-groups', { ...writeBody, operation_id: randomUUID() });
    assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { error: 'neighborhood_selection_changed' });
    const invalidFrom = calls.length;
    const injected = await request('select-groups', { ...writeBody, actor_user_id: auth.userId, source_rows: [] });
    assert.equal(injected.status, 400); assert.equal(calls.length, invalidFrom);
    const injectedNumeric = await request('selection-preview', { ...numericBody, account_ids: [] });
    assert.equal(injectedNumeric.status, 400); assert.equal(calls.length, invalidFrom);
    const injectedMap = await request('selection-viewport', { ...mapBody, account_ids: [] });
    assert.equal(injectedMap.status, 400); assert.equal(calls.length, invalidFrom);
    denySummary = true;
    try {
      const denied = await request('selection-preview', numericBody);
      assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'neighborhood_access_denied' });
      const deniedMap = await request('selection-viewport', mapBody);
      assert.equal(deniedMap.status, 403); assert.deepEqual(await deniedMap.json(), { error: 'neighborhood_access_denied' });
    } finally { denySummary = false; }
    summaryPolicyCalls = 0; denyFinalSummary = true;
    try {
      const finalDeniedMap = await request('selection-viewport', mapBody);
      assert.equal(finalDeniedMap.status, 403);
      assert.deepEqual(await finalDeniedMap.json(), { error: 'neighborhood_access_denied' });
    } finally { denyFinalSummary = false; }
    await suspend('suspended');
    try {
      const revoked = await request('group-selection', readBody);
      assert.equal(revoked.status, 403); assert.deepEqual(await revoked.json(), { error: 'neighborhood_access_denied' });
      const revokedNumeric = await request('selection-preview', numericBody);
      assert.equal(revokedNumeric.status, 403); assert.deepEqual(await revokedNumeric.json(), { error: 'neighborhood_access_denied' });
      const revokedMap = await request('selection-viewport', mapBody);
      assert.equal(revokedMap.status, 403); assert.deepEqual(await revokedMap.json(), { error: 'neighborhood_access_denied' });
    } finally { await suspend('active'); }
    denyPolicy = true;
    try {
      const denied = await request('group-selection', readBody);
      assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'neighborhood_access_denied' });
    } finally { denyPolicy = false; }
    assert.equal(await head(), 3); assert.deepEqual(await protectedState(), before);
    checks.push('native authenticated ID-only HTTP save/reopen preserves exact lost-ACK operation, stale/current-role/source fences and unchanged report state');
    checks.push('native exact-reference HTTP numeric summaries preserve complete and empty populations, refuse stale/injected/summary-denied/current-role requests and disclose no geometry or raw member pages');
    checks.push('native exact-reference HTTP viewport has non-vacuous selected/empty geometry and actual offline prepared-tile parity without full source/map replay; stale, injected members and current actor/source refusals leave report state unchanged');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  return { checks };
}
