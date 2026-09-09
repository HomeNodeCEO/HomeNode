import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript');
function compile(name, imports) {
  const file = fileURLToPath(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url));
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${result.outputText}\n})`, { filename: file }).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected lifecycle dependency: ${key}`); return imports[key];
  }, module, module.exports);
  return module.exports;
}
const checkpointHelpers = compile('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers });
const { createCustomWorkspaceLifecycle: create } = compile('customWorkspaceLifecycle', {
  './customWorkspaceCheckpoint': checkpointHelpers, './customCohortPocketCatalog': catalogHelpers,
});
const TARGET = Object.freeze({ accountId: 'SUBJECT', assignmentFileId: '9007199254740993', sessionKey: 'synthetic-session-1' });
const OPERATION = '10000000-0000-4000-8000-000000000001', OLD = '10000000-0000-4000-8000-000000000002';
const PERIOD = Object.freeze({ start_date: '2023-01-01', end_date: '2024-02-29' });
const groupId = number => `recorded-cad:${number.toString(16).padStart(64, '0')}`;
const context = id => ({ context_id: id, context_revision: '1', context_sha256: 'a'.repeat(64) });
const copy = value => structuredClone(value);
function activeSection() {
  return { revision: 5, value: { workspace_version: 1, active: { context_ref: context(OLD), observation_period: copy(PERIOD),
    selection: { revision: 9, included_recorded_group_ids: [groupId(2)] } }, pending_capture: null } };
}
function captured(input) { return { status: 'registered', reused: false, context_ref: context(input.operationId),
  source_query_complete: true, provider_coverage: 'not_established', discovery: { account_count: 3, parcel_count: 3, radius_metres: '4828.032' },
  unsupported_capabilities: ['historical_characteristics'] }; }
function catalog(input) {
  return { status: 'catalog', subject_freshness: 'matched', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: copy(input.contextRef), selection_revision: input.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: 1, status: 'review_only', apply: { status: 'blocked' },
      binding: { context_ref: copy(input.contextRef), selection_revision: input.selection.revision },
      pockets: ['SUBJECT', 'B'].map((id, index) => ({ id: groupId(index + 1), disposition: 'needs_review', label: `Synthetic group ${index}`,
        county: 'Synthetic', account_ids: [id], member_count: 1 })),
      unassigned: { account_ids: ['C'], member_count: 1, reason_counts: [] },
      coverage: { discovery_member_count: 3, assigned_account_count: 2, unassigned_account_count: 1 },
      subject_membership: { account_id: 'SUBJECT', assigned_pocket_id: groupId(1), recorded_label_match_only: true, status: 'matched' }, limitations: [],
    } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function harness({ initialSection, save, capture, loadCatalog, timeoutMs = 1000, onChange } = {}) {
  const calls = [], states = [], timers = new Map(); let clock = 100, timerId = 0, ids = 0, open = 0, maxOpen = 0;
  const db = { section: copy(initialSection) };
  const commit = input => {
    assert.equal(input.sectionKey, 'neighborhood_workspace');
    assert.deepEqual(input.target, TARGET);
    if (input.expectedRevision !== (db.section?.revision ?? 0)) throw new Error('synthetic section CAS conflict');
    db.section = { key: input.sectionKey, revision: input.expectedRevision + 1, value: copy(input.value) };
    return { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, section: copy(db.section) };
  };
  const invoke = async (kind, input, options, fn) => {
    calls.push({ kind, input: copy(input), signal: options.signal, deadline: options.deadline });
    assert.ok(options.signal instanceof AbortSignal && Number.isFinite(options.deadline) && options.deadline > clock);
    open += 1; maxOpen = Math.max(maxOpen, open);
    try { return await fn(input, options); } finally { open -= 1; }
  };
  const controller = create({ target: copy(TARGET), initialSection, timeoutMs, now: () => clock,
    timer: { set(fn) { timers.set(++timerId, fn); return timerId; }, clear(id) { timers.delete(id); } },
    operationId: () => { ids += 1; return OPERATION; },
    onChange: value => { states.push(value); onChange?.(value); },
    save: (input, options) => invoke('save', input, options, save ? (value, opts) => save(value, opts, commit) : commit),
    capture: (input, options) => invoke('capture', input, options, capture ?? captured),
    catalog: (input, options) => invoke('catalog', input, options, loadCatalog ?? catalog),
  });
  return { controller, db, calls, states, timers, get ids() { return ids; }, get maxOpen() { return maxOpen; },
    reload: () => controller.reload({ target: copy(TARGET), section: copy(db.section) }),
    expire() { clock += timeoutMs; for (const fn of [...timers.values()]) fn(); } };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.workspaceCode === code);

test('start persists pending before capture and exact catalog before default-all active save', async () => {
  const h = harness(), result = await h.controller.start(PERIOD);
  assert.deepEqual(h.calls.map(c => c.kind), ['save', 'capture', 'catalog', 'save']);
  assert.equal(h.calls[0].input.expectedRevision, 0);
  assert.equal(h.calls[0].input.value.pending_capture.operation_id, OPERATION);
  assert.equal(h.calls[1].input.operationId, OPERATION);
  assert.equal(h.calls[2].input.contextRef.context_id, OPERATION);
  assert.deepEqual(h.calls[2].input.selection, { revision: 1, pockets: [] });
  assert.equal(h.calls[3].input.expectedRevision, 1);
  assert.equal(result.status, 'ready'); assert.equal(result.operation_pending, false);
  assert.equal(result.section_revision, 2); assert.equal(result.checkpoint.active.selection.revision, 1);
  assert.deepEqual(result.checkpoint.active.selection.included_recorded_group_ids, [groupId(1), groupId(2), 'discovery:unassigned']);
  assert.deepEqual(result.selection.pockets[0].account_ids, ['B', 'C', 'SUBJECT']);
  assert.equal(result.checkpoint.pending_capture, null); assert.equal(h.ids, 1); assert.equal(h.maxOpen, 1);
  assert.equal(h.controller.isSettled(), true); assert.equal(h.timers.size, 0);
});

test('reopen uses only exact active context and restores chosen groups without save or capture', async () => {
  const original = activeSection(), h = harness({ initialSection: original });
  const result = await h.controller.reopen();
  assert.deepEqual(h.calls.map(c => c.kind), ['catalog']);
  assert.equal(h.calls[0].input.contextRef.context_id, OLD);
  assert.equal(h.calls[0].input.selection.revision, 9);
  assert.deepEqual(result.checkpoint, original.value);
  assert.deepEqual(result.selection.pockets[0].account_ids, ['B']);
  assert.equal(result.section_revision, 5); assert.equal(h.ids, 0);
});

test('setGroups saves exact empty selection with independent selection and section revisions', async () => {
  const h = harness({ initialSection: activeSection() }); await h.controller.reopen();
  const result = await h.controller.setGroups([]);
  assert.equal(result.section_revision, 6); assert.equal(result.checkpoint.active.selection.revision, 10);
  assert.deepEqual(result.checkpoint.active.selection.included_recorded_group_ids, []);
  assert.deepEqual(result.selection.pockets, []);
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
  const fresh = harness({ initialSection: copy(h.db.section) });
  assert.deepEqual((await fresh.controller.reopen()).selection.pockets, []);
});

test('unknown selected group never reaches save and does not modify persisted intent', async () => {
  const h = harness({ initialSection: activeSection() }); await h.controller.reopen();
  await rejects(h.controller.setGroups([groupId(999)]), 'unknown_recorded_group');
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 0);
  assert.deepEqual(h.db.section, activeSection());
  assert.equal(h.controller.getState().status, 'ready');
  assert.deepEqual(h.controller.getState().selection.pockets[0].account_ids, ['B']);
});

test('malformed initial section remains invalid until an explicit valid target-bound reload', async () => {
  for (const initialSection of [null, { revision: 1, value: null }, { revision: 0, value: activeSection().value }]) {
    const h = harness({ initialSection });
    assert.equal(h.controller.getState().status, 'invalid');
    await rejects(h.controller.start(PERIOD), 'recovery_required');
    await rejects(h.controller.reopen(), 'recovery_required');
    assert.equal(h.calls.length, 0); assert.equal(h.ids, 0);
  }
  const h = harness({ initialSection: null }); h.db.section = activeSection();
  assert.equal((await h.reload()).status, 'ready');
});

test('unknown pending-save acknowledgement requires reload and resumes the same committed UUID', async () => {
  let first = true;
  const h = harness({ save(input, options, commit) {
    const result = commit(input); if (first) { first = false; throw new Error('synthetic lost save ACK'); } return result;
  } });
  await rejects(h.controller.start(PERIOD), 'operation_failed');
  assert.equal(h.controller.getState().recovery, 'reload');
  assert.equal(h.calls.filter(c => c.kind === 'capture').length, 0);
  await rejects(h.controller.start(PERIOD), 'recovery_required');
  await rejects(h.controller.resumePending(), 'recovery_required');
  await h.reload(); await h.controller.resumePending();
  assert.equal(h.ids, 1); assert.equal(h.calls.find(c => c.kind === 'capture').input.operationId, OPERATION);
  assert.equal(h.controller.getState().status, 'ready');
});

test('fresh absent reload after failed pending save still reuses the locally attempted operation', async () => {
  let first = true;
  const h = harness({ save(input, options, commit) {
    if (first) { first = false; throw new Error('synthetic not-acknowledged save'); } return commit(input);
  } });
  await rejects(h.controller.start(PERIOD), 'operation_failed');
  await rejects(h.controller.reload(undefined), 'reload_target_mismatch');
  await h.reload();
  assert.equal(h.controller.getState().error, 'pending_save_unconfirmed');
  assert.equal(h.controller.getState().recovery, 'resume_pending');
  await rejects(h.controller.start({ start_date: '2022-01-01', end_date: PERIOD.end_date }), 'recovery_required');
  await h.controller.resumePending();
  assert.equal(h.ids, 1);
  assert.deepEqual(h.calls.filter(c => c.kind === 'save').slice(0, 2).map(c => c.input.value.pending_capture.operation_id), [OPERATION, OPERATION]);
  assert.deepEqual(h.calls.map(c => c.kind), ['save', 'save', 'capture', 'catalog', 'save']);
});

test('unknown capture acknowledgement stops and explicit resume repeats only the saved operation', async () => {
  let first = true;
  const h = harness({ capture(input) { if (first) { first = false; throw new Error('synthetic durable capture lost ACK'); } return { ...captured(input), reused: true }; } });
  await rejects(h.controller.start(PERIOD), 'operation_failed');
  assert.equal(h.controller.getState().recovery, 'resume_pending');
  assert.equal(h.db.section.value.pending_capture.operation_id, OPERATION);
  await h.controller.resumePending();
  assert.deepEqual(h.calls.filter(c => c.kind === 'capture').map(c => c.input.operationId), [OPERATION, OPERATION]);
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 2); assert.equal(h.ids, 1);
});

