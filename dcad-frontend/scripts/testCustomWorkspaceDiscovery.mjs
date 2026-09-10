import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { privateSalesSummaryFixture } from './fixtures/customPrivateSalesSummaryFixture.mjs';
import { prepareCustomNeighborhoodWorkspaceCheckpoint as serverPrepare,
  readCustomNeighborhoodWorkspaceCheckpoint as serverRead } from '../../server/src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';

const ts = createRequire(new URL('../package.json', import.meta.url))('typescript');
function compile(name, imports) {
  const file = fileURLToPath(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url));
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${result.outputText}\n})`, { filename: file }).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected dependency: ${key}`); return imports[key];
  }, module, module.exports);
  return module.exports;
}
const checkpoint = compile('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers,
  './customWorkspaceDiscovery.ts': compile('customWorkspaceDiscovery', {}) });
const { prepareCustomWorkspaceCheckpoint: prepare, readCustomWorkspaceCheckpoint: read,
  prepareCustomWorkspaceDiscovery: prepareDiscovery } = checkpoint;
const { createCustomWorkspaceLifecycle: createLifecycle } = compile('customWorkspaceLifecycle', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPocketCatalog': catalogHelpers,
});
const { createCustomWorkspaceApi: createApi } = compile('customWorkspaceApi', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': compile('customCohortPreviewTransport', {}),
});
const RADII = ['4828.032', '8046.72', '16093.44'];
const choice = radius => ({ profile_id: 'custom-suburban-radius-v2', radius_metres: radius });
const TARGET = { accountId: 'SUBJECT', assignmentFileId: '37', sessionKey: 'discovery-test' };
const PERIOD = { start_date: '2026-01-01', end_date: '2026-09-10' };
const OP = '10000000-0000-4000-8000-000000000001', OLD = '10000000-0000-4000-8000-000000000002';
const PRIVATE = { batch_id: '20000000-0000-4000-8000-000000000003', expected_review_revision: 7 };
const GROUP = `recorded-cad:${'a'.repeat(64)}`;
const context = id => ({ context_id: id, context_revision: '1', context_sha256: 'b'.repeat(64) });
const copy = value => structuredClone(value);
const active = (discovery, id = OLD) => ({ context_ref: context(id), observation_period: copy(PERIOD),
  selection: { revision: 4, included_recorded_group_ids: [] }, ...(discovery ? { discovery: copy(discovery) } : {}) });
const section = (discovery, pending = null) => ({ revision: 5, value: { workspace_version: discovery || pending?.discovery ? 3 : 1,
  active: active(discovery), pending_capture: pending } });
const pending = (discovery, privateInput) => ({ operation_id: OP, observation_period: copy(PERIOD),
  ...(privateInput ? { private_sales_import: copy(privateInput) } : {}), ...(discovery ? { discovery: copy(discovery) } : {}) });
function catalog(input, privateInput) {
  const result = { status: 'catalog', subject_freshness: 'matched', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: copy(input.contextRef), selection_revision: input.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: 1, status: 'review_only', apply: { status: 'blocked' },
      binding: { context_ref: copy(input.contextRef), selection_revision: input.selection.revision },
      pockets: [{ id: GROUP, label: 'Synthetic group', county: 'Synthetic', account_ids: ['SUBJECT'], member_count: 1, disposition: 'needs_review' }],
      unassigned: { account_ids: [], member_count: 0, reason_counts: [] },
      coverage: { discovery_member_count: 1, assigned_account_count: 1, unassigned_account_count: 0 },
      subject_membership: { account_id: 'SUBJECT', assigned_pocket_id: GROUP, recorded_label_match_only: true, status: 'matched' }, limitations: [],
    } };
  if (privateInput) {
    result.private_sales = privateSalesSummaryFixture({ input, privateSalesImport: privateInput, period: PERIOD });
    result.catalog.binding.selection_sha256 = result.private_sales.binding.selection_sha256;
  }
  return result;
}
const captureReply = input => ({ status: 'registered', reused: false, context_ref: context(input.operationId), source_query_complete: true,
  discovery: { radius_metres: input.discovery?.radius_metres ?? '4828.032', account_count: 1, parcel_count: 1 },
  ...(input.privateSalesImport ? { private_sales_import: copy(input.privateSalesImport) } : {}) });
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const rejection = (promise, code) => assert.rejects(promise, e => e.workspaceCode === code);
function harness({ initialSection, save, capture } = {}) {
  const calls = [], db = { section: copy(initialSection) }; let ids = 0, privateInput = initialSection?.value.pending_capture?.private_sales_import;
  const commit = input => {
    assert.equal(input.expectedRevision, db.section?.revision ?? 0);
    db.section = { value: copy(input.value), revision: input.expectedRevision + 1 };
    return { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, section: copy(db.section) };
  };
  const owner = createLifecycle({ target: TARGET, initialSection, onChange() {}, operationId: () => { ids++; return OP; },
    save: async (input, io) => { calls.push({ kind: 'save', input: copy(input), io }); return save ? save(input, io, commit) : commit(input); },
    capture: async (input, io) => { calls.push({ kind: 'capture', input: copy(input), io }); privateInput = input.privateSalesImport;
      return capture ? capture(input, io) : captureReply(input); },
    catalog: async (input, io) => { calls.push({ kind: 'catalog', input: copy(input), io }); return catalog(input, input.contextRef.context_id === OP ? privateInput : null); },
  });
  return { owner, calls, db, get ids() { return ids; }, reload: () => owner.reload({ target: TARGET, section: copy(db.section) }) };
}
function apiHarness(reply) {
  const requests = [], api = createApi({ urlFor: path => path, editorKeyForSave: () => 'synthetic-editor-key',
    request: async (url, init) => { requests.push({ url, init }); const body = JSON.parse(init.body);
      const value = reply ? await reply(body) : captureReply({ operationId: body.operation_id, discovery: body.discovery });
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); },
  });
  return { api, requests };
}
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });

