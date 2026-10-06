import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as serverCheckpoint } from '../../server/src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';
import { prepareCustomCohortGroupWorkspaceTransportRequest as serverRequest,
  presentCustomCohortGroupWorkspaceTransportResponse as serverResponse } from '../../server/src/services/neighborhoodAssessment/customCohortGroupWorkspaceTransport.js';

const checkpoint = loadTrustedRepositoryCommonJs(new URL('../src/features/neighborhood/customWorkspaceCheckpoint.ts', import.meta.url),
  name => { if (name === './customWorkspaceDiscovery.ts') return discovery; assert.equal(name, './customCohortPocketCatalog'); return catalog; });
const helpers = loadTrustedRepositoryCommonJs(new URL('../src/features/neighborhood/customCohortGroupWorkspaceTransport.ts', import.meta.url),
  name => { const modules = { './customWorkspaceCheckpoint.ts': checkpoint, './customCohortPreviewTransport.ts': transport,
    './customCohortRecordedGroupTransport.ts': selection }; assert.ok(Object.hasOwn(modules, name), 'no persistence/authentication side imports'); return modules[name]; });
const { createCustomCohortGroupWorkspaceTransport: create, prepareCustomCohortGroupWorkspaceCheckpoint: prepare,
  readCustomCohortGroupWorkspaceSection: read } = helpers;
const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const operation = '70000000-0000-4000-8000-000000000002', A = `recorded-cad:${'a'.repeat(64)}`, B = `recorded-cad:${'b'.repeat(64)}`;
const period = { start_date: '2024-01-01', end_date: '2024-06-30' };
const radius = { profile_id: 'custom-suburban-radius-v2', radius_metres: '4828.032' };
const ref = () => ({ selection_version: 1, selection_revision: 1, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '750000' } });
const empty = () => ({ workspace_version: 7, active: null, pending_capture: null });
const pending = () => ({ operation_id: context.context_id, observation_period: structuredClone(period) });
const base = () => ({ accountId: 'R-001/#1', assignmentFileId: '9007199254740993' });
const start = () => ({ ...base(), expectedWorkspaceRevision: 0, expectedWorkspaceCheckpoint: empty(), pendingCapture: pending() });
const cancel = () => ({ ...base(), expectedWorkspaceRevision: 1, expectedWorkspaceCheckpoint: { ...empty(), pending_capture: pending() } });
const save = () => ({ ...base(), contextRef: structuredClone(context), operationId: operation, expectedSelectionRef: null,
  includedRecordedGroupIds: [B, A], expectedWorkspaceRevision: 1 });
const complete = () => ({ ...save(), expectedWorkspaceCheckpoint: cancel().expectedWorkspaceCheckpoint });
const active = () => ({ workspace_version: 7, active: { context_ref: context, observation_period: period, selection_ref: ref() }, pending_capture: null });
const written = () => ({ status: 'stored', authority: 'not_established', context_ref: context, selection_ref: ref(),
  included_recorded_group_ids: [A, B], operation_id: operation, workspace: { revision: 2, value: active() } });