test('a new controller resumes a durable pending checkpoint without allocating another UUID', async () => {
  const initialSection = activeSection();
  initialSection.value.pending_capture = { operation_id: OPERATION, observation_period: copy(PERIOD) };
  const h = harness({ initialSection });
  assert.equal(h.controller.getState().status, 'pending');
  await h.controller.resumePending();
  assert.deepEqual(h.calls.map(c => c.kind), ['capture', 'catalog', 'save']);
  assert.equal(h.calls[0].input.operationId, OPERATION);
  assert.equal(h.calls[2].input.expectedRevision, 5);
  assert.equal(h.ids, 0);
});

test('active-save lost acknowledgement recovers from exact saved section without recapture', async () => {
  let saves = 0;
  const h = harness({ save(input, options, commit) {
    const result = commit(input); if (++saves === 2) throw new Error('synthetic lost active save ACK'); return result;
  } });
  await rejects(h.controller.start(PERIOD), 'operation_failed');
  assert.equal(h.controller.getState().recovery, 'reload');
  assert.equal(h.controller.getState().checkpoint.pending_capture.operation_id, OPERATION);
  assert.equal(h.db.section.value.pending_capture, null);
  assert.equal((await h.reload()).status, 'ready');
  assert.equal(h.calls.filter(c => c.kind === 'capture').length, 1); assert.equal(h.ids, 1);
});

