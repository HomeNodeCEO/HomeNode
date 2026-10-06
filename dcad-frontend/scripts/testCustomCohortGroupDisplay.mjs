import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { createCustomWorkspaceRequestLane } from '../src/features/neighborhood/customWorkspaceRequestLane.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { selectionMapOpeningFixture } from '../../server/test/fixtures/customCohortSelectionMapOpeningFixture.js';
import { selectionSummaryTransportFixture } from '../../server/test/fixtures/customCohortSelectionSummaryTransportFixture.js';
import { presentCustomCohortGroupMapOpening } from '../../server/src/services/neighborhoodAssessment/customCohortGroupMapOpening.js';
import { canonicalAssessmentJson } from '../../server/src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortGroupWorkspaceTransportRequest as serverRequest,
  presentCustomCohortGroupWorkspaceTransportResponse as serverResponse } from '../../server/src/services/neighborhoodAssessment/customCohortGroupWorkspaceTransport.js';

const load = (name, dependencies) => loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url),
  key => { assert.ok(Object.hasOwn(dependencies, key), `unexpected display import ${key}`); return dependencies[key]; });
const checkpoint = load('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers, './customWorkspaceDiscovery.ts': discovery });
const workspace = load('customCohortGroupWorkspaceTransport', { './customWorkspaceCheckpoint.ts': checkpoint,
  './customCohortPreviewTransport.ts': transport, './customCohortRecordedGroupTransport.ts': selection });
const display = load('customCohortGroupDisplay', { './customCohortGroupWorkspaceTransport.ts': workspace, './customCohortRecordedGroupTransport.ts': selection });
const legacy = load('customWorkspaceApi', { './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': transport });
const { createCustomCohortGroupWorkspaceApi: createApi } = load('customCohortGroupWorkspaceApi', {
  './customWorkspaceApi.ts': legacy, './customCohortPreviewTransport.ts': transport,
  './customCohortGroupWorkspaceTransport.ts': workspace, './customCohortRecordedGroupTransport.ts': selection,
  './customCohortGroupDisplay.ts': display,
});
const { createCustomCohortGroupWorkspaceLifecycle: lifecycle } = load('customCohortGroupWorkspaceLifecycle', {
  './customCohortGroupWorkspaceTransport.ts': workspace, './customCohortRecordedGroupTransport.ts': selection,
  './customWorkspaceCheckpoint.ts': checkpoint, './customCohortPocketCatalog.ts': catalogHelpers, './customCohortGroupDisplay.ts': display,
});
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const drain = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); await new Promise(resolve => setImmediate(resolve)); };
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
function rawCatalog(f) {
  return { status: 'catalog', subject_freshness: 'matched', target: { account_id: f.accountId, assignment_file_id: f.request.assignment_file_id },
    context_ref: f.request.context_ref, selection_revision: f.request.selection_ref.selection_revision, apply: { status: 'blocked' },
    catalog: { ...f.catalog, binding: { ...f.catalog.binding, selection_revision: f.request.selection_ref.selection_revision },
      pockets: f.catalog.pockets.map(p => ({ ...p, disposition: 'needs_review' })), unassigned: { ...f.catalog.unassigned, reason_counts: [] },
      coverage: { discovery_member_count: 3, assigned_account_count: 3, unassigned_account_count: 0 }, limitations: [] } };
}
async function fixture(options = {}) {
  options = { assignmentFileId: '37', ...options };
  const f = await selectionMapOpeningFixture(options);
  const summary = await selectionSummaryTransportFixture({ accountId: f.accountId, ...options });
  const input = { accountId: f.accountId, assignmentFileId: f.request.assignment_file_id,
    contextRef: f.request.context_ref, selection: { revision: f.request.selection_ref.selection_revision, pockets: [] } };
  const catalog = catalogHelpers.checkCustomCohortPocketCatalog(rawCatalog(f), input);
  const target = { accountId: f.accountId, assignmentFileId: f.request.assignment_file_id, sessionKey: 'synthetic-session' };
  const value = { target, workspaceRevision: 5, checkpoint: { workspace_version: 7, pending_capture: null,
    active: { context_ref: f.request.context_ref, selection_ref: f.request.selection_ref, observation_period: summary.result.summary.observation_period } },
    catalog, selected: f.saved };
  return { ...f, numerical: summary.result, value };
}
async function harness(options = {}) {
  const f = await fixture(options), calls = [], states = [], keys = [];
  let current = f, section = { revision: 5, value: structuredClone(f.value.checkpoint) }, openingHeld = null, maxOpen = 0, open = 0;
  const api = createApi({ urlFor: p => `https://example.invalid${p}`,
    editorKeyForSave: () => { keys.push(true); throw new Error('no generic writer'); },
    request: async (url, init) => {
      const action = url.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null;
      calls.push({ action, body, signal: init.signal }); open++; maxOpen = Math.max(maxOpen, open);
      try {
        if (action === 'catalog') return json(rawCatalog(current));
        if (action === 'group-selection') return json(current.saved);
        if (action === 'selection-preview') return options.preview ? options.preview(current, init) : json(current.numerical);
        if (action === 'selection-map-opening') return openingHeld ? await openingHeld.promise
          : options.opening ? options.opening(current, init) : json(current.result);
        if (action === 'save-groups') {
          const command = serverRequest(body, action);
          assert.equal(command.expected_workspace_revision, section.revision);
          assert.deepEqual(command.expected_selection_ref, current.request.selection_ref);
          current = await fixture({ revision: current.request.selection_ref.selection_revision + 1, empty: body.included_recorded_group_ids.length === 0 });
          assert.deepEqual(body.included_recorded_group_ids, current.saved.included_recorded_group_ids);
          section = { revision: section.revision + 1, value: structuredClone(current.value.checkpoint) };
          return json(serverResponse({ ...current.saved, status: 'stored', operation_id: body.operation_id, workspace: section }, command, action));
        }
        throw new Error(`unexpected wire request ${action}`);
      } finally { open--; }
    } });
  return { f, api, calls, keys, states, get current() { return current; }, get section() { return section; }, get maxOpen() { return maxOpen; },
    holdOpening() { openingHeld = deferred(); return openingHeld; },
    owner() { return lifecycle({ ...api, target: f.value.target, initialSection: section,
      initialGroups: () => [], onChange: s => states.push(s), operationId: () => '70000000-0000-4000-8000-000000000009' }); } };
}

