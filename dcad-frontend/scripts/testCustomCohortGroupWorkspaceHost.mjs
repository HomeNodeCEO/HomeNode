import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as catalog from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as selection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as lane from '../src/features/neighborhood/customWorkspaceRequestLane.ts';
import * as marketTransport from '../src/features/neighborhood/customCohortGroupMarketTransport.ts';
import { completeCalendarMonthWindow } from '../../server/src/services/marketConditions.js';
import { checkpoint, workspace, displayModule, mapView, memberView, groupMemberViewFixture, json, io } from './customCohortGroupMemberViewFixture.mjs';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';
import { prepareCustomCohortGroupWorkspaceTransportRequest as serverRequest,
  presentCustomCohortGroupWorkspaceTransportResponse as serverResponse } from '../../server/src/services/neighborhoodAssessment/customCohortGroupWorkspaceTransport.js';

const runtime = createRequire(new URL('../package.json', import.meta.url)), jsx = runtime('react/jsx-runtime');
const { renderToStaticMarkup } = runtime('react-dom/server');
const cities = JSON.parse(readFileSync(new URL('../src/data/neighborhoodCityBoundaries.json', import.meta.url), 'utf8'));
const load = (name, modules) => loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}`, import.meta.url), key => {
  assert.ok(Object.hasOwn(modules, key), `unexpected host dependency ${key}`); return modules[key];
});
const lifecycle = load('customCohortGroupWorkspaceLifecycle.ts', { './customCohortGroupWorkspaceTransport.ts': workspace,
  './customCohortRecordedGroupTransport.ts': selection, './customWorkspaceCheckpoint.ts': checkpoint,
  './customCohortPocketCatalog.ts': catalog, './customCohortGroupDisplay.ts': displayModule });
const legacy = load('customWorkspaceApi.ts', { './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': transport });
const marketView = load('customCohortGroupMarketView.ts', { './customCohortGroupDisplay.ts': displayModule, './customCohortGroupMarketTransport.ts': marketTransport });
const { createCustomCohortGroupWorkspaceApi: createApi } = load('customCohortGroupWorkspaceApi.ts', {
  './customWorkspaceApi.ts': legacy, './customCohortPreviewTransport.ts': transport, './customCohortGroupWorkspaceTransport.ts': workspace,
  './customCohortRecordedGroupTransport.ts': selection, './customCohortGroupDisplay.ts': displayModule, './customCohortGroupMapView.ts': mapView,
  './customCohortGroupMarketView.ts': marketView, './customCohortGroupMarketTransport.ts': marketTransport });
const clone = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const children = n => (Array.isArray(n?.props?.children) ? n.props.children : [n?.props?.children]).flat(Infinity);
const walk = n => n && typeof n === 'object' ? [n, ...children(n).flatMap(walk)] : [];
const text = n => typeof n === 'string' || typeof n === 'number' ? String(n) : n && typeof n === 'object' ? children(n).map(text).join('') : '';

/** Actual row/numeric/opening/member producers and checked API/atomic receipts;
 * only the HTTP/storage boundary is injected. Not a native SQL/live SLA proof. */
async function server({ absent = false, pending = false, privateSales = false } = {}) {
  let fixture = await groupMemberViewFixture({ privateSales });
  const target = fixture.value.target, calls = [], overrides = new Map(), receipts = new Map();
  const accepted = { revision: 8, value: { synthetic_accepted: 'unchanged' } };
  let section = absent ? undefined : { revision: fixture.value.workspaceRevision, value: clone(fixture.value.checkpoint) };
  if (pending) section.value.pending_capture = { operation_id: '70000000-0000-4000-8000-000000000009', observation_period: clone(fixture.summary.observation_period) };
  let status = 'draft', open = 0, maxOpen = 0, keys = 0;
  const request = async (url, init) => {
    const action = url.split('/').at(-1), body = init.body ? JSON.parse(init.body) : null;
    const call = { action, body, signal: init.signal, method: init.method ?? 'GET' }; calls.push(call);
    assert.ok(init.signal instanceof AbortSignal); open++; maxOpen = Math.max(maxOpen, open);
    const respond = async () => {
      if (action === 'workfile') return json({ ok: true, account_id: target.accountId, workfile: {
        assignment_file_id: Number(target.assignmentFileId), status, sections: {
          neighborhood_assessment: clone(accepted), ...(section === undefined ? {} : { neighborhood_workspace: clone(section) }) } } });
      if (action === 'catalog') return json({ ...clone(fixture.rawCatalog), selection_revision: body.selection.revision,
        catalog: { ...clone(fixture.rawCatalog.catalog), binding: { context_ref: clone(body.context_ref), selection_revision: body.selection.revision } } });
      if (action === 'group-selection') return json(fixture.saved);
      if (action === 'selection-preview') return json(fixture.numeric);
      if (action === 'selection-map-opening') return json(fixture.opening);
      if (action === 'selection-members') return json(fixture.resultFor(body.population, body.page));
      if (action === 'selection-market-analysis') return json(marketResponse(target, body));
      if (action === 'preview' || action === 'members') return json({ subset_inspection_only: true });
      if (action === 'capture') {
        fixture = await groupMemberViewFixture({ contextRef: { ...fixture.request.context_ref, context_id: body.operation_id }, empty: true });
        return json({ status: 'registered', reused: false, context_ref: fixture.request.context_ref, source_query_complete: true,
          discovery: { account_count: 3, parcel_count: 3, ...(body.discovery?.profile_id === 'custom-city-polygon-v1'
            ? body.discovery : { radius_metres: body.discovery?.radius_metres ?? '4828.032' }) } });
      }
      const kinds = { 'start-group-capture': 'start', 'cancel-group-capture': 'cancel', 'complete-group-capture': 'complete', 'save-groups': 'save' };
      const kind = kinds[action]; assert.ok(kind, `unexpected path ${url}`);
      const command = serverRequest(body, action), key = JSON.stringify([action, body]);
      if (receipts.has(key)) return json(serverResponse({ ...clone(receipts.get(key)), status: 'reused' }, command, action));
      assert.equal(command.assignment_file_id, target.assignmentFileId); assert.equal(command.expected_workspace_revision, section?.revision ?? 0);
      const previous = section?.value ?? { workspace_version: 7, active: null, pending_capture: null };
      let value;
      if (kind === 'start') value = { ...clone(previous), pending_capture: clone(command.pending_capture) };
      else if (kind === 'cancel') value = { ...clone(previous), pending_capture: null };
      else {
        fixture = await groupMemberViewFixture({ contextRef: command.context_ref, revision: (command.expected_selection_ref?.selection_revision ?? 0) + 1,
          empty: command.included_recorded_group_ids.length === 0 });
        const period = kind === 'complete' ? previous.pending_capture.observation_period : previous.active.observation_period;
        const discovery = kind === 'complete' ? previous.pending_capture.discovery : previous.active.discovery;
        value = { workspace_version: 7, active: { context_ref: clone(command.context_ref), selection_ref: clone(fixture.request.selection_ref),
          observation_period: clone(period), ...(discovery ? { discovery: clone(discovery) } : {}) }, pending_capture: null };
      }
      section = { revision: command.expected_workspace_revision + 1, value };
      const result = { status: 'stored', workspace: clone(section),
        ...(['save', 'complete'].includes(kind) ? { authority: 'not_established', context_ref: clone(command.context_ref), selection_ref: clone(fixture.request.selection_ref),
          operation_id: command.operation_id, included_recorded_group_ids: clone(command.included_recorded_group_ids) } : {}) };
      receipts.set(key, clone(result)); return json(serverResponse(result, command, action));
    };
    try { return await (overrides.get(action)?.(call, respond) ?? respond()); } finally { open--; }
  };
  const api = createApi({ request, urlFor: path => path, editorKeyForSave: () => { keys++; throw new Error('no generic writer'); } });
  return { target, api, calls, overrides, accepted, get fixture() { return fixture; }, get section() { return section; }, set section(s) { section = s; },
    get status() { return status; }, set status(s) { status = s; }, get maxOpen() { return maxOpen; }, get keys() { return keys; } };
}

/** Existing deterministic hook approach with actual React elements/SSR and
 * injected visual children. Strict effect replay, not a concurrent browser test. */
function harness(t, db, overrides = {}, laneModule = lane) {
  let fiber, currentFiber, cursor = 0, dirty = false, tree, props, controls;
  const registered = [];
  const react = {
    useState(initial) { const owner = currentFiber, index = cursor++; owner.cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [owner.cells[index].value, next => { if (!owner.live) return; const value = typeof next === 'function' ? next(owner.cells[index].value) : next;
        if (!Object.is(value, owner.cells[index].value)) { owner.cells[index].value = value; dirty = true; } }]; },
    useRef(value) { const index = cursor++; currentFiber.cells[index] ??= { current: value }; return currentFiber.cells[index]; },
    useEffect(setup, deps) { const owner = currentFiber, index = cursor++, old = owner.cells[index]; if (!old || !same(old.deps, deps)) {
      const effect = { setup, deps, cleanup: old?.cleanup }; owner.cells[index] = effect; owner.effects.push(() => { effect.cleanup?.(); effect.cleanup = setup(); }); } },
  };
  function WorkspaceStub() { return jsx.jsx('div', { 'data-testid': 'exact-workspace' }); }
  function AdoptionStub() { return jsx.jsx('div', { 'data-testid': 'adoption' }); }
  const Host = load('components/CustomCohortGroupWorkspaceHost.tsx', { react, 'react/jsx-runtime': jsx,
    '../customCohortGroupWorkspaceLifecycle': lifecycle, '../customWorkspaceCheckpoint': checkpoint,
    '../customWorkspaceRequestLane': laneModule, '../customCohortGroupMemberView': memberView,
    '../customCohortGroupMarketTransport': marketTransport,
    './CustomCohortWorkspace': { default: WorkspaceStub, __esModule: true }, './CustomReportedObservationAdoption': { default: AdoptionStub, __esModule: true },
    '../../../data/neighborhoodCityBoundaries.json': { default: cities, __esModule: true } }).default;
  const cleanup = () => { if (fiber) { fiber.cells.forEach(c => c?.cleanup?.()); fiber.live = false; fiber = null; } };
  function render(next = props) { props = next; dirty = false; const owner = Host(props);
    if (!owner || typeof owner.type !== 'function') { cleanup(); tree = owner; return; }
    if (!fiber || fiber.key !== owner.key) { cleanup(); fiber = { key: owner.key, cells: [], effects: [], live: true }; }
    cursor = 0; currentFiber = fiber; tree = owner.type(owner.props); currentFiber = null; fiber.effects.splice(0).forEach(fn => fn()); }
  const flush = () => { let n = 0; while (dirty) { assert.ok(++n < 40); render(); } };
  props = { target: clone(db.target), subjectLabel: 'Synthetic subject', initialPeriod: null, workfileStatus: 'draft', enabled: true, api: db.api,
    initialGroups: () => [], registerControls: value => { controls = value; registered.push(value); }, ...overrides };
  render(); flush(); t.after(cleanup);
  return { registered, get controls() { return controls; }, get props() { return props; }, render(next) { render(next); flush(); },
    workspace: () => walk(tree).find(n => n.type === WorkspaceStub)?.props,
    adoption: () => walk(tree).find(n => n.type === AdoptionStub)?.props,
    text: () => text(tree), html: () => renderToStaticMarkup(tree),
    button(label) { return walk(tree).find(n => n.type === 'button' && text(n) === label); },
    click(label) { const b = this.button(label); assert.ok(b); assert.equal(Boolean(b.props.disabled), false, `${label} enabled`); b.props.onClick(); flush(); },
    select(ids) { this.workspace().exact.onSelectionIntent(ids); flush(); },
    strictReplay() { const effects = fiber.cells.filter(c => c?.setup); effects.forEach(e => e.cleanup?.()); effects.forEach(e => { e.cleanup = e.setup(); }); flush(); },
    async settle() { for (let n = 0; n < 30; n++) { for (let i = 0; i < 30; i++) await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve)); flush(); } }, unmount: cleanup };
}
const actions = db => db.calls.map(c => c.action);
const WINDOW = { west: '-97', south: '32', east: '-96', north: '33' };
const PAGE = { limit: 1, after_member_id: null };
const STUDY = { asOf: '2026-10-31', periodMonths: 12, contextOverride: null };
function marketResponse(target, body) {
  const p = completeCalendarMonthWindow(body.as_of, body.period_months);
  return { subject: { account_id: target.accountId }, analyses: [{ market: { key: 'exploration', scope: 'exploration' },
    period: { start: p.start, end: p.end }, population: { eligible_sale_count: 0, mapped_sale_count: 0 },
    filters: { record_type: 'closed_sale', period_months: p.periodMonths, analysis_as_of: p.analysisAsOf,
      complete_calendar_months: true, partial_as_of_month_excluded: p.partialMonthExcluded } }],
    recommendation: { conclusion: 'insufficient' }, unavailable_areas: [], independence_notice: 'Independent market study.',
    exploration_binding: { context_ref: body.context_ref, selection_revision: body.selection_ref.selection_revision,
      selection_sha256: body.selection_ref.selection_sha256 }, exploration_selection_ref: body.selection_ref };
}

test('current host publishes only an exact market area with a read-only keyed lane, not a fake legacy selection or report writer', async t => {
  const db = await server(), published = [], before = clone(db.section), accepted = clone(db.accepted);
  const h = harness(t, db, { onMarketAreaChange: value => published.push(value) }); await h.settle();
  const area = published.at(-1); assert.ok(area && Object.isFrozen(area));
  assert.equal(area.display, h.workspace().exact.display); displayModule.requireCustomCohortGroupDisplay(area.display);
  const result = await area.read(STUDY, io()); await h.settle();
  assert.deepEqual(result.exploration_selection_ref, area.display.active.selection_ref);
  assert.deepEqual(actions(db).slice(-1), ['selection-market-analysis']);
  const sent = db.calls.at(-1).body;
  assert.equal(sent.as_of, '2026-10-31'); assert.deepEqual(sent.area_keys, ['exploration']);
  assert.doesNotMatch(JSON.stringify(sent), /account_ids|pockets|viewport|geometry|sessionKey/);
  assert.equal(db.maxOpen, 1); assert.equal(db.keys, 0); assert.deepEqual(db.section, before); assert.deepEqual(db.accepted, accepted);
  assert.equal(await h.controls.flush(), true);
  h.unmount(); assert.equal(published.at(-1), null);
  const count = db.calls.length; await assert.rejects(area.read(STUDY, io())); assert.equal(db.calls.length, count);
});

test('a map click invalidates a settling market study before a queued selection save, and old callbacks never query the newer display', async t => {
  const db = await server(), hold = deferred(), published = [];
  db.overrides.set('selection-market-analysis', async () => hold.promise);
  const h = harness(t, db, { onMarketAreaChange: area => published.push(area) }); await h.settle();
  const old = published.at(-1), waiting = old.read(STUDY, io()), refused = assert.rejects(waiting);
  await h.settle(); const body = db.calls.find(c => c.action === 'selection-market-analysis').body;
  h.select([]); await h.settle(); assert.equal(published.at(-1), null); assert.equal(actions(db).includes('save-groups'), false);
  hold.resolve(json(marketResponse(db.target, body))); await refused; await h.settle();
  const next = published.at(-1); assert.ok(next && next !== old);
  assert.equal(next.display.active.selection_ref.selection_revision, old.display.active.selection_ref.selection_revision + 1);
  assert.equal(next.display.observations.summary.selected.account_count, 0);
  const count = db.calls.length; await assert.rejects(old.read(STUDY, io())); assert.equal(db.calls.length, count);
  assert.equal(db.maxOpen, 1); assert.equal(db.keys, 0);
});

test('read-only finalization and unmount revoke even a retained exact market area without a report write', async t => {
  const db = await server(), published = [], hold = deferred();
  const h = harness(t, db, { onMarketAreaChange: area => published.push(area) }); await h.settle();
  const area = published.at(-1), count = db.calls.length;
  h.controls.setReadOnly(true); await h.settle(); assert.equal(published.at(-1), null);
  await assert.rejects(area.read(STUDY, io())); assert.equal(db.calls.length, count);
  h.controls.setReadOnly(false); await h.settle();
  db.overrides.set('selection-market-analysis', () => hold.promise);
  const waiting = published.at(-1).read(STUDY, io()), refused = assert.rejects(waiting); await h.settle();
  const body = db.calls.at(-1).body; h.unmount(); assert.equal(published.at(-1), null); await refused;
  hold.resolve(json(marketResponse(db.target, body))); assert.equal(db.keys, 0);
});

test('a queued market window is detached before lane admission and never runs concurrently with another consumer', async t => {
  const db = await server(), published = [], hold = deferred(); let requests = 0;
  db.overrides.set('selection-market-analysis', async (_call, respond) => { if (++requests === 1) await hold.promise; return respond(); });
  const h = harness(t, db, { onMarketAreaChange: area => published.push(area) }); await h.settle();
  const area = published.at(-1), first = area.read(STUDY, io()); await h.settle();
  const study = { ...STUDY, asOf: '2026-09-30', contextOverride: { source: 'manual', city: 'Garland' } };
  const second = area.read(study, io()); study.asOf = '2020-01-01'; study.contextOverride.city = 'Changed';
  await h.settle(); assert.equal(requests, 1); hold.resolve(); await first; const result = await second; await h.settle();
  const calls = db.calls.filter(c => c.action === 'selection-market-analysis'); assert.equal(calls.length, 2);
  assert.equal(calls[1].body.as_of, '2026-09-30'); assert.equal(calls[1].body.context_override.city, 'Garland');
  assert.equal(result.analyses[0].filters.analysis_as_of, '2026-09-30'); assert.equal(db.maxOpen, 1);
});

test('fresh draft read precedes one coherent exact opening without a generic writer or report mutation', async t => {
  const db = await server(), accepted = clone(db.accepted), initial = clone(db.section), h = harness(t, db); await h.settle();
  assert.deepEqual(actions(db), ['workfile', 'catalog', 'group-selection', 'selection-preview', 'selection-map-opening']);
  const d = h.workspace().exact.display; displayModule.requireCustomCohortGroupDisplay(d);
  assert.equal(h.workspace().workspace, undefined); assert.deepEqual(d.active.selection_ref, db.fixture.request.selection_ref);
  assert.equal(h.workspace().exact.freshness, 'current'); assert.equal(h.adoption(), undefined);
  assert.doesNotMatch(h.html(), /data-testid="adoption"/);
  assert.equal(await h.controls.flush(), true); assert.deepEqual(db.section, initial); assert.deepEqual(db.accepted, accepted);
  assert.equal(db.keys, 0); assert.equal(db.maxOpen, 1); assert.match(h.html(), /Neighborhood ready/);
  h.render({ ...h.props, target: clone(db.target), initialPeriod: null }); await h.settle(); assert.equal(db.calls.length, 5);
});

for (const status of ['signed', 'archived']) test(`fresh ${status} status overrides a stale draft prop and performs no exploration`, async t => {
  const db = await server(); db.status = status; const h = harness(t, db); await h.settle();
  assert.deepEqual(actions(db), ['workfile']); assert.equal(h.workspace(), undefined); assert.equal(h.adoption(), undefined);
  assert.equal(await h.controls.flush(), false); assert.match(h.text(), /no longer editable/);
});

test('missing/legacy/corrupt section or read failure cannot initialize a fake empty workspace and explicit retry can recover a failed read', async t => {
  const db = await server(), original = clone(db.section);
  db.overrides.set('workfile', () => json({ error: 'raw SQL private diagnostic' }, 500));
  const h = harness(t, db); await h.settle(); assert.equal(h.workspace(), undefined); assert.equal(await h.controls.flush(), false);
  assert.equal(h.button('Try again').props.disabled, false); assert.doesNotMatch(h.text(), /raw SQL|private diagnostic/);
  db.overrides.delete('workfile'); db.section = { revision: 5, value: { workspace_version: 6, active: null, pending_capture: null } };
  h.click('Try again'); await h.settle(); assert.deepEqual(actions(db), ['workfile', 'workfile']); assert.equal(h.workspace(), undefined);
  db.section = original; h.click('Try again'); await h.settle(); assert.equal(h.workspace().exact.freshness, 'current');
  assert.equal(await h.controls.flush(), true);
});

test('explicit empty selection atomically advances the same map/statistics/head and never selects all', async t => {
  const db = await server(), h = harness(t, db); await h.settle(); const before = h.workspace().exact.display;
  h.select([]); await h.settle(); const after = h.workspace().exact.display;
  assert.notEqual(after, before); assert.equal(after.workspace_revision, before.workspace_revision + 1);
  assert.equal(after.active.selection_ref.selection_revision, before.active.selection_ref.selection_revision + 1);
  assert.deepEqual(after.selected.included_recorded_group_ids, []); assert.equal(after.observations.summary.selected.account_count, 0);
  assert.equal(after.observations.summary.all.account_count, 3); assert.equal(await h.controls.flush(), true);
  const command = db.calls.find(c => c.action === 'save-groups').body;
  assert.deepEqual(command.included_recorded_group_ids, []); assert.doesNotMatch(JSON.stringify(command), /account_ids|pockets/);
  assert.equal(db.maxOpen, 1); assert.equal(db.keys, 0);
});

test('unacknowledged committed selection reloads the new coherent head without replaying a save', async t => {
  const db = await server(), h = harness(t, db); await h.settle(); const before = h.workspace().exact.display;
  db.overrides.set('save-groups', async (_call, commit) => { await commit(); return json({ error: 'outcome lost' }, 500); });
  h.select([]); await h.settle(); assert.equal(h.workspace().exact.display, before); assert.equal(await h.controls.flush(), false);
  h.click('Try again'); await h.settle(); assert.equal(h.workspace().exact.display.observations.summary.selected.account_count, 0);
  assert.equal(actions(db).filter(a => a === 'save-groups').length, 1); assert.equal(await h.controls.flush(), true);
});

test('post-ACK opening failure retains the prior pair; explicit retry is a checked reopen not a second write', async t => {
  const db = await server(), h = harness(t, db); await h.settle(); const before = h.workspace().exact.display;
  db.overrides.set('selection-map-opening', () => json({ error: 'source denied' }, 403)); h.select([]); await h.settle();
  assert.equal(h.workspace().exact.display, before); assert.equal(h.workspace().exact.freshness, 'stale'); assert.equal(await h.controls.flush(), false);
  db.overrides.delete('selection-map-opening'); h.click('Try again'); await h.settle();
  assert.equal(actions(db).filter(a => a === 'save-groups').length, 1); assert.equal(h.workspace().exact.display.observations.summary.selected.account_count, 0);
  assert.equal(await h.controls.flush(), true);
});

test('all consumer reads and selection writes share one lane; ordinary cancellation retains actual underlying ownership', async t => {
  const db = await server(), hold = deferred(), ports = [];
  const api = { ...db.api, map: async (...args) => { ports.push('map-start'); await hold.promise; ports.push('map-end'); return db.api.map(...args); } };
  const h = harness(t, db, { api }); await h.settle(); const exact = h.workspace().exact, abort = new AbortController();
  const map = exact.readViewport(exact.display, WINDOW, { signal: abort.signal, deadline: performance.now() + 65_000 });
  await h.settle(); abort.abort(); await assert.rejects(map, e => e.name === 'AbortError');
  let flushed = false; const waiting = h.controls.flush().then(value => { flushed = true; return value; });
  h.select([]); await h.settle(); assert.equal(flushed, false); assert.equal(actions(db).includes('save-groups'), false);
  hold.resolve(); await h.settle(); await waiting; assert.deepEqual(ports, ['map-start', 'map-end']);
  assert.equal(actions(db).filter(a => a === 'save-groups').length, 1); assert.equal(await h.controls.flush(), true);
});

test('stale display and queued detail callbacks cannot acquire reads after a selection change', async t => {
  const db = await server(), hold = deferred(), api = { ...db.api, map: async (...args) => { await hold.promise; return db.api.map(...args); } };
  const h = harness(t, db, { api }); await h.settle(); const old = h.workspace().exact;
  const map = old.readViewport(old.display, WINDOW, io()); await h.settle();
  const member = old.readMembers(old.display, 'stock', PAGE, io());
  const refused = assert.rejects(member, /custom_workspace_read_only/); h.select([]); await h.settle();
  hold.resolve(); await map; await refused; await h.settle();
  assert.equal(actions(db).includes('selection-members'), false);
  await assert.rejects(old.readMembers(old.display, 'stock', PAGE, io()), /read_only/);
  old.onSelectionIntent([`recorded-cad:${'a'.repeat(64)}`]); await h.settle();
  assert.equal(actions(db).filter(a => a === 'save-groups').length, 1);
});

test('read-only closes retained read/action callbacks while an admitted page remains owned by flush', async t => {
  const db = await server(), hold = deferred(); db.overrides.set('selection-members', async (_call, respond) => { await hold.promise; return respond(); });
  const h = harness(t, db); await h.settle(); const exact = h.workspace().exact;
  const page = exact.readMembers(exact.display, 'stock', PAGE, io()); await h.settle(); h.controls.setReadOnly(true);
  await assert.rejects(exact.readViewport(exact.display, WINDOW, io()), /read_only/);
  await assert.rejects(exact.readMembers(exact.display, 'stock', PAGE, io()), /read_only/);
  exact.onSelectionIntent([]); assert.equal(h.adoption(), undefined);
  let ended = false; const flushed = h.controls.flush().then(v => { ended = true; return v; }); await h.settle(); assert.equal(ended, false);
  hold.resolve(); const result = await page; assert.equal(result.members.page.returned_count, 1);
  assert.equal(await flushed, true); assert.equal(actions(db).includes('save-groups'), false);
});

test('independent subset inspections use original preview/members ports, never the main exact-reference population', async t => {
  const db = await server(), h = harness(t, db); await h.settle(); h.select([]); await h.settle();
  const exact = h.workspace().exact;
  assert.equal(exact.display.active.selection_ref.selection_revision, 2, 'inspection must still work after changing the main selection');
  const input = { accountId: db.target.accountId, assignmentFileId: db.target.assignmentFileId, contextRef: exact.display.active.context_ref, include_map: false,
    selection: catalog.selectionFromRecordedGroups(exact.display.catalog, [catalog.CUSTOM_COHORT_UNASSIGNED_GROUP], 1) };
  await exact.inspectionPreview(input, { signal: new AbortController().signal });
  await exact.inspectionMembers(input, { group: 'selected', kind: 'stock' }, PAGE, { signal: new AbortController().signal });
  assert.deepEqual(actions(db).slice(-2), ['preview', 'members']);
  const body = db.calls.at(-2).body; assert.deepEqual(body.selection, input.selection); assert.equal(Object.hasOwn(body, 'selection_ref'), false);
  const before = db.calls.length;
  await assert.rejects(exact.inspectionPreview({ ...input, contextRef: { ...input.contextRef, context_sha256: 'b'.repeat(64) } }, io()), /context_changed/);
  assert.equal(db.calls.length, before); assert.equal(h.workspace().exact.display, exact.display); assert.equal(db.maxOpen, 1);
});

test('independent subset revision remains validated without substituting the saved main revision', async t => {
  const db = await server(), h = harness(t, db); await h.settle(); const exact = h.workspace().exact, before = db.calls.length;
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const input = { accountId: db.target.accountId, assignmentFileId: db.target.assignmentFileId,
      contextRef: exact.display.active.context_ref, include_map: false,
      selection: { ...catalog.selectionFromRecordedGroups(exact.display.catalog, [], 1), revision } };
    await assert.rejects(exact.inspectionPreview(input, io()), /context_changed/);
  }
  assert.equal(db.calls.length, before); assert.equal(h.workspace().exact.display, exact.display);
  assert.equal(db.keys, 0); assert.equal(await h.controls.flush(), true);
});

test('deadline quarantine needs actual settlement and explicit fresh recovery, never an automatic retry', async t => {
  const db = await server(), hold = deferred(), timers = new Map(); let id = 0;
  const laneModule = { ...lane, createCustomWorkspaceRequestLane: () => lane.createCustomWorkspaceRequestLane({ timer: {
    set(fn) { const key = ++id; timers.set(key, fn); return key; }, clear(key) { timers.delete(key); } } }) };
  const api = { ...db.api, map: async (...args) => { await hold.promise; return db.api.map(...args); } }, h = harness(t, db, { api }, laneModule);
  await h.settle(); const exact = h.workspace().exact, waiting = exact.readViewport(exact.display, WINDOW, io());
  const rejected = assert.rejects(waiting, /lane_deadline/); await h.settle(); assert.equal(timers.size, 1);
  [...timers.values()][0](); await rejected; await h.settle(); const count = db.calls.length;
  assert.equal(await h.controls.flush(), false); h.click('Try again'); await h.settle(); assert.equal(db.calls.length, count);
  hold.resolve(); await h.settle(); h.click('Try again'); await h.settle();
  assert.equal(db.calls.at(count).action, 'workfile'); assert.equal(await h.controls.flush(), true);
});

test('the removed report-adoption panel stays absent across coherent selection changes without accepted-report writes', async t => {
  const db = await server(), accepted = clone(db.accepted), h = harness(t, db); await h.settle();
  assert.equal(h.adoption(), undefined); h.select([]); await h.settle();
  assert.equal(h.workspace().exact.display.observations.summary.selected.account_count, 0);
  assert.equal(h.adoption(), undefined); assert.doesNotMatch(h.html(), /data-testid="adoption"/);
  assert.equal(actions(db).filter(a => a === 'save-groups').length, 1);
  assert.deepEqual(db.accepted, accepted); assert.equal(db.keys, 0); assert.equal(await h.controls.flush(), true);
});

test('pending saved capture is not silently resumed; a checked explicit set-aside keeps the completed study', async t => {
  const db = await server({ pending: true }), h = harness(t, db); await h.settle(); const ref = clone(db.section.value.active.selection_ref);
  assert.equal(actions(db).includes('capture'), false); assert.equal(await h.controls.flush(), false);
  h.click('Choose a different area'); await h.settle(); assert.equal(db.section.value.pending_capture, null);
  assert.deepEqual(db.section.value.active.selection_ref, ref); assert.equal(actions(db).includes('capture'), false);
  assert.equal(await h.controls.flush(), true, JSON.stringify({ text: h.text(), calls: actions(db),
    freshness: h.workspace()?.exact.freshness, blocked: h.workspace()?.exact.blockedReason }));
});

test('StrictMode effect replay fresh-reads again, old controls fail and unmounted late work cannot publish or start a capture', async t => {
  const db = await server(), hold = deferred(); let reads = 0;
  db.overrides.set('workfile', async (_call, respond) => { if (++reads === 1) await hold.promise; return respond(); });
  const h = harness(t, db); await h.settle(); const old = h.controls; h.strictReplay(); await h.settle();
  assert.equal(await old.flush(), false); assert.equal(await old.useReviewedSales({ batch_id: db.fixture.request.context_ref.context_id, expected_review_revision: 1 }), false);
  hold.resolve(); await h.settle(); assert.equal(h.workspace().exact.freshness, 'current');
  assert.equal(actions(db).includes('capture'), false); assert.equal(await h.controls.flush(), true);
  const exact = h.workspace().exact; h.unmount(); await assert.rejects(exact.readMembers(exact.display, 'stock', PAGE, io()), /read_only/);
  assert.equal(h.registered.at(-1), null);
});

test('unrelated render keeps session while changed file/session remounts and cannot use retained callbacks', async t => {
  const db = await server(), h = harness(t, db); await h.settle(); const old = h.workspace().exact;
  h.render({ ...h.props, target: { ...db.target, sessionKey: 'new-session' } }); await h.settle();
  await assert.rejects(old.readMembers(old.display, 'stock', PAGE, io()), /read_only/);
  assert.equal(h.workspace().exact.display.target.sessionKey, 'new-session'); assert.equal(actions(db).filter(a => a === 'workfile').length, 2);
  h.render({ ...h.props, workfileStatus: 'signed' }); await h.settle(); assert.equal(h.workspace(), undefined); assert.equal(h.controls, null);
});

test('confirmed new draft with an actual period starts once using only explicit initial IDs, never silently all', async t => {
  const db = await server({ absent: true }), period = clone(db.fixture.summary.observation_period), h = harness(t, db, { initialPeriod: period });
  await h.settle(); assert.deepEqual(actions(db), ['workfile', 'start-group-capture', 'capture', 'catalog', 'complete-group-capture',
    'group-selection', 'selection-preview', 'selection-map-opening']);
  assert.deepEqual(db.section.value.active.observation_period, period); assert.equal(db.section.value.pending_capture, null);
  assert.equal(h.workspace().exact.display.observations.summary.selected.account_count, 0);
  assert.deepEqual(db.calls.find(c => c.action === 'complete-group-capture').body.included_recorded_group_ids, []);
  assert.equal(db.maxOpen, 1); assert.equal(await h.controls.flush(), true);
});

test('absent draft without an actual period stays idle; an invalid displayed period allocates no capture UUID', async t => {
  const db = await server({ absent: true }), h = harness(t, db, { initialPeriod: { start_date: '2024-02-30', end_date: '2024-06-30' } });
  await h.settle(); assert.deepEqual(actions(db), ['workfile']); assert.equal(h.workspace(), undefined); assert.equal(await h.controls.flush(), true);
  assert.equal(h.button('Explore 3-mile area').props.disabled, true); h.button('Explore 3-mile area').props.onClick(); await h.settle();
  assert.deepEqual(actions(db), ['workfile']); assert.equal(db.section, undefined);
});

test('uncommitted lost response uses the exact recorded save UUID only after fresh predecessor confirmation', async t => {
  const db = await server(), h = harness(t, db); await h.settle();
  db.overrides.set('save-groups', () => json({ error: 'unknown response' }, 500)); h.select([]); await h.settle();
  const original = clone(db.calls.find(c => c.action === 'save-groups').body); assert.equal(await h.controls.flush(), false);
  db.overrides.delete('save-groups'); h.click('Try again'); await h.settle();
  const commands = db.calls.filter(c => c.action === 'save-groups').map(c => c.body);
  assert.equal(commands.length, 2); assert.deepEqual(commands[1], original); assert.equal(await h.controls.flush(), true);
});

test('retained read and selection callbacks cannot acquire a later display or restore the removed report panel', async t => {
  const db = await server(), accepted = clone(db.accepted), h = harness(t, db); await h.settle();
  const old = h.workspace().exact; h.select([]); await h.settle();
  await assert.rejects(old.readMembers(old.display, 'stock', PAGE, io()), /read_only/);
  old.onSelectionIntent(old.display.selected.included_recorded_group_ids); await h.settle();
  const current = h.workspace().exact;
  const page = await current.readMembers(current.display, 'stock', PAGE, io());
  assert.equal(page.members.page.returned_count, 0);
  assert.equal(actions(db).filter(a => a === 'save-groups').length, 1);
  assert.equal(h.adoption(), undefined); assert.deepEqual(db.accepted, accepted); assert.equal(await h.controls.flush(), true);
});

test('queued independent inspection cannot be rebound by mutating file/context input before actual admission', async t => {
  const db = await server(), hold = deferred(), h = harness(t, db, { api: { ...db.api, map: async (...args) => { await hold.promise; return db.api.map(...args); } } });
  await h.settle(); const exact = h.workspace().exact, map = exact.readViewport(exact.display, WINDOW, io()); await h.settle();
  const input = { accountId: db.target.accountId, assignmentFileId: db.target.assignmentFileId, contextRef: clone(exact.display.active.context_ref),
    include_map: false, selection: catalog.selectionFromRecordedGroups(exact.display.catalog, [], exact.display.active.selection_ref.selection_revision) };
  const inspected = exact.inspectionPreview(input, io()), rejected = assert.rejects(inspected, /context_changed/);
  input.assignmentFileId = '38'; hold.resolve(); await map; await rejected;
  assert.equal(actions(db).includes('preview'), false); assert.equal(db.keys, 0);
});

test('a detail-source denial cannot become an empty successful page, retry, report write or raw diagnostic', async t => {
  const db = await server(), h = harness(t, db); await h.settle(); const exact = h.workspace().exact;
  db.overrides.set('selection-members', () => json({ error: 'neighborhood_access_denied', raw: 'private SQL diagnostics' }, 403));
  await assert.rejects(exact.readMembers(exact.display, 'stock', PAGE, io()), e => e.status === 403 && !e.message.includes('SQL'));
  assert.equal(actions(db).filter(a => a === 'selection-members').length, 1); assert.equal(actions(db).includes('save-groups'), false);
  assert.equal(h.workspace().exact.display, exact.display); assert.deepEqual(db.accepted.value, { synthetic_accepted: 'unchanged' });
});
