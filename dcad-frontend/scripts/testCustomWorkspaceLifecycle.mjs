import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { privateSalesSummaryFixture } from './fixtures/customPrivateSalesSummaryFixture.mjs';

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
const checkpointHelpers = compile('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers,
  './customWorkspaceDiscovery.ts': compile('customWorkspaceDiscovery', {}) });
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
function harness({ initialSection, save, capture, loadCatalog, timeoutMs = 1000, onChange, operationId } = {}) {
  const calls = [], states = [], timers = new Map(); let clock = 100, timerId = 0, ids = 0, open = 0, maxOpen = 0;
  const db = { section: copy(initialSection) };
  const privateBindings = new Map();
  if (initialSection?.value?.pending_capture?.private_sales_import) {
    const pending = initialSection.value.pending_capture; privateBindings.set(pending.operation_id, pending);
  }
  const commit = input => {
    assert.equal(input.sectionKey, 'neighborhood_workspace');
    assert.deepEqual(input.target, TARGET);
    if (input.expectedRevision !== (db.section?.revision ?? 0)) throw new Error('synthetic section CAS conflict');
    db.section = { key: input.sectionKey, revision: input.expectedRevision + 1, value: copy(input.value) };
    return { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, section: copy(db.section) };
  };
  const invoke = async (kind, input, options, fn) => {
    calls.push({ kind, input: copy(input), signal: options.signal, deadline: options.deadline });
    if (kind === 'capture' && input.privateSalesImport) privateBindings.set(input.operationId,
      { private_sales_import: input.privateSalesImport, observation_period: input.observationPeriod });
    assert.ok(options.signal instanceof AbortSignal && Number.isFinite(options.deadline) && options.deadline > clock);
    open += 1; maxOpen = Math.max(maxOpen, open);
    try { return await fn(input, options); } finally { open -= 1; }
  };
  const controller = create({ target: copy(TARGET), initialSection, timeoutMs, now: () => clock,
    timer: { set(fn) { timers.set(++timerId, fn); return timerId; }, clear(id) { timers.delete(id); } },
    operationId: () => { ids += 1; return operationId ? operationId(ids) : OPERATION; },
    onChange: value => { states.push(value); onChange?.(value); },
    save: (input, options) => invoke('save', input, options, save ? (value, opts) => save(value, opts, commit) : commit),
    capture: (input, options) => invoke('capture', input, options, capture ?? captured),
    catalog: (input, options) => invoke('catalog', input, options, loadCatalog ?? (request => {
      const response = catalog(request), pending = privateBindings.get(request.contextRef.context_id);
      if (pending) {
        response.private_sales = privateSalesSummaryFixture({ input: request, privateSalesImport: pending.private_sales_import, period: pending.observation_period });
        response.catalog.binding.selection_sha256 = response.private_sales.binding.selection_sha256;
      }
      return response;
    })),
  });
  return { controller, db, calls, states, timers, get ids() { return ids; }, get maxOpen() { return maxOpen; },
    reload: () => controller.reload({ target: copy(TARGET), section: copy(db.section) }),
    expire() { clock += timeoutMs; for (const fn of [...timers.values()]) fn(); } };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.workspaceCode === code);
const PRIVATE = Object.freeze({ batch_id: '20000000-0000-4000-8000-000000000003', expected_review_revision: 7 });
const privateCaptured = input => ({ ...captured(input), private_sales_import: copy(input.privateSalesImport) });

