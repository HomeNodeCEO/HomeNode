import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import * as loader from '../src/features/neighborhood/customCohortViewportLoader.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { prepareCustomCohortGroupWorkspaceTransportRequest as serverRequest,
  presentCustomCohortGroupWorkspaceTransportResponse as serverResponse } from '../../server/src/services/neighborhoodAssessment/customCohortGroupWorkspaceTransport.js';
import { selectionSummaryTransportFixture } from '../../server/test/fixtures/customCohortSelectionSummaryTransportFixture.js';
import { selectionViewportFixture } from '../../server/test/fixtures/customCohortSelectionViewportFixture.js';
import { selectionMemberFixture } from '../../server/test/fixtures/customCohortSelectionMemberFixture.js';
import { selectionMapOpeningFixture } from '../../server/test/fixtures/customCohortSelectionMapOpeningFixture.js';

const load = (name, modules) => loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url),
  key => { assert.ok(Object.hasOwn(modules, key), `unexpected API dependency ${key}`); return modules[key]; });
const checkpoint = load('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalog, './customWorkspaceDiscovery.ts': discovery });
const workspace = load('customCohortGroupWorkspaceTransport', { './customWorkspaceCheckpoint.ts': checkpoint,
  './customCohortPreviewTransport.ts': transport, './customCohortRecordedGroupTransport.ts': selection });
const display = load('customCohortGroupDisplay', { './customCohortGroupWorkspaceTransport.ts': workspace,
  './customCohortRecordedGroupTransport.ts': selection });
const mapView = load('customCohortGroupMapView', { './customCohortGroupDisplay.ts': display, './customCohortViewportLoader.ts': loader });
const legacy = load('customWorkspaceApi', { './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': transport });
const { createCustomCohortGroupWorkspaceApi: create } = load('customCohortGroupWorkspaceApi', {
  './customWorkspaceApi.ts': legacy, './customCohortPreviewTransport.ts': transport,
  './customCohortGroupWorkspaceTransport.ts': workspace, './customCohortRecordedGroupTransport.ts': selection,
  './customCohortGroupDisplay.ts': display,
  './customCohortGroupMapView.ts': mapView,
});
const { createCustomCohortGroupWorkspaceLifecycle: lifecycle } = load('customCohortGroupWorkspaceLifecycle', {
  './customCohortGroupWorkspaceTransport.ts': workspace, './customCohortRecordedGroupTransport.ts': selection,
  './customWorkspaceCheckpoint.ts': checkpoint, './customCohortPocketCatalog.ts': catalog,
  './customCohortGroupDisplay.ts': display,
});
const TARGET = { accountId: 'SUBJECT', assignmentFileId: '37', sessionKey: 'synthetic-session' };
const CONTEXT = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const OPERATION = '70000000-0000-4000-8000-000000000002';
const PERIOD = { start_date: '2024-01-01', end_date: '2024-06-30' };
const REF = { selection_version: 1, selection_revision: 1, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '1000' } };
const GROUP = `recorded-cad:${'a'.repeat(64)}`;
const empty = () => ({ workspace_version: 7, active: null, pending_capture: null });
const active = () => ({ ...empty(), active: { context_ref: structuredClone(CONTEXT), observation_period: structuredClone(PERIOD), selection_ref: structuredClone(REF) } });
const pending = () => ({ operation_id: CONTEXT.context_id, observation_period: structuredClone(PERIOD) });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const readResponse = () => ({ ok: true, account_id: TARGET.accountId, workfile: { assignment_file_id: 37, status: 'draft',
  sections: { neighborhood_workspace: { revision: 5, value: active(), updated_by: 'synthetic-actor', updated_at: 'synthetic-date' },
    neighborhood_assessment: { revision: 8, value: { retained: 'never returned by this reader' } },
    document_evidence: { private_source: 'not returned' } }, signed_snapshot: null } });