test('coherent API composition publishes whole numeric population and neutral map in one frozen exact-reference bundle', async () => {
  const h = await harness(), options = io(), result = await h.api.display(h.f.value, options);
  assert.deepEqual(h.calls.map(c => c.action), ['selection-preview', 'selection-map-opening']); assert.equal(h.maxOpen, 1);
  assert.ok(h.calls.every(c => c.signal === options.signal)); assert.deepEqual(result.active, h.f.value.checkpoint.active);
  assert.deepEqual(result.selected.included_recorded_group_ids, h.f.saved.included_recorded_group_ids);
  assert.equal(result.catalog, h.f.value.catalog); assert.deepEqual(result.manifest, h.f.result.map_opening.manifest);
  assert.equal(result.observations.summary.selected.account_count, 2); assert.equal(result.observations.summary.all.account_count, 3);
  assert.equal(result.manifest.counts.captured_parcels, 3); assert.equal(result.manifest.subject_parcels.length, 1);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.active.selection_ref.manifest_ref) && Object.isFrozen(result.observations.summary));
  assert.doesNotMatch(JSON.stringify(h.calls), /account_ids|included_recorded_group_ids/); assert.equal(h.keys.length, 0);
  assert.equal(display.checkCustomCohortGroupDisplayResult(result, h.f.value), result);
  assert.throws(() => display.checkCustomCohortGroupDisplayResult(structuredClone(result), h.f.value), /invalid_custom_cohort_group_display/);
});

test('deliberate empty selection retains complete map labels/subject while statistics remain empty', async () => {
  const empty = await harness({ empty: true }), nonempty = await harness();
  const result = await empty.api.display(empty.f.value, io());
  assert.equal(result.observations.summary.selected.account_count, 0); assert.deepEqual(result.selected.included_recorded_group_ids, []);
  assert.deepEqual(result.manifest, (await nonempty.api.display(nonempty.f.value, io())).manifest);
});

