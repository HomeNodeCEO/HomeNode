import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomNeighborhoodCohortRouter } from '../../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { runCustomCohortPreparedViewportTileJob } from '../../src/services/neighborhoodAssessment/customCohortPreparedViewportTileJob.js';
import { customCohortOpeningSelection } from '../../src/services/neighborhoodAssessment/customCohortOpeningPreview.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../../src/services/customAppraisalWorkfiles.js';

/** Invoked only by the verified disposable PostgreSQL fixture. No live accounts,
 * source provider, user report choices, accepted sections or shared database.
 */
export async function runCustomCohortRecordedGroupOwnerDatabaseChecks({ pool, auth, scope, grant, observationPeriod }) {
  const calls = [], checks = [];
  let loseCommitAck = false, cancelAtHead = null, revokeAtHead = false, revokeAtRead = false;
  let cancelAtWorkspace = null, revokeAtWorkspace = false, failWorkspaceHistory = false;
  let denyPolicy = false, denyFinalPolicy = false, denySummary = false, denyFinalSummary = false;
  let denyMembers = false, denyFinalMembers = false;
  let policyCalls = 0, summaryPolicyCalls = 0, memberPolicyCalls = 0;
  const suspend = status => pool.query(`UPDATE app_auth.organization_memberships SET status=$3
    WHERE organization_id=$1 AND user_id=$2`, [scope.organization_id, auth.userId, status]);
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), async query(config) {
      calls.push(config.text);
      const result = await client.query(config);
      if (config.values?.[1] === 'neighborhood_workspace') {
        if (config.text.includes('INSERT INTO app.custom_appraisal_workfile_sections (')) {
          cancelAtWorkspace?.abort(); cancelAtWorkspace = null;
          if (revokeAtWorkspace) { revokeAtWorkspace = false; await suspend('suspended'); }
        }
        if (failWorkspaceHistory && config.text.includes('INSERT INTO app.custom_appraisal_workfile_section_history (')) {
          failWorkspaceHistory = false; throw new Error('synthetic workspace history write acknowledgment failure');
        }
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
    if (exposure === 'report_observation_members') memberPolicyCalls++;
    return denyPolicy || (denyFinalPolicy && policyCalls > 1)
      || (exposure === 'report_observation_summary' && (denySummary || (denyFinalSummary && summaryPolicyCalls > 1)))
      || (exposure === 'report_observation_members' && (denyMembers || (denyFinalMembers && memberPolicyCalls > 1)))
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
    const emptyMembers = await request('selection-members', { ...readBody, selection_ref: empty.selection_ref,
      population: { group: 'selected', kind: 'stock' }, page: { limit: 1, after_member_id: null } });
    assert.equal(emptyMembers.status, 200);
    const emptyPage = await emptyMembers.json();
    assert.equal(emptyPage.page.total_count, 0); assert.deepEqual(emptyPage.page.members, []);
    assert.equal(emptyPage.page.is_full_population, true);
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
    const memberBody = { ...numericBody, population: { group: 'selected', kind: 'stock' }, page: { limit: 1, after_member_id: null } };
    assert.ok(summary.summary.selected.stock.member_count > 1, 'native paging witness includes more than one real captured account');
    for (const group of ['all', 'selected']) for (const kind of ['stock', 'transactions', 'omitted_transactions', 'source_reported']) {
      const population = { group, kind }, body = { ...memberBody, population }, start = calls.length;
      const inspected = await request('selection-members', body);
      assert.equal(inspected.status, 200); assert.equal(inspected.headers.get('cache-control'), 'no-store');
      const actual = await inspected.json();
      const legacy = await owner.inspect({ ...read, selection: customCohortOpeningSelection(catalog.catalog, ids, 3) },
      { population, page: body.page });
      assert.deepEqual(actual.page, legacy.page);
      assert.deepEqual(actual.selection_ref, receipt.selection_ref);
      assert.ok(!calls.slice(start).some(sql => sql.includes('compressed_map')), 'member inspection does not load geometry');
      if (group === 'selected' && kind === 'stock') {
        assert.equal(actual.page.returned_count, 1); assert.equal(actual.page.has_more, true);
        const nextBody = { ...body, page: { limit: 50, after_member_id: actual.page.next_after_member_id } };
        const continued = await request('selection-members', nextBody); assert.equal(continued.status, 200);
        const nextPage = await continued.json(); assert.equal(nextPage.page.start_index, 1);
        assert.equal(nextPage.page.has_more, false);
        assert.notEqual(nextPage.page.members[0].member_id, actual.page.members[0].member_id);
      }
    }
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
    const staleMembers = await request('selection-members', { ...memberBody, selection_ref: empty.selection_ref });
    assert.equal(staleMembers.status, 409); assert.deepEqual(await staleMembers.json(), { error: 'neighborhood_selection_changed' });
    const stale = await request('select-groups', { ...writeBody, operation_id: randomUUID() });
    assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), { error: 'neighborhood_selection_changed' });
    const invalidFrom = calls.length;
    const injected = await request('select-groups', { ...writeBody, actor_user_id: auth.userId, source_rows: [] });
    assert.equal(injected.status, 400); assert.equal(calls.length, invalidFrom);
    const injectedNumeric = await request('selection-preview', { ...numericBody, account_ids: [] });
    assert.equal(injectedNumeric.status, 400); assert.equal(calls.length, invalidFrom);
    const injectedMap = await request('selection-viewport', { ...mapBody, account_ids: [] });
    assert.equal(injectedMap.status, 400); assert.equal(calls.length, invalidFrom);
    const injectedMembers = await request('selection-members', { ...memberBody, account_ids: [] });
    assert.equal(injectedMembers.status, 400); assert.equal(calls.length, invalidFrom);
    const unknownCursor = await request('selection-members', { ...memberBody, page: { limit: 1, after_member_id: `member:${'f'.repeat(64)}` } });
    assert.equal(unknownCursor.status, 400);
    denyMembers = true;
    const memberDeniedFrom = calls.length;
    try {
      const deniedMembers = await request('selection-members', memberBody);
      assert.equal(deniedMembers.status, 403); assert.deepEqual(await deniedMembers.json(), { error: 'neighborhood_access_denied' });
    } finally { denyMembers = false; }
    assert.ok(!calls.slice(memberDeniedFrom).some(sql => sql.includes('prepared-catalog:read')
      || sql.includes('custom-cohort-group-selection:head')), 'catalog rights alone never open member facts');
    memberPolicyCalls = 0; denyFinalMembers = true;
    try {
      const deniedFinalMembers = await request('selection-members', memberBody);
      assert.equal(deniedFinalMembers.status, 403);
    } finally { denyFinalMembers = false; }
    assert.ok(memberPolicyCalls >= 2, 'member exposure is independently repeated before delivery');
    denySummary = true;
    try {
      const denied = await request('selection-preview', numericBody);
      assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'neighborhood_access_denied' });
      const deniedMap = await request('selection-viewport', mapBody);
      assert.equal(deniedMap.status, 403); assert.deepEqual(await deniedMap.json(), { error: 'neighborhood_access_denied' });
      assert.equal((await request('selection-members', memberBody)).status, 200, 'member and summary purposes remain separate grants');
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
      const revokedMembers = await request('selection-members', memberBody);
      assert.equal(revokedMembers.status, 403); assert.deepEqual(await revokedMembers.json(), { error: 'neighborhood_access_denied' });
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
    checks.push('native exact-reference member pages preserve actual legacy all/selected stock/transaction/source/omitted projections, exact cursors, empty population and independent initial/final member rights with unchanged report state and no geometry transfer');
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  // Explicit QA-only conversion after the unchanged-report legacy tests above.
  // Use the existing schema/writer and exact retained context, not fabricated
  // context pages or a production file. The browser has no v7 activation yet.
  const currentRef = (await owner.readRecordedGroupSelection(read)).selection_ref;
  const seedValue = { workspace_version: 6, active: { context_ref: read.contextRef, observation_period: observationPeriod,
    selection: { revision: currentRef.selection_revision, included_recorded_group_ids: [...ids].sort() } }, pending_capture: null };
  const seedClient = await pool.connect(); let seeded;
  try {
    await seedClient.query('BEGIN');
    const old = (await seedClient.query(`SELECT revision FROM app.custom_appraisal_workfile_sections
      WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [scope.assignment_file_id])).rows[0];
    seeded = await saveCustomAppraisalWorkfileSectionInTransaction(seedClient, {
      accountId: scope.account_id, assignmentFileId: scope.assignment_file_id, sectionKey: 'neighborhood_workspace',
      sectionValue: seedValue, expectedRevision: old?.revision ?? 0, saveReason: 'manual_save', reviewer: auth.userId,
    });
    await seedClient.query('COMMIT');
  } catch (error) { await seedClient.query('ROLLBACK'); throw error; }
  finally { seedClient.release(); }
  const workspaceState = async () => ({
    section: (await pool.query(`SELECT revision,section_value FROM app.custom_appraisal_workfile_sections
      WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [scope.assignment_file_id])).rows[0],
    history: (await pool.query(`SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_section_history
      WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [scope.assignment_file_id])).rows[0].n,
    head: await head(), blobs: await blobs(),
  });
  const protectedOther = async () => {
    const state = await protectedState(); state.sections = state.sections.filter(row => row.value.section_key !== 'neighborhood_workspace');
    return state;
  };
  const otherBefore = await protectedOther();
  const atomicInput = { ...select, operationId: randomUUID(), expectedSelectionRef: currentRef,
    expectedWorkspaceRevision: seeded.revision };
  const unchanged = await workspaceState();
  const failNext = () => ({ ...atomicInput, operationId: randomUUID() });
  const afterWorkspaceCancel = new AbortController(); cancelAtWorkspace = afterWorkspaceCancel;
  await assert.rejects(owner.selectAndSaveRecordedGroups(failNext(), { signal: afterWorkspaceCancel.signal }), /cancelled/);
  assert.deepEqual(await workspaceState(), unchanged, 'head, pages, workspace and history roll back after the actual section write');
  failWorkspaceHistory = true;
  await assert.rejects(owner.selectAndSaveRecordedGroups(failNext()), /history write acknowledgment failure/);
  assert.deepEqual(await workspaceState(), unchanged, 'history failure rolls back head and workspace together');
  policyCalls = 0; denyFinalPolicy = true;
  try { await assert.rejects(owner.selectAndSaveRecordedGroups(failNext()), /market_data_access_denied/); }
  finally { denyFinalPolicy = false; }
  assert.deepEqual(await workspaceState(), unchanged);
  revokeAtWorkspace = true;
  try { await assert.rejects(owner.selectAndSaveRecordedGroups(failNext()), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.deepEqual(await workspaceState(), unchanged);
  checks.push('native exact-reference workspace transaction rolls back staged pages, head, section and history after section cancellation, history failure, final source refusal or current-role revocation');

  loseCommitAck = true;
  await assert.rejects(owner.selectAndSaveRecordedGroups(atomicInput), error => error.outcome_unknown === true);
  const committed = await workspaceState();
  assert.equal(committed.section.revision, seeded.revision + 1); assert.equal(committed.history, unchanged.history + 1);
  const atomic = await owner.selectAndSaveRecordedGroups(atomicInput);
  assert.equal(atomic.status, 'reused'); assert.equal(atomic.workspace.revision, seeded.revision + 1);
  assert.equal(atomic.workspace.value.workspace_version, 7);
  assert.deepEqual(atomic.workspace.value.active.selection_ref, atomic.selection_ref);
  assert.equal(committed.head, atomic.selection_ref.selection_revision);
  assert.deepEqual(await workspaceState(), committed, 'lost-ACK replay produces neither another history row nor another head');
  await assert.rejects(owner.selectRecordedGroups({ ...select, operationId: randomUUID(), expectedSelectionRef: atomic.selection_ref }),
    /selection_workspace_workflow_required/);
  const downgradeClient = await pool.connect();
  try {
    await downgradeClient.query('BEGIN');
    await assert.rejects(saveCustomAppraisalWorkfileSectionInTransaction(downgradeClient, {
      accountId: scope.account_id, assignmentFileId: scope.assignment_file_id, sectionKey: 'neighborhood_workspace',
      sectionValue: seedValue, expectedRevision: atomic.workspace.revision, saveReason: 'autosave', reviewer: auth.userId,
    }), /selection_workspace_workflow_required/);
    await downgradeClient.query('ROLLBACK');
  } finally { await downgradeClient.query('ROLLBACK'); downgradeClient.release(); }
  assert.deepEqual(await workspaceState(), committed);

  const emptyAtomicInput = { ...atomicInput, operationId: randomUUID(), expectedSelectionRef: atomic.selection_ref,
    expectedWorkspaceRevision: atomic.workspace.revision, includedRecordedGroupIds: [] };
  const atomicEmpty = await owner.selectAndSaveRecordedGroups(emptyAtomicInput);
  assert.equal(atomicEmpty.status, 'stored'); assert.deepEqual(atomicEmpty.included_recorded_group_ids, []);
  assert.deepEqual(atomicEmpty.workspace.value.active.selection_ref, atomicEmpty.selection_ref);
  assert.equal((await owner.previewRecordedGroupSelection({ ...read, selectionRef: atomicEmpty.selection_ref })).summary.selected.account_count, 0);
  await assert.rejects(owner.selectAndSaveRecordedGroups(atomicInput), /revision_changed/);
  const ready = await workspaceState();
  const contentionInput = { ...atomicInput, expectedSelectionRef: atomicEmpty.selection_ref,
    expectedWorkspaceRevision: atomicEmpty.workspace.revision };
  const outcomes = await Promise.allSettled([1, 2].map(() => owner.selectAndSaveRecordedGroups({ ...contentionInput, operationId: randomUUID() })));
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
  const winner = outcomes.find(item => item.status === 'fulfilled').value, afterRace = await workspaceState();
  assert.equal(afterRace.section.revision, ready.section.revision + 1); assert.equal(afterRace.history, ready.history + 1);
  assert.deepEqual(afterRace.section.section_value.active.selection_ref, winner.selection_ref);
  assert.equal(afterRace.head, winner.selection_ref.selection_revision);
  assert.deepEqual(await protectedOther(), otherBefore, 'no accepted section, receipt, assignment geography or report content changes');
  checks.push('native exact workspace/head COMMIT loss replays once, generic autosave and legacy head writes cannot downgrade or detach it, explicit empty stays empty, stale replay cannot rewind, and competing CAS operations commit one coherent winner without changing accepted reports');
  return { checks };
}
