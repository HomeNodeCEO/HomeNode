import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { privateSalesSummaryFixture } from './fixtures/customPrivateSalesSummaryFixture.mjs';
import { prepareCustomCohortGroupWorkspaceTransportRequest as serverRequest,
  presentCustomCohortGroupWorkspaceTransportResponse as serverResponse } from '../../server/src/services/neighborhoodAssessment/customCohortGroupWorkspaceTransport.js';

const load = (name, dependencies) => loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url),
  key => { assert.ok(Object.hasOwn(dependencies, key), `unexpected lifecycle import ${key}`); return dependencies[key]; });
const checkpoint = load('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers, './customWorkspaceDiscovery.ts': discovery });
const workspace = load('customCohortGroupWorkspaceTransport', { './customWorkspaceCheckpoint.ts': checkpoint,
  './customCohortPreviewTransport.ts': transport, './customCohortRecordedGroupTransport.ts': selection });
const { createCustomCohortGroupWorkspaceLifecycle: create } = load('customCohortGroupWorkspaceLifecycle', {
  './customCohortGroupWorkspaceTransport.ts': workspace, './customCohortRecordedGroupTransport.ts': selection,
  './customWorkspaceCheckpoint.ts': checkpoint, './customCohortPocketCatalog.ts': catalogHelpers,
});
const TARGET = { accountId: 'SUBJECT', assignmentFileId: '9007199254740993', sessionKey: 'synthetic-session' };
const PERIOD = { start_date: '2023-01-01', end_date: '2024-02-29' };
const OLD = '20000000-0000-4000-8000-000000000099';
const group = number => `recorded-cad:${number.toString(16).padStart(64, '0')}`;
const context = id => ({ context_id: id, context_revision: '1', context_sha256: 'a'.repeat(64) });
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (revision, ids = []) => ({ selection_version: 1, selection_revision: revision, selection_sha256: hash([revision, ids]),
  manifest_ref: { content_sha256: hash([ids, revision]), canonical_utf8_bytes: '1000' } });
const empty = () => ({ workspace_version: 7, active: null, pending_capture: null });
function activeSection() {
  return { revision: 5, value: { ...empty(), active: { context_ref: context(OLD), observation_period: clone(PERIOD), selection_ref: ref(9, [group(2)]) } } };
}
function pendingSection() {
  const s = activeSection(); s.revision++; s.value.pending_capture = { operation_id: '20000000-0000-4000-8000-000000000001', observation_period: clone(PERIOD) }; return s;
}
function catalog(input) {
  return { status: 'catalog', subject_freshness: 'matched', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: clone(input.contextRef), selection_revision: input.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: 3, status: 'review_only', apply: { status: 'blocked' },
      binding: { context_ref: clone(input.contextRef), selection_revision: input.selection.revision },
      pockets: ['SUBJECT', 'B'].map((account, index) => ({ id: group(index + 1), disposition: 'needs_review', label: `Synthetic group ${index}`,
        county: 'Synthetic', account_ids: [account], member_count: 1 })),
      unassigned: { account_ids: ['C'], member_count: 1, reason_counts: [] },
      coverage: { discovery_member_count: 3, assigned_account_count: 2, unassigned_account_count: 1 },
      subject_membership: { account_id: 'SUBJECT', assigned_pocket_id: group(1), recorded_label_match_only: true, status: 'matched' }, limitations: [],
    } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const rejects = (promise, code) => assert.rejects(promise, error => error.workspaceCode === code);
function harness({ initialSection, intercept, initialGroups = () => [], onChange } = {}) {
  const calls = [], states = [], timers = new Map(), db = { section: clone(initialSection), heads: new Map(), receipts: new Map() };
  let ids = 0, clock = 100, timer = 0, open = 0, maxOpen = 0;
  if (initialSection?.value.active) {
    const a = initialSection.value.active;
    db.heads.set(a.context_ref.context_id, { status: 'selected', authority: 'not_established', context_ref: clone(a.context_ref),
      selection_ref: clone(a.selection_ref), included_recorded_group_ids: [group(2)] });
  }
  const commit = (kind, request) => {
    const commandKey = hash([kind, request]), replay = db.receipts.get(commandKey);
    if (replay && JSON.stringify(db.section) === JSON.stringify(replay.workspace)) return { ...clone(replay), status: 'reused' };
    assert.equal(request.accountId, TARGET.accountId); assert.equal(request.assignmentFileId, TARGET.assignmentFileId);
    assert.equal(request.expectedWorkspaceRevision, db.section?.revision ?? 0, 'atomic workspace CAS');
    const prior = clone(db.section?.value ?? empty());
    if (kind !== 'save') assert.deepEqual(request.expectedWorkspaceCheckpoint, prior);
    let next, selected;
    if (kind === 'start') next = { ...prior, pending_capture: clone(request.pendingCapture) };
    else if (kind === 'cancel') next = { ...prior, pending_capture: null };
    else {
      const c = request.contextRef, previous = db.heads.get(c.context_id)?.selection_ref ?? null;
      assert.deepEqual(previous, request.expectedSelectionRef, 'atomic selection head CAS');
      const selectedRef = ref((previous?.selection_revision ?? 0) + 1, request.includedRecordedGroupIds);
      selected = { status: 'stored', authority: 'not_established', context_ref: clone(c), selection_ref: selectedRef,
        included_recorded_group_ids: clone(request.includedRecordedGroupIds), operation_id: request.operationId };
      const pending = prior.pending_capture;
      if (kind === 'complete') { assert.equal(pending.operation_id, c.context_id); assert.equal(previous, null); }
      next = { ...empty(), active: { context_ref: clone(c), selection_ref: selectedRef,
        observation_period: clone(kind === 'complete' ? pending.observation_period : prior.active.observation_period),
        ...((kind === 'complete' ? pending.discovery : prior.active.discovery)
          ? { discovery: clone(kind === 'complete' ? pending.discovery : prior.active.discovery) } : {}) } };
      db.heads.set(c.context_id, { ...clone(selected), status: 'selected' }); delete db.heads.get(c.context_id).operation_id;
    }
    db.section = { revision: request.expectedWorkspaceRevision + 1, value: clone(next) };
    const ack = { ...(selected ?? { status: 'stored', authority: 'not_established' }), workspace: clone(db.section) };
    db.receipts.set(commandKey, clone(ack)); return ack;
  };
  const defaults = (kind, request) => {
    if (['start', 'cancel', 'complete', 'save'].includes(kind)) return commit(kind, request);
    if (kind === 'selection') return clone(db.heads.get(request.contextRef.context_id) ?? { status: 'absent', authority: 'not_established',
      context_ref: request.contextRef, selection_ref: null, included_recorded_group_ids: null });
    const pending = db.section?.value.pending_capture;
    if (kind === 'capture') return { status: 'registered', reused: false, context_ref: context(request.operationId), source_query_complete: true,
      discovery: request.discovery?.profile_id === 'custom-city-polygon-v1'
        ? { ...clone(request.discovery), account_count: 3, parcel_count: 3 }
        : { account_count: 3, parcel_count: 3, radius_metres: request.discovery?.radius_metres ?? '4828.032' },
      ...(request.privateSalesImport ? { private_sales_import: clone(request.privateSalesImport) } : {}) };
    const response = catalog(request);
    const city = pending?.discovery ?? db.section?.value.active?.discovery;
    if (city?.profile_id === 'custom-city-polygon-v1') response.discovery = clone(city);
    if (pending?.private_sales_import) {
      response.private_sales = privateSalesSummaryFixture({ input: request, privateSalesImport: pending.private_sales_import, period: pending.observation_period });
      response.catalog.binding.selection_sha256 = response.private_sales.binding.selection_sha256;
    }
    return response;
  };
  const invoke = async (kind, request, io) => {
    calls.push({ kind, request: clone(request), signal: io.signal, deadline: io.deadline });
    assert.ok(io.signal instanceof AbortSignal && io.deadline > clock); open++; maxOpen = Math.max(maxOpen, open);
    try { return await (intercept ? intercept(kind, request, io, () => defaults(kind, request), db) : defaults(kind, request)); }
    finally { open--; }
  };
  const controller = create({ target: clone(TARGET), initialSection, timeoutMs: 1000, now: () => clock,
    timer: { set(fn) { timers.set(++timer, fn); return timer; }, clear(key) { timers.delete(key); } },
    operationId: () => `20000000-0000-4000-8000-${(++ids).toString().padStart(12, '0')}`,
    onChange: state => { states.push(state); onChange?.(state); }, initialGroups,
    start: (r, io) => invoke('start', r, io), cancel: (r, io) => invoke('cancel', r, io),
    complete: (r, io) => invoke('complete', r, io), save: (r, io) => invoke('save', r, io),
    capture: (r, io) => invoke('capture', r, io), catalog: (r, io) => invoke('catalog', r, io), readSelection: (r, io) => invoke('selection', r, io),
  });
  return { controller, calls, db, states, timers, get ids() { return ids; }, get maxOpen() { return maxOpen; },
    reload: () => controller.reload({ target: clone(TARGET), section: clone(db.section) }),
    expire() { clock += 1000; for (const callback of [...timers.values()]) callback(); } };
}

test('bootstrap uses two atomic commands, one UUID per operation, no flattened selection and no implicit selected groups', async () => {
  const h = harness();
  try {
    const ready = await h.controller.start(PERIOD);
    assert.deepEqual(h.calls.map(c => c.kind), ['start', 'capture', 'catalog', 'complete', 'selection']);
    assert.equal(ready.status, 'ready'); assert.equal(ready.section_revision, 2); assert.equal(ready.checkpoint.workspace_version, 7);
    assert.equal(ready.checkpoint.pending_capture, null); assert.deepEqual(ready.selected.included_recorded_group_ids, []);
    assert.deepEqual(ready.checkpoint.active.selection_ref, ready.selected.selection_ref);
    assert.equal(Object.hasOwn(ready.checkpoint.active, 'selection'), false); assert.equal(Object.hasOwn(ready, 'selection'), false);
    const write = h.calls.find(c => c.kind === 'complete').request;
    assert.equal(write.expectedSelectionRef, null); assert.deepEqual(write.includedRecordedGroupIds, []);
    assert.equal(Object.hasOwn(write, 'account_ids'), false); assert.equal(Object.hasOwn(write, 'pockets'), false);
    assert.equal(h.ids, 2); assert.equal(h.maxOpen, 1);
    assert.ok(Object.isFrozen(ready) && Object.isFrozen(ready.checkpoint.active.selection_ref));
  } finally { h.controller.dispose(); }
});

test('an explicit initial policy, group toggle and empty selection retain exact original context and publish the atomic receipt', async () => {
  const h = harness({ initialGroups: () => [group(2), group(1)] });
  try {
    await h.controller.start(PERIOD); const previous = clone(h.controller.getState().checkpoint);
    const ready = await h.controller.setGroups([group(1)]);
    assert.deepEqual(ready.checkpoint.active.context_ref, previous.active.context_ref);
    assert.equal(ready.checkpoint.active.selection_ref.selection_revision, 2); assert.equal(ready.section_revision, 3);
    assert.deepEqual(ready.selected.included_recorded_group_ids, [group(1)]);
    const write = h.calls.find(c => c.kind === 'save').request;
    assert.deepEqual(write.expectedSelectionRef, previous.active.selection_ref);
    assert.deepEqual(write.includedRecordedGroupIds, [group(1)]);
    const cleared = await h.controller.setGroups([]);
    assert.equal(cleared.checkpoint.active.selection_ref.selection_revision, 3); assert.deepEqual(cleared.selected.included_recorded_group_ids, []);
  } finally { h.controller.dispose(); }
});

test('the real bounded atomic HTTP transports and both actual response grammars compose with the lifecycle without generic writes', async () => {
  const actions = { start: 'start-group-capture', complete: 'complete-group-capture', save: 'save-groups', cancel: 'cancel-group-capture' };
  const wire = [];
  const h = harness({ initialSection: activeSection(), initialGroups: () => [group(1)],
    intercept(kind, request, io, perform) {
      if (!Object.hasOwn(actions, kind)) return perform();
      const api = workspace.createCustomCohortGroupWorkspaceTransport({ urlFor: path => `https://example.invalid${path}`,
        request: async (url, init) => {
          assert.equal(url, `https://example.invalid/api/accounts/SUBJECT/neighborhood-cohort/${actions[kind]}`);
          assert.equal(init.signal, io.signal);
          const body = JSON.parse(init.body), admitted = serverRequest(body, actions[kind]);
          wire.push({ kind, body }); assert.equal(admitted.assignment_file_id, TARGET.assignmentFileId);
          const result = perform(); if (kind === 'start' || kind === 'cancel') delete result.authority;
          return new Response(JSON.stringify(serverResponse(result, admitted, actions[kind])), { headers: { 'Content-Type': 'application/json' } });
        } });
      return api[kind](request, io);
    } });
  try {
    await h.controller.reopen(); await h.controller.start(PERIOD); await h.controller.setGroups([]);
    await h.controller.start(PERIOD);
    // Separately install an authentic-shaped pending intent in this synthetic
    // command store to exercise cancellation through the same wire boundary.
    const section = clone(h.db.section); section.revision++;
    section.value.pending_capture = { operation_id: OLD, observation_period: PERIOD };
    h.db.section = section; await h.reload(); await h.controller.setAsidePending();
    assert.equal(h.controller.getState().status, 'ready');
    assert.deepEqual(new Set(wire.map(call => call.kind)), new Set(['start', 'complete', 'save', 'cancel']));
    for (const { body } of wire) {
      assert.equal(Object.hasOwn(body, 'source_rows'), false); assert.equal(Object.hasOwn(body, 'selection'), false);
      assert.equal(Object.hasOwn(body, 'account_ids'), false); assert.equal(Object.hasOwn(body, 'reviewer'), false);
    }
  } finally { h.controller.dispose(); }
});

test('explicit radius, city vintage and private batch/review bind the completed study without changing their period', async () => {
  const privateInput = { batch_id: OLD, expected_review_revision: 7 };
  for (const scope of [{ profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' },
    { profile_id: 'custom-city-polygon-v1', city: { geoid: '4819000', vintage: '2025-01-01', asset_sha256: 'd'.repeat(64) } }]) {
    const h = harness();
    try {
      await h.controller.start(PERIOD, privateInput, scope);
      assert.equal(h.controller.getState().status, 'ready');
      assert.deepEqual(h.controller.getState().checkpoint.active.discovery, scope);
      assert.deepEqual(h.controller.getState().checkpoint.active.observation_period, PERIOD);
      const pending = h.calls[0].request.pendingCapture;
      assert.deepEqual(pending.private_sales_import, privateInput); assert.deepEqual(pending.discovery, scope);
      assert.equal(h.calls.some(c => Object.hasOwn(c.request, 'source_use_confirmed')), false);
    } finally { h.controller.dispose(); }
  }
});

test('old active area remains retained during a new study; a failed capture can be cancelled without another capture or selection write', async () => {
  const original = activeSection(); let fail = true;
  const h = harness({ initialSection: original, intercept(kind, _r, _io, perform) {
    if (kind === 'capture' && fail) throw new Error('synthetic capture unavailable'); return perform();
  } });
  try {
    await h.controller.reopen(); await rejects(h.controller.start(PERIOD), 'operation_failed');
    assert.deepEqual(h.controller.getState().checkpoint.active, original.value.active);
    assert.equal(h.controller.getState().recovery, 'resume_pending');
    fail = false; const result = await h.controller.setAsidePending();
    assert.equal(result.status, 'ready'); assert.equal(result.checkpoint.pending_capture, null);
    assert.deepEqual(result.checkpoint.active, original.value.active);
    assert.equal(h.calls.filter(c => c.kind === 'capture').length, 1); assert.equal(h.calls.filter(c => c.kind === 'save' || c.kind === 'complete').length, 0);
  } finally { h.controller.dispose(); }
});

for (const kind of ['start', 'cancel', 'complete', 'save']) for (const commitFirst of [false, true]) {
  test(`${kind} ${commitFirst ? 'committed' : 'uncommitted'} lost ACK requires fresh reload; retry never allocates a replacement command`, async () => {
    let lost = true;
    const initialSection = kind === 'cancel' || kind === 'complete' ? pendingSection() : kind === 'save' ? activeSection() : undefined;
    const h = harness({ initialSection, intercept(action, _r, _io, perform) {
      if (action === kind && lost) { lost = false; if (commitFirst) perform(); throw new Error('synthetic lost ACK'); } return perform();
    } });
    try {
      if (kind === 'save') await h.controller.reopen();
      await rejects(kind === 'start' ? h.controller.start(PERIOD) : kind === 'cancel' ? h.controller.setAsidePending()
        : kind === 'complete' ? h.controller.resumePending() : h.controller.setGroups([group(1)]), 'operation_failed');
      assert.equal(h.controller.getState().recovery, 'reload'); const ids = h.ids;
      await rejects(h.controller.retryExact(), 'recovery_required');
      await h.reload();
      if (!commitFirst) {
        assert.equal(h.controller.getState().recovery, 'retry_exact');
        await h.controller.retryExact();
        const commands = h.calls.filter(c => c.kind === kind);
        assert.equal(commands.length, 2); assert.deepEqual(commands[1].request, commands[0].request);
        assert.equal(h.ids, ids + (kind === 'start' ? 1 : 0), 'only a newly needed completion operation gets a new UUID');
      } else if (kind === 'start') await h.controller.resumePending();
      assert.equal(h.controller.getState().status, 'ready');
      assert.equal(h.controller.getState().checkpoint.pending_capture, null);
      assert.deepEqual(h.controller.getState().checkpoint.active.selection_ref, h.controller.getState().selected.selection_ref);
    } finally { h.controller.dispose(); }
  });
}

test('later authoritative edits win over an old unacknowledged toggle and cannot be rewound by a same-operation retry', async () => {
  let lost = true;
  const h = harness({ initialSection: activeSection(), intercept(kind, _r, _io, perform) {
    const response = perform(); if (kind === 'save' && lost) { lost = false; throw new Error('synthetic lost ACK'); } return response;
  } });
  try {
    await h.controller.reopen(); await rejects(h.controller.setGroups([group(1)]), 'operation_failed');
    const a = h.db.section.value.active, later = ref(11, []);
    h.db.section = { revision: 7, value: { ...empty(), active: { ...a, selection_ref: later } } };
    h.db.heads.set(a.context_ref.context_id, { status: 'selected', authority: 'not_established', context_ref: a.context_ref,
      selection_ref: later, included_recorded_group_ids: [] });
    await h.reload(); assert.equal(h.controller.getState().status, 'ready');
    assert.deepEqual(h.controller.getState().selected.included_recorded_group_ids, []);
    await rejects(h.controller.retryExact(), 'exact_retry_required'); assert.equal(h.calls.filter(c => c.kind === 'save').length, 1);
    await rejects(h.controller.reload({ target: TARGET, section: activeSection() }), 'reload_revision_changed');
    assert.equal(h.controller.getState().section_revision, 7);
  } finally { h.controller.dispose(); }
});

test('a hung timed-out write owns the lane until it actually settles; a late success cannot update disposed or timed-out state', async () => {
  const wait = deferred();
  const h = harness({ intercept(kind, _r, _io, perform) { return kind === 'start' ? wait.promise : perform(); } });
  const attempt = h.controller.start(PERIOD); await drain(); h.expire();
  await rejects(attempt, 'cancelled_or_timed_out');
  assert.equal(h.controller.isSettled(), false); assert.equal(h.controller.getState().operation_pending, true);
  await rejects(h.reload(), 'busy'); assert.equal(h.calls.length, 1);
  wait.resolve({ malformed: 'late acknowledgment' }); await drain();
  assert.equal(h.controller.isSettled(), true); assert.equal(h.controller.getState().checkpoint, null);
  h.controller.dispose(); await rejects(h.controller.start(PERIOD), 'disposed'); assert.equal(h.controller.getState().status, 'disposed');
});

test('observer failures cannot turn an atomic save into a failed command', async () => {
  const h = harness({ onChange() { throw new Error('synthetic broken render'); } });
  try { await h.controller.start(PERIOD); assert.equal(h.controller.getState().status, 'ready'); assert.equal(h.calls.filter(c => c.kind === 'complete').length, 1); }
  finally { h.controller.dispose(); }
});

test('malformed present, legacy and future checkpoints stay invalid; only absent is eligible for V7 bootstrap', async () => {
  for (const initialSection of [null, { revision: 0, value: empty() }, { revision: 1, value: { ...empty(), workspace_version: 6 } },
    { revision: 1, value: { ...empty(), workspace_version: 8 } }, { revision: 5, value: { ...empty(), source_rows: [] } }]) {
    const h = harness({ initialSection });
    try { assert.equal(h.controller.getState().status, 'invalid'); await rejects(h.controller.start(PERIOD), 'recovery_required');
      assert.equal(h.ids, 0); assert.equal(h.calls.length, 0); }
    finally { h.controller.dispose(); }
  }
});

test('invalid period, private intent and group membership fail before allocating UUIDs or sending a write', async () => {
  const h = harness();
  try {
    for (const [period, privateInput, scope] of [[{ start_date: '2023-02-29', end_date: '2024-01-01' }],
      [PERIOD, { batch_id: OLD, expected_review_revision: 0 }], [PERIOD, undefined, { profile_id: 'arbitrary' }]])
      await rejects(h.controller.start(period, privateInput, scope), 'operation_failed');
    assert.equal(h.ids, 0); assert.equal(h.calls.length, 0);
    await h.controller.start(PERIOD); const count = h.calls.length, ids = h.ids;
    await rejects(h.controller.setGroups([group(999)]), 'unknown_recorded_group');
    await rejects(h.controller.setGroups([group(1), group(1)]), 'operation_failed');
    assert.equal(h.calls.length, count); assert.equal(h.ids, ids);
  } finally { h.controller.dispose(); }
});

test('wrong active head or catalog binding fails reopening without a save or a successful observation projection', async () => {
  for (const wrong of ['head', 'catalog']) {
    const h = harness({ initialSection: activeSection(), intercept(kind, _r, _io, perform) {
      const value = perform();
      if (kind === 'selection' && wrong === 'head') value.selection_ref = ref(10, [group(2)]);
      if (kind === 'catalog' && wrong === 'catalog') value.context_ref.context_sha256 = 'd'.repeat(64);
      return value;
    } });
    try { await rejects(h.controller.reopen(), wrong === 'head' ? 'selection_head_changed' : 'operation_failed');
      assert.equal(h.controller.getState().status, 'error'); assert.equal(h.controller.getState().selected, null);
      assert.equal(h.calls.some(c => ['start', 'save', 'complete', 'cancel'].includes(c.kind)), false); }
    finally { h.controller.dispose(); }
  }
});

test('wrong acknowledgement period is rejected, and a late catalog failure recovers the acknowledged new head without repeating its save', async () => {
  let wrong = true, unavailable = false;
  const h = harness({ initialSection: activeSection(), intercept(kind, _r, _io, perform) {
    if (kind === 'catalog' && unavailable) throw new Error('synthetic read unavailable');
    const value = perform();
    if (kind === 'save' && wrong) { value.workspace.value.active.observation_period.start_date = '2023-01-02'; wrong = false; }
    return value;
  } });
  try {
    await h.controller.reopen(); await rejects(h.controller.setGroups([group(1)]), 'save_ack_mismatch');
    await h.reload(); assert.equal(h.controller.getState().status, 'ready');
    unavailable = true; await rejects(h.controller.setGroups([]), 'operation_failed');
    assert.equal(h.controller.getState().recovery, 'reopen'); const saves = h.calls.filter(c => c.kind === 'save').length;
    unavailable = false; await h.controller.reopen(); assert.equal(h.calls.filter(c => c.kind === 'save').length, saves);
    assert.deepEqual(h.controller.getState().selected.included_recorded_group_ids, []);
  } finally { h.controller.dispose(); }
});

test('wrong capture UUID, discovery and private review are refused while the same durable pending operation remains available', async () => {
  const privateInput = { batch_id: OLD, expected_review_revision: 7 };
  for (const wrong of ['context', 'discovery', 'private']) {
    const h = harness({ intercept(kind, _r, _io, perform) {
      const value = perform(); if (kind === 'capture') {
        if (wrong === 'context') value.context_ref.context_id = OLD;
        if (wrong === 'discovery') value.discovery.radius_metres = '1609.344';
        if (wrong === 'private') value.private_sales_import.expected_review_revision = 8;
      } return value;
    } });
    try {
      await rejects(h.controller.start(PERIOD, wrong === 'private' ? privateInput : undefined), wrong === 'context'
        ? 'capture_operation_mismatch' : wrong === 'discovery' ? 'capture_response' : 'capture_private_sales_mismatch');
      assert.equal(h.controller.getState().recovery, 'resume_pending');
      assert.equal(h.controller.getState().checkpoint.pending_capture.operation_id, h.calls[0].request.pendingCapture.operation_id);
      assert.equal(h.calls.some(c => c.kind === 'complete'), false);
    } finally { h.controller.dispose(); }
  }
});

test('reload must have the exact current file and session, and cannot reset a known row to absence or mutate an existing revision', async () => {
  const original = activeSection(), h = harness({ initialSection: original });
  try {
    for (const field of ['accountId', 'assignmentFileId', 'sessionKey']) await rejects(h.controller.reload({
      target: { ...TARGET, [field]: field === 'assignmentFileId' ? '8' : 'other' }, section: original }), 'reload_target_mismatch');
    await rejects(h.controller.reload({ target: TARGET, section: undefined }), 'reload_revision_changed');
    const changed = clone(original); changed.value.active.observation_period.start_date = '2023-01-02';
    await rejects(h.controller.reload({ target: TARGET, section: changed }), 'reload_revision_changed');
    assert.equal(h.controller.getState().section_revision, 5); assert.deepEqual(h.controller.getState().checkpoint, original.value);
    assert.equal(h.calls.length, 0);
  } finally { h.controller.dispose(); }
});