test('exact period, immutable catalog, absent/foreign selection, target and closed caller intent fail before I/O', async () => {
  const h = await harness(), value = h.f.value;
  for (const altered of [{ ...value, workspaceRevision: 0 }, { ...value, catalog: structuredClone(value.catalog) },
    { ...value, target: { ...value.target, accountId: 'OTHER' } }, { ...value, target: { ...value.target, sessionKey: '' } },
    { ...value, selected: { ...value.selected, status: 'absent', selection_ref: null, included_recorded_group_ids: null } },
    { ...value, selected: { ...value.selected, selection_ref: { ...value.selected.selection_ref, selection_sha256: 'd'.repeat(64) } } },
    { ...value, checkpoint: { ...value.checkpoint, active: null } }, { ...value, account_ids: [] }])
    await assert.rejects(h.api.display(altered, io()));
  let getters = 0; const poisoned = { ...value }; Object.defineProperty(poisoned, 'target', { enumerable: true, get() { getters++; return value.target; } });
  await assert.rejects(h.api.display(poisoned, io())); assert.equal(getters, 0); assert.equal(h.calls.length, 0);
  const changedPeriod = { ...value, checkpoint: { ...value.checkpoint, active: { ...value.checkpoint.active,
    observation_period: { start_date: '2020-01-01', end_date: '2020-12-31' } } } };
  await assert.rejects(h.api.display(changedPeriod, io())); assert.deepEqual(h.calls.map(c => c.action), ['selection-preview']);
});

test('caller target/checkpoint/intent are pinned before numeric await without freezing or editing caller objects', async () => {
  const held = deferred(), h = await harness({ preview: () => held.promise }), value = { ...h.f.value,
    target: { ...h.f.value.target }, checkpoint: structuredClone(h.f.value.checkpoint), selected: structuredClone(h.f.value.selected) };
  const wait = h.api.display(value, io()); await drain(); value.target.sessionKey = 'OTHER'; value.target.accountId = 'OTHER';
  value.checkpoint.active.observation_period.start_date = '2020-01-01'; value.selected.included_recorded_group_ids.length = 0;
  held.resolve(json(h.f.numerical)); const result = await wait;
  assert.deepEqual(result.target, h.f.value.target); assert.deepEqual(result.active, h.f.value.checkpoint.active);
  assert.deepEqual(result.selected, h.f.value.selected); assert.ok(!Object.isFrozen(value.target));
});

test('a missing/stale/foreign map never turns already finished numerical results into a display', async () => {
  for (const [status, error] of [[403, 'neighborhood_access_denied'], [409, 'neighborhood_selection_changed'], [503, 'neighborhood_request_interrupted']]) {
    const h = await harness({ opening: () => json({ error }, status) });
    await assert.rejects(h.api.display(h.f.value, io())); assert.equal(h.calls.length, 2);
  }
  const h = await harness({ opening: f => json({ ...f.result, selection_ref: { ...f.request.selection_ref, selection_sha256: 'e'.repeat(64) } }) });
  await assert.rejects(h.api.display(h.f.value, io())); assert.equal(h.calls.length, 2);
});

test('aborting between projections sends no opening; ignored late openings cannot become a coherent bundle', async () => {
  const first = deferred(), h = await harness({ preview: () => first.promise }), options = io();
  const wait = h.api.display(h.f.value, options); await drain(); options.signal.throwIfAborted();
  const owner = new AbortController(), h2 = await harness({ preview: () => { owner.abort(); return json(h.f.numerical); } });
  await assert.rejects(h2.api.display(h2.f.value, { signal: owner.signal, deadline: performance.now() + 1000 }), { name: 'AbortError' });
  assert.equal(h2.calls.length, 1); first.resolve(json(h.f.numerical)); await wait;
  const h3 = await harness(), held = h3.holdOpening(), abort = new AbortController();
  const late = h3.api.display(h3.f.value, { signal: abort.signal, deadline: performance.now() + 1000 });
  await drain(); abort.abort(); await assert.rejects(late, { name: 'AbortError' }); held.resolve(json(h3.f.result));
  assert.equal(h3.calls.length, 2);
});