test('old active checkpoint stays saved while a new captured catalog is unavailable', async () => {
  let first = true;
  const initial = activeSection(), h = harness({ initialSection: initial,
    loadCatalog(input) { if (first) { first = false; throw new Error('synthetic catalog unavailable'); } return catalog(input); } });
  await rejects(h.controller.start(PERIOD), 'operation_failed');
  assert.deepEqual(h.db.section.value.active, initial.value.active);
  assert.equal(h.db.section.value.pending_capture.operation_id, OPERATION);
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
  await h.controller.resumePending();
  assert.equal(h.db.section.value.active.context_ref.context_id, OPERATION);
});

for (const [name, mutate] of [
  ['operation UUID', r => { r.context_ref.context_id = OLD; }],
  ['reference revision', r => { r.context_ref.context_revision = 1; }],
  ['reference hash', r => { r.context_ref.context_sha256 = 'invalid'; }],
  ['registration status', r => { r.status = 'incomplete'; }],
  ['query completeness', r => { r.source_query_complete = false; }],
]) test(`malformed capture ${name} cannot become active or trigger catalog`, async () => {
  const h = harness({ capture(input) { const result = captured(input); mutate(result); return result; } });
  await assert.rejects(h.controller.start(PERIOD));
  assert.equal(h.calls.filter(c => c.kind === 'catalog').length, 0);
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
  assert.equal(h.controller.getState().recovery, 'resume_pending');
});