function harness(reply = () => json(readResponse())) {
  const calls = [], paths = [], keys = [];
  const api = create({ request: async (url, init) => { calls.push({ url, init }); return reply(url, init); },
    urlFor: path => { paths.push(path); return `https://example.invalid${path}`; },
    editorKeyForSave: (...args) => { keys.push(args); throw new Error('atomic API must never acquire a generic editor-save key'); } });
  return { api, calls, paths, keys };
}
const refusal = code => error => error.workspaceCode === code && error.message === `custom_workspace_${code}`;

test('fresh V7 reads preserve exact target/session, section reference and current status without returning unrelated private or accepted report data', async () => {
  for (const status of ['draft', 'signed', 'archived']) {
    const h = harness(() => { const value = readResponse(); value.workfile.status = status; return json(value); });
    const options = io(), result = await h.api.read(TARGET, options);
    assert.deepEqual(result, { target: TARGET, status, section: { revision: 5, value: active() } });
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.target) && Object.isFrozen(result.section.value.active.selection_ref.manifest_ref));
    assert.equal(h.paths[0], '/api/accounts/SUBJECT/assignment-files/37/workfile');
    assert.equal(h.calls[0].init.method, 'GET'); assert.equal(h.calls[0].init.cache, 'no-store');
    assert.equal(h.calls[0].init.signal, options.signal); assert.equal(h.keys.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /document_evidence|neighborhood_assessment|signed_snapshot|private_source/);
  }
  const absent = harness(() => { const value = readResponse(); delete value.workfile.sections.neighborhood_workspace; return json(value); });
  assert.equal((await absent.api.read(TARGET, io())).section, undefined);
});

test('present corrupt, legacy and future workspace data cannot be mistaken for absence or silently upgraded', async () => {
  for (const section of [null, {}, { revision: 0, value: empty() }, { revision: 1, value: { ...empty(), workspace_version: 6 } },
    { revision: 1, value: { ...empty(), workspace_version: 8 } }, { revision: 5, value: { ...active(), source_rows: [] } }]) {
    const h = harness(() => { const value = readResponse(); value.workfile.sections.neighborhood_workspace = section; return json(value); });
    await assert.rejects(h.api.read(TARGET, io()), refusal('invalid_response')); assert.equal(h.calls.length, 1); assert.equal(h.keys.length, 0);
  }
});

test('workfile read rejects wrong account/file/status/revision and unsafe generic IDs without rounding the cohort command identity', async () => {
  for (const change of [value => { value.account_id = 'OTHER'; }, value => { value.workfile.assignment_file_id = 38; },
    value => { value.workfile.assignment_file_id = '37'; }, value => { value.workfile.status = 'other'; },
    value => { value.workfile.sections.neighborhood_workspace.revision = '5'; }]) {
    const h = harness(() => { const value = readResponse(); change(value); return json(value); });
    await assert.rejects(h.api.read(TARGET, io()), refusal('invalid_response'));
  }
  const h = harness();
  for (const target of [{ ...TARGET, assignmentFileId: '9007199254740993' }, { ...TARGET, assignmentFileId: '037' },
    { ...TARGET, sessionKey: '' }, { ...TARGET, sessionKey: 'session\u0000' }, { ...TARGET, accountId: '../another' }])
    await assert.rejects(h.api.read(target, io()), refusal('invalid_target'));
  assert.equal(h.calls.length, 0); assert.equal(h.paths.length, 0); assert.equal(h.keys.length, 0);
});

test('late authentication cannot rebind a fresh read to caller-mutated file/session fields', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; })), target = structuredClone(TARGET);
  const waiting = h.api.read(target, io()); target.accountId = 'OTHER'; target.assignmentFileId = '38'; target.sessionKey = 'other-session';
  while (!release) await Promise.resolve(); release(json(readResponse()));
  assert.deepEqual((await waiting).target, TARGET); assert.equal(h.calls.length, 1);
});