const json = (value, init = {}) => new Response(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
function harness(respond = (_action, _body) => json(written())) {
  const calls = [], controller = new AbortController();
  const api = create({ request: async (url, init) => { const action = url.split('/').at(-1), body = JSON.parse(init.body);
    calls.push({ url, init, action, body }); return respond(action, body, init); }, urlFor: path => `https://example.invalid${path}` });
  return { calls, controller, call: (method, value) => api[method](value, { signal: controller.signal }) };
}

test('V7 small checkpoint parity preserves reference, pending/private/discovery and immutable intent without upgrading legacy', () => {
  const city = { profile_id: 'custom-city-polygon-v1', city: { geoid: '4819000', vintage: '2025-01-01', asset_sha256: 'd'.repeat(64) } };
  for (const value of [empty(), active(), { ...empty(), pending_capture: pending() },
    { ...active(), pending_capture: { ...pending(), operation_id: operation, discovery: radius,
      private_sales_import: { batch_id: operation, expected_review_revision: 3 } } },
    { ...active(), active: { ...active().active, discovery: city } }]) {
    const before = structuredClone(value), actual = prepare(value);
    assert.deepEqual(actual, serverCheckpoint(value)); assert.deepEqual(value, before); assert.ok(Object.isFrozen(actual));
    if (actual.active) assert.ok(Object.isFrozen(actual.active.selection_ref.manifest_ref));
    if (actual.pending_capture) assert.ok(Object.isFrozen(actual.pending_capture.observation_period));
  }
  for (const value of [{ ...empty(), workspace_version: 6 }, { ...active(), source_rows: [] },
    { ...active(), active: { ...active().active, selection: { revision: 1, included_recorded_group_ids: [] } } },
    { ...active(), active: { ...active().active, selection_ref: { ...ref(), selection_revision: 0 } } },
    { ...empty(), pending_capture: { ...pending(), observation_period: { start_date: '2023-02-29', end_date: '2024-01-01' } } },
    { ...active(), pending_capture: { ...pending(), discovery: radius } }]) {
    assert.throws(() => prepare(value));
    if (value.workspace_version === 7) assert.throws(() => serverCheckpoint(value));
    else assert.equal(serverCheckpoint(value).workspace_version, 6, 'existing server still admits its legacy version');
  }
  assert.equal(checkpoint.readCustomWorkspaceCheckpoint({ revision: 1, value: active() }).status, 'invalid', 'old reader must not activate V7');
});

test('V7 section reader distinguishes true absence from corrupt, future, legacy or metadata-bearing resets', () => {
  assert.deepEqual(read(undefined), { status: 'absent', section_revision: 0, checkpoint: null });
  assert.deepEqual(read({ revision: 3, value: active(), key: 'neighborhood_workspace', updated_by: 'actor', updated_at: 'date' }),
    { status: 'restored', section_revision: 3, checkpoint: active() });
  for (const value of [null, {}, { revision: 0, value: empty() }, { revision: 1, value: null },
    { revision: 1, value: { ...empty(), workspace_version: 6 } }, { revision: 1, value: empty(), key: 'neighborhood_assessment' },
    { revision: 1, value: empty(), updated_by: {} }, { revision: 1, value: empty(), authority: 'established' }])
    assert.deepEqual(read(value), { status: 'invalid', section_revision: null, checkpoint: null });
});

test('atomic save and completion bind exact selection/workspace CAS without generic writer or defaults', async () => {
  for (const method of ['save', 'complete']) {
    const h = harness(), request = method === 'save' ? save() : complete(), result = await h.call(method, request);
    assert.deepEqual(result, written()); assert.ok(Object.isFrozen(result.workspace.value.active.selection_ref));
    assert.equal(h.calls.length, 1); const call = h.calls[0]; assert.equal(call.init.signal, h.controller.signal); assert.equal(call.init.cache, 'no-store');
    assert.equal(call.url, `https://example.invalid/api/accounts/R-001%2F%231/neighborhood-cohort/${method === 'save' ? 'save-groups' : 'complete-group-capture'}`);
    assert.deepEqual(call.body.included_recorded_group_ids, [A, B]); assert.equal(call.body.expected_workspace_revision, 1);
    assert.deepEqual(serverRequest(call.body, call.action), call.body);
    assert.deepEqual(serverResponse(written(), call.body, call.action), result);
  }
  const h = harness(() => json({ ...written(), included_recorded_group_ids: [] }));
  assert.deepEqual((await h.call('save', { ...save(), includedRecordedGroupIds: [] })).included_recorded_group_ids, []);
});

test('start/cancel preserve active reference and use server exact pending transition receipt', async () => {
  const h = harness((action, body) => { const request = serverRequest(body, action);
    return json(serverResponse({ status: 'stored', workspace: { revision: request.expected_workspace_revision + 1,
      value: { ...request.expected_workspace_checkpoint, pending_capture: action === 'start-group-capture' ? request.pending_capture : null } } }, request, action)); });
  const started = await h.call('start', start()); assert.equal(started.workspace.revision, 1); assert.deepEqual(started.workspace.value.pending_capture, pending());
  assert.equal(started.authority, 'not_established'); const cancelled = await h.call('cancel', cancel());
  assert.equal(cancelled.workspace.revision, 2); assert.equal(cancelled.workspace.value.pending_capture, null);
  const oldActive = structuredClone(active()); const request = { ...start(), expectedWorkspaceRevision: 5,
    expectedWorkspaceCheckpoint: oldActive, pendingCapture: { ...pending(), operation_id: operation } };
  const kept = await h.call('start', request); assert.deepEqual(kept.workspace.value.active, oldActive.active);
  assert.equal(h.calls.length, 3); assert.equal(Object.hasOwn(h.calls[0].body, 'auth'), false);
});

test('all caller intent is detached before authentication I/O and lost-ACK retry never allocates a new operation', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const value = complete(), awaiting = h.call('complete', value);
  value.includedRecordedGroupIds.pop(); value.expectedWorkspaceCheckpoint.pending_capture.observation_period.end_date = '2024-05-01';
  value.contextRef.context_sha256 = 'e'.repeat(64);
  while (!finish) await Promise.resolve(); finish(json(written())); assert.deepEqual(await awaiting, written());
  assert.deepEqual(h.calls[0].body.expected_workspace_checkpoint.pending_capture.observation_period, period);
  const reused = harness(() => json({ ...written(), status: 'reused' }));
  assert.equal((await reused.call('complete', complete())).status, 'reused'); assert.equal(reused.calls[0].body.operation_id, operation);
});