for (const [name, mutate] of [
  ['account', r => { r.target.account_id = 'foreign'; }],
  ['file', r => { r.target.assignment_file_id = '1'; }],
  ['context', r => { r.context_ref.context_id = OLD; }],
  ['selection revision', r => { r.selection_revision = 2; }],
]) test(`foreign catalog ${name} never triggers active save`, async () => {
  const h = harness({ loadCatalog(input) { const result = catalog(input); mutate(result); return result; } });
  await rejects(h.controller.start(PERIOD), 'operation_failed');
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
  assert.equal(h.db.section.value.active, null);
});

for (const [name, mutate] of [
  ['account', r => { r.accountId = 'foreign'; }],
  ['file', r => { r.assignmentFileId = '1'; }],
  ['revision', r => { r.section.revision += 1; }],
  ['saved body', r => { r.section.value.pending_capture = null; }],
]) test(`save acknowledgement ${name} mismatch blocks capture until reload`, async () => {
  const h = harness({ save(input, options, commit) { const result = commit(input); mutate(result); return result; } });
  await assert.rejects(h.controller.start(PERIOD));
  assert.equal(h.controller.getState().recovery, 'reload');
  assert.equal(h.calls.filter(c => c.kind === 'capture').length, 0);
});

test('competing actions reject instead of overlapping the pending-save/capture lane', async () => {
  const held = deferred(); let first = true;
  const h = harness({ save: async (input, options, commit) => { if (first) { first = false; await held.promise; } return commit(input); } });
  const start = h.controller.start(PERIOD); await drain();
  await rejects(h.controller.start(PERIOD), 'busy');
  await rejects(h.controller.setGroups([]), 'busy');
  await rejects(h.reload(), 'busy');
  assert.equal(h.calls.length, 1); assert.equal(h.ids, 1); assert.equal(h.controller.isSettled(), false);
  held.resolve(); await start;
  assert.equal(h.maxOpen, 1); assert.equal(h.controller.isSettled(), true);
});