test('all four mutations use actual checked atomic wire receipts, never the generic section writer or editor-save key', async () => {
  const checkpoint = { ...empty(), pending_capture: pending() };
  const shared = { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId };
  for (const kind of ['start', 'cancel', 'complete', 'save']) {
    const actions = { start: 'start-group-capture', cancel: 'cancel-group-capture', complete: 'complete-group-capture', save: 'save-groups' };
    const write = { ...shared, contextRef: CONTEXT, operationId: OPERATION, expectedSelectionRef: null,
      includedRecordedGroupIds: [GROUP], expectedWorkspaceRevision: 5 };
    const input = kind === 'start' ? { ...shared, expectedWorkspaceRevision: 0, expectedWorkspaceCheckpoint: empty(), pendingCapture: pending() }
      : kind === 'cancel' ? { ...shared, expectedWorkspaceRevision: 5, expectedWorkspaceCheckpoint: checkpoint }
        : kind === 'complete' ? { ...write, expectedWorkspaceCheckpoint: checkpoint } : write;
    const h = harness((url, init) => {
      assert.ok(url.endsWith(`/neighborhood-cohort/${actions[kind]}`));
      const admitted = serverRequest(JSON.parse(init.body), actions[kind]);
      const value = kind === 'start' ? checkpoint : kind === 'cancel' ? empty() : active();
      const result = { status: 'stored', workspace: { revision: input.expectedWorkspaceRevision + 1, value },
        ...(['save', 'complete'].includes(kind) ? { authority: 'not_established', context_ref: CONTEXT, selection_ref: REF,
          operation_id: OPERATION, included_recorded_group_ids: [GROUP] } : {}) };
      return json(serverResponse(result, admitted, actions[kind]));
    });
    const result = await h.api[kind](input, io());
    assert.equal(result.workspace.revision, input.expectedWorkspaceRevision + 1);
    assert.equal(result.authority, 'not_established'); assert.equal(h.calls.length, 1); assert.equal(h.keys.length, 0);
    assert.equal(h.paths.some(path => path.includes('/workfile/sections/')), false);
  }
});

test('current head reads remain exact, deliberate empty stays empty, and a foreign or absent reference is not fabricated', async () => {
  const input = { accountId: TARGET.accountId, assignmentFileId: '9007199254740993', contextRef: CONTEXT };
  const response = { status: 'selected', authority: 'not_established', context_ref: CONTEXT, selection_ref: REF, included_recorded_group_ids: [] };
  const h = harness(() => json(response)), result = await h.api.readSelection(input, io());
  assert.deepEqual(result.included_recorded_group_ids, []); assert.deepEqual(result.selection_ref, REF);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { assignment_file_id: input.assignmentFileId, context_ref: CONTEXT });
  assert.equal(h.keys.length, 0);
  const absent = harness(() => json({ ...response, status: 'absent', selection_ref: null, included_recorded_group_ids: null }));
  assert.equal((await absent.api.readSelection(input, io())).status, 'absent');
  const foreign = harness(() => json({ ...response, context_ref: { ...CONTEXT, context_sha256: 'd'.repeat(64) } }));
  await assert.rejects(foreign.api.readSelection(input, io()), refusal('request_failed'));
});

