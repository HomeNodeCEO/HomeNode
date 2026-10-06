import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { prepareCustomCohortGroupWorkspaceTransportRequest as prepare,
  presentCustomCohortGroupWorkspaceTransportResponse as present } from '../src/services/neighborhoodAssessment/customCohortGroupWorkspaceTransport.js';

const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const operation = '70000000-0000-4000-8000-000000000002', A = `recorded-cad:${'a'.repeat(64)}`;
const period = { start_date: '2024-01-01', end_date: '2024-06-30' };
const discovery = { profile_id: 'custom-suburban-radius-v2', radius_metres: '4828.032' };
const ref = () => ({ selection_version: 1, selection_revision: 1, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '750000' } });
const empty = () => ({ workspace_version: 7, active: null, pending_capture: null });
const pending = () => ({ operation_id: context.context_id, observation_period: period });
const start = () => ({ assignment_file_id: '9007199254740993', expected_workspace_revision: 0,
  expected_workspace_checkpoint: empty(), pending_capture: pending() });
const cancel = () => ({ assignment_file_id: start().assignment_file_id, expected_workspace_revision: 1,
  expected_workspace_checkpoint: { ...empty(), pending_capture: pending() } });
const write = () => ({ assignment_file_id: start().assignment_file_id, context_ref: context, operation_id: operation,
  expected_selection_ref: null, included_recorded_group_ids: [A], expected_workspace_revision: 1 });
const complete = () => ({ ...write(), expected_workspace_checkpoint: cancel().expected_workspace_checkpoint });
const selected = () => ({ status: 'stored', authority: 'not_established', context_ref: context, selection_ref: ref(),
  included_recorded_group_ids: [A], operation_id: operation, workspace: { revision: 2, value: {
    workspace_version: 7, active: { context_ref: context, observation_period: period, selection_ref: ref() }, pending_capture: null } } });
const intent = (body, starting) => ({ status: 'stored', workspace: { revision: body.expected_workspace_revision + 1,
  value: { ...body.expected_workspace_checkpoint, pending_capture: starting ? body.pending_capture : null } } });