test('display acceptance cannot rebind file/session/workspace revision, checkpoint or catalog instance', async () => {
  const h = await harness(), result = await h.api.display(h.f.value, io());
  for (const value of [{ ...h.f.value, workspaceRevision: 6 }, { ...h.f.value, target: { ...h.f.value.target, sessionKey: 'OTHER' } },
    { ...h.f.value, catalog: catalogHelpers.checkCustomCohortPocketCatalog(rawCatalog(h.f), { accountId: h.f.accountId,
      assignmentFileId: h.f.request.assignment_file_id, contextRef: h.f.request.context_ref, selection: { revision: 1, pockets: [] } }) }])
    assert.throws(() => display.checkCustomCohortGroupDisplayResult(result, value), /invalid_custom_cohort_group_display/);
});

test('the actual V7 lifecycle waits for a complete pair before readiness, retains old coherent results during a toggle, and publishes deliberate empty together', async () => {
  const h = await harness(), owner = h.owner();
  try {
    const first = await owner.reopen(); assert.equal(first.display_freshness, 'current'); assert.ok(first.display);
    assert.deepEqual(h.calls.map(c => c.action), ['catalog', 'group-selection', 'selection-preview', 'selection-map-opening']);
    const original = first.display, held = h.holdOpening(), saving = owner.setGroups([]); void saving.catch(() => {}); await drain();
    assert.equal(owner.getState().display, original); assert.equal(owner.getState().display_freshness, 'stale');
    for (let i = 0; i < 1000 && h.calls.filter(c => c.action === 'selection-map-opening').length < 2; i++) await drain();
    if (h.calls.filter(c => c.action === 'selection-map-opening').length < 2) {
      assert.fail(`display did not reach opening: ${h.calls.map(c => c.action).join(',')} / ${JSON.stringify(owner.getState())}`);
    }
    assert.equal(h.calls.filter(c => c.action === 'selection-map-opening').length, 2);
    assert.equal(owner.getState().status, 'busy'); assert.equal(owner.getState().display, original);
    await assert.rejects(owner.setGroups([]), error => error.workspaceCode === 'busy');
    held.resolve(json(h.current.result)); const ready = await saving;
    assert.equal(ready.display_freshness, 'current'); assert.equal(ready.display.workspace_revision, 6);
    assert.equal(ready.display.observations.summary.selected.account_count, 0); assert.deepEqual(ready.display.selected.included_recorded_group_ids, []);
    assert.equal(ready.display.manifest.labels.features.length, 2); assert.equal(ready.display.manifest.subject_parcels.length, 1);
    assert.equal(h.calls.filter(c => c.action === 'save-groups').length, 1); assert.equal(h.maxOpen, 1);
    assert.ok(h.states.every(s => s.display_freshness !== 'current' || s.display.active.selection_ref.selection_sha256 === s.checkpoint.active.selection_ref.selection_sha256));
  } finally { owner.dispose(); }
});

test('post-ACK display failure retains previous map/numbers and recovers by reopening acknowledged head, never resending its save', async () => {
  let rejectNew = false;
  const h = await harness({ opening: f => rejectNew && f.request.selection_ref.selection_revision > 1 ? json({ error: 'neighborhood_service_busy' }, 503) : json(f.result) });
  const owner = h.owner();
  try {
    const first = await owner.reopen(); rejectNew = true;
    await assert.rejects(owner.setGroups([])); const failed = owner.getState();
    assert.equal(failed.section_revision, 6); assert.equal(failed.recovery, 'reopen'); assert.equal(failed.display, first.display);
    assert.equal(failed.display_freshness, 'stale'); rejectNew = false;
    const recovered = await owner.reopen(); assert.equal(recovered.display_freshness, 'current'); assert.equal(recovered.section_revision, 6);
    assert.equal(recovered.display.observations.summary.selected.account_count, 0);
    assert.equal(h.calls.filter(c => c.action === 'save-groups').length, 1); assert.equal(h.keys.length, 0);
  } finally { owner.dispose(); }
});

test('disposed lifecycle cannot accept an ignored late pair or allow another action', async () => {
  const h = await harness(), held = h.holdOpening(), owner = h.owner();
  const waiting = owner.reopen(); void waiting.catch(() => {});
  for (let i = 0; i < 1000 && !h.calls.some(c => c.action === 'selection-map-opening'); i++) await drain();
  assert.ok(h.calls.some(c => c.action === 'selection-map-opening'));
  owner.dispose(); await assert.rejects(waiting); held.resolve(json(h.f.result)); await drain();
  assert.equal(owner.getState().status, 'disposed'); assert.equal(owner.getState().display, null);
  await assert.rejects(owner.reopen(), error => error.workspaceCode === 'disposed');
});