function denseCatalog(input) {
  const result = catalog(input), c = result.catalog;
  c.catalog_version = 2;
  c.pockets = Array.from({ length: 887 }, (_, i) => ({ id: groupId(i + 1), disposition: 'needs_review', label: `Group ${i}`,
    county: 'Dallas', account_ids: [i === 0 ? 'SUBJECT' : `A${i}`], member_count: 1 }));
  c.coverage = { discovery_member_count: 888, assigned_account_count: 887, unassigned_account_count: 1 };
  return result;
}
function legacyDenseSection(included = ['discovery:unassigned']) {
  const s = activeSection(); s.value.active.selection.included_recorded_group_ids = included; return s;
}
test('dense catalog upgrade is CAS-saved before any ready preview, never recaptures or loses members', async () => {
  const held = deferred(); let saves = 0;
  const h = harness({ initialSection: legacyDenseSection(), loadCatalog: denseCatalog,
    save: async (input, opts, commit) => { if (++saves === 1) await held.promise; return commit(input); } });
  const reopening = h.controller.reopen(); await drain();
  assert.equal(h.controller.getState().phase, 'upgrading_catalog_checkpoint');
  assert.equal(h.controller.getState().selection, null); assert.ok(!h.states.some(s => s.status === 'ready'));
  held.resolve(); await reopening;
  assert.deepEqual(h.calls.map(c => c.kind), ['catalog', 'save']); assert.equal(h.ids, 0);
  assert.equal(h.db.section.revision, 6); assert.equal(h.db.section.value.workspace_version, 5);
  assert.equal(h.db.section.value.active.selection.revision, 10);
  assert.equal(h.controller.getState().selection.pockets[0].account_ids.length, 888);
  await h.reload(); assert.equal(saves, 1); assert.equal(h.controller.getState().selection.pockets[0].account_ids.length, 888);
  await h.controller.setGroups([groupId(1)]);
  assert.deepEqual(h.controller.getState().selection.pockets[0].account_ids, ['SUBJECT']);
  await h.reload(); assert.deepEqual(h.controller.getState().selection.pockets[0].account_ids, ['SUBJECT']);
});
test('dense upgrade preserves explicit exclusion of all, and rejects impossible legacy named selections', async () => {
  const empty = harness({ initialSection: legacyDenseSection([]), loadCatalog: denseCatalog }); await empty.controller.reopen();
  assert.deepEqual(empty.controller.getState().selection.pockets, []); assert.equal(empty.db.section.value.workspace_version, 5);
  const bad = harness({ initialSection: activeSection(), loadCatalog: denseCatalog });
  await rejects(bad.controller.reopen(), 'operation_failed');
  assert.deepEqual(bad.calls.map(c => c.kind), ['catalog']); assert.equal(bad.controller.getState().selection, null);
});
test('uncertain dense upgrade ACK requires fresh reload; a committed upgrade is never replayed or called failed', async () => {
  const h = harness({ initialSection: legacyDenseSection(), loadCatalog: denseCatalog, save(input, opts, commit) {
    commit(input); throw new Error('lost ACK');
  } });
  await rejects(h.controller.reopen(), 'operation_failed');
  assert.equal(h.controller.getState().recovery, 'reload'); assert.equal(h.controller.getState().selection, null);
  await rejects(h.controller.reopen(), 'recovery_required');
  await h.reload(); assert.equal(h.controller.getState().status, 'ready');
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1); assert.equal(h.controller.getState().selection.pockets[0].account_ids.length, 888);
});
for (const badAck of ['target', 'revision', 'value']) test(`dense upgrade rejects wrong ${badAck} ACK before preview`, async () => {
  const h = harness({ initialSection: legacyDenseSection(), loadCatalog: denseCatalog, save(input, opts, commit) {
    const ack = commit(input);
    if (badAck === 'target') ack.assignmentFileId = '1';
    if (badAck === 'revision') ack.section.revision++;
    if (badAck === 'value') ack.section.value.active.selection.included_recorded_group_ids = [];
    return ack;
  } });
  await assert.rejects(h.controller.reopen()); assert.equal(h.controller.getState().recovery, 'reload');
  assert.equal(h.controller.getState().selection, null); assert.ok(!h.states.some(s => s.status === 'ready'));
});
test('new dense capture writes v5 and preserves it while the next radius capture is pending', async () => {
  let captures = 0;
  const h = harness({ loadCatalog: denseCatalog, operationId: n => n === 1 ? OPERATION : OLD,
    capture(input) { if (++captures > 1) throw new Error('offline'); return captured(input); } });
  await h.controller.start(PERIOD); assert.equal(h.db.section.value.workspace_version, 5);
  assert.equal(h.controller.getState().selection.pockets[0].account_ids.length, 888);
  await rejects(h.controller.start(PERIOD, undefined, { profile_id: 'custom-suburban-radius-v2', radius_metres: '4828.032' }), 'operation_failed');
  assert.equal(h.db.section.value.workspace_version, 5); assert.equal(h.db.section.value.active.selection.included_recorded_group_ids.length, 888);
});

const pendingSection = (active = true) => ({ revision: 6, value: { workspace_version: 2,
  active: active ? activeSection().value.active : null,
  pending_capture: { operation_id: OPERATION, observation_period: PERIOD, private_sales_import: PRIVATE } } });