async function app(t, { enabled = true, authenticated = true, parsed = false, failure, respond } = {}) {
  const calls = [], auth = { userId: '70000000-0000-4000-8000-000000000003', organizations: [] };
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => assert.fail('legacy called')]));
  for (const name of ['selectAndSaveRecordedGroups', 'startRecordedGroupCapture', 'cancelRecordedGroupCapture', 'completeRecordedGroupCapture'])
    service[name] = async (input, options) => { calls.push({ name, input, options }); if (failure) throw failure;
      if (respond) return respond(name, input); if (name === 'selectAndSaveRecordedGroups' || name === 'completeRecordedGroupCapture') return selected();
      return intent({ expected_workspace_revision: input.expectedWorkspaceRevision,
        expected_workspace_checkpoint: input.expectedWorkspaceCheckpoint, pending_capture: input.pendingCapture }, name === 'startRecordedGroupCapture'); };
  const application = express(); application.set('json spaces', 8);
  application.use((req, _res, next) => { if (authenticated) req.mobileAuth = auth; next(); });
  if (parsed) application.use(express.json({ limit: 10_000_000 }));
  application.use(createCustomNeighborhoodCohortRouter({ cohortService: service, logger: {},
    ...(enabled ? { recordedGroupWorkspaceTransitions: true } : {}) }));
  const server = await new Promise(resolve => { const s = application.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (action, body) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/R-001/neighborhood-cohort/${action}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { calls, post, auth };
}

test('closed workspace transport detaches exact V7 pending intent; no automatic upgrade or population', () => {
  const input = start(); input.pending_capture = { ...pending(), discovery,
    private_sales_import: { batch_id: operation, expected_review_revision: 3 } };
  const prepared = prepare(input, 'start-group-capture'); input.pending_capture.observation_period = { ...period, end_date: '2024-05-01' };
  assert.deepEqual(prepared.pending_capture.observation_period, period); assert.ok(Object.isFrozen(prepared.pending_capture.discovery));
  assert.deepEqual(prepare(complete(), 'complete-group-capture').included_recorded_group_ids, [A]);
  assert.deepEqual(prepare({ ...write(), included_recorded_group_ids: [] }, 'save-groups').included_recorded_group_ids, []);
  assert.deepEqual(prepare(cancel(), 'cancel-group-capture'), cancel());
  for (const [body, action] of [
    [{ ...start(), expected_workspace_checkpoint: { ...empty(), workspace_version: 6 } }, 'start-group-capture'],
    [{ ...start(), pending_capture: null }, 'start-group-capture'],
    [{ ...start(), pending_capture: { ...pending(), source_rows: [] } }, 'start-group-capture'],
    [{ ...cancel(), expected_workspace_revision: 0 }, 'cancel-group-capture'],
    [{ ...write(), expected_workspace_revision: 0 }, 'save-groups'],
    [{ ...complete(), expected_selection_ref: ref() }, 'complete-group-capture'],
    [{ ...complete(), context_ref: { ...context, context_id: operation } }, 'complete-group-capture'],
    [{ ...start(), auth: {} }, 'start-group-capture'], [{ ...write(), included_recorded_group_ids: [A, A] }, 'save-groups'],
    [{ ...complete(), expected_workspace_checkpoint: empty() }, 'complete-group-capture'],
    [start(), 'unknown'],
  ]) assert.throws(() => prepare(body, action), { message: 'invalid_input' });
  const getter = Object.defineProperty(start(), 'pending_capture', { enumerable: true, get() { assert.fail('getter executed'); } });
  assert.throws(() => prepare(getter, 'start-group-capture'), { message: 'invalid_input' });
});

test('immediate response binds workspace CAS, active selection and pending study; hides all extras', () => {
  assert.deepEqual(present(selected(), prepare(write(), 'save-groups'), 'save-groups'), selected());
  assert.deepEqual(present(selected(), prepare(complete(), 'complete-group-capture'), 'complete-group-capture'), selected());
  assert.equal(present(intent(start(), true), prepare(start(), 'start-group-capture'), 'start-group-capture').authority, 'not_established');
  assert.equal(present(intent(cancel(), false), prepare(cancel(), 'cancel-group-capture'), 'cancel-group-capture').workspace.value.pending_capture, null);
  for (const mutate of [
    v => { v.workspace.revision = 3; }, v => { v.workspace.value.active.context_ref.context_sha256 = 'd'.repeat(64); },
    v => { v.workspace.value.active.selection_ref.selection_sha256 = 'd'.repeat(64); },
    v => { v.workspace.value.active.observation_period.start_date = '2023-01-01'; },
    v => { v.workspace.value.active.discovery = discovery; }, v => { v.workspace.value.pending_capture = pending(); },
    v => { v.source_rows = ['PRIVATE']; }, v => { v.workspace.history = ['PRIVATE']; },
  ]) { const value = structuredClone(selected()); mutate(value);
    assert.throws(() => present(value, prepare(complete(), 'complete-group-capture'), 'complete-group-capture'), /invalid_response/); }
  const altered = intent(start(), true); altered.workspace.value.pending_capture = { ...pending(), discovery };
  assert.throws(() => present(altered, prepare(start(), 'start-group-capture'), 'start-group-capture'), /invalid_response/);
});

test('workspace routes are unmounted by default and require all four owners on explicit opt-in', async t => {
  const f = await app(t, { enabled: false });
  for (const [action, body] of [['save-groups', write()], ['start-group-capture', start()], ['cancel-group-capture', cancel()], ['complete-group-capture', complete()]])
    assert.equal((await f.post(action, body)).status, 404);
  assert.equal(f.calls.length, 0);
  const required = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => {}]));
  assert.throws(() => createCustomNeighborhoodCohortRouter({ cohortService: required, recordedGroupWorkspaceTransitions: true }), /dependencies_required/);
  assert.throws(() => createCustomNeighborhoodCohortRouter({ cohortService: required, recordedGroupWorkspaceTransitions: 'true' }), /dependencies_required/);
});