test('malformed, actor/source/member-bearing and wrong pending/revision commands fail before authentication', async () => {
  for (const [method, request] of [
    ['save', { ...save(), auth: {} }], ['save', { ...save(), expectedWorkspaceRevision: 0 }], ['save', { ...save(), includedRecordedGroupIds: [A, A] }],
    ['complete', { ...complete(), expectedSelectionRef: ref() }], ['complete', { ...complete(), expectedWorkspaceCheckpoint: empty() }],
    ['complete', { ...complete(), contextRef: { ...context, context_id: operation } }],
    ['start', { ...start(), pendingCapture: null }], ['start', { ...start(), source_rows: [] }],
    ['start', { ...start(), expectedWorkspaceCheckpoint: { ...empty(), workspace_version: 6 } }],
    ['start', { ...start(), accountId: 'R\u0000-001' }], ['start', { ...start(), assignmentFileId: '9223372036854775808' }],
    ['cancel', { ...cancel(), expectedWorkspaceRevision: 0 }], ['cancel', { ...cancel(), expectedWorkspaceCheckpoint: empty() }],
  ]) { const h = harness(); await assert.rejects(h.call(method, request)); assert.equal(h.calls.length, 0); }
  const getter = Object.defineProperty(start(), 'pendingCapture', { enumerable: true, get() { assert.fail('getter executed'); } });
  await assert.rejects(harness().call('start', getter));
});

test('altered response context, groups, reference, CAS, study or raw fields cannot be published', async () => {
  for (const change of [
    v => { v.workspace.revision = 3; }, v => { v.workspace.value.active.selection_ref.selection_sha256 = 'd'.repeat(64); },
    v => { v.workspace.value.active.observation_period.end_date = '2024-05-01'; }, v => { v.workspace.value.active.discovery = radius; },
    v => { v.workspace.value.pending_capture = pending(); }, v => { v.included_recorded_group_ids = [A]; },
    v => { v.authority = 'established'; }, v => { v.originals = ['PRIVATE']; }, v => { v.workspace.history = ['PRIVATE']; },
  ]) { const bad = structuredClone(written()); change(bad); await assert.rejects(harness(() => json(bad)).call('complete', complete())); }
  const bad = { status: 'stored', authority: 'not_established', workspace: { revision: 1, value: { ...empty(), pending_capture: { ...pending(), discovery: radius } } } };
  await assert.rejects(harness(() => json(bad)).call('start', start()));
});

test('bounded transport preserves sanitized refusal/lost-ACK semantics with no automatic retry', async () => {
  for (const [status, body] of [[409, { error: 'neighborhood_workspace_changed' }],
    [409, { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true }],
    [403, { error: 'neighborhood_access_denied' }], [503, { error: 'neighborhood_request_interrupted' }]]) {
    const h = harness(() => json(body, { status }));
    await assert.rejects(h.call('start', start()), e => e.status === status && e.errorCode === body.error); assert.equal(h.calls.length, 1);
  }
});

test('new group workspace operations retain 262144 UTF-8 request/response ceilings and abort in-flight authentication', async () => {
  const controller = new AbortController(), calls = [];
  const raw = transport.createCustomCohortJsonTransport({ request: async (_u, init) => { calls.push(init); return json({ text: 'é'.repeat(140000) }); }, urlFor: p => p });
  for (const action of ['save-groups', 'start-group-capture', 'cancel-group-capture', 'complete-group-capture']) {
    await assert.rejects(raw('R-1', action, { text: 'é'.repeat(140000) }, { signal: controller.signal }), /too large/);
    await assert.rejects(raw('R-1', action, {}, { signal: controller.signal }), /too large/);
  }
  assert.equal(calls.length, 4);
  let resolveAuth; const h = harness(() => new Promise(resolve => { resolveAuth = resolve; }));
  const awaiting = h.call('start', start()); while (!resolveAuth) await Promise.resolve(); h.controller.abort();
  await assert.rejects(awaiting, e => e.name === 'AbortError'); resolveAuth(json({})); assert.equal(h.calls.length, 1);
});