test('installed discovery choices are fixed, detached and frozen', () => {
  assert.deepEqual(checkpoint.CUSTOM_WORKSPACE_DISCOVERY_RADII_METRES, RADII);
  for (const radius of RADII) { const raw = choice(radius), checked = prepareDiscovery(raw); raw.radius_metres = 'wrong';
    assert.deepEqual(checked, choice(radius)); assert.ok(Object.isFrozen(checked)); }
});
for (const radius of RADII) for (const privateInput of [null, PRIVATE]) {
  test(`v3 ${radius} with private=${Boolean(privateInput)} has actual server parity and preserves legacy active`, () => {
    const raw = section(undefined, pending(choice(radius), privateInput)), result = prepare(raw.value);
    assert.deepEqual(result, serverPrepare(raw.value)); assert.deepEqual(read(raw), serverRead(raw));
    assert.deepEqual(result.active, active()); assert.deepEqual(result.active.selection.included_recorded_group_ids, []);
    assert.ok(Object.isFrozen(result.pending_capture.discovery)); raw.value.pending_capture.discovery.radius_metres = 'wrong';
    assert.equal(result.pending_capture.discovery.radius_metres, radius);
  });
  test(`lifecycle ${radius} with private=${Boolean(privateInput)} saves exact intent before capture and activation`, async () => {
    const h = harness({ initialSection: section() });
    try { const state = await h.owner.start(PERIOD, privateInput ?? undefined, choice(radius));
      assert.deepEqual(h.calls.map(c => c.kind), ['save', 'capture', 'catalog', 'save']);
      assert.deepEqual(h.calls[0].input.value.active, active()); assert.equal(h.calls[0].input.value.workspace_version, 3);
      assert.deepEqual(h.calls[1].input.discovery, choice(radius)); assert.deepEqual(state.checkpoint.active.discovery, choice(radius));
      assert.equal(state.checkpoint.pending_capture, null); assert.equal(state.status, 'ready'); assert.equal(h.ids, 1);
      assert.deepEqual(state.checkpoint.active.selection.included_recorded_group_ids, [GROUP]);
    } finally { h.owner.dispose(); }
  });
  test(`API emits exact ${radius} discovery with private=${Boolean(privateInput)}`, async () => {
    const h = apiHarness(); await h.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD,
      discovery: choice(radius), ...(privateInput ? { privateSalesImport: privateInput } : {}) }, io());
    assert.equal(h.requests.length, 1); assert.deepEqual(JSON.parse(h.requests[0].init.body), {
      assignment_file_id: '37', operation_id: OP, observation_period: PERIOD,
      ...(privateInput ? { private_sales_import: privateInput } : {}), discovery: choice(radius) });
  });
}
for (const bad of [undefined, null, {}, [], { ...choice('8046.72'), extra: true },
  { ...choice('8046.72'), profile_id: 'custom-simple-suburban-radius-v1' }, choice(8046.72), choice('8046.720'), choice(' 8046.72'), choice('8.04672e3'), choice('32186.88')]) {
  test(`invalid discovery ${JSON.stringify(bad)} is never defaulted in checkpoint or API`, async () => {
    const raw = section(undefined, pending(choice('8046.72'))); raw.value.pending_capture.discovery = bad;
    assert.throws(() => prepare(raw.value)); assert.throws(() => serverPrepare(raw.value));
    const h = apiHarness(); await rejection(h.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD, discovery: bad }, io()), 'invalid_input');
    assert.equal(h.requests.length, 0);
  });
}
test('discovery accessor is rejected without invoking it', () => {
  let calls = 0; const raw = choice('8046.72');
  Object.defineProperty(raw, 'radius_metres', { enumerable: true, get() { calls++; return '8046.72'; } });
  assert.throws(() => prepareDiscovery(raw)); const value = section(undefined, pending(choice('8046.72'))).value;
  value.pending_capture.discovery = raw; assert.throws(() => prepare(value)); assert.throws(() => serverPrepare(value)); assert.equal(calls, 0);
});
test('v1/v2 forbid discovery; v3 distinguishes absent discovery from explicit three miles on same operation', () => {
  for (const version of [1, 2]) for (const slot of ['active', 'pending_capture']) {
    const value = section(undefined, pending(undefined, version === 2 ? PRIVATE : null)).value; value.workspace_version = version;
    value[slot].discovery = choice('4828.032'); assert.throws(() => prepare(value)); assert.throws(() => serverPrepare(value));
  }
  const value = section(undefined, pending(choice('4828.032'))).value; value.active = active(undefined, OP);
  assert.throws(() => prepare(value), e => e.checkpointReason === 'operation_discovery_conflict'); assert.throws(() => serverPrepare(value));
  value.active.discovery = choice('4828.032'); assert.deepEqual(prepare(value), serverPrepare(value));
  value.pending_capture.discovery = choice('8046.72'); assert.throws(() => prepare(value)); assert.throws(() => serverPrepare(value));
  value.pending_capture.discovery = choice('4828.032'); value.pending_capture.observation_period.start_date = '2025-01-01';
  assert.throws(() => prepare(value), e => e.checkpointReason === 'operation_study_conflict');
});
test('legacy omitted API and lifecycle retain exact three-mile request/checkpoint shapes', async () => {
  const a = apiHarness(); await a.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD }, io());
  assert.deepEqual(JSON.parse(a.requests[0].init.body), { assignment_file_id: '37', operation_id: OP, observation_period: PERIOD });
  const h = harness(); try { await h.owner.start(PERIOD); const saved = h.db.section.value;
    assert.equal(saved.workspace_version, 1); assert.equal(Object.hasOwn(saved.active, 'discovery'), false);
    assert.equal(Object.hasOwn(h.calls.find(c => c.kind === 'capture').input, 'discovery'), false);
  } finally { h.owner.dispose(); }
});
test('capture input mutation while pending save awaits cannot change durable discovery, dates or private reference', async () => {
  const entered = defer(), held = defer(), h = harness({ save: async (input, _io, commit) => {
    if (input.value.pending_capture) { entered.resolve(); await held.promise; } return commit(input); } });
  const discovery = choice('8046.72'), period = copy(PERIOD), source = copy(PRIVATE);
  try { const work = h.owner.start(period, source, discovery); await entered.promise;
    discovery.radius_metres = '16093.44'; period.start_date = '2025-01-01'; source.expected_review_revision++;
    held.resolve(); await work; const call = h.calls.find(c => c.kind === 'capture');
    assert.deepEqual(call.input.discovery, choice('8046.72')); assert.deepEqual(call.input.observationPeriod, PERIOD);
    assert.deepEqual(call.input.privateSalesImport, PRIVATE); assert.deepEqual(h.db.section.value.active.discovery, choice('8046.72'));
  } finally { held.resolve(); h.owner.dispose(); }
});
for (const radius of [undefined, null, 8046.72, '4828.032', '8046.720', '16093.44']) {
  test(`wrong/missing capture radius ${String(radius)} preserves previous active and allows only explicit retry`, async () => {
    let attempts = 0; const h = harness({ initialSection: section(), capture: input => {
      const result = captureReply(input); if (!attempts++) result.discovery.radius_metres = radius; return result; } });
    try { await rejection(h.owner.start(PERIOD, undefined, choice('8046.72')), 'capture_discovery_mismatch');
      assert.deepEqual(h.db.section.value.active, active()); assert.deepEqual(h.db.section.value.pending_capture.discovery, choice('8046.72'));
      assert.deepEqual(h.calls.map(c => c.kind), ['save', 'capture']); assert.equal(h.owner.getState().recovery, 'resume_pending');
      await h.owner.resumePending(); assert.deepEqual(h.calls.filter(c => c.kind === 'capture').map(c => c.input.operationId), [OP, OP]);
      assert.deepEqual(h.db.section.value.active.discovery, choice('8046.72')); assert.equal(h.ids, 1);
    } finally { h.owner.dispose(); }
  });
}
test('saved expanded private pending resumes after remount without a new UUID or inferred choice', async () => {
  const initial = section(undefined, pending(choice('16093.44'), PRIVATE)), h = harness({ initialSection: initial });
  try { await h.owner.resumePending(); assert.deepEqual(h.calls.map(c => c.kind), ['capture', 'catalog', 'save']);
    assert.deepEqual(h.calls[0].input.discovery, choice('16093.44')); assert.deepEqual(h.calls[0].input.privateSalesImport, PRIVATE); assert.equal(h.ids, 0);
  } finally { h.owner.dispose(); }
});
test('lost pending ACK keeps the exact discovery and UUID across absent reload then resume', async () => {
  let first = true; const h = harness({ save(input, _io, commit) { if (first) { first = false; throw Error('unknown'); } return commit(input); } });
  try { await rejection(h.owner.start(PERIOD, undefined, choice('8046.72')), 'operation_failed'); await h.reload();
    await rejection(h.owner.start(PERIOD, undefined, choice('16093.44')), 'recovery_required'); await h.owner.resumePending();
    assert.equal(h.ids, 1); assert.deepEqual(h.calls.find(c => c.kind === 'capture').input.discovery, choice('8046.72'));
  } finally { h.owner.dispose(); }
});
for (const changed of [false, true]) test(`lost active ACK reload ${changed ? 'cannot resolve changed' : 'resolves exact'} discovery`, async () => {
  const h = harness({ save(input, _io, commit) { const ack = commit(input); if (input.value.active?.context_ref.context_id === OP) throw Error('lost active'); return ack; } });
  try { await rejection(h.owner.start(PERIOD, undefined, choice('8046.72')), 'operation_failed');
    if (changed) h.db.section.value.active.discovery = choice('16093.44');
    await h.reload(); assert.equal(h.owner.getState().recovery, changed ? 'resume_pending' : null);
    assert.equal(h.calls.filter(c => c.kind === 'capture').length, 1);
  } finally { h.owner.dispose(); }
});
test('expanded active requires deliberate discovery for new capture; no downgrade or lost empty selection on reopen', async () => {
  const h = harness({ initialSection: section(choice('16093.44')) });
  try { await h.owner.reopen(); assert.deepEqual(h.owner.getState().checkpoint.active.selection.included_recorded_group_ids, []);
    assert.deepEqual(h.owner.getState().selection.pockets, []); const count = h.calls.length;
    await rejection(h.owner.start(PERIOD), 'discovery_required'); assert.equal(h.calls.length, count); assert.equal(h.ids, 0);
    await h.owner.start(PERIOD, undefined, choice('4828.032'));
    assert.deepEqual(h.calls.find(c => c.kind === 'save').input.value.active.discovery, choice('16093.44'));
    assert.deepEqual(h.db.section.value.active.discovery, choice('4828.032'));
  } finally { h.owner.dispose(); }
});
test('set aside failed expanded pending preserves prior active and does not recapture', async () => {
  const h = harness({ initialSection: section(choice('4828.032'), pending(choice('16093.44'))) });
  try { await h.owner.setAsidePending(); assert.deepEqual(h.calls.map(c => c.kind), ['save', 'catalog']);
    assert.deepEqual(h.db.section.value.active, active(choice('4828.032'))); assert.equal(h.db.section.value.pending_capture, null);
  } finally { h.owner.dispose(); }
});
for (const radius of [null, 8046.72, '4828.032', '8046.720', '32186.88']) test(`API rejects unbound response radius ${String(radius)}`, async () => {
  const h = apiHarness(body => ({ ...captureReply({ operationId: body.operation_id }), discovery: { radius_metres: radius } }));
  await rejection(h.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD, discovery: choice('8046.72') }, io()), 'capture_discovery_mismatch');
  assert.equal(h.requests.length, 1);
});
test('API captures expected choice before awaiting and rejects omitted discovery in a successful envelope', async () => {
  const entered = defer(), held = defer(), discovery = choice('8046.72');
  const h = apiHarness(async body => { entered.resolve(); await held.promise; return captureReply({ operationId: body.operation_id, discovery: body.discovery }); });
  const work = h.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD, discovery }, io());
  await entered.promise; discovery.radius_metres = '16093.44'; held.resolve(); assert.equal((await work).discovery.radius_metres, '8046.72');
  const missing = apiHarness(() => ({ status: 'registered' }));
  await rejection(missing.api.capture({ target: TARGET, operationId: OP, observationPeriod: PERIOD }, io()), 'invalid_response');
});