for (const [label, mutate] of [
  ['missing', r => { delete r.private_sales; }],
  ['wrong batch', r => { r.private_sales.binding.batch.batch_id = OLD; }],
  ['newer review', r => { r.private_sales.binding.review.revision++; }],
  ['other observation period', r => { r.private_sales.observation_period.start_date = '2022-01-01'; }],
]) test(`private catalog ${label} never saves an active context even with correct capture echo`, async () => {
  const h = harness({ capture: privateCaptured, loadCatalog(input) {
    const result = catalog(input); result.private_sales = copy(privateSalesSummaryFixture({ input, privateSalesImport: PRIVATE, period: PERIOD }));
    result.catalog.binding.selection_sha256 = result.private_sales.binding.selection_sha256; mutate(result); return result;
  } });
  await rejects(h.controller.start(PERIOD, PRIVATE), 'catalog_private_sales_mismatch');
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1); assert.equal(h.controller.getState().recovery, 'resume_pending');
});
test('ordinary capture cannot silently activate a catalog carrying a private source', async () => {
  const h = harness({ loadCatalog(input) { const result = catalog(input);
    result.private_sales = privateSalesSummaryFixture({ input, privateSalesImport: PRIVATE, period: PERIOD });
    result.catalog.binding.selection_sha256 = result.private_sales.binding.selection_sha256; return result; } });
  await rejects(h.controller.start(PERIOD), 'catalog_private_sales_mismatch');
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
});
test('explicit set aside saves only pending=null by section CAS, preserving exact active selection and context', async () => {
  const initial = pendingSection(), h = harness({ initialSection: initial });
  const ready = await h.controller.setAsidePending();
  assert.deepEqual(h.calls.map(c => c.kind), ['save', 'catalog']); assert.equal(h.calls[0].input.expectedRevision, 6);
  assert.deepEqual(ready.checkpoint, { ...initial.value, pending_capture: null });
  assert.deepEqual(ready.selection.pockets[0].account_ids, ['B']); assert.equal(ready.section_revision, 7);
  assert.equal(ready.status, 'ready'); assert.equal(h.ids, 0); assert.equal(h.maxOpen, 1);
});
test('set aside with no active context returns idle and permits a later deliberate new source choice', async () => {
  const h = harness({ initialSection: pendingSection(false), capture: privateCaptured });
  assert.equal((await h.controller.setAsidePending()).status, 'idle');
  const changed = { ...PRIVATE, expected_review_revision: 8 }; await h.controller.start(PERIOD, changed);
  assert.deepEqual(h.calls.find(c => c.kind === 'capture').input.privateSalesImport, changed);
});
test('lost clear acknowledgement blocks all replacement intent until fresh exact saved-clear read', async () => {
  let first = true; const h = harness({ initialSection: pendingSection(), capture: privateCaptured,
    save(input, opts, commit) { const result = commit(input); if (first) { first = false; throw new Error('lost clear acknowledgement'); } return result; } });
  await rejects(h.controller.setAsidePending(), 'operation_failed');
  assert.equal(h.controller.getState().checkpoint.pending_capture.operation_id, OPERATION);
  await rejects(h.controller.start(PERIOD, { ...PRIVATE, expected_review_revision: 8 }), 'recovery_required');
  await rejects(h.controller.setAsidePending(), 'recovery_required');
  await h.reload(); assert.equal(h.controller.getState().status, 'ready'); assert.equal(h.controller.getState().checkpoint.pending_capture, null);
  await h.controller.start(PERIOD, { ...PRIVATE, expected_review_revision: 8 });
  assert.equal(h.calls.filter(c => c.kind === 'capture').length, 1);
});
test('lost clear followed by fresh absent/older read cannot erase the unresolved capture identity', async () => {
  const h = harness({ initialSection: pendingSection(), save() { throw new Error('unknown clear'); } });
  await rejects(h.controller.setAsidePending(), 'operation_failed');
  await h.controller.reload({ target: TARGET, section: undefined });
  assert.equal(h.controller.getState().recovery, 'reload'); assert.equal(h.controller.getState().error, 'pending_clear_unconfirmed');
  await rejects(h.controller.start(PERIOD), 'recovery_required'); await rejects(h.controller.resumePending(), 'recovery_required');
  assert.equal(h.calls.length, 1); assert.equal(h.ids, 0);
});
test('fresh still-pending read permits explicit same-revision CAS clear retry, never an automatic one', async () => {
  let first = true; const h = harness({ initialSection: pendingSection(), save(input, opts, commit) {
    if (first) { first = false; throw new Error('unknown clear'); } return commit(input); } });
  await rejects(h.controller.setAsidePending(), 'operation_failed'); await h.reload();
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1); assert.ok(h.controller.getState().checkpoint.pending_capture);
  await h.controller.setAsidePending(); assert.equal(h.db.section.value.pending_capture, null);
  assert.deepEqual(h.calls.filter(c => c.kind === 'save').map(c => c.input.expectedRevision), [6, 6]);
});
test('set aside refuses an inflight capture and an unacknowledged pending save before fresh reload', async () => {
  const held = deferred(), h = harness({ initialSection: pendingSection(), capture: () => held.promise });
  const capture = h.controller.resumePending(); await drain(); await rejects(h.controller.setAsidePending(), 'busy');
  held.resolve(privateCaptured(h.calls[0].input)); await capture;
  await rejects(h.controller.setAsidePending(), 'pending_capture_required');
  const uncertain = harness({ save() { throw new Error('lost pending'); } });
  await rejects(uncertain.controller.start(PERIOD, PRIVATE), 'operation_failed');
  await rejects(uncertain.controller.setAsidePending(), 'recovery_required'); await uncertain.reload();
  assert.equal(uncertain.controller.getState().recovery, 'resume_pending');
});
test('another tab active revision cannot be overwritten by set aside; disposal ignores late clear acknowledgement', async () => {
  const h = harness({ initialSection: pendingSection() }); h.db.section = activeSection(); h.db.section.revision = 7;
  await rejects(h.controller.setAsidePending(), 'operation_failed'); assert.deepEqual(h.db.section.value, activeSection().value);
  const held = deferred(), late = harness({ initialSection: pendingSection(), save: async (input, opts, commit) => { await held.promise; return commit(input); } });
  const operation = late.controller.setAsidePending(), rejected = rejects(operation, 'cancelled_or_timed_out'); await drain();
  late.controller.dispose(); await rejected; const stateCount = late.states.length; held.resolve(); await drain();
  assert.equal(late.states.length, stateCount); assert.equal(late.calls.length, 1); assert.equal(late.controller.getState().status, 'disposed');
});