test('int64 and maximum read-only selection/workspace revisions remain exact without a write or local UUID allocation', async () => {
  const h = await harness({ assignmentFileId: '9007199254740993', revision: 2147483647 });
  const value = { ...h.f.value, workspaceRevision: 2147483647 }, result = await h.api.display(value, io());
  assert.equal(result.workspace_revision, 2147483647); assert.equal(result.active.selection_ref.selection_revision, 2147483647);
  assert.equal(result.target.assignmentFileId, '9007199254740993'); assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(c => c.body.assignment_file_id === '9007199254740993'));
  assert.ok(h.calls.every(c => !Object.hasOwn(c.body, 'operation_id')));
});

test('same-reference malformed counts cannot substitute a viewport/partial numerical population; unavailable original geometry is not invented', async () => {
  const wrong = await harness({ preview: f => { const value = structuredClone(f.numerical); value.summary.selected.account_count = 1; return json(value); } });
  await assert.rejects(wrong.api.display(wrong.f.value, io())); assert.equal(wrong.calls.length, 1);
  const missing = await harness({ opening: f => json({ ...f.result, map_opening: presentCustomCohortGroupMapOpening({ ...f.projection,
    manifest: { status: 'unavailable', context_ref: f.request.context_ref, geometry_semantics: f.projection.manifest.geometry_semantics, reason: 'geometry_missing' } }) }) });
  const result = await missing.api.display(missing.f.value, io()); assert.equal(result.manifest.status, 'unavailable');
  assert.equal(result.manifest.reason, 'geometry_missing'); assert.equal(result.observations.summary.selected.account_count, 2);
});

test('one shared host lane covers the entire pair: subscriber cancellation cannot overlap another request with an ignored opening', async () => {
  const h = await harness(), held = h.holdOpening(), lane = createCustomWorkspaceRequestLane(), subscriber = new AbortController();
  let finished = false;
  const work = lane.run(inner => h.api.display(h.f.value, { ...inner, deadline: performance.now() + 60_000 }), { signal: subscriber.signal });
  for (let i = 0; i < 1000 && !h.calls.some(c => c.action === 'selection-map-opening'); i++) await drain();
  assert.ok(h.calls.some(c => c.action === 'selection-map-opening')); subscriber.abort(); await assert.rejects(work, { name: 'AbortError' });
  assert.equal(lane.isIdle(), false);
  const following = lane.run(inner => h.api.readSelection({ accountId: h.f.accountId, assignmentFileId: h.f.request.assignment_file_id,
    contextRef: h.f.request.context_ref }, { ...inner, deadline: performance.now() + 60_000 }), io());
  const flushing = lane.flush().then(() => { finished = true; }); await drain();
  assert.equal(h.calls.length, 2); assert.equal(finished, false); held.resolve(json(h.f.result));
  assert.deepEqual(await following, h.f.saved); await flushing;
  assert.equal(h.maxOpen, 1); assert.equal(lane.isIdle(), true); assert.equal(finished, true); lane.dispose();
});

test('authoritative newer empty checkpoint clears an old display instead of showing a no-longer-active area', async () => {
  const h = await harness(), owner = h.owner();
  try {
    await owner.reopen(); const result = await owner.reload({ target: h.f.value.target,
      section: { revision: 6, value: { workspace_version: 7, active: null, pending_capture: null } } });
    assert.equal(result.status, 'idle'); assert.equal(result.display, null); assert.equal(result.display_freshness, 'none');
    assert.equal(h.calls.length, 4);
  } finally { owner.dispose(); }
});

test('canonical retained JSON key order does not turn an identical observation period into a mismatch', async () => {
  const response = value => new Response(canonicalAssessmentJson(value), { headers: { 'content-type': 'application/json' } });
  const h = await harness({ preview: f => response(f.numerical), opening: f => response(f.result) });
  const result = await h.api.display(h.f.value, io());
  assert.equal(result.observations.summary.observation_period.start_date, result.active.observation_period.start_date);
  assert.equal(result.observations.summary.observation_period.end_date, result.active.observation_period.end_date);
});
