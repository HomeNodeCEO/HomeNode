import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../../src/modules/accounts/customNeighborhoodCohortRouter.js';

/** Called only by the guarded migrated disposable-database owner fixture.
 * Actual router/closed presenters, transactions, originals and current DB roles;
 * middleware identity and source-policy decisions remain explicit fixture ports.
 * This is not a live session, application-wide middleware or large-area SLA test.
 */
export async function runCustomCohortGroupWorkspaceHttpDatabaseChecks({ pool, owner, auth, scope,
  current, originalGroupIds, calls, workspaceState: originalWorkspaceState, protectedOther, coordinatorWorkspace,
  coordinatorBefore, suspend, loseNextCommit, denySource }) {
  const protectedBefore = await protectedOther(), app = express();
  const authorization = 'Bearer synthetic-v7-native-fixture';
  app.use((req, _res, next) => {
    if (req.get('authorization') === authorization) req.mobileAuth = auth;
    next();
  });
  app.use(createCustomNeighborhoodCohortRouter({ cohortService: owner, logger: {},
    recordedGroupWorkspaceTransitions: true }));
  const server = await new Promise((resolve, reject) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle)); handle.once('error', reject);
  });
  const path = `http://127.0.0.1:${server.address().port}/api/accounts/${encodeURIComponent(scope.account_id)}/neighborhood-cohort`;
  // The parent's head witness intentionally remains pinned to its ORIGINAL
  // context. These HTTP transitions start from a later active context, so
  // inspect that checkpoint's actual current head separately, retaining the
  // original witness rather than relabelling it as the active population.
  const workspaceState = async () => {
    const original = await originalWorkspaceState();
    const active = original.section.section_value.active;
    const rows = (await pool.query(`SELECT selection_revision FROM app.neighborhood_custom_cohort_group_selection_heads
      WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, active.context_ref.context_id])).rows;
    assert.equal(rows.length, 1);
    return { ...original, original_head: original.head, head: rows[0].selection_revision };
  };
  const request = (action, body, authenticated = true) => fetch(`${path}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const readBody = contextRef => ({ assignment_file_id: scope.assignment_file_id, context_ref: contextRef });
  const saveBody = value => ({ ...readBody(value.workspace.value.active.context_ref), operation_id: randomUUID(),
    expected_workspace_revision: value.workspace.revision, expected_selection_ref: value.selection_ref,
    included_recorded_group_ids: originalGroupIds });
  const transitionBody = value => ({ assignment_file_id: scope.assignment_file_id,
    expected_workspace_revision: value.workspace.revision, expected_workspace_checkpoint: value.workspace.value });
  const success = async (action, body, status = 'stored') => {
    const response = await request(action, body);
    assert.equal(response.status, 200, `${action} must execute its actual native owner and closed presenter`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.status, status); assert.equal(result.authority, 'not_established');
    assert.equal(result.workspace.revision, body.expected_workspace_revision + 1);
    assert.equal(result.workspace.value.workspace_version, 7);
    assert.equal(Object.hasOwn(result, 'account_ids'), false);
    assert.equal(Object.hasOwn(result, 'catalog'), false);
    return result;
  };
  const refusal = async (action, body, status, error, authenticated = true) => {
    const response = await request(action, body, authenticated);
    assert.equal(response.status, status, `${action} refusal`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error, ...(error === 'neighborhood_operation_outcome_unknown'
      ? { retry_same_operation: true } : {}) });
  };
  try {
    const beforeAdmission = await workspaceState(), beforeQueries = calls.length;
    for (const action of ['save-groups', 'start-group-capture', 'cancel-group-capture', 'complete-group-capture']) {
      await refusal(action, {}, 401, 'authentication_required', false);
      await refusal(action, { auth, allowed: true }, 400, 'invalid_neighborhood_request');
    }
    assert.equal(calls.length, beforeQueries, 'anonymous/malformed commands must not enter any SQL owner');
    assert.deepEqual(await workspaceState(), beforeAdmission);

    const selectionCommand = saveBody(current);
    loseNextCommit();
    await refusal('save-groups', selectionCommand, 409, 'neighborhood_operation_outcome_unknown');
    const committedSelection = await workspaceState();
    const selected = await success('save-groups', selectionCommand, 'reused');
    assert.deepEqual(selected.included_recorded_group_ids, [...originalGroupIds].sort());
    assert.deepEqual(selected.workspace.value.active.selection_ref, selected.selection_ref);
    assert.deepEqual(await workspaceState(), committedSelection, 'HTTP replay must not add a second head/history row');
    assert.equal(committedSelection.history, beforeAdmission.history + 1);
    assert.equal(committedSelection.head, selected.selection_ref.selection_revision);
    await refusal('save-groups', { ...selectionCommand, operation_id: randomUUID() }, 409, 'neighborhood_selection_changed');
    assert.deepEqual(await workspaceState(), committedSelection);

    const deniedCommand = saveBody(selected);
    await suspend('suspended');
    try { await refusal('save-groups', deniedCommand, 403, 'neighborhood_access_denied'); }
    finally { await suspend('active'); }
    denySource(true);
    try { await refusal('save-groups', deniedCommand, 403, 'neighborhood_access_denied'); }
    finally { denySource(false); }
    assert.deepEqual(await workspaceState(), committedSelection);
    const workfile = (await pool.query(`SELECT status,signed_at::text,updated_at::text FROM app.custom_appraisal_workfiles
      WHERE assignment_file_id=$1`, [scope.assignment_file_id])).rows[0];
    try {
      await pool.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp() WHERE assignment_file_id=$1", [scope.assignment_file_id]);
      await refusal('save-groups', deniedCommand, 409, 'neighborhood_private_source_read_only');
    } finally {
      await pool.query('UPDATE app.custom_appraisal_workfiles SET status=$2,signed_at=$3,updated_at=$4 WHERE assignment_file_id=$1',
        [scope.assignment_file_id, workfile.status, workfile.signed_at, workfile.updated_at]);
    }
    assert.deepEqual(await workspaceState(), committedSelection);

    // Start/cancel retain old active choices. They require fresh assignment
    // authority but intentionally need no stale source grant or map replay.
    const period = selected.workspace.value.active.observation_period;
    const pending = { operation_id: randomUUID(), observation_period: period };
    const startCommand = { ...transitionBody(selected), pending_capture: pending };
    const startFrom = calls.length;
    let started, canceled;
    denySource(true);
    try {
      loseNextCommit();
      await refusal('start-group-capture', startCommand, 409, 'neighborhood_operation_outcome_unknown');
      const startedState = await workspaceState();
      started = await success('start-group-capture', startCommand, 'reused');
      assert.deepEqual(await workspaceState(), startedState);
      assert.deepEqual(started.workspace.value.active, selected.workspace.value.active);
      assert.deepEqual(started.workspace.value.pending_capture, pending);
      const cancelCommand = transitionBody(started);
      loseNextCommit();
      await refusal('cancel-group-capture', cancelCommand, 409, 'neighborhood_operation_outcome_unknown');
      const canceledState = await workspaceState();
      canceled = await success('cancel-group-capture', cancelCommand, 'reused');
      assert.deepEqual(await workspaceState(), canceledState);
      assert.deepEqual(canceled.workspace.value.active, selected.workspace.value.active);
      assert.equal(canceled.workspace.value.pending_capture, null);
      assert.ok(!calls.slice(startFrom).some(sql => /neighborhood-cohort-blob:|prepared-catalog:read|prepared-preview:read/.test(sql)),
        'pending HTTP intent/replay does not open retained source/catalog/map facts');
    } finally { denySource(false); }
    await refusal('start-group-capture', startCommand, 409, 'neighborhood_workspace_changed');

    const nextPending = { operation_id: randomUUID(), observation_period: period };
    started = await success('start-group-capture', { ...transitionBody(canceled), pending_capture: nextPending });
    const completionCommand = { ...transitionBody(started), context_ref: { context_id: nextPending.operation_id,
      context_revision: '1', context_sha256: 'a'.repeat(64) }, operation_id: randomUUID(),
    expected_selection_ref: null, included_recorded_group_ids: originalGroupIds };
    const beforeCapture = await workspaceState();
    await refusal('complete-group-capture', completionCommand, 404, 'neighborhood_context_unavailable');
    assert.deepEqual(await workspaceState(), beforeCapture, 'HTTP cannot complete an unregistered capture');

    // A genuinely registered new immutable context, acquired by the installed
    // bounded HTTP capture, not a fabricated row or a durable-job claim.
    const captureResponse = await request('capture', { assignment_file_id: scope.assignment_file_id,
      operation_id: nextPending.operation_id, observation_period: period });
    assert.equal(captureResponse.status, 200); assert.equal(captureResponse.headers.get('cache-control'), 'no-store');
    const captured = await captureResponse.json();
    assert.equal(captured.context_ref.context_id, nextPending.operation_id);
    const catalogResponse = await request('catalog', { ...readBody(captured.context_ref),
      selection: { revision: 1, pockets: [] }, catalog_version: 3 });
    assert.equal(catalogResponse.status, 200);
    const catalog = (await catalogResponse.json()).catalog;
    assert.equal(catalog.catalog_complete, true);
    const groupIds = catalog.pockets.map(p => p.id);
    if (catalog.unassigned.member_count) groupIds.push('discovery:unassigned');
    assert.ok(groupIds.length > 0, 'native HTTP acceptance must use an actual nonempty subdivision population');
    const registeredState = await workspaceState();
    assert.deepEqual(registeredState.section, beforeCapture.section);
    assert.equal(registeredState.history, beforeCapture.history);
    assert.equal(registeredState.head, beforeCapture.head);
    const finish = { ...completionCommand, context_ref: captured.context_ref, included_recorded_group_ids: groupIds };
    denySource(true);
    try { await refusal('complete-group-capture', finish, 403, 'neighborhood_access_denied'); }
    finally { denySource(false); }
    assert.deepEqual(await workspaceState(), registeredState, 'registered context alone cannot replace active choices');
    loseNextCommit();
    await refusal('complete-group-capture', finish, 409, 'neighborhood_operation_outcome_unknown');
    const completedState = await workspaceState();
    const completed = await success('complete-group-capture', finish, 'reused');
    assert.deepEqual(await workspaceState(), completedState);
    assert.deepEqual(completed.workspace.value.active.context_ref, captured.context_ref);
    assert.deepEqual(completed.workspace.value.active.observation_period, period);
    assert.deepEqual(completed.workspace.value.active.selection_ref, completed.selection_ref);
    assert.equal(completed.workspace.value.pending_capture, null);
    assert.equal(completed.selection_ref.selection_revision, 1);

    const exactBody = { ...readBody(captured.context_ref), selection_ref: completed.selection_ref };
    const numericResponse = await request('selection-preview', exactBody);
    assert.equal(numericResponse.status, 200);
    const numeric = await numericResponse.json();
    assert.deepEqual(numeric.selection_ref, completed.selection_ref);
    assert.ok(numeric.summary.selected.account_count > 1);
    const openingResponse = await request('selection-map-opening', exactBody);
    assert.equal(openingResponse.status, 200);
    const opening = await openingResponse.json();
    assert.deepEqual(opening.selection_ref, numeric.selection_ref);
    assert.ok(opening.map_opening.manifest.counts.captured_parcels > 0);
    const memberResponse = await request('selection-members', { ...exactBody, population: { group: 'selected', kind: 'stock' },
      page: { limit: 1, after_member_id: null } });
    assert.equal(memberResponse.status, 200);
    const member = await memberResponse.json();
    assert.deepEqual(member.selection_ref, numeric.selection_ref);
    assert.equal(member.page.total_count, numeric.summary.selected.stock.member_count);
    assert.equal(member.page.returned_count, 1); assert.equal(member.page.has_more, true);

    const emptyCommand = { ...readBody(captured.context_ref), operation_id: randomUUID(),
      expected_workspace_revision: completed.workspace.revision, expected_selection_ref: completed.selection_ref,
      included_recorded_group_ids: [] };
    const empty = await success('save-groups', emptyCommand);
    assert.deepEqual(empty.included_recorded_group_ids, []);
    assert.deepEqual(empty.workspace.value.active.selection_ref, empty.selection_ref);
    const emptyResponse = await request('selection-preview', { ...exactBody, selection_ref: empty.selection_ref });
    assert.equal(emptyResponse.status, 200);
    assert.equal((await emptyResponse.json()).summary.selected.account_count, 0);
    await refusal('complete-group-capture', finish, 409, 'neighborhood_workspace_changed');
    await refusal('cancel-group-capture', transitionBody(started), 409, 'neighborhood_workspace_changed');
    assert.deepEqual(await protectedOther(), protectedBefore, 'all accepted/report/assignment rows remain byte-identical');
    assert.deepEqual((await coordinatorWorkspace()).rows, coordinatorBefore, 'original cold-start coordinator assignment remains untouched');
    return { checks: [
      'native opt-in four-command HTTP admission rejects anonymous/injected bodies before SQL; actual closed receipts preserve lost-COMMIT save/replay, stale CAS, current database actor/source/signing fences',
      'native start/cancel HTTP COMMIT-loss replay retains old active choices, opens no old source/map originals and advances history once without requiring a stale source grant',
      'native HTTP capture/completion requires a registered nonempty original context and current source authority, then reopens numeric/map/member projections at its same exact head; explicit empty and stale completion/cancel cannot rewind accepted/report rows',
    ] };
  } finally {
    denySource(false);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
