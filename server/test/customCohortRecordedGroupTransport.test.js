import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { prepareCustomCohortRecordedGroupTransportRequest as prepare,
  presentCustomCohortRecordedGroupTransportResponse as present } from '../src/services/neighborhoodAssessment/customCohortRecordedGroupTransport.js';

const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const operation = '70000000-0000-4000-8000-000000000002';
const A = `recorded-cad:${'a'.repeat(64)}`, B = `recorded-cad:${'b'.repeat(64)}`;
const read = () => ({ assignment_file_id: '9007199254740993', context_ref: structuredClone(context) });
const write = () => ({ ...read(), operation_id: operation, expected_selection_ref: null, included_recorded_group_ids: [B, A] });
const ref = (revision = 1) => ({ selection_version: 1, selection_revision: revision,
  selection_sha256: 'b'.repeat(64), manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '750000' } });
const result = () => ({ status: 'stored', authority: 'not_established', context_ref: structuredClone(context),
  selection_ref: ref(), included_recorded_group_ids: [A, B], operation_id: operation });

async function app(t, { parsed = false, authenticated = true, enabled = true, failure, respond = result } = {}) {
  const calls = [], auth = { userId: '70000000-0000-4000-8000-000000000003', organizations: [] };
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(key => [key, () => assert.fail('legacy owner called')]));
  if (enabled) Object.assign(service, {
    selectRecordedGroups: async (...args) => { calls.push(['write', ...args]); if (failure) throw failure; return respond(...args); },
    readRecordedGroupSelection: async (...args) => { calls.push(['read', ...args]); if (failure) throw failure;
      return { status: 'absent', authority: 'not_established', context_ref: context,
        selection_ref: null, included_recorded_group_ids: null }; },
  });
  const application = express(); application.set('json spaces', 8);
  application.use((req, _res, next) => { if (authenticated) req.mobileAuth = auth; next(); });
  if (parsed) application.use(express.json({ limit: 10_000_000 }));
  application.use(createCustomNeighborhoodCohortRouter({ cohortService: service, logger: {} }));
  const server = await new Promise(resolve => { const s = application.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (action, body, extra = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/R-001/neighborhood-cohort/${action}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra });
  return { calls, post, auth };
}

test('closed syntax detaches group IDs, predecessor and context; empty is not absent', () => {
  const body = write(), request = prepare(body, true);
  body.context_ref.context_sha256 = 'd'.repeat(64); body.included_recorded_group_ids.pop();
  assert.deepEqual(request.included_recorded_group_ids, [A, B]); assert.deepEqual(request.context_ref, context);
  assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.included_recorded_group_ids), true);
  assert.deepEqual(prepare({ ...write(), included_recorded_group_ids: [] }, true).included_recorded_group_ids, []);
  assert.deepEqual(prepare(read(), false), read());
  for (const body of [
    { ...write(), actor_user_id: operation }, { ...write(), auth: {} }, { ...write(), account_ids: [] },
    { ...write(), included_recorded_group_ids: [A, A] }, { ...write(), included_recorded_group_ids: ['R-001'] },
    { ...write(), operation_id: 'not-an-operation' }, { ...write(), expected_selection_ref: ref(2147483647) },
    { ...write(), expected_selection_ref: { ...ref(), extra: true } }, { ...write(), assignment_file_id: 7 },
    { ...read(), context_ref: { ...context, authority: 'granted' } },
  ]) assert.throws(() => prepare(body, Object.hasOwn(body, 'operation_id')), { message: 'invalid_input' });
  const getter = Object.defineProperty(write(), 'operation_id', { enumerable: true, get() { assert.fail('getter executed'); } });
  assert.throws(() => prepare(getter, true), { message: 'invalid_input' });
});

test('intent responses bind exact context/operation/revision/groups, and disclose no extras', () => {
  const request = prepare(write(), true);
  assert.deepEqual(present(result(), request, true), result());
  assert.deepEqual(present({ status: 'absent', authority: 'not_established', context_ref: context,
    selection_ref: null, included_recorded_group_ids: null }, prepare(read(), false), false).included_recorded_group_ids, null);
  const empty = { ...result(), included_recorded_group_ids: [], status: 'selected' }; delete empty.operation_id;
  assert.deepEqual(present(empty, prepare(read(), false), false).included_recorded_group_ids, []);
  for (const changed of [
    { ...result(), source_rows: ['PRIVATE'] }, { ...result(), authority: 'established' }, { ...result(), status: 'applied' },
    { ...result(), operation_id: context.context_id }, { ...result(), selection_ref: ref(2) },
    { ...result(), included_recorded_group_ids: [B, A] }, { ...result(), included_recorded_group_ids: [A] },
    { ...result(), context_ref: { ...context, context_sha256: 'e'.repeat(64) } },
  ]) assert.throws(() => present(changed, request, true), /invalid_response/);
});

