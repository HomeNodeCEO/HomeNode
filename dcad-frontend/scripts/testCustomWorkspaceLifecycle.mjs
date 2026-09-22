import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import { privateSalesSummaryFixture } from './fixtures/customPrivateSalesSummaryFixture.mjs';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

function compile(name, imports) {
  return loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url), key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected lifecycle dependency: ${key}`); return imports[key];
  });
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
    // Opaque here: the preview controller separately admits summary/map bindings.
    ...(['all_catalog_groups', 'recommended_area'].includes(input.initialPreviewMode) || Object.hasOwn(input, 'initialPreviewGroups')
      ? { initial_preview: { fixture: 'opening' } } : {}),
    context_ref: copy(input.contextRef), selection_revision: input.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: input.catalogVersion ?? 1, status: 'review_only', apply: { status: 'blocked' },
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
  c.catalog_version = input.catalogVersion ?? 2;
  c.pockets = Array.from({ length: 887 }, (_, i) => ({ id: groupId(i + 1), disposition: 'needs_review', label: `Group ${i}`,
    county: 'Dallas', account_ids: [i === 0 ? 'SUBJECT' : `A${i}`], member_count: 1 }));
  c.coverage = { discovery_member_count: 888, assigned_account_count: 887, unassigned_account_count: 1 };
  return result;
}

function catalogV3(input) {
  const result = denseCatalog(input), c = result.catalog;
  c.catalog_version = 3;
  c.pockets = Array.from({ length: 1475 }, (_, i) => ({ id: groupId(i + 1), disposition: 'needs_review', label: `Group ${i}`,
    county: 'Dallas', account_ids: [i === 0 ? 'SUBJECT' : `A${i}`], member_count: 1 }));
  c.coverage = { discovery_member_count: 1476, assigned_account_count: 1475, unassigned_account_count: 1 };
  return result;
}
// The old bounded contract placed the entire over-limit roster in unresolved;
// it did not expose a named prefix of the newer grouping.
function pinnedDenseCatalog(input) {
  const result = catalogV3(input);
  if (input.catalogVersion === 1 || input.catalogVersion === 2) {
    const c = result.catalog;
    c.catalog_version = input.catalogVersion; c.status = 'incomplete';
    c.unassigned.account_ids = [...c.pockets.flatMap(p => p.account_ids), ...c.unassigned.account_ids].sort();
    c.unassigned.member_count = 1476; c.pockets = [];
    c.coverage = { discovery_member_count: 1476, assigned_account_count: 0, unassigned_account_count: 1476 };
    c.subject_membership.assigned_pocket_id = null; c.subject_membership.status = 'catalog_incomplete';
  }
  return result;
}

function ordinaryPendingSection() {
  const result = activeSection(); result.revision++;
  result.value.pending_capture = { operation_id: OPERATION, observation_period: copy(PERIOD) };
  return result;
}
function openingCatalog(input, kind) {
  const result = kind === 'dense1475' ? catalogV3(input) : kind === 'dense887' ? denseCatalog(input) : catalog(input), c = result.catalog;
  if (kind === 'empty' || kind === 'unassigned-only') {
    const accounts = kind === 'empty' ? [] : ['C', 'SUBJECT'];
    c.pockets = []; c.unassigned = { account_ids: accounts, member_count: accounts.length, reason_counts: [] };
    c.coverage = { discovery_member_count: accounts.length, assigned_account_count: 0, unassigned_account_count: accounts.length };
    c.subject_membership.assigned_pocket_id = null; c.subject_membership.status = kind === 'empty' ? 'not_in_discovery' : 'unassigned';
  } else if (kind === 'named-only') {
    c.unassigned = { account_ids: [], member_count: 0, reason_counts: [] };
    c.coverage = { discovery_member_count: 2, assigned_account_count: 2, unassigned_account_count: 0 };
  }
  return result;
}
for (const resume of [false, true]) for (const kind of ['mixed', 'named-only', 'empty', 'unassigned-only', 'dense887', 'dense1475']) {
  test(`${resume ? 'resumed' : 'fresh'} combined opening conserves the complete ${kind} catalog in one read`, async () => {
    let original, before;
    const h = harness({ initialSection: resume ? ordinaryPendingSection() : undefined, loadCatalog(input) {
      original = openingCatalog(input, kind); before = JSON.stringify(original); return original;
    } });
    try {
      const state = await (resume ? h.controller.resumePending() : h.controller.start(PERIOD));
      assert.deepEqual(h.calls.map(c => c.kind), resume ? ['capture', 'catalog', 'save'] : ['save', 'capture', 'catalog', 'save']);
      const request = h.calls.find(c => c.kind === 'catalog').input;
      assert.equal(request.initialPreviewMode, 'recommended_area'); assert.equal(Object.hasOwn(request, 'initialPreviewGroups'), false);
      assert.equal(request.catalogVersion, 3, 'new captures explicitly opt into v3 without changing old-client defaults');
      assert.deepEqual(request.selection, { revision: 1, pockets: [] });
      const expectedIds = kind.startsWith('dense') ? [...Array.from({ length: kind === 'dense1475' ? 1475 : 887 }, (_, i) => groupId(i + 1)), 'discovery:unassigned']
        : kind === 'empty' ? [] : kind === 'unassigned-only' ? ['discovery:unassigned']
        : [groupId(1), groupId(2), ...(kind === 'mixed' ? ['discovery:unassigned'] : [])];
      const expectedAccounts = [...original.catalog.pockets.flatMap(p => p.account_ids), ...original.catalog.unassigned.account_ids].sort();
      assert.deepEqual(state.checkpoint.active.selection.included_recorded_group_ids, expectedIds);
      assert.deepEqual(state.selection.pockets.flatMap(p => p.account_ids), expectedAccounts);
      assert.equal(new Set(expectedAccounts).size, original.catalog.coverage.discovery_member_count);
      assert.deepEqual(state.initial_preview.input, { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId,
        contextRef: context(OPERATION), selection: state.selection });
      assert.equal(state.initial_preview.value.fixture, 'opening'); assert.equal(state.status, 'ready');
      assert.equal(state.checkpoint.pending_capture, null); assert.equal(h.ids, resume ? 0 : 1);
      assert.equal(h.maxOpen, 1); assert.equal(JSON.stringify(original), before, 'opaque response is not rewritten');
      assert.ok(Object.isFrozen(state.initial_preview) && Object.isFrozen(state.initial_preview.input.selection));
      assert.equal(state.checkpoint.workspace_version, 6);
    } finally { h.controller.dispose(); }
  });
}

for (const resume of [false, true]) test(`${resume ? 'resumed' : 'fresh'} acquisition refuses a missing opening before active publication`, async () => {
  const initial = resume ? ordinaryPendingSection() : activeSection();
  const h = harness({ initialSection: initial, loadCatalog(input) { const result = catalog(input); delete result.initial_preview; return result; } });
  try {
    await rejects(resume ? h.controller.resumePending() : h.controller.start(PERIOD), 'opening_preview_missing');
    assert.deepEqual(h.calls.map(c => c.kind), resume ? ['capture', 'catalog'] : ['save', 'capture', 'catalog']);
    assert.deepEqual(h.db.section.value.active, initial.value.active);
    assert.deepEqual(h.controller.getState().checkpoint.active, initial.value.active);
    assert.equal(h.controller.getState().checkpoint.pending_capture.operation_id, OPERATION);
    assert.equal(h.controller.getState().initial_preview, null); assert.equal(h.controller.getState().recovery, 'resume_pending');
    assert.ok(!h.states.some(s => s.status === 'ready'));
  } finally { h.controller.dispose(); }
});

test('combined opening remains unpublished until the exact active-save CAS acknowledgment', async () => {
  const entered = deferred(), held = deferred(), initial = activeSection();
  const h = harness({ initialSection: initial, save: async (input, _io, commit) => {
    if (input.value.active?.context_ref.context_id === OPERATION) { entered.resolve(); await held.promise; }
    return commit(input);
  } });
  try {
    const prior = await h.controller.reopen(); const work = h.controller.start(PERIOD); await entered.promise;
    assert.equal(h.controller.getState().phase, 'saving_active');
    assert.deepEqual(h.controller.getState().checkpoint.active, initial.value.active);
    assert.equal(h.controller.getState().initial_preview, prior.initial_preview);
    assert.deepEqual(h.db.section.value.active, initial.value.active);
    assert.ok(!h.states.some(s => s.initial_preview?.input.contextRef.context_id === OPERATION || (s.status === 'ready' && s.checkpoint.active.context_ref.context_id === OPERATION)));
    held.resolve(); const ready = await work;
    assert.equal(ready.status, 'ready'); assert.equal(ready.initial_preview.value.fixture, 'opening');
    assert.equal(ready.section_revision, initial.revision + 2);
    assert.deepEqual(ready.initial_preview.input.selection, ready.selection);
    assert.equal(h.calls.filter(c => c.kind === 'catalog' && c.input.contextRef.context_id === OPERATION).length, 1);
  } finally { held.resolve(); h.controller.dispose(); }
});

for (const badAck of ['target', 'revision', 'value']) test(`combined opening rejects wrong active ${badAck} ACK and retains prior acknowledged identity`, async () => {
  const initial = activeSection(), h = harness({ initialSection: initial, save(input, _io, commit) {
    const ack = commit(input);
    if (input.value.active?.context_ref.context_id === OPERATION) {
      if (badAck === 'target') ack.assignmentFileId = '1';
      if (badAck === 'revision') ack.section.revision++;
      if (badAck === 'value') ack.section.value.active.selection.included_recorded_group_ids = [];
    }
    return ack;
  } });
  try {
    await h.controller.reopen(); await assert.rejects(h.controller.start(PERIOD));
    assert.deepEqual(h.controller.getState().checkpoint.active, initial.value.active);
    assert.equal(h.controller.getState().checkpoint.pending_capture.operation_id, OPERATION);
    assert.equal(h.controller.getState().initial_preview, null); assert.equal(h.controller.getState().recovery, 'reload');
    assert.ok(!h.states.some(s => s.initial_preview?.input.contextRef.context_id === OPERATION || (s.status === 'ready' && s.checkpoint.active.context_ref.context_id === OPERATION)));
    await rejects(h.controller.resumePending(), 'recovery_required');
    await h.reload(); assert.equal(h.controller.getState().status, 'ready');
    assert.equal(h.calls.filter(c => c.kind === 'capture').length, 1, 'fresh saved-section recovery must not recapture');
  } finally { h.controller.dispose(); }
});

test('late failed active save cannot publish the timed-out combined opening or replace the previous saved study', async () => {
  const entered = deferred(), held = deferred(), initial = activeSection();
  const h = harness({ initialSection: initial, save: async (input, _io, commit) => {
    if (input.value.active?.context_ref.context_id === OPERATION) { entered.resolve(); await held.promise; }
    return commit(input);
  } });
  try {
    await h.controller.reopen(); const work = h.controller.start(PERIOD); await entered.promise;
    h.expire(); await rejects(work, 'cancelled_or_timed_out');
    assert.equal(h.controller.getState().operation_pending, true); assert.equal(h.controller.getState().initial_preview, null);
    held.reject(new Error('synthetic late save failure')); await drain();
    assert.deepEqual(h.db.section.value.active, initial.value.active);
    assert.deepEqual(h.controller.getState().checkpoint.active, initial.value.active);
    assert.equal(h.controller.getState().initial_preview, null); assert.equal(h.controller.getState().recovery, 'reload');
    assert.ok(!h.states.some(s => s.initial_preview?.input.contextRef.context_id === OPERATION || (s.status === 'ready' && s.checkpoint.active.context_ref.context_id === OPERATION)));
    assert.equal(h.calls.filter(c => c.kind === 'catalog' && c.input.contextRef.context_id === OPERATION).length, 1);
  } finally { held.resolve(); h.controller.dispose(); }
});

test('real retained producers cross combined transport, fresh lifecycle ACK and controller admission with one catalog request', async () => {
  const { recordedProximityFixture } = await import('../../server/test/fixtures/customCohortRecordedProximityFixture.js');
  const { buildCustomCohortObservationPreview } = await import('../../server/src/services/neighborhoodAssessment/customCohortObservationPreview.js');
  const { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog } = await import('../../server/src/services/neighborhoodAssessment/customCohortPocketCatalog.js');
  const { customCohortOpeningGroupIds, customCohortOpeningSelection } = await import('../../server/src/services/neighborhoodAssessment/customCohortOpeningPreview.js');
  const { presentCustomCohortPreview } = await import('../../server/src/services/neighborhoodAssessment/customCohortPreviewPresentation.js');
  const { buildCustomCohortParcelMap } = await import('../../server/src/services/neighborhoodAssessment/customCohortParcelMap.js');
  const { createCustomCohortPreviewController } = await import('../src/features/neighborhood/customCohortPreviewController.ts');
  const { createCustomCohortJsonTransport, createCustomCohortPreviewTransport } = await import('../src/features/neighborhood/customCohortPreviewTransport.ts');
  // Existing original-capture/persist/reopen fixture, not a relabeled capture or
  // native database/authorization proof. Its max-int64 file identity is supported
  // by this transport, not the generic-workfile API gate tested separately.
  // Actual presenters provide the wire data without changing retained identities.
  const f = await recordedProximityFixture(), retained_inputs = f.retained_inputs, before = JSON.stringify(retained_inputs);
  const target = { accountId: f.input.expected.target.account_id, assignmentFileId: f.input.expected.target.assignment_file_id,
    sessionKey: 'synthetic-combined-opening' };
  const requests = [], saves = [], entered = deferred(), ack = deferred(); let section, producedOpening, previewController;
  const adapters = { urlFor: path => path,
    request: async (url, init) => {
      requests.push({ url, init }); assert.match(url, /\/catalog$/);
      const body = JSON.parse(init.body);
      assert.equal(body.initial_preview_mode, 'recommended_area'); assert.equal(Object.hasOwn(body, 'initial_preview_groups'), false);
      assert.equal(body.catalog_version, 3);
      assert.deepEqual(body.selection, { revision: 1, pockets: [] }); assert.deepEqual(body.context_ref, f.context_ref);
      const expected = { context_ref: f.context_ref, selection_revision: body.selection.revision };
      const preview = buildCustomCohortObservationPreview({ context_ref: f.context_ref, retained_inputs, selection: body.selection });
      const catalog = presentCustomCohortPocketCatalog({ expected, preview,
        catalog: buildCustomCohortPocketCatalog({ retained_inputs, preview, catalog_version: 3 }) });
      const selection = customCohortOpeningSelection(catalog, customCohortOpeningGroupIds(catalog), 1);
      const common = { target: { account_id: target.accountId, assignment_file_id: target.assignmentFileId },
        context_ref: f.context_ref, selection_revision: 1, subject_freshness: 'matched',
        apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
      producedOpening = { ...common, status: 'preview', summary: presentCustomCohortPreview({ expected,
        preview: buildCustomCohortObservationPreview({ context_ref: f.context_ref, retained_inputs, selection }) }),
      parcel_map: buildCustomCohortParcelMap({ retained_inputs, selected_account_ids: selection.pockets.flatMap(p => p.account_ids) }) };
      return new Response(JSON.stringify({ ...common, status: 'catalog', catalog, initial_preview: producedOpening }),
        { headers: { 'content-type': 'application/json' } });
    } };
  const catalogTransport = createCustomCohortJsonTransport(adapters);
  const owner = create({ target, onChange() {}, operationId: () => f.context_ref.context_id,
    catalog: (input, io) => catalogTransport(input.accountId, 'catalog', { assignment_file_id: input.assignmentFileId,
      context_ref: input.contextRef, selection: input.selection, catalog_version: input.catalogVersion,
      include_recommendation: true, initial_preview_mode: input.initialPreviewMode }, io),
    capture: async input => { assert.equal(input.operationId, f.context_ref.context_id); return { status: 'registered', reused: false,
      context_ref: f.context_ref, source_query_complete: true, discovery: { radius_metres: '4828.032',
        account_count: f.accountIds.length, parcel_count: f.parcels.length } }; },
    save: async input => {
      saves.push(copy(input)); assert.equal(input.expectedRevision, section?.revision ?? 0);
      if (input.value.active) { entered.resolve(); await ack.promise; }
      section = { revision: input.expectedRevision + 1, value: copy(input.value) };
      return { accountId: target.accountId, assignmentFileId: target.assignmentFileId, section: copy(section) };
    } });
  try {
    const work = owner.start(retained_inputs.study.observation_period); await entered.promise;
    assert.equal(owner.getState().initial_preview, null); assert.equal(section.value.active, null);
    ack.resolve(); const ready = await work; assert.equal(ready.status, 'ready'); assert.equal(ready.checkpoint.workspace_version, 6);
    const timers = new Map(); let sequence = 0;
    previewController = createCustomCohortPreviewController({ initialResponse: ready.initial_preview,
      fingerprint: async canonical => createHash('sha256').update(canonical).digest('hex'),
      timer: { set(fn) { timers.set(++sequence, fn); return sequence; }, clear(id) { timers.delete(id); } },
      transport: createCustomCohortPreviewTransport(adapters) });
    previewController.setSelection(ready.initial_preview.input);
    const pendingTimers = [...timers.values()]; timers.clear(); pendingTimers.forEach(fn => fn()); await drain();
    const visible = previewController.getState();
    assert.equal(visible.status, 'ready'); assert.equal(visible.freshness, 'current'); assert.equal(requests.length, 1);
    assert.equal(visible.group.summary.all.stock.member_count, f.accountIds.length);
    assert.equal(visible.group.summary.selected.stock.member_count, f.accountIds.length);
    assert.equal(visible.group.parcel_map.status, 'available'); assert.equal(visible.group.parcel_map.counts.selected_accounts, f.accountIds.length);
    assert.deepEqual(visible.group.parcel_map.geojson, producedOpening.parcel_map.geojson);
    assert.equal(visible.group.binding.selectionFingerprint, producedOpening.summary.binding.selection_sha256);
    assert.deepEqual(ready.selection, ready.initial_preview.input.selection);
    assert.equal(saves.length, 2); assert.ok(saves.every(save => !JSON.stringify(save.value).includes('initial_preview')));
    assert.equal(JSON.stringify(retained_inputs), before, 'no retained input was changed to fit the opening');
  } finally { ack.resolve(); previewController?.dispose(); owner.dispose(); }
});

for (const ids of [[groupId(1), groupId(2), 'discovery:unassigned'], []]) test(`v5 reopens the exact ${ids.length}-group selection in one read without saving`, async () => {
  const initialSection = legacyDenseSection(ids); initialSection.value.workspace_version = 5;
  const h = harness({ initialSection, loadCatalog: denseCatalog });
  const state = await h.controller.reopen();
  assert.deepEqual(h.calls.map(c => c.kind), ['catalog']);
  assert.deepEqual(h.calls[0].input.initialPreviewGroups, ids);
  assert.equal(h.calls[0].input.catalogVersion, 2);
  assert.equal(Object.hasOwn(h.calls[0].input, 'initialPreviewMode'), false);
  assert.deepEqual(state.initial_preview.input.selection, state.selection);
  assert.equal(state.initial_preview.value.fixture, 'opening');
  const opening = state.initial_preview;
  await h.controller.setGroups([groupId(3)]);
  assert.equal(h.controller.getState().initial_preview, opening, 'selection saves do not restart the opening controller');
  await h.reload();
  assert.notEqual(h.controller.getState().initial_preview, opening, 'explicit fresh reload supplies a new opening response');
  assert.deepEqual(h.calls.at(-1).input.initialPreviewGroups, [groupId(3)]);
  assert.deepEqual(h.db.section.value.active.selection.included_recorded_group_ids, [groupId(3)]);
  h.controller.dispose(); assert.equal(h.controller.getState().initial_preview, null);
});

for (const [version, load] of [[1, catalog], [5, denseCatalog], [6, catalogV3]]) test(`v${version} refuses a missing opening response without saving`, async () => {
  const initialSection = legacyDenseSection([]); initialSection.value.workspace_version = version;
  const h = harness({ initialSection, loadCatalog: input => { const result = load(input); delete result.initial_preview; return result; } });
  await rejects(h.controller.reopen(), 'opening_preview_missing');
  assert.equal(h.controller.getState().catalog, null); assert.equal(h.controller.getState().initial_preview, null);
  assert.deepEqual(h.calls.map(c => c.kind), ['catalog']);
  assert.deepEqual(h.calls[0].input.initialPreviewGroups, []);
  assert.equal(h.calls[0].input.catalogVersion, version === 6 ? 3 : version === 5 ? 2 : 1);
  h.controller.dispose();
});
function legacyDenseSection(included = ['discovery:unassigned']) {
  const s = activeSection(); s.value.active.selection.included_recorded_group_ids = included; return s;
}
for (const version of [1, 5]) test(`v${version} reopens pinned whole-unresolved before explicit v3 upgrade is CAS-saved without losing members`, async () => {
  const held = deferred(); let saves = 0;
  const initialSection = legacyDenseSection(); initialSection.value.workspace_version = version;
  const h = harness({ initialSection, loadCatalog: pinnedDenseCatalog,
    save: async (input, opts, commit) => { if (++saves === 1) await held.promise; return commit(input); } });
  const original = await h.controller.reopen();
  assert.deepEqual(h.calls.map(c => c.kind), ['catalog']); assert.equal(h.calls[0].input.catalogVersion, version === 5 ? 2 : 1);
  assert.deepEqual(h.db.section, initialSection); assert.equal(original.catalog.pockets.length, 0);
  assert.equal(original.catalog.status, 'incomplete');
  assert.equal(original.selection.pockets[0].account_ids.length, 1476);
  const upgrading = h.controller.upgradeGrouping(); await drain();
  assert.equal(h.controller.getState().phase, 'upgrading_catalog_checkpoint');
  assert.deepEqual(h.controller.getState().checkpoint, original.checkpoint);
  assert.equal(h.controller.getState().catalog, original.catalog); assert.deepEqual(h.db.section, initialSection);
  assert.ok(!h.states.some(s => s.status === 'ready' && s.catalog?.catalog_version === 3));
  const request = h.calls[1].input;
  assert.equal(request.catalogVersion, 3); assert.deepEqual(request.contextRef, context(OLD));
  assert.equal(request.selection.revision, 10);
  assert.equal(Object.hasOwn(request, 'initialPreviewMode'), false); assert.equal(Object.hasOwn(request, 'initialPreviewGroups'), false);
  assert.equal(h.calls[2].input.expectedRevision, initialSection.revision);
  held.resolve(); await upgrading;
  assert.deepEqual(h.calls.map(c => c.kind), ['catalog', 'catalog', 'save']); assert.equal(h.ids, 0);
  assert.equal(h.db.section.revision, 6); assert.equal(h.db.section.value.workspace_version, 6);
  assert.equal(h.db.section.value.active.selection.revision, 10);
  assert.deepEqual(h.controller.getState().selection.pockets[0].account_ids, original.selection.pockets[0].account_ids);
  assert.equal(h.controller.getState().catalog.pockets.length, 1475); assert.equal(h.controller.getState().initial_preview, null);
  await h.reload(); assert.equal(saves, 1); assert.equal(h.calls.at(-1).input.catalogVersion, 3);
  assert.equal(h.controller.getState().selection.pockets[0].account_ids.length, 1476);
  await h.controller.setGroups([groupId(1)]);
  assert.deepEqual(h.controller.getState().selection.pockets[0].account_ids, ['SUBJECT']);
  await h.reload(); assert.deepEqual(h.controller.getState().selection.pockets[0].account_ids, ['SUBJECT']);
  h.controller.dispose();
});
test('explicit v3 upgrade preserves exclusion of all; pinned legacy unknown groups never save', async () => {
  const empty = harness({ initialSection: legacyDenseSection([]), loadCatalog: pinnedDenseCatalog }); await empty.controller.reopen();
  await empty.controller.upgradeGrouping();
  assert.deepEqual(empty.controller.getState().selection.pockets, []); assert.equal(empty.db.section.value.workspace_version, 6);
  const bad = harness({ initialSection: activeSection(), loadCatalog: pinnedDenseCatalog });
  await rejects(bad.controller.reopen(), 'operation_failed');
  assert.deepEqual(bad.calls.map(c => c.kind), ['catalog']); assert.equal(bad.controller.getState().selection, null);
  empty.controller.dispose(); bad.controller.dispose();
});

test('explicit upgrade preserves a strict selected subset when new groups split the old selected leaf', async () => {
  const h = harness({ initialSection: activeSection(), loadCatalog(input) {
    const result = catalog(input), c = result.catalog;
    if (input.catalogVersion === 1) {
      c.pockets[1].account_ids = ['B', 'C']; c.pockets[1].member_count = 2;
      c.unassigned = { account_ids: [], member_count: 0, reason_counts: [] };
      c.coverage.assigned_account_count = 3; c.coverage.unassigned_account_count = 0;
    }
    return result;
  } });
  try {
    const old = await h.controller.reopen(); assert.deepEqual(old.selection.pockets[0].account_ids, ['B', 'C']);
    const next = await h.controller.upgradeGrouping();
    assert.deepEqual(next.selection.pockets[0].account_ids, ['B', 'C']);
    assert.deepEqual(next.checkpoint.active.selection.included_recorded_group_ids, [groupId(2), 'discovery:unassigned']);
    assert.equal(next.checkpoint.active.selection.revision, 10); assert.equal(next.section_revision, 6);
    assert.deepEqual(next.checkpoint.active.context_ref, old.checkpoint.active.context_ref);
    assert.deepEqual(next.checkpoint.active.observation_period, old.checkpoint.active.observation_period);
    assert.deepEqual(h.calls.map(c => c.kind), ['catalog', 'catalog', 'save']);
  } finally { h.controller.dispose(); }
});

for (const reason of ['merged selected and excluded', 'changed roster', 'changed context', 'wrong response version'])
  test(`explicit upgrade rejects ${reason} before any save or recapture`, async () => {
    const initial = activeSection(), h = harness({ initialSection: initial, loadCatalog(input) {
      const result = catalog(input), c = result.catalog;
      if (input.catalogVersion === 3) {
        if (reason === 'merged selected and excluded') {
          c.pockets[1].account_ids = ['B', 'C']; c.pockets[1].member_count = 2;
          c.unassigned = { account_ids: [], member_count: 0, reason_counts: [] };
          c.coverage.assigned_account_count = 3; c.coverage.unassigned_account_count = 0;
        }
        if (reason === 'changed roster') c.unassigned.account_ids = ['D'];
        if (reason === 'changed context') result.context_ref.context_id = OPERATION;
        if (reason === 'wrong response version') c.catalog_version = 2;
      }
      return result;
    } });
    try {
      await h.controller.reopen(); await assert.rejects(h.controller.upgradeGrouping());
      assert.deepEqual(h.db.section, initial); assert.deepEqual(h.calls.map(c => c.kind), ['catalog', 'catalog']);
      assert.equal(h.controller.getState().selection, null);
      assert.ok(!h.states.some(s => s.status === 'ready' && s.catalog?.catalog_version === 3));
    } finally { h.controller.dispose(); }
  });

for (const mode of ['no active', 'not reopened', 'pending capture', 'already v3']) test(`grouping upgrade is unavailable with ${mode}`, async () => {
  let initial = mode === 'no active' ? undefined : mode === 'pending capture' ? ordinaryPendingSection() : activeSection();
  if (mode === 'already v3') initial.value.workspace_version = 6;
  const h = harness({ initialSection: initial });
  try {
    if (mode === 'pending capture' || mode === 'already v3') await h.controller.reopen();
    const before = copy(h.db.section), count = h.calls.length;
    await rejects(h.controller.upgradeGrouping(), 'grouping_upgrade_unavailable');
    assert.equal(h.calls.length, count); assert.deepEqual(h.db.section, before);
  } finally { h.controller.dispose(); }
});

for (const [savedVersion, wrongVersion] of [[1, 2], [5, 3], [6, 2]]) test(`v${savedVersion} reopen refuses a server catalog version drift to ${wrongVersion}`, async () => {
  const initial = activeSection(); initial.value.workspace_version = savedVersion;
  const h = harness({ initialSection: initial, loadCatalog(input) { const result = catalog(input); result.catalog.catalog_version = wrongVersion; return result; } });
  try {
    await rejects(h.controller.reopen(), 'catalog_version_mismatch');
    assert.deepEqual(h.db.section, initial); assert.deepEqual(h.calls.map(c => c.kind), ['catalog']);
  } finally { h.controller.dispose(); }
});

test('fresh acquisition cannot publish a legacy catalog response to its explicit v3 request', async () => {
  const h = harness({ loadCatalog(input) { const result = catalog(input); result.catalog.catalog_version = 2; return result; } });
  try {
    await rejects(h.controller.start(PERIOD), 'catalog_version_mismatch');
    assert.deepEqual(h.calls.map(c => c.kind), ['save', 'capture', 'catalog']);
    assert.equal(h.db.section.value.active, null); assert.equal(h.calls.at(-1).input.catalogVersion, 3);
  } finally { h.controller.dispose(); }
});
test('uncertain dense upgrade ACK requires fresh reload; a committed upgrade is never replayed or called failed', async () => {
  const h = harness({ initialSection: legacyDenseSection(), loadCatalog: pinnedDenseCatalog, save(input, opts, commit) {
    commit(input); throw new Error('lost ACK');
  } });
  await h.controller.reopen(); await rejects(h.controller.upgradeGrouping(), 'operation_failed');
  assert.equal(h.controller.getState().recovery, 'reload'); assert.equal(h.controller.getState().selection, null);
  await rejects(h.controller.reopen(), 'recovery_required');
  await h.reload(); assert.equal(h.controller.getState().status, 'ready');
  assert.equal(h.calls.filter(c => c.kind === 'save').length, 1); assert.equal(h.controller.getState().selection.pockets[0].account_ids.length, 1476);
  assert.equal(h.calls.at(-1).input.catalogVersion, 3); h.controller.dispose();
});
for (const badAck of ['target', 'revision', 'value']) test(`dense upgrade rejects wrong ${badAck} ACK before preview`, async () => {
  const h = harness({ initialSection: legacyDenseSection(), loadCatalog: pinnedDenseCatalog, save(input, opts, commit) {
    const ack = commit(input);
    if (badAck === 'target') ack.assignmentFileId = '1';
    if (badAck === 'revision') ack.section.revision++;
    if (badAck === 'value') ack.section.value.active.selection.included_recorded_group_ids = [];
    return ack;
  } });
  await h.controller.reopen(); await assert.rejects(h.controller.upgradeGrouping()); assert.equal(h.controller.getState().recovery, 'reload');
  assert.equal(h.controller.getState().selection, null); assert.ok(!h.states.some(s => s.status === 'ready' && s.catalog?.catalog_version === 3));
  h.controller.dispose();
});
test('new dense capture writes v6 and preserves it while the next radius capture is pending', async () => {
  let captures = 0;
  const h = harness({ loadCatalog: denseCatalog, operationId: n => n === 1 ? OPERATION : OLD,
    capture(input) { if (++captures > 1) throw new Error('offline'); return captured(input); } });
  await h.controller.start(PERIOD); assert.equal(h.db.section.value.workspace_version, 6);
  assert.equal(h.controller.getState().selection.pockets[0].account_ids.length, 888);
  await rejects(h.controller.start(PERIOD, undefined, { profile_id: 'custom-suburban-radius-v2', radius_metres: '4828.032' }), 'operation_failed');
  assert.equal(h.db.section.value.workspace_version, 6); assert.equal(h.db.section.value.active.selection.included_recorded_group_ids.length, 888);
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
  assert.equal(result.checkpoint.workspace_version, 6); assert.equal(result.checkpoint.pending_capture, null);
  assert.deepEqual(Object.keys(result.checkpoint.active).sort(), ['context_ref', 'observation_period', 'selection']);
  assert.equal(h.maxOpen, 1); assert.equal(h.ids, 1);
  await h.controller.setGroups([]); assert.deepEqual(h.controller.getState().selection.pockets, []);
  assert.equal(h.db.section.value.workspace_version, 6);
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