test('fresh API V7 read and exact catalog/head ports reopen in the actual lifecycle as one selected reference without a mutation', async () => {
  const head = { status: 'selected', authority: 'not_established', context_ref: CONTEXT, selection_ref: REF, included_recorded_group_ids: [GROUP] };
  const h = harness((url, init) => {
    if (init.method === 'GET') return json(readResponse());
    if (url.endsWith('/group-selection')) return json(head);
    assert.ok(url.endsWith('/catalog'));
    const request = JSON.parse(init.body);
    return json({ status: 'catalog', subject_freshness: 'matched', target: { account_id: TARGET.accountId, assignment_file_id: TARGET.assignmentFileId },
      context_ref: CONTEXT, selection_revision: request.selection.revision, apply: { status: 'blocked' }, catalog: {
        catalog_version: 3, status: 'review_only', apply: { status: 'blocked' },
        binding: { context_ref: CONTEXT, selection_revision: request.selection.revision },
        pockets: [{ id: GROUP, disposition: 'needs_review', label: 'Synthetic subdivision', county: 'Synthetic', account_ids: ['SUBJECT'], member_count: 1 }],
        unassigned: { account_ids: [], member_count: 0, reason_counts: [] },
        coverage: { discovery_member_count: 1, assigned_account_count: 1, unassigned_account_count: 0 },
        subject_membership: { account_id: 'SUBJECT', assigned_pocket_id: GROUP, recorded_label_match_only: true, status: 'matched' }, limitations: [],
      } });
  });
  const fresh = await h.api.read(TARGET, io()), states = [];
  // This older fixture tests the explicitly observation-free lifecycle. The
  // coherent-display fixture below exercises the full API composition.
  const owner = lifecycle({ ...h.api, display: undefined, target: fresh.target, initialSection: fresh.section,
    initialGroups: () => [], onChange: state => states.push(state) });
  try {
    const ready = await owner.reopen(); assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.checkpoint.active.selection_ref, ready.selected.selection_ref);
    assert.deepEqual(ready.selected.included_recorded_group_ids, [GROUP]); assert.equal(ready.section_revision, 5);
    assert.deepEqual(h.paths.map(path => path.split('/').at(-1)), ['workfile', 'catalog', 'group-selection']);
    assert.equal(h.keys.length, 0); assert.equal(states.some(state => state.status === 'ready' && state.selected === null), false);
  } finally { owner.dispose(); }
});

test('current rights, signed locks, unknown COMMIT and storage failures retain exact sanitized machine distinctions without retry or raw diagnostic text', async () => {
  const input = { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, expectedWorkspaceRevision: 5,
    expectedWorkspaceCheckpoint: { ...empty(), pending_capture: pending() } };
  for (const [status, error, code] of [[401, 'authentication_required', 'save_authentication_required'],
    [403, 'neighborhood_access_denied', 'save_access_denied'], [409, 'neighborhood_workspace_changed', 'save_revision_conflict'],
    [409, 'neighborhood_private_source_read_only', 'save_read_only'], [409, 'neighborhood_operation_outcome_unknown', 'save_outcome_unknown'],
    [503, 'neighborhood_service_busy', 'save_service_busy'], [503, 'neighborhood_request_interrupted', 'save_interrupted'],
    [500, 'raw SQL credential-like diagnostic', 'request_failed'], [403, 'neighborhood_workspace_changed', 'request_failed']]) {
    const h = harness(() => json({ error, private_source: 'must not propagate' }, status));
    await assert.rejects(h.api.cancel(input, io()), err => refusal(code)(err) && err.status === status && !('cause' in err));
    assert.equal(h.calls.length, 1); assert.equal(h.keys.length, 0);
  }
});

test('exact numeric summary keeps all selected properties, independently of the viewport, through the actual retained producer fixture', async () => {
  const f = await selectionSummaryTransportFixture({ accountId: 'R-001/#1' }), h = harness(() => json(f.result));
  const input = { accountId: 'R-001/#1', assignmentFileId: f.request.assignment_file_id,
    contextRef: f.request.context_ref, selectionRef: f.request.selection_ref };
  const result = await h.api.preview(input, io());
  assert.deepEqual(result.summary, f.result.summary); assert.equal(result.summary.all.account_count, 3);
  assert.equal(result.summary.selected.account_count, 2); assert.deepEqual(result.selection_ref, f.request.selection_ref);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), f.request); assert.equal(result.apply.status, 'blocked');
  assert.doesNotMatch(h.calls[0].init.body, /account_ids|included_recorded_group_ids|pockets/);
});

test('exact map-opening API port preserves the complete neutral manifest/current reference without an editor key or generic save', async () => {
  const f = await selectionMapOpeningFixture(), h = harness(() => json(f.result));
  const input = { accountId: f.accountId, assignmentFileId: f.request.assignment_file_id,
    contextRef: f.request.context_ref, selectionRef: f.request.selection_ref };
  const out = await h.api.opening(input, f.saved, f.catalog, io());
  assert.deepEqual(out.manifest, f.result.map_opening.manifest); assert.deepEqual(out.selection_ref, f.request.selection_ref);
  assert.equal(h.keys.length, 0); assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), f.request);
});