test('new routes pass only middleware identity and ID intent, under the existing finite gate', async t => {
  const f = await app(t), before = performance.now();
  const response = await f.post('select-groups', write());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), JSON.stringify(result()), 'app-wide indentation cannot expand this response');
  assert.deepEqual(f.calls[0][1], { auth: f.auth, accountId: 'R-001', assignmentFileId: '9007199254740993',
    contextRef: context, operationId: operation, expectedSelectionRef: null, includedRecordedGroupIds: [A, B] });
  assert.ok(f.calls[0][2].signal instanceof AbortSignal);
  assert.ok(f.calls[0][2].deadline >= before + 60_000 && f.calls[0][2].deadline <= performance.now() + 60_000);
  const reopened = await f.post('group-selection', read()); assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).status, 'absent');
  assert.deepEqual(f.calls[1][1], { auth: f.auth, accountId: 'R-001', assignmentFileId: '9007199254740993', contextRef: context });
  const anonymous = await app(t, { authenticated: false });
  assert.equal((await anonymous.post('select-groups', write())).status, 401); assert.equal(anonymous.calls.length, 0);
  const old = await app(t, { enabled: false });
  assert.equal((await old.post('select-groups', write())).status, 404); assert.equal(old.calls.length, 0);
});

test('closed group requests refuse source/member/actor claims and oversized original UTF-8 before owner work', async t => {
  for (const parsed of [false, true]) {
    const f = await app(t, { parsed });
    for (const extra of [{ auth: {} }, { actor_user_id: operation }, { source_rows: [] }, { manifest_ref: ref().manifest_ref },
      { selection: { pockets: [] } }, { include_map: true }]) {
      const response = await f.post('select-groups', { ...write(), ...extra });
      assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'invalid_neighborhood_request' });
    }
    const oversized = await f.post('select-groups', { ...write(), operation_id: 'é'.repeat(140_000) });
    assert.equal(oversized.status, 413); assert.equal(oversized.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await oversized.json(), { error: 'neighborhood_request_too_large' });
    assert.equal(f.calls.length, 0);
  }
});

test('selection errors preserve exact conflict/retry semantics and hide originals/SQL', async t => {
  for (const [failure, status, payload] of [
    [new TypeError('custom_cohort_group_selection_selection_changed'), 409, { error: 'neighborhood_selection_changed' }],
    [new TypeError('custom_cohort_group_selection_operation_conflict'), 409, { error: 'neighborhood_operation_conflict' }],
    [new TypeError('custom_cohort_recorded_group_selection_unknown_group'), 409, { error: 'neighborhood_selection_changed' }],
    [new TypeError('custom_cohort_job_actor_access_revoked'), 403, { error: 'neighborhood_access_denied' }],
    [Object.assign(new Error('PRIVATE SQL'), { reason: 'market_data_access_denied' }), 403, { error: 'neighborhood_access_denied' }],
    [Object.assign(new Error('PRIVATE SQL'), { reason: 'private_source_read_only' }), 409, { error: 'neighborhood_private_source_read_only' }],
    [Object.assign(new Error('PRIVATE SQL'), { outcome_unknown: true }), 409,
      { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true }],
    [new TypeError('custom_cohort_group_selection_storage_conflict'), 500, { error: 'neighborhood_request_failed' }],
  ]) {
    const f = await app(t, { failure }), response = await f.post('select-groups', write());
    assert.equal(response.status, status); assert.deepEqual(await response.json(), payload);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const leaky = await app(t, { respond: () => ({ ...result(), originals: 'PRIVATE' }) });
  const denied = await leaky.post('select-groups', write());
  assert.equal(denied.status, 500); assert.deepEqual(await denied.json(), { error: 'neighborhood_request_failed' });
});