test('private start saves version2 pending exact batch/review before capture and catalog; old active remains until completion', async () => {
  const initial = activeSection(), held = deferred(); let first = true;
  const selected = copy(PRIVATE), h = harness({ initialSection: initial, capture: privateCaptured,
    save: async (input, options, commit) => { if (first) { first = false; await held.promise; } return commit(input); } });
  const task = h.controller.start(PERIOD, selected); selected.expected_review_revision = 8; await drain();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].input.value.workspace_version, 2);
  assert.deepEqual(h.calls[0].input.value.active, initial.value.active);
  assert.deepEqual(h.calls[0].input.value.pending_capture.private_sales_import, PRIVATE);
  held.resolve(); const result = await task;
  assert.deepEqual(h.calls.map(call => call.kind), ['save', 'capture', 'catalog', 'save']);
  assert.deepEqual(h.calls[1].input.privateSalesImport, PRIVATE); assert.equal(h.calls[1].input.operationId, OPERATION);
  assert.equal(result.checkpoint.workspace_version, 2); assert.equal(result.checkpoint.pending_capture, null);
  assert.deepEqual(Object.keys(result.checkpoint.active).sort(), ['context_ref', 'observation_period', 'selection']);
  assert.equal(h.maxOpen, 1); assert.equal(h.ids, 1);
  await h.controller.setGroups([]); assert.deepEqual(h.controller.getState().selection.pockets, []);
  assert.equal(h.db.section.value.workspace_version, 2);
});

test('stored private pending resumes same UUID/revision after a fresh lifecycle without generating an operation', async () => {
  const value = { workspace_version: 2, active: null, pending_capture: { operation_id: OPERATION,
    observation_period: PERIOD, private_sales_import: PRIVATE } };
  const h = harness({ initialSection: { revision: 1, value }, capture: privateCaptured });
  const ready = await h.controller.resumePending();
  assert.deepEqual(h.calls.map(call => call.kind), ['capture', 'catalog', 'save']);
  assert.deepEqual(h.calls[0].input, { target: TARGET, operationId: OPERATION, observationPeriod: PERIOD, privateSalesImport: PRIVATE });
  assert.equal(h.ids, 0); assert.equal(ready.status, 'ready');
  const reopened = harness({ initialSection: h.db.section }); await reopened.controller.reopen();
  assert.deepEqual(reopened.calls.map(call => call.kind), ['catalog']); assert.equal(reopened.ids, 0);
});

