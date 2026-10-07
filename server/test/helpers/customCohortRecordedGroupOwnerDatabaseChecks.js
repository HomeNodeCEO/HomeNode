import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomNeighborhoodCohortRouter } from '../../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { runCustomCohortPreparedViewportTileJob } from '../../src/services/neighborhoodAssessment/customCohortPreparedViewportTileJob.js';
import { runCustomCohortPreparedMapOpeningJob } from '../../src/services/neighborhoodAssessment/customCohortPreparedMapOpeningJob.js';
import { customCohortOpeningSelection } from '../../src/services/neighborhoodAssessment/customCohortOpeningPreview.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../../src/services/customAppraisalWorkfiles.js';
import { runCustomCohortGroupWorkspaceHttpDatabaseChecks } from './customCohortGroupWorkspaceHttpDatabaseChecks.js';
import { runCustomCohortPreparedCatalogOwnerDatabaseChecks } from './customCohortPreparedCatalogOwnerDatabaseChecks.js';
import { runCustomCohortPreparedMembershipOwnerDatabaseChecks } from './customCohortPreparedMembershipOwnerDatabaseChecks.js';

/** Invoked only by the verified disposable PostgreSQL fixture. No live accounts,
 * source provider, user report choices, accepted sections or shared database.
 */
export async function runCustomCohortRecordedGroupOwnerDatabaseChecks({ pool, scope: sourceScope, grant, observationPeriod }) {
  // This suite intentionally commits workspace/head changes. Give it its own
  // actor, organization and report so the coordinator's subsequent cold-start
  // checkpoint checks still exercise an actually untouched assignment.
  const organization = randomUUID(), actor = randomUUID(), caseId = randomUUID(), snapshot = randomUUID(), report = randomUUID();
  await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic group workspace','Synthetic group workspace')", [organization]);
  await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic group workspace actor')", [actor, `${actor}@example.test`]);
  await pool.query('INSERT INTO app_auth.organization_memberships(organization_id,user_id) VALUES($1,$2)', [organization, actor]);
  await pool.query("INSERT INTO app_auth.membership_roles(organization_id,user_id,role_code) VALUES($1,$2,'appraiser')", [organization, actor]);
  const copiedCase = await pool.query(`INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date)
    SELECT $1,$2,r.account_id,c.effective_date FROM app.report_files r
    JOIN app.appraisal_cases c ON c.id=r.appraisal_case_id
    WHERE r.id=$3 AND r.organization_id=$4 AND r.custom_assignment_file_id=$5 AND r.account_id=$6`,
  [caseId, organization, sourceScope.report_file_id, sourceScope.organization_id, sourceScope.assignment_file_id, sourceScope.account_id]);
  assert.equal(copiedCase.rowCount, 1, 'only copy the exact verified synthetic owner fixture');
  const copiedSnapshot = await pool.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
    SELECT $1,$2,1,s.effective_date,s.subject_data FROM app.report_files r
    JOIN app.appraisal_subject_snapshots s ON s.id=r.subject_snapshot_id
    WHERE r.id=$3 AND r.organization_id=$4 AND r.custom_assignment_file_id=$5 AND r.account_id=$6`,
  [snapshot, caseId, sourceScope.report_file_id, sourceScope.organization_id, sourceScope.assignment_file_id, sourceScope.account_id]);
  assert.equal(copiedSnapshot.rowCount, 1);
  const assignment = (await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
    VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [organization, sourceScope.account_id, `GROUP-${randomUUID()}`, actor])).rows[0].id;
  await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
    VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [report, organization, sourceScope.account_id, `GROUP-${randomUUID()}`, assignment, caseId, snapshot]);
  await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)', [assignment, `group-workspace-${randomUUID()}`]);
  const scope = { organization_id: organization, report_file_id: report, assignment_file_id: assignment, account_id: sourceScope.account_id };
  const auth = { userId: actor, organizations: [{ organizationId: organization, roles: ['appraiser'] }] };
  const coordinatorWorkspace = () => pool.query(`SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s
    WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [sourceScope.assignment_file_id]);
  const coordinatorBefore = (await coordinatorWorkspace()).rows;
  const calls = [], checks = [];
  let loseCommitAck = false, cancelAtHead = null, revokeAtHead = false, revokeAtRead = false;
  let revokeAtCatalogRead = false, cancelAtCatalogRead = null, loseRegistryAck = false;
  let loseMembershipAck = false, cancelAtMembershipInsert = null, revokeAtMembershipInsert = false;
  let cancelAtWorkspace = null, revokeAtWorkspace = false, failWorkspaceHistory = false;
  let denyPolicy = false, denyFinalPolicy = false, denySummary = false, denyFinalSummary = false;
  let denyMembers = false, denyFinalMembers = false;
  let policyCalls = 0, summaryPolicyCalls = 0, memberPolicyCalls = 0,
    pauseAtWorkfile = null, missPreparedCatalog = false;
  const suspend = status => pool.query(`UPDATE app_auth.organization_memberships SET status=$3
    WHERE organization_id=$1 AND user_id=$2`, [scope.organization_id, auth.userId, status]);
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), async query(config) {
      calls.push(config.text);
      const result = await client.query(config);
      if (config.text.includes('prepared-catalog-registry:read')) {
        cancelAtCatalogRead?.abort(); cancelAtCatalogRead = null;
        if (revokeAtCatalogRead) { revokeAtCatalogRead = false; await suspend('suspended'); }
      }
      if (loseRegistryAck && config.text.includes('prepared-catalog-registry:insert')) {
        loseRegistryAck = false; throw new Error('synthetic_registry_ack_failure');
      }
      if (config.text.includes('prepared-catalog-membership:insert')) {
        cancelAtMembershipInsert?.abort(); cancelAtMembershipInsert = null;
        if (revokeAtMembershipInsert) { revokeAtMembershipInsert = false; await suspend('suspended'); }
        if (loseMembershipAck) { loseMembershipAck = false; throw new Error('synthetic_membership_ack_failure'); }
      }
      if (config.values?.[1] === 'neighborhood_workspace') {
        if (config.text.includes('INSERT INTO app.custom_appraisal_workfile_sections (')) {
          cancelAtWorkspace?.abort(); cancelAtWorkspace = null;
          if (revokeAtWorkspace) { revokeAtWorkspace = false; await suspend('suspended'); }
        }
        if (failWorkspaceHistory && config.text.includes('INSERT INTO app.custom_appraisal_workfile_section_history (')) {
          failWorkspaceHistory = false; throw new Error('synthetic workspace history write acknowledgment failure');
        }
      }
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
  checks.push(...(await runCustomCohortPreparedCatalogOwnerDatabaseChecks({ pool, owner, read, scope, calls,
    protectedState, suspend, denySource: (value, final = false) => {
      denyPolicy = value && !final; denyFinalPolicy = value && final; policyCalls = 0;
    }, revokeNextRead: () => { revokeAtCatalogRead = true; },
    cancelNextRead: controller => { cancelAtCatalogRead = controller; }, loseNextRegistryAck: () => { loseRegistryAck = true; },
  })).checks);
  checks.push(...(await runCustomCohortPreparedMembershipOwnerDatabaseChecks({ pool, owner, read, scope, calls,
    protectedState, suspend, expectedAccounts: catalog.catalog.pockets.reduce((n,p) => n + p.member_count, catalog.catalog.unassigned.member_count),
    denyMembers: (value, final = false) => { denyMembers = value && !final; denyFinalMembers = value && final; memberPolicyCalls = 0; },
    loseNextMembershipAck: () => { loseMembershipAck = true; },
    cancelNextMembershipInsert: controller => { cancelAtMembershipInsert = controller; },
    revokeNextMembershipInsert: () => { revokeAtMembershipInsert = true; },
    revokeNextRead: () => { revokeAtCatalogRead = true; },
  })).checks);
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
  const marketUnion = await owner.authorizeRecordedGroupMarketSelection({ ...read, selectionRef: first.selection_ref });
  const expectedMarketUnion = [...new Set([...catalog.catalog.pockets.filter(p => ids.includes(p.id)).flatMap(p => p.account_ids),
    ...(ids.includes('discovery:unassigned') ? catalog.catalog.unassigned.account_ids : [])])].sort();
  assert.deepEqual(marketUnion.accountIds, expectedMarketUnion);
  assert.deepEqual(marketUnion.selection_ref, first.selection_ref); assert.ok(Object.isFrozen(marketUnion.accountIds));
  assert.deepEqual(marketUnion.binding, summary.summary.binding);
  assert.ok(!calls.slice(from).some(sql => sql.includes('neighborhood-cohort-blob:read-batch')),
    'prepared selection reads complete catalog/roster without replaying source pages');
  assert.ok(!calls.slice(from).some(sql => sql.includes('compressed_map')),
    'selection persistence must not transfer full geometry');
  checks.push('native server-derived recorded-group selection retains actor intent and exact pages, reopens current head, and reuses lost-ACK operation without source/map replay');
  const firstOpening = await owner.openRecordedGroupSelectionMap({ ...read, selectionRef: first.selection_ref });
  const legacyOpening = await owner.catalog({ ...read, selection: { revision: 1, pockets: [] },
    catalogVersion: 3, includeRecommendation: true, initialPreviewGroups: ids, initialMapMode: 'manifest' });
  assert.deepEqual(firstOpening.map_opening.manifest, legacyOpening.initial_preview.map_manifest,
    'opening uses the exact whole original bounds, group anchors and subject pointer, not the selected union or viewport');
  assert.deepEqual(firstOpening.selection_ref, first.selection_ref);
  assert.equal(firstOpening.map_opening.display_only, true);

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
  assert.deepEqual((await owner.authorizeRecordedGroupMarketSelection({ ...read, selectionRef: empty.selection_ref })).accountIds, []);
  await assert.rejects(owner.authorizeRecordedGroupMarketSelection({ ...read, selectionRef: first.selection_ref }), /selection_changed/);
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
  denySummary = true;
  try { await assert.rejects(owner.authorizeRecordedGroupMarketSelection({ ...read, selectionRef: empty.selection_ref }), /market_data_access_denied/); }
  finally { denySummary = false; }
  summaryPolicyCalls = 0; denyFinalSummary = true;
  try { await assert.rejects(owner.authorizeRecordedGroupMarketSelection({ ...read, selectionRef: empty.selection_ref }), /market_data_access_denied/); }
  finally { denyFinalSummary = false; }
  assert.ok(summaryPolicyCalls >= 2, 'internal exact market union checks the separate ending summary grant');
  checks.push('native exact-reference market authorization reopens every original of the complete union, keeps empty empty, rejects stale heads and initial/final summary-rights denial without changing report rows');
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
    const emptyOpening = await request('selection-map-opening', { ...readBody, selection_ref: empty.selection_ref });
    assert.equal(emptyOpening.status, 200);
    const emptyOpeningResult = await emptyOpening.json();
    assert.deepEqual(emptyOpeningResult.map_opening.manifest, firstOpening.map_opening.manifest,
      'explicit empty still displays the complete captured map without a default selection');
    assert.deepEqual(emptyOpeningResult.selection_ref, empty.selection_ref);
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
    const openingBefore = await request('selection-map-opening', numericBody);
    assert.equal(openingBefore.status, 200); assert.equal(openingBefore.headers.get('cache-control'), 'no-store');
    const completeOpening = await openingBefore.json();
    assert.deepEqual(completeOpening.map_opening.manifest, firstOpening.map_opening.manifest);
    assert.deepEqual(completeOpening.selection_ref, receipt.selection_ref);
    assert.equal(Object.hasOwn(completeOpening, 'summary'), false); assert.equal(Object.hasOwn(completeOpening, 'account_ids'), false);
    // Separate checksummed offline derivative, only in this migrated synthetic
    // database. Current source/actor authorization still surrounds every read.
    await runCustomCohortPreparedMapOpeningJob(pool, { maximumContexts: 100, maximumRuntimeMinutes: 1, logger: {} });
    assert.equal((await pool.query(`SELECT status FROM app.neighborhood_custom_cohort_prepared_map_openings
      WHERE organization_id=$1 AND context_id=$2`, cacheKey)).rows[0]?.status, 'available');
    const fastOpeningFrom = calls.length;
    const fastOpening = await request('selection-map-opening', numericBody);
    assert.equal(fastOpening.status, 200); assert.deepEqual(await fastOpening.json(), completeOpening);
    assert.ok(calls.slice(fastOpeningFrom).some(sql => sql.includes('custom-cohort-prepared-map-opening:read')));
    assert.ok(!calls.slice(fastOpeningFrom).some(sql => (sql.includes('/* custom-cohort-prepared-preview:read */') && sql.includes('compressed_map'))
      || sql.includes('neighborhood-cohort-blob:read-batch')), 'opening derivative verifies originals without transferring/decompressing whole geometry');
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
    const staleOpening = await request('selection-map-opening', { ...numericBody, selection_ref: empty.selection_ref });
    assert.equal(staleOpening.status, 409); assert.deepEqual(await staleOpening.json(), { error: 'neighborhood_selection_changed' });
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
    const injectedOpening = await request('selection-map-opening', { ...numericBody, account_ids: [] });
    assert.equal(injectedOpening.status, 400); assert.equal(calls.length, invalidFrom);
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
      const deniedOpeningFrom = calls.length;
      assert.equal((await request('selection-map-opening', numericBody)).status, 403);
      assert.ok(!calls.slice(deniedOpeningFrom).some(sql => sql.includes('prepared-map-opening:read')
        || sql.includes('prepared-catalog:read') || sql.includes('custom-cohort-group-selection:head')),
      'catalog rights alone do not authorize opening geometry metadata or selection originals');
      assert.equal((await request('selection-members', memberBody)).status, 200, 'member and summary purposes remain separate grants');
    } finally { denySummary = false; }
    summaryPolicyCalls = 0; denyFinalSummary = true;
    try {
      const finalDeniedMap = await request('selection-viewport', mapBody);
      assert.equal(finalDeniedMap.status, 403);
      assert.deepEqual(await finalDeniedMap.json(), { error: 'neighborhood_access_denied' });
    } finally { denyFinalSummary = false; }
    summaryPolicyCalls = 0; denyFinalSummary = true;
    try { assert.equal((await request('selection-map-opening', numericBody)).status, 403); }
    finally { denyFinalSummary = false; }
    assert.ok(summaryPolicyCalls >= 2, 'opening exposure is repeated before delivery');
    await suspend('suspended');
    try {
      const revoked = await request('group-selection', readBody);
      assert.equal(revoked.status, 403); assert.deepEqual(await revoked.json(), { error: 'neighborhood_access_denied' });
      const revokedNumeric = await request('selection-preview', numericBody);
      assert.equal(revokedNumeric.status, 403); assert.deepEqual(await revokedNumeric.json(), { error: 'neighborhood_access_denied' });
      const revokedMap = await request('selection-viewport', mapBody);
      assert.equal(revokedMap.status, 403); assert.deepEqual(await revokedMap.json(), { error: 'neighborhood_access_denied' });
      assert.equal((await request('selection-map-opening', numericBody)).status, 403);
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
    checks.push('native exact-reference map opening keeps complete/empty bounds, all labels and subject anchors, actual offline derivative/fallback parity without full-map transfer, stale/injected/current actor and initial/final source refusal; report/workspace/selection originals unchanged');
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
  assert.deepEqual((await coordinatorWorkspace()).rows, coordinatorBefore, 'the separate coordinator cold-start assignment remains untouched');
  checks.push('native exact workspace/head COMMIT loss replays once, generic autosave and legacy head writes cannot downgrade or detach it, explicit empty stays empty, stale replay cannot rewind, and competing CAS operations commit one coherent winner without changing accepted reports');

  const nextPeriod = { start_date: observationPeriod.start_date === '2020-01-01' ? '2019-01-01' : '2020-01-01',
    end_date: observationPeriod.end_date };
  const pendingCapture = { operation_id: randomUUID(), observation_period: nextPeriod };
  const start = { ...identity, expectedWorkspaceRevision: winner.workspace.revision,
    expectedWorkspaceCheckpoint: winner.workspace.value, pendingCapture };
  const pendingBefore = await workspaceState(), transitionFrom = calls.length;
  policyCalls = 0; denyPolicy = true;
  let started;
  try {
    loseCommitAck = true;
    await assert.rejects(owner.startRecordedGroupCapture(start), error => error.outcome_unknown === true);
    const afterStart = await workspaceState();
    started = await owner.startRecordedGroupCapture(start);
    assert.equal(started.status, 'reused'); assert.deepEqual(await workspaceState(), afterStart);
    assert.equal(afterStart.section.revision, pendingBefore.section.revision + 1);
    assert.equal(afterStart.history, pendingBefore.history + 1); assert.equal(afterStart.head, pendingBefore.head);
    assert.equal(afterStart.blobs, pendingBefore.blobs);
    assert.deepEqual(started.workspace.value.active, winner.workspace.value.active);
    assert.deepEqual(started.workspace.value.pending_capture, pendingCapture);
    assert.equal(policyCalls, 0, 'pending intent needs current assignment write access, not an old source grant');
    assert.ok(!calls.slice(transitionFrom).some(sql => /neighborhood-cohort-blob:|prepared-catalog:read|prepared-preview:read/.test(sql)),
      'start/replay must not open source/cached facts');
    const cancel = { ...identity, expectedWorkspaceRevision: started.workspace.revision,
      expectedWorkspaceCheckpoint: started.workspace.value };
    const unchangedPending = await workspaceState();
    const cancelled = new AbortController(); cancelAtWorkspace = cancelled;
    await assert.rejects(owner.cancelRecordedGroupCapture(cancel, { signal: cancelled.signal }), /cancelled/);
    assert.deepEqual(await workspaceState(), unchangedPending);
    revokeAtWorkspace = true;
    try { await assert.rejects(owner.cancelRecordedGroupCapture(cancel), /job_actor_access_revoked/); }
    finally { await suspend('active'); }
    assert.deepEqual(await workspaceState(), unchangedPending, 'final role refusal rolls back cancellation history and preserves pending');
    loseCommitAck = true;
    await assert.rejects(owner.cancelRecordedGroupCapture(cancel), error => error.outcome_unknown === true);
    const canceledState = await workspaceState(), canceled = await owner.cancelRecordedGroupCapture(cancel);
    assert.equal(canceled.status, 'reused'); assert.deepEqual(await workspaceState(), canceledState);
    assert.deepEqual(canceled.workspace.value.active, winner.workspace.value.active);
    assert.equal(canceled.workspace.value.pending_capture, null);
    await assert.rejects(owner.startRecordedGroupCapture(start), /revision_changed/);
    started = await owner.startRecordedGroupCapture({ ...start, expectedWorkspaceRevision: canceled.workspace.revision,
      expectedWorkspaceCheckpoint: canceled.workspace.value });
  } finally { denyPolicy = false; }
  checks.push('native pending start/cancel preserves the old active head and accepted report, opens no old source facts, reloads current roles, rolls back actual post-section failures, and replays lost COMMIT acknowledgments once without extra history');

  const uncaptured = { ...identity, contextRef: { context_id: pendingCapture.operation_id, context_revision: '1',
    context_sha256: 'a'.repeat(64) }, operationId: randomUUID(), expectedSelectionRef: null,
    expectedWorkspaceRevision: started.workspace.revision, expectedWorkspaceCheckpoint: started.workspace.value,
    includedRecordedGroupIds: [] };
  const beforeCapture = await workspaceState();
  await assert.rejects(owner.completeRecordedGroupCapture(uncaptured));
  assert.deepEqual(await workspaceState(), beforeCapture, 'a registered original new context is required before completion');
  const captured = await owner.capture({ ...identity, operationId: pendingCapture.operation_id, observationPeriod: nextPeriod });
  const newRead = { ...identity, contextRef: captured.context_ref };
  const newCatalog = await owner.catalog({ ...newRead, selection: { revision: 1, pockets: [] }, catalogVersion: 3 });
  assert.equal(newCatalog.catalog.catalog_complete, true);
  const newIds = newCatalog.catalog.pockets.map(p => p.id);
  if (newCatalog.catalog.unassigned.member_count) newIds.push('discovery:unassigned');
  const finish = { ...uncaptured, contextRef: captured.context_ref, includedRecordedGroupIds: newIds };
  const newHead = async () => (await pool.query(`SELECT selection_revision FROM app.neighborhood_custom_cohort_group_selection_heads
    WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, captured.context_ref.context_id])).rows;
  const transitionState = async () => ({ workspace: await workspaceState(), newHead: await newHead() });
  const beforeFinish = await transitionState(); assert.deepEqual(beforeFinish.newHead, []);
  for (const mutate of [x => { x.pending_capture.observation_period.start_date = '2018-01-01'; },
    x => { x.pending_capture.discovery = { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' }; },
    x => { x.pending_capture.private_sales_import = { batch_id: randomUUID(), expected_review_revision: 1 }; }]) {
    const checkpoint = structuredClone(finish.expectedWorkspaceCheckpoint); mutate(checkpoint);
    await assert.rejects(owner.completeRecordedGroupCapture({ ...finish, expectedWorkspaceCheckpoint: checkpoint }), /study_changed/);
    assert.deepEqual(await transitionState(), beforeFinish, 'mismatched new study cannot detach original active/pending choices');
  }
  const failFinish = () => ({ ...finish, operationId: randomUUID() });
  failWorkspaceHistory = true;
  await assert.rejects(owner.completeRecordedGroupCapture(failFinish()), /history write acknowledgment failure/);
  assert.deepEqual(await transitionState(), beforeFinish, 'new head, pages, checkpoint and history roll back together');
  const afterCompletionCancel = new AbortController(); cancelAtWorkspace = afterCompletionCancel;
  await assert.rejects(owner.completeRecordedGroupCapture(failFinish(), { signal: afterCompletionCancel.signal }), /cancelled/);
  assert.deepEqual(await transitionState(), beforeFinish);
  policyCalls = 0; denyFinalPolicy = true;
  try { await assert.rejects(owner.completeRecordedGroupCapture(failFinish()), /market_data_access_denied/); }
  finally { denyFinalPolicy = false; }
  assert.deepEqual(await transitionState(), beforeFinish);
  revokeAtWorkspace = true;
  try { await assert.rejects(owner.completeRecordedGroupCapture(failFinish()), /job_actor_access_revoked/); }
  finally { await suspend('active'); }
  assert.deepEqual(await transitionState(), beforeFinish);
  loseCommitAck = true;
  await assert.rejects(owner.completeRecordedGroupCapture(finish), error => error.outcome_unknown === true);
  const committedFinish = await transitionState(), finished = await owner.completeRecordedGroupCapture(finish);
  assert.equal(finished.status, 'reused'); assert.deepEqual(await transitionState(), committedFinish);
  assert.equal(finished.workspace.revision, started.workspace.revision + 1);
  assert.deepEqual(finished.workspace.value.active.context_ref, captured.context_ref);
  assert.deepEqual(finished.workspace.value.active.observation_period, nextPeriod);
  assert.deepEqual(finished.workspace.value.active.selection_ref, finished.selection_ref);
  assert.equal(finished.workspace.value.pending_capture, null); assert.equal(finished.selection_ref.selection_revision, 1);
  assert.equal(committedFinish.workspace.head, winner.selection_ref.selection_revision, 'old immutable context selection is not rewritten');
  assert.deepEqual((await owner.readRecordedGroupSelection(newRead)).selection_ref, finished.selection_ref,
    'the shared original verifier reopens command v3 and its complete memberships');
  await assert.rejects(owner.cancelRecordedGroupCapture({ ...identity, expectedWorkspaceRevision: started.workspace.revision,
    expectedWorkspaceCheckpoint: started.workspace.value }), /study_changed|revision_changed/);
  const later = await owner.selectAndSaveRecordedGroups({ ...newRead, operationId: randomUUID(),
    expectedSelectionRef: finished.selection_ref, expectedWorkspaceRevision: finished.workspace.revision,
    includedRecordedGroupIds: [] });
  assert.equal(later.workspace.value.active.selection_ref.selection_revision, 2);
  await assert.rejects(owner.completeRecordedGroupCapture(finish), /revision_changed/);
  assert.deepEqual(await protectedOther(), otherBefore);
  assert.deepEqual((await coordinatorWorkspace()).rows, coordinatorBefore);
  checks.push('native V7 study transition requires a registered exact period/discovery/private-purpose context, atomically publishes its fresh complete selection with pending cleared, rolls new pages/head/history back on failures, reopens v3 originals, and cannot rewind later edits or alter accepted reports');
  checks.push(...(await runCustomCohortGroupWorkspaceHttpDatabaseChecks({ pool, owner, auth, scope,
    current: later, originalGroupIds: newIds, calls, workspaceState, protectedOther, coordinatorWorkspace,
    coordinatorBefore, suspend, loseNextCommit: () => { loseCommitAck = true; },
    denySource: value => { denyPolicy = value; } })).checks);
  return { checks };
}