test('concurrent stored revision change is not overwritten or retried automatically', async () => {
  const h = harness({ initialSection: activeSection() }); await h.controller.reopen();
  h.db.section.revision += 1;
  await rejects(h.controller.setGroups([]), 'operation_failed');
  assert.equal(h.controller.getState().recovery, 'reload');
  assert.deepEqual(h.db.section.value.active.selection.included_recorded_group_ids, [groupId(2)]);
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
  await h.reload(); assert.equal(h.controller.getState().section_revision, 6);
});

test('deadline bounds controller completion but quarantines an adapter that ignores cancellation', async () => {
  const held = deferred(); let first = true;
  const h = harness({ capture: input => { if (first) { first = false; return held.promise; } return captured(input); } });
  const start = h.controller.start(PERIOD), rejected = rejects(start, 'cancelled_or_timed_out'); await drain();
  h.expire(); await rejected;
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.controller.getState().operation_pending, true); assert.equal(h.controller.isSettled(), false);
  await rejects(h.controller.resumePending(), 'busy');
  const count = h.calls.length; held.resolve(captured(h.calls[1].input)); await drain();
  assert.equal(h.calls.length, count); assert.equal(h.controller.getState().status, 'error');
  assert.equal(h.controller.getState().operation_pending, false); assert.equal(h.controller.isSettled(), true);
  await h.controller.resumePending(); assert.equal(h.controller.getState().status, 'ready');
});

test('dispose aborts owned I/O and ignores every late callback and completion', async () => {
  const held = deferred(), h = harness({ capture: () => held.promise });
  const start = h.controller.start(PERIOD), rejected = rejects(start, 'cancelled_or_timed_out'); await drain();
  h.controller.dispose(); await rejected;
  const stateCount = h.states.length, callCount = h.calls.length;
  held.resolve(captured(h.calls[1].input)); await drain();
  assert.equal(h.states.length, stateCount); assert.equal(h.calls.length, callCount);
  assert.equal(h.calls[1].signal.aborted, true); assert.equal(h.controller.getState().status, 'disposed');
  await rejects(h.controller.resumePending(), 'disposed');
});

test('target/session-bound reload cannot adopt another file or erase uncertainty with a bare absence', async () => {
  const h = harness({ initialSection: activeSection() }); await h.controller.reopen();
  for (const target of [{ ...TARGET, accountId: 'foreign' }, { ...TARGET, assignmentFileId: '1' }, { ...TARGET, sessionKey: 'new-session' }]) {
    await rejects(h.controller.reload({ target, section: undefined }), 'reload_target_mismatch');
    assert.deepEqual(h.controller.getState().checkpoint, activeSection().value);
  }
  await rejects(h.controller.reload({ target: TARGET }), 'reload_target_mismatch');
  await h.reload(); assert.equal(h.controller.getState().status, 'ready');
});

test('caller mutation cannot change copied target, period or selection after an operation starts', async () => {
  const held = deferred(); let first = true;
  const period = copy(PERIOD), h = harness({ save: async (input, options, commit) => { if (first) { first = false; await held.promise; } return commit(input); } });
  const result = h.controller.start(period); period.start_date = 'invalid'; held.resolve(); await result;
  assert.deepEqual(h.calls.find(c => c.kind === 'capture').input.observationPeriod, PERIOD);
  assert.equal(Object.isFrozen(h.controller.getState().target), true);
  const ids = [groupId(1)], saved = h.controller.setGroups(ids); ids.push(groupId(999)); await saved;
  assert.deepEqual(h.controller.getState().checkpoint.active.selection.included_recorded_group_ids, [groupId(1)]);
});

test('invalid period generates no operation, makes no requests and leaks no underlying error text', async () => {
  const h = harness();
  await rejects(h.controller.start({ start_date: '2023-02-29', end_date: '2024-02-29' }), 'operation_failed');
  assert.equal(h.ids, 0); assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getState().error, 'operation_failed');
});