test('uncertain private pending save preserves batch/revision and UUID even after fresh absent read', async () => {
  let first = true; const h = harness({ capture: privateCaptured,
    save(input, options, commit) { if (first) { first = false; throw new Error('synthetic pending save unknown'); } return commit(input); } });
  await rejects(h.controller.start(PERIOD, PRIVATE), 'operation_failed');
  await h.reload(); assert.equal(h.controller.getState().recovery, 'resume_pending');
  for (const changed of [undefined, { ...PRIVATE, expected_review_revision: 8 }, { ...PRIVATE, batch_id: OLD }])
    await assert.rejects(h.controller.start(PERIOD, changed));
  assert.equal(h.calls.length, 1); assert.equal(h.ids, 1);
  await h.controller.resumePending(); assert.deepEqual(h.calls.find(call => call.kind === 'capture').input.privateSalesImport, PRIVATE);
  assert.deepEqual(h.calls.filter(call => call.kind === 'save').slice(0, 2).map(call => call.input.value.pending_capture.private_sales_import), [PRIVATE, PRIVATE]);
});

test('private capture lost acknowledgement reuses exact saved tuple, not the current review revision', async () => {
  let first = true; const h = harness({ capture(input) {
    if (first) { first = false; throw new Error('synthetic capture commit lost acknowledgement'); }
    return { ...privateCaptured(input), reused: true };
  } });
  await rejects(h.controller.start(PERIOD, PRIVATE), 'operation_failed'); await h.controller.resumePending();
  const captures = h.calls.filter(call => call.kind === 'capture'); assert.equal(captures.length, 2);
  assert.deepEqual(captures[0].input, captures[1].input); assert.equal(h.ids, 1);
});

test('lost private active-save acknowledgement reconciles only the exact acknowledged immutable context', async () => {
  let saves = 0; const h = harness({ capture: privateCaptured, save(input, options, commit) {
    const result = commit(input); if (++saves === 2) throw new Error('synthetic active save unknown'); return result;
  } });
  await rejects(h.controller.start(PERIOD, PRIVATE), 'operation_failed');
  assert.equal((await h.reload()).status, 'ready'); assert.equal(h.calls.filter(call => call.kind === 'capture').length, 1);
  assert.equal(h.ids, 1);
});

test('same UUID but no acknowledged private context cannot erase source uncertainty on active reload', async () => {
  const h = harness({ capture: privateCaptured, save() { throw new Error('synthetic pending save unknown'); } });
  await rejects(h.controller.start(PERIOD, PRIVATE), 'operation_failed');
  h.db.section = activeSection(); h.db.section.value.active.context_ref = context(OPERATION);
  await h.reload(); assert.equal(h.controller.getState().recovery, 'resume_pending');
  assert.equal(h.controller.getState().error, 'pending_save_unconfirmed'); assert.equal(h.calls.filter(call => call.kind === 'capture').length, 0);
});

for (const [name, mutate] of [
  ['missing echo', result => { delete result.private_sales_import; }], ['null echo', result => { result.private_sales_import = null; }],
  ['wrong batch', result => { result.private_sales_import.batch_id = OLD; }],
  ['newer revision', result => { result.private_sales_import.expected_review_revision++; }],
  ['string revision', result => { result.private_sales_import.expected_review_revision = '7'; }],
  ['authority extra', result => { result.private_sales_import.source_use_confirmed = true; }],
]) test(`private ${name} cannot be saved as active or acquire its catalog`, async () => {
  const h = harness({ capture(input) { const result = privateCaptured(input); mutate(result); return result; } });
  await rejects(h.controller.start(PERIOD, PRIVATE), 'capture_private_sales_mismatch');
  assert.deepEqual(h.calls.map(call => call.kind), ['save', 'capture']);
  assert.equal(h.db.section.value.active, null); assert.deepEqual(h.db.section.value.pending_capture.private_sales_import, PRIVATE);
});

test('ordinary capture never silently adopts an unexpected private source', async () => {
  const h = harness({ capture: input => ({ ...captured(input), private_sales_import: PRIVATE }) });
  await rejects(h.controller.start(PERIOD), 'capture_private_sales_mismatch'); assert.equal(h.calls.length, 2);
});

test('invalid private intent fails before UUID generation or database calls', async () => {
  for (const selected of [null, {}, { ...PRIVATE, expected_review_revision: 0 }, { ...PRIVATE, expected_review_revision: '7' },
    { ...PRIVATE, batch_id: 'latest' }, { ...PRIVATE, retained_rows: [] }]) {
    const h = harness(); await assert.rejects(h.controller.start(PERIOD, selected)); assert.equal(h.ids, 0); assert.equal(h.calls.length, 0);
  }
});

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