test('exact viewport and member ports preserve the producer selection and complete analytical population, not the displayed geometry prefix', async () => {
  const f = await selectionViewportFixture({ accountId: 'R-001/#1' });
  const saved = { status: 'selected', authority: 'not_established', context_ref: f.request.context_ref,
    selection_ref: f.request.selection_ref, included_recorded_group_ids: [GROUP] };
  const local = { binding: { context_ref: f.request.context_ref, selection_revision: 1 },
    pockets: [{ id: GROUP, account_ids: ['10000000000000000', '10000000000000001'] }], unassigned: { account_ids: ['10000000000000002'] } };
  const h = harness(() => json(f.result)), input = { accountId: 'R-001/#1', assignmentFileId: f.request.assignment_file_id,
    contextRef: f.request.context_ref, selectionRef: f.request.selection_ref, viewport: f.request.viewport };
  const viewport = await h.api.viewport(input, saved, local, 3, io());
  assert.deepEqual(viewport.map.features.map(feature => feature.properties.selected), [true, false]);
  assert.equal(f.summary.selected.account_count, 2); assert.deepEqual(JSON.parse(h.calls[0].init.body), f.request);
  const m = await selectionMemberFixture({ accountId: 'R-001/#1' }), memberInput = { accountId: 'R-001/#1', assignmentFileId: m.request.assignment_file_id,
    contextRef: m.request.context_ref, selectionRef: m.request.selection_ref, population: { group: 'selected', kind: 'stock' }, page: m.request.page };
  const memberSaved = { ...saved, context_ref: m.request.context_ref, selection_ref: m.request.selection_ref };
  const memberCatalog = { ...local, binding: { context_ref: m.request.context_ref, selection_revision: 1 } };
  const mh = harness((_url, init) => { const r = JSON.parse(init.body); return json(m.resultFor(r.population, r.page)); });
  const members = await mh.api.members(memberInput, memberSaved, memberCatalog, { group: 'selected', kind: 'stock', total_count: 2 }, io());
  assert.equal(members.members.page.total_count, 2); assert.equal(members.members.page.returned_count, 1);
  assert.deepEqual(members.selection_ref, m.request.selection_ref);
  assert.doesNotMatch(mh.calls[0].init.body, /account_ids|included_recorded_group_ids|pockets/);
});

test('abort terminates a hung read without a second request, and shared capture/catalog/report ports do not acquire a generic-save key', async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; })), abort = new AbortController();
  const waiting = h.api.read(TARGET, { signal: abort.signal, deadline: performance.now() + 60_000 });
  while (!release) await Promise.resolve(); abort.abort(); await assert.rejects(waiting, error => error.name === 'AbortError');
  release(json(readResponse())); assert.equal(h.calls.length, 1); assert.equal(h.keys.length, 0);
  const fresh = harness((_url, init) => init.method === 'GET' ? json(readResponse()) : json({ status: 'registered',
    discovery: { account_count: 3, parcel_count: 3, radius_metres: '4828.032' } }));
  await fresh.api.capture({ target: TARGET, operationId: OPERATION, observationPeriod: PERIOD }, io());
  await fresh.api.catalog({ accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, contextRef: CONTEXT,
    selection: { revision: 1, pockets: [] }, catalogVersion: 3 }, io());
  assert.equal(await fresh.api.readReportEditor(TARGET, io()), 8);
  await fresh.api.reportedOperation({ target: TARGET, operation: 'reported-proposal', body: { operation_id: OPERATION } }, io());
  assert.equal(fresh.keys.length, 0);
  assert.deepEqual(fresh.paths.map(path => path.split('/').at(-1)), ['capture', 'catalog', 'workfile', 'reported-proposal']);
});