test('opted-in routes pass only middleware principal and exact closed intent under finite cancellation gate', async t => {
  const f = await app(t), before = performance.now();
  for (const [action, body, name] of [['save-groups', write(), 'selectAndSaveRecordedGroups'],
    ['start-group-capture', start(), 'startRecordedGroupCapture'], ['cancel-group-capture', cancel(), 'cancelRecordedGroupCapture'],
    ['complete-group-capture', complete(), 'completeRecordedGroupCapture']]) {
    const response = await f.post(action, body); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const text = await response.text(); assert.equal(text, JSON.stringify(JSON.parse(text)));
    const call = f.calls.at(-1); assert.equal(call.name, name); assert.equal(call.input.auth, f.auth);
    assert.equal(call.input.assignmentFileId, '9007199254740993'); assert.equal(call.input.accountId, 'R-001');
    assert.ok(call.options.signal instanceof AbortSignal); assert.ok(call.options.deadline >= before + 60_000);
    assert.ok(call.options.deadline <= performance.now() + 60_000);
    assert.equal(Object.hasOwn(call.input, 'actor_user_id'), false);
  }
  assert.deepEqual(f.calls[0].input.includedRecordedGroupIds, [A]);
  assert.deepEqual(f.calls[1].input.expectedWorkspaceCheckpoint, empty());
  assert.deepEqual(f.calls[1].input.pendingCapture, pending());
  const anonymous = await app(t, { authenticated: false });
  assert.equal((await anonymous.post('start-group-capture', start())).status, 401); assert.equal(anonymous.calls.length, 0);
});

test('workspace HTTP rejects source/actor/member claims and oversized UTF-8 before owner work', async t => {
  for (const parsed of [false, true]) {
    const f = await app(t, { parsed });
    for (const extra of [{ auth: {} }, { actor_user_id: operation }, { account_ids: [] }, { source_rows: [] }, { accepted: {} }])
      assert.equal((await f.post('complete-group-capture', { ...complete(), ...extra })).status, 400);
    assert.equal((await f.post('start-group-capture', { ...start(), pending_capture: 'é'.repeat(140_000) })).status, 413);
    assert.equal(f.calls.length, 0);
  }
});

test('workspace conflict, rights, signed, lost-ACK and storage failures retain sanitized semantics', async t => {
  for (const [failure, status, error, retry] of [
    ...['revision_changed', 'study_changed', 'selection_changed', 'replay_changed', 'capture_pending', 'unavailable']
      .map(reason => [new TypeError(`custom_cohort_group_workspace_${reason}`), 409, 'neighborhood_workspace_changed']),
    [new Error('custom_appraisal_section_revision_conflict'), 409, 'neighborhood_workspace_changed'],
    [new Error('custom_appraisal_workfile_signed'), 409, 'neighborhood_private_source_read_only'],
    [new TypeError('custom_cohort_job_actor_access_revoked'), 403, 'neighborhood_access_denied'],
    [Object.assign(new Error('PRIVATE SQL'), { reason: 'market_data_access_denied' }), 403, 'neighborhood_access_denied'],
    [Object.assign(new Error('PRIVATE SQL'), { outcome_unknown: true }), 409, 'neighborhood_operation_outcome_unknown', true],
    [new TypeError('custom_cohort_group_workspace_storage_conflict'), 500, 'neighborhood_request_failed'],
  ]) { const f = await app(t, { failure }), response = await f.post('start-group-capture', start());
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error, ...(retry ? { retry_same_operation: true } : {}) }); }
  const leaky = await app(t, { respond: () => ({ ...selected(), original: 'PRIVATE' }) });
  assert.equal((await leaky.post('save-groups', write())).status, 500);
});
