import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as lane from '../src/features/neighborhood/customWorkspaceRequestLane.ts';
import { privateSalesSummaryFixture } from './fixtures/customPrivateSalesSummaryFixture.mjs';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const jsx = requireRuntime('react/jsx-runtime');
const { renderToStaticMarkup } = requireRuntime('react-dom/server');
const cityCatalog = JSON.parse(readFileSync(new URL('../src/data/neighborhoodCityBoundaries.json', import.meta.url), 'utf8'));
const cityChoice = city => ({ profile_id: 'custom-city-polygon-v1', city: {
  geoid: city.geoid, vintage: cityCatalog.vintage, asset_sha256: city.sha256 } });
const cityKey = discovery => `city:${discovery.city.geoid}:${discovery.city.vintage}:${discovery.city.asset_sha256}`;
function compile(name, imports) {
  return loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}`, import.meta.url), key => {
    assert.ok(Object.hasOwn(imports, key), `Unexpected host test dependency: ${key}`); return imports[key];
  });
}
const checkpoint = compile('customWorkspaceCheckpoint.ts', { './customCohortPocketCatalog': catalogHelpers,
  './customWorkspaceDiscovery.ts': compile('customWorkspaceDiscovery.ts', {}) });
const lifecycle = compile('customWorkspaceLifecycle.ts', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPocketCatalog': catalogHelpers,
});
const { createCustomWorkspaceApi } = compile('customWorkspaceApi.ts', {
  './customCohortPreviewTransport': transport, './customWorkspaceCheckpoint': checkpoint,
});
const TARGET = { accountId: 'SUBJECT', assignmentFileId: '41', sessionKey: 'synthetic-session-1' };
const PERIOD = { start_date: '2023-01-01', end_date: '2024-02-29' };
const OLD = '10000000-0000-4000-8000-000000000002';
const context = id => ({ context_id: id, context_revision: '1', context_sha256: 'a'.repeat(64) });
const groupId = number => `recorded-cad:${number.toString(16).padStart(64, '0')}`;
const copy = value => structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function activeSection(ids = [groupId(2)], id = OLD) {
  return { key: 'neighborhood_workspace', revision: 5, value: { workspace_version: 1,
    active: { context_ref: context(id), observation_period: copy(PERIOD),
      selection: { revision: 9, included_recorded_group_ids: ids } }, pending_capture: null } };
}
function catalog(account, body) {
  return { status: 'catalog', subject_freshness: 'matched', target: { account_id: account, assignment_file_id: body.assignment_file_id },
    // WorkspaceStub does not admit the nested map/summary; controller tests do.
    // Supply an opaque opening only when the real API explicitly requested it.
    ...(['all_catalog_groups', 'recommended_area'].includes(body.initial_preview_mode) || Object.hasOwn(body, 'initial_preview_groups')
      ? { initial_preview: { fixture: 'opening' } } : {}),
    context_ref: copy(body.context_ref), selection_revision: body.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: body.catalog_version ?? 2, status: 'review_only', apply: { status: 'blocked' },
      binding: { context_ref: copy(body.context_ref), selection_revision: body.selection.revision },
      pockets: [account, 'B'].map((id, index) => ({ id: groupId(index + 1), disposition: 'needs_review', label: `Synthetic group ${index}`,
        county: 'Synthetic', account_ids: [id], member_count: 1 })),
      unassigned: { account_ids: ['C'], member_count: 1, reason_counts: [] },
      coverage: { discovery_member_count: 3, assigned_account_count: 2, unassigned_account_count: 1 },
      subject_membership: { account_id: account, assigned_pocket_id: groupId(1), recorded_label_match_only: true, status: 'matched' }, limitations: [],
    } };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
/** Only the HTTP boundary is fake. Requests traverse the actual bounded JSON,
 * workfile identity/ACK checks, checkpoint lifecycle, and serialized lane. */
function server(initialSection) {
  const files = new Map(), privateContexts = new Map(), cityContexts = new Map(), calls = [], overrides = new Map(); let open = 0, maxOpen = 0;
  const key = target => `${target.accountId}/${target.assignmentFileId}`;
  const install = (target, section) => files.set(key(target), { section: copy(section), status: 'draft',
    accepted: { revision: 7, value: { synthetic_accepted_report_marker: 'unchanged' } } });
  install(TARGET, initialSection);
  if (initialSection?.value.active?.discovery?.profile_id === 'custom-city-polygon-v1')
    cityContexts.set(initialSection.value.active.context_ref.context_id, copy(initialSection.value.active.discovery));
  const request = async (url, init) => {
    const match = /^\/api\/accounts\/([^/]+)\/(?:assignment-files\/([0-9]+)\/workfile(\/sections\/neighborhood_workspace)?|neighborhood-cohort\/(capture|catalog|preview|members))$/.exec(url);
    assert.ok(match, `Unexpected HTTP path ${url}`);
    const account = decodeURIComponent(match[1]), body = init.body ? JSON.parse(init.body) : null;
    const fileId = match[2] ?? body.assignment_file_id, file = files.get(`${account}/${fileId}`);
    assert.ok(file, 'Every synthetic HTTP target must be explicitly installed');
    const kind = match[4] ?? (match[3] ? 'save' : 'read');
    assert.equal(init.method ?? 'GET', kind === 'read' ? 'GET' : kind === 'save' ? 'PUT' : 'POST');
    assert.ok(init.signal instanceof AbortSignal);
    const call = { kind, account, fileId, body, signal: init.signal }; calls.push(call);
    open++; maxOpen = Math.max(maxOpen, open);
    const respond = () => {
      if (kind === 'read') return json({ ok: true, account_id: account, workfile: {
        assignment_file_id: Number(fileId), status: file.status, sections: {
          neighborhood_assessment: copy(file.accepted), ...(file.section === undefined ? {} : { neighborhood_workspace: copy(file.section) }),
        } } });
      if (kind === 'save') {
        assert.equal(new Headers(init.headers).get('x-homenode-editor-key'), 'synthetic-editor-key');
        assert.equal(body.save_reason, 'autosave');
        if (body.expected_revision !== (file.section?.revision ?? 0)) return json({ error: 'section_revision_conflict' }, 409);
        file.section = { key: 'neighborhood_workspace', revision: body.expected_revision + 1, value: copy(body.value) };
        return json({ ok: true, account_id: account, assignment_file_id: Number(fileId), section: copy(file.section) });
      }
      if (kind === 'capture') {
        if (body.private_sales_import) privateContexts.set(body.operation_id, copy(body));
        if (body.discovery?.profile_id === 'custom-city-polygon-v1') cityContexts.set(body.operation_id, copy(body.discovery));
        return json({ status: 'registered', reused: false, context_ref: context(body.operation_id),
        source_query_complete: true, provider_coverage: 'not_established',
        discovery: { account_count: 3, parcel_count: 3, ...(body.discovery?.profile_id === 'custom-city-polygon-v1'
          ? copy(body.discovery) : { radius_metres: body.discovery?.radius_metres ?? '4828.032' }) }, unsupported_capabilities: ['historical_characteristics'],
        ...(body.private_sales_import ? { private_sales_import: body.private_sales_import } : {}) });
      }
      if (kind === 'catalog') {
        const result = catalog(account, body), captured = privateContexts.get(body.context_ref.context_id);
        if (cityContexts.has(body.context_ref.context_id)) result.discovery = copy(cityContexts.get(body.context_ref.context_id));
        if (captured) {
          result.private_sales = privateSalesSummaryFixture({ input: { accountId: account, assignmentFileId: fileId,
            contextRef: body.context_ref, selection: body.selection }, privateSalesImport: captured.private_sales_import,
          period: captured.observation_period });
          result.catalog.binding.selection_sha256 = result.private_sales.binding.selection_sha256;
        }
        return json(result);
      }
      // The nested workspace's preview admission is tested independently. This
      // transport response never enters report state or the host checkpoint.
      return json({ status: 'preview', target: { account_id: account, assignment_file_id: fileId },
        context_ref: body.context_ref, selection_revision: body.selection.revision, apply: { status: 'blocked' } });
    };
    try { return await (overrides.get(kind)?.(call, respond) ?? respond()); } finally { open--; }
  };
  const api = createCustomWorkspaceApi({ request, urlFor: value => value,
    editorKeyForSave: () => 'synthetic-editor-key' });
  return { api, calls, overrides, install, file: target => files.get(key(target)), get maxOpen() { return maxOpen; } };
}
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const children = node => (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(text).join('') : '';
/** Same deterministic hook-dispatcher approach as the existing component
 * harnesses, with actual React elements/server rendering. Effect cleanup/setup
 * is replayed with preserved cells for StrictMode; keyed sessions get new cells.
 * This is not a browser or React concurrent-renderer integration test. */
function harness(t, db, initialSection, overrides = {}) {
  let fiber = null, currentFiber = null, cursor = 0, dirty = false, tree, props, controls;
  const registered = [];
  function WorkspaceStub({ workspace, accountId, assignmentFileId }) {
    return jsx.jsx('div', { 'data-testid': 'controlled-workspace', 'data-target': `${accountId}/${assignmentFileId}`,
      'data-saving': String(workspace.saving), 'data-blocked-reason': workspace.blockedReason ?? '',
      children: JSON.stringify(workspace.selection) });
  }
  function AdoptionStub() { return jsx.jsx('div', { 'data-testid': 'report-adoption' }); }
  const react = {
    useState(initial) {
      const owner = currentFiber, index = cursor++;
      owner.cells[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [owner.cells[index].value, next => {
        if (!owner.live) return;
        const value = typeof next === 'function' ? next(owner.cells[index].value) : next;
        if (!Object.is(value, owner.cells[index].value)) { owner.cells[index].value = value; dirty = true; }
      }];
    },
    useRef(value) { const index = cursor++; currentFiber.cells[index] ??= { current: value }; return currentFiber.cells[index]; },
    useEffect(setup, deps) {
      const owner = currentFiber, index = cursor++, old = owner.cells[index];
      if (!old || !same(old.deps, deps)) {
        const effect = { deps, setup, cleanup: old?.cleanup }; owner.cells[index] = effect;
        owner.effects.push(() => { effect.cleanup?.(); effect.cleanup = setup(); });
      }
    },
  };
  const Host = compile('components/CustomNeighborhoodWorkspaceHost.tsx', {
    react, 'react/jsx-runtime': jsx, '../customWorkspaceLifecycle': lifecycle,
    '../customWorkspaceCheckpoint': checkpoint,
    '../customWorkspaceRequestLane': lane, './CustomCohortWorkspace': { default: WorkspaceStub, __esModule: true },
    './CustomReportedObservationAdoption': { default: AdoptionStub, __esModule: true },
    '../../../data/neighborhoodCityBoundaries.json': { default: cityCatalog, __esModule: true },
  }).default;
  const cleanup = () => { if (!fiber) return; fiber.cells.forEach(cell => cell?.cleanup?.()); fiber.live = false; fiber = null; };
  function render(next = props) {
    props = next; dirty = false;
    const owner = Host(props);
    if (!owner || typeof owner.type !== 'function') { cleanup(); tree = owner; return; }
    if (!fiber || fiber.key !== owner.key) { cleanup(); fiber = { key: owner.key, cells: [], effects: [], live: true }; }
    cursor = 0; currentFiber = fiber; tree = owner.type(owner.props); currentFiber = null;
    fiber.effects.splice(0).forEach(fn => fn());
  }
  const flush = () => { let turns = 0; while (dirty) { assert.ok(++turns < 40, 'Host render loop'); render(); } };
  props = { target: copy(TARGET), subjectLabel: 'Synthetic subject', initialSection: copy(initialSection),
    initialPeriod: copy(PERIOD), workfileStatus: 'draft', enabled: true, api: db.api,
    registerControls: value => { controls = value; registered.push(value); }, ...overrides };
  render(); flush(); t.after(cleanup);
  return {
    db, registered, get controls() { return controls; }, get props() { return props; },
    render(next) { render(next); flush(); },
    html: () => renderToStaticMarkup(tree), text: () => text(tree),
    workspace: () => walk(tree).find(node => node.type === WorkspaceStub)?.props,
    adoption: () => walk(tree).find(node => node.type === AdoptionStub),
    button(label) {
      // Keep lifecycle-focused cases readable while the appraiser UI collapses
      // the former multi-step recovery controls into one action.
      let visibleLabel = ({
        'Start 3-mile exploration': 'Explore 3-mile area',
        'Capture a new 3-mile study': 'Explore a new 3-mile area',
        'Update grouping from saved capture': 'Refresh subdivision grouping',
      })[label] ?? label;
      visibleLabel = visibleLabel.replace(/^Capture a new (5|10)-mile study$/, 'Explore a new $1-mile area')
        .replace(/^Capture (.+ city polygon \(.+\)) study$/, 'Explore $1');
      return walk(tree).find(node => node.type === 'button' && text(node) === visibleLabel);
    },
    dates(start, end) { const inputs = walk(tree).filter(node => node.type === 'input' && node.props.type === 'date');
      assert.equal(inputs.length, 2); inputs[0].props.onChange({ target: { value: start } });
      inputs[1].props.onChange({ target: { value: end } }); flush(); },
    radius(value) { const select = walk(tree).find(node => node.type === 'select'); assert.ok(select);
      assert.equal(Boolean(select.props.disabled), false); select.props.onChange({ target: { value } }); flush(); },
    click(label) { const node = this.button(label); assert.ok(node, label); assert.equal(Boolean(node.props.disabled), false, `${label} enabled`);
      node.props.onClick(); flush(); },
    select(ids) { const child = this.workspace(); assert.ok(child); assert.equal(child.workspace.saving, false);
      assert.equal(Boolean(child.workspace.blockedReason), false);
      child.workspace.onSelectionIntent(ids); flush(); },
    strictReplay() { const effects = fiber.cells.filter(cell => cell?.setup); effects.forEach(effect => effect.cleanup?.());
      effects.forEach(effect => { effect.cleanup = effect.setup(); }); flush(); },
    async settle() { for (let round = 0; round < 15; round++) { for (let i = 0; i < 24; i++) await Promise.resolve(); flush(); } },
    unmount: cleanup,
  };
}
const kinds = db => db.calls.map(call => call.kind);

for (const dates of [
  { start_date: '2026-09-20', end_date: '2026-09-19' },
  { start_date: '2023-02-29', end_date: '2024-02-29' },
  { start_date: '2024-02-29', end_date: '' },
]) test(`invalid displayed period ${JSON.stringify(dates)} never allocates an operation and is editable without reload`, async t => {
  const uuid = t.mock.method(globalThis.crypto, 'randomUUID');
  const db = server(), h = harness(t, db, undefined, { initialPeriod: dates }); await h.settle();
  assert.deepEqual(kinds(db), []); assert.equal(uuid.mock.callCount(), 0);
  assert.match(h.text(), /Choose valid observation start and end dates/);
  const start = h.button('Start 3-mile exploration'); assert.equal(start.props.disabled, true);
  start.props.onClick(); await h.settle();
  assert.equal(await h.controls.useReviewedSales({ batch_id: OLD, expected_review_revision: 1 }), false);
  assert.deepEqual(kinds(db), []); assert.equal(uuid.mock.callCount(), 0);
  assert.equal(db.file(TARGET).section, undefined); assert.equal(await h.controls.flush(), true);
  h.dates(PERIOD.start_date, PERIOD.end_date); h.click('Start 3-mile exploration'); await h.settle();
  assert.deepEqual(kinds(db), ['save', 'capture', 'catalog', 'save']);
  assert.equal(uuid.mock.callCount(), 1); assert.doesNotMatch(h.text(), /Choose valid observation/);
  assert.deepEqual(db.calls.find(call => call.kind === 'capture').body.observation_period, PERIOD);
  assert.equal(await h.controls.flush(), true);
});

for (const code of [
  'neighborhood_service_busy',
  'neighborhood_request_interrupted',
]) test(`catalog ${code} preserves pending UUID and requires explicit recovery, not another capture`, async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted);
  db.overrides.set('catalog', (call, respond) => call.body.context_ref.context_id === OLD ? respond()
    : json({ error: code, detail: 'SECRET database text' }, 503));
  h.click('Capture a new 3-mile study'); await h.settle();
  const pending = copy(db.file(TARGET).section.value.pending_capture);
  assert.match(h.text(), /The neighborhood could not be updated\. Try again\./); assert.doesNotMatch(h.text(), /SECRET|database text/);
  assert.equal(h.workspace().workspace.blockedReason, 'reload_required');
  assert.equal(h.button('Resume saved capture').props.disabled, true);
  h.button('Resume saved capture').props.onClick(); await h.settle();
  assert.equal(db.calls.filter(call => call.kind === 'capture').length, 1);
  h.click('Reload saved choices'); await h.settle();
  assert.deepEqual(db.file(TARGET).section.value.pending_capture, pending);
  assert.equal(h.button('Resume saved capture').props.disabled, false); assert.equal(await h.controls.flush(), false);
  db.overrides.delete('catalog'); h.click('Resume saved capture'); await h.settle();
  assert.deepEqual(db.calls.filter(call => call.kind === 'capture').map(call => call.body.operation_id), [pending.operation_id, pending.operation_id]);
  assert.deepEqual(db.file(TARGET).accepted, accepted); assert.equal(db.maxOpen, 1);
  assert.equal(await h.controls.flush(), true);
});

for (const [status, code, guidance] of [
  [401, 'authentication_required', /Please sign in again/],
  [409, 'custom_appraisal_section_revision_conflict', /The neighborhood could not be updated/],
  [409, 'custom_appraisal_workfile_signed', /Neighborhood analysis is not available/],
]) test(`pending save ${status}/${code} has fixed guidance and never calls capture`, async t => {
  const db = server(); db.overrides.set('save', () => json({ error: code, detail: 'SECRET ownership data' }, status));
  const h = harness(t, db); await h.settle();
  assert.match(h.text(), guidance); assert.doesNotMatch(h.text(), /SECRET|ownership data/);
  assert.deepEqual(kinds(db), ['save']); assert.equal(db.file(TARGET).section, undefined);
  assert.equal(await h.controls.flush(), false); assert.equal(h.button('Start 3-mile exploration').props.disabled, true);
});

test('unknown catalog and pending-save refusals remain generic and never display raw server text', async t => {
  for (const kind of ['catalog', 'save']) {
    const db = server(); db.overrides.set(kind, () => json({ error: 'neighborhood_service_busy\n', detail: 'SECRET' }, 503));
    const h = harness(t, db); await h.settle();
    assert.match(h.text(), /The neighborhood could not be updated\. Try again\./);
    assert.doesNotMatch(h.text(), /SECRET|neighborhood processing is busy|workspace could not finish/);
    assert.equal(await h.controls.flush(), false); h.unmount();
  }
});

test('fresh absent reload after uncertain pending save allows explicit same-UUID recovery without creating another operation', async t => {
  const uuid = t.mock.method(globalThis.crypto, 'randomUUID');
  const db = server(); db.overrides.set('save', () => { throw new Error('SECRET failed before a confirmed save'); });
  const h = harness(t, db); await h.settle();
  const pending = copy(db.calls[0].body.value.pending_capture), accepted = copy(db.file(TARGET).accepted);
  assert.deepEqual(kinds(db), ['save']); assert.equal(uuid.mock.callCount(), 1);
  assert.equal(db.file(TARGET).section, undefined); assert.equal(await h.controls.flush(), false);
  h.click('Reload saved choices'); await h.settle();
  assert.deepEqual(kinds(db), ['save', 'read']); assert.match(h.text(), /neighborhood update was interrupted/);
  assert.equal(h.button('Resume saved capture').props.disabled, false);
  assert.equal(h.button('Start 3-mile exploration').props.disabled, true);
  assert.equal(await h.controls.flush(), false); assert.equal(uuid.mock.callCount(), 1);
  db.overrides.delete('save'); h.click('Resume saved capture'); await h.settle();
  assert.deepEqual(kinds(db), ['save', 'read', 'save', 'capture', 'catalog', 'save']);
  assert.deepEqual(db.calls.filter(call => call.kind === 'save').slice(0, 2).map(call => call.body.value.pending_capture), [pending, pending]);
  assert.equal(db.calls.find(call => call.kind === 'capture').body.operation_id, pending.operation_id);
  assert.equal(uuid.mock.callCount(), 1); assert.equal(await h.controls.flush(), true);
  assert.deepEqual(db.file(TARGET).accepted, accepted); assert.equal(db.maxOpen, 1);
});

test('capacity after new capture preserves pending UUID, old study, exact reload and explicit set-aside CAS', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted);
  db.overrides.set('catalog', (call, respond) => call.body.context_ref.context_id === OLD ? respond()
    : json({ error: 'neighborhood_preview_capacity_exceeded', detail: 'SECRET' }, 422));
  h.click('Capture a new 3-mile study'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'save', 'capture', 'catalog']);
  const pending = copy(db.file(TARGET).section.value.pending_capture), revision = db.file(TARGET).section.revision;
  assert.ok(pending.operation_id); assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
  assert.match(h.text(), /area could not be loaded completely/);
  assert.doesNotMatch(h.text(), /If the previous study reopens|SECRET/);
  assert.equal(h.workspace().workspace.blockedReason, 'reload_required'); assert.equal(await h.controls.flush(), false);
  assert.equal(h.adoption(), undefined); assert.equal(h.button('Set aside pending capture').props.disabled, true);
  h.button('Resume saved capture').props.onClick(); await h.settle(); assert.equal(kinds(db).length, 4);
  h.click('Reload saved choices'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'save', 'capture', 'catalog', 'read', 'catalog']);
  assert.deepEqual(db.file(TARGET).section.value.pending_capture, pending);
  assert.equal(h.workspace().workspace.blockedReason, 'pending_capture'); assert.equal(await h.controls.flush(), false);
  h.click('Set aside pending capture'); await h.settle();
  const saves = db.calls.filter(call => call.kind === 'save'); assert.equal(saves.length, 2);
  assert.equal(saves[1].body.expected_revision, revision); assert.equal(saves[1].body.value.pending_capture, null);
  assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
  assert.equal(await h.controls.flush(), true); assert.equal(h.workspace().workspace.blockedReason ?? null, null);
  assert.deepEqual(db.file(TARGET).accepted, accepted); assert.equal(db.maxOpen, 1);
});

test('appraiser Try again restores saved choices and resumes the exact pending area in one action', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  db.overrides.set('capture', () => json({ error: 'neighborhood_service_busy' }, 503));
  h.radius('5'); h.click('Capture a new 5-mile study'); await h.settle();
  const pending = copy(db.file(TARGET).section.value.pending_capture);
  assert.ok(pending); assert.ok(h.button('Try again')); assert.match(h.text(), /neighborhood could not be updated/i);
  db.overrides.delete('capture'); h.click('Try again'); await h.settle();
  assert.deepEqual(db.calls.filter(call => call.kind === 'capture').map(call => call.body.operation_id),
    [pending.operation_id, pending.operation_id]);
  assert.equal(db.file(TARGET).section.value.pending_capture, null);
  assert.equal(db.file(TARGET).section.value.active.discovery.radius_metres, '8046.72');
  assert.equal(await h.controls.flush(), true);
});

test('appraiser can clear an incomplete area without changing the last completed study or report', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted);
  db.overrides.set('capture', () => json({ error: 'neighborhood_source_unavailable' }, 422));
  h.radius('10'); h.click('Capture a new 10-mile study'); await h.settle();
  assert.ok(h.button('Choose a different area')); h.click('Choose a different area'); await h.settle();
  assert.equal(db.file(TARGET).section.value.pending_capture, null);
  assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
  assert.deepEqual(db.file(TARGET).accepted, accepted);
  assert.equal(h.workspace().workspace.blockedReason ?? null, null);
  assert.equal(await h.controls.flush(), true);
});

for (const recoveryAction of ['Try again', 'Choose a different area']) test(
  `${recoveryAction} stops after authoritative reload discovers a finalized appraisal`, async t => {
    const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
    db.overrides.set('capture', () => json({ error: 'neighborhood_service_busy' }, 503));
    h.click('Capture a new 3-mile study'); await h.settle();
    const beforeRecovery = kinds(db);
    assert.ok(h.button(recoveryAction));

    db.file(TARGET).status = 'signed';
    db.overrides.delete('capture');
    h.click(recoveryAction); await h.settle();

    assert.deepEqual(kinds(db), [...beforeRecovery, 'read']);
    assert.equal(h.workspace(), undefined);
    assert.match(h.html(), /no longer editable/);
    assert.equal(await h.controls.flush(), false);
  });

test('catalog capacity on reopen does not promise a working new-study escape or bypass recovery', async t => {
  const initial = activeSection([]), db = server(initial);
  db.overrides.set('catalog', () => json({ error: 'neighborhood_preview_capacity_exceeded' }, 422));
  const h = harness(t, db, initial); await h.settle();
  assert.match(h.text(), /area could not be loaded completely/);
  assert.equal(h.workspace(), undefined); assert.equal(h.adoption(), undefined); assert.equal(await h.controls.flush(), false);
  assert.equal(h.button('Start 3-mile exploration').props.disabled, true);
  assert.deepEqual(kinds(db), ['catalog']); assert.deepEqual(db.calls[0].body.selection.pockets, []);
  h.render({ ...h.props }); await h.settle(); assert.deepEqual(kinds(db), ['catalog']);
  h.click('Reload saved choices'); await h.settle(); assert.deepEqual(kinds(db), ['catalog', 'read', 'catalog']);
  assert.deepEqual(db.file(TARGET).section, initial); assert.equal(await h.controls.flush(), false);
});

test('settled preview capacity does not block explicit narrowing but preserves save and report quiescence', async t => {
  const initial = activeSection([groupId(1), groupId(2)]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted);
  db.overrides.set('preview', () => json({ error: 'neighborhood_preview_capacity_exceeded' }, 422));
  const input = { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, contextRef: context(OLD),
    selection: { revision: 9, pockets: [] }, include_map: true };
  await assert.rejects(h.workspace().workspace.previewTransport(input, { signal: new AbortController().signal }),
    error => error.workspaceCode === 'preview_capacity_exceeded' && error.status === 422);
  await h.settle(); assert.equal(h.workspace().workspace.blockedReason ?? null, null);
  assert.equal(await h.controls.flush(), true, 'The saved intent is flushed, not a promise that its preview succeeded');
  assert.equal(h.adoption().props.workspaceRevision, initial.revision);
  const held = deferred(); db.overrides.set('save', async (_call, respond) => { await held.promise; return respond(); });
  h.select([]); await h.settle(); assert.equal(h.workspace().workspace.saving, true); assert.equal(h.adoption(), undefined);
  const flush = h.controls.flush(); let finished = false; void flush.then(() => { finished = true; }); await h.settle();
  assert.equal(finished, false); assert.deepEqual(db.file(TARGET).section, initial);
  held.resolve(); assert.equal(await flush, true); await h.settle();
  assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, []);
  assert.equal(h.workspace().workspace.selection.revision, 10); assert.equal(h.adoption().props.workspaceRevision, 6);
  h.controls.setReadOnly(true); await h.settle();
  await assert.rejects(h.workspace().workspace.previewTransport(input, { signal: new AbortController().signal }), /read_only/);
  h.workspace().workspace.onSelectionIntent([groupId(1)]); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'preview', 'save']); assert.equal(await h.controls.flush(), true);
  assert.deepEqual(db.file(TARGET).accepted, accepted); assert.equal(db.maxOpen, 1);
});

for (const city of cityCatalog.cities) test(`installed ${city.name} study is explicit analytical intent, not a reference-camera action`, async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted), scope = cityChoice(city);
  h.radius(cityKey(scope)); await h.settle();
  assert.deepEqual(kinds(db), ['catalog']); assert.match(h.html(), /Displayed study: 3-mile radius/);
  assert.doesNotMatch(h.text(), /mailing-city names|reference control/);
  h.click(`Capture ${city.name} city polygon (${cityCatalog.vintage}) study`); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'save', 'capture', 'catalog', 'save']);
  assert.deepEqual(db.calls[1].body.value.active, initial.value.active); assert.equal(db.calls[1].body.value.workspace_version, 4);
  assert.deepEqual(db.calls[2].body.discovery, scope); assert.equal(Object.hasOwn(db.calls[2].body.discovery, 'radius_metres'), false);
  assert.deepEqual(db.file(TARGET).section.value.active.discovery, scope);
  assert.match(h.text(), new RegExp(`Displayed study: ${city.name} city polygon`));
  assert.deepEqual(db.file(TARGET).accepted, accepted); assert.equal(await h.controls.flush(), true); assert.equal(db.maxOpen, 1);
  const saved = copy(db.file(TARGET).section); h.unmount();
  const reopened = harness(t, db, saved); await reopened.settle();
  assert.equal(kinds(db).at(-1), 'catalog'); assert.equal(db.calls.filter(c => c.kind === 'capture').length, 1);
  assert.match(reopened.text(), new RegExp(`Displayed study: ${city.name} city polygon`));
  assert.equal(await reopened.controls.flush(), true);
});

test('city -> three-mile study preserves old city until activation and retains explicit radius intent', async t => {
  const city = cityCatalog.cities[0], initial = activeSection([]); initial.value.workspace_version = 4;
  initial.value.active.discovery = cityChoice(city);
  const db = server(initial), h = harness(t, db, initial); await h.settle();
  h.radius('3'); await h.settle(); assert.deepEqual(kinds(db), ['catalog']);
  assert.match(h.text(), /Displayed study: Coppell city polygon/);
  h.click('Capture a new 3-mile study'); await h.settle();
  assert.equal(db.calls[1].body.value.workspace_version, 4); assert.deepEqual(db.calls[1].body.value.active, initial.value.active);
  assert.deepEqual(db.calls[2].body.discovery, { profile_id: 'custom-suburban-radius-v2', radius_metres: '4828.032' });
  assert.equal(db.file(TARGET).section.value.workspace_version, 6); assert.match(h.text(), /Displayed study: 3-mile radius/);
  assert.equal(await h.controls.flush(), true);
});

test('failed city capture keeps the old map selection/report and resumes the exact pending city', async t => {
  const initial = activeSection([]), city = cityCatalog.cities[1], scope = cityChoice(city);
  const db = server(initial), h = harness(t, db, initial); await h.settle(); const accepted = copy(db.file(TARGET).accepted);
  db.overrides.set('capture', () => json({ error: 'capture_limit' }, 422));
  h.radius(cityKey(scope)); h.click(`Capture ${city.name} city polygon (${cityCatalog.vintage}) study`); await h.settle();
  const pending = copy(db.file(TARGET).section.value.pending_capture);
  assert.deepEqual(pending.discovery, scope); assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
  assert.equal(h.workspace().contextRef.context_id, OLD); assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
  assert.match(h.text(), /Displayed study: 3-mile radius/); assert.equal(await h.controls.flush(), false);
  db.overrides.delete('capture'); h.click('Reload saved choices'); await h.settle();
  h.click('Resume saved capture'); await h.settle();
  assert.deepEqual(db.calls.filter(c => c.kind === 'capture').map(c => c.body.operation_id), [pending.operation_id, pending.operation_id]);
  assert.match(h.text(), /Displayed study: Dallas city polygon/); assert.deepEqual(db.file(TARGET).accepted, accepted);
  assert.equal(await h.controls.flush(), true);
});

test('historical saved city reopens without substituting current asset and cannot be used for new capture', async t => {
  const initial = activeSection([]); initial.value.workspace_version = 4;
  initial.value.active.discovery = { profile_id: 'custom-city-polygon-v1', city: {
    geoid: cityCatalog.cities[0].geoid, vintage: '2001-01-01', asset_sha256: 'f'.repeat(64) } };
  const db = server(initial), h = harness(t, db, initial); await h.settle();
  assert.deepEqual(kinds(db), ['catalog']); assert.match(h.text(), /Displayed study: City GEOID 4816612 city polygon \(2001-01-01\)/);
  assert.match(h.text(), /retained; not installed for new capture/);
  const start = h.button('Capture City GEOID 4816612 city polygon (2001-01-01) study'); assert.equal(start.props.disabled, true);
  assert.equal(await h.controls.flush(), true);
  h.radius(cityKey(cityChoice(cityCatalog.cities[0]))); await h.settle();
  assert.equal(h.button('Capture Coppell city polygon (2026-01-01) study').props.disabled, false);
  assert.deepEqual(kinds(db), ['catalog']); assert.deepEqual(db.file(TARGET).section, initial);
});

for (const [errorCode, expectedText] of [
  ['neighborhood_city_subject_outside_scope', 'The subject is outside the selected city area.'],
  ['neighborhood_city_source_unavailable', 'That city area is currently unavailable.'],
]) test(`known city refusal ${errorCode} reaches the Host with safe set-aside guidance and unchanged study`, async t => {
  const initial = activeSection([]), city = cityCatalog.cities[0], db = server(initial), h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted);
  db.overrides.set('capture', () => json({ error: errorCode, detail: 'secret local source path' }, 422));
  h.radius(cityKey(cityChoice(city))); h.click(`Capture ${city.name} city polygon (${cityCatalog.vintage}) study`); await h.settle();
  assert.ok(h.text().includes(expectedText)); assert.match(h.text(), /Choose a different area/);
  assert.doesNotMatch(h.text(), /secret local source path|neighborhood_city_/);
  assert.equal(h.workspace().contextRef.context_id, OLD); assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
  assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active); assert.deepEqual(db.file(TARGET).accepted, accepted);
  assert.equal(await h.controls.flush(), false); assert.equal(h.button('Set aside pending capture').props.disabled, true);
  h.click('Reload saved choices'); await h.settle();
  assert.equal(h.button('Set aside pending capture').props.disabled, false);
  h.click('Set aside pending capture'); await h.settle();
  assert.equal(db.file(TARGET).section.value.pending_capture, null); assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
  assert.deepEqual(db.file(TARGET).accepted, accepted); assert.equal(await h.controls.flush(), true);
  assert.equal(db.calls.filter(c => c.kind === 'capture').length, 1);
});

test('unknown city error remains generic and never displays raw server text', async t => {
  const initial = activeSection([]), city = cityCatalog.cities[0], db = server(initial), h = harness(t, db, initial); await h.settle();
  db.overrides.set('capture', () => json({ error: 'neighborhood_city_source_unavailable: secret local source path' }, 422));
  h.radius(cityKey(cityChoice(city))); h.click(`Capture ${city.name} city polygon (${cityCatalog.vintage}) study`); await h.settle();
  assert.match(h.text(), /The neighborhood could not be updated\. Try again\./);
  assert.doesNotMatch(h.text(), /secret local source path|selected city polygon is unavailable/);
  assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
});

for (const [status, errorCode] of [
  [401, 'authentication_required'],
  [403, 'neighborhood_access_denied'],
  [503, 'custom_neighborhood_workspace_disabled'],
  [404, 'neighborhood_context_unavailable'],
  [422, 'neighborhood_source_unavailable'],
  [422, 'neighborhood_capture_capacity_exceeded'],
  [422, 'neighborhood_private_source_review_required'],
  [422, 'neighborhood_private_source_limit'],
  [409, 'neighborhood_private_review_changed'],
  [409, 'neighborhood_private_source_read_only'],
  [409, 'neighborhood_operation_conflict'],
  [409, 'neighborhood_subject_changed'],
  [409, 'neighborhood_target_changed'],
  [409, 'neighborhood_market_policy_changed'],
  [409, 'neighborhood_operation_outcome_unknown'],
  [503, 'neighborhood_request_interrupted'],
  [503, 'neighborhood_service_busy'],
]) test(`capture refusal ${status}/${errorCode} shows fixed guidance while preserving pending operation and old display`, async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  db.overrides.set('capture', () => {
    // Another editor may change a report while this capture is refused. The
    // Host must describe only this capture's effects, not promise global stasis.
    db.file(TARGET).accepted = { revision: 8, value: { synthetic_other_editor: true } };
    return json({ error: errorCode, detail: 'secret provider/database data', retry_same_operation: true }, status);
  });
  h.radius('5'); h.click('Capture a new 5-mile study'); await h.settle();
  const pending = copy(db.file(TARGET).section.value.pending_capture);
  assert.match(h.text(), /Please sign in again|Neighborhood analysis is not available|area could not be loaded completely|neighborhood could not be updated/);
  assert.doesNotMatch(h.text(), /secret provider\/database data|your report has not changed|accepted report are unchanged/);
  assert.equal(h.workspace().contextRef.context_id, OLD); assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
  assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
  assert.deepEqual(db.file(TARGET).accepted, { revision: 8, value: { synthetic_other_editor: true } });
  assert.equal(await h.controls.flush(), false); assert.equal(h.button('Resume saved capture').props.disabled, true);
  h.button('Resume saved capture').props.onClick(); await h.settle(); assert.equal(db.calls.filter(c => c.kind === 'capture').length, 1);
  db.overrides.delete('capture'); h.click('Reload saved choices'); await h.settle();
  assert.equal(db.calls.filter(c => c.kind === 'capture').length, 1, 'reload must not auto-capture');
  assert.deepEqual(db.file(TARGET).section.value.pending_capture, pending); assert.equal(await h.controls.flush(), false);
  h.click('Resume saved capture'); await h.settle();
  assert.deepEqual(db.calls.filter(c => c.kind === 'capture').map(c => c.body.operation_id), [pending.operation_id, pending.operation_id]);
  assert.deepEqual(db.calls.filter(c => c.kind === 'capture').map(c => c.body.discovery), [pending.discovery, pending.discovery]);
  assert.equal(db.file(TARGET).section.value.pending_capture, null); assert.equal(await h.controls.flush(), true);
  assert.equal(db.maxOpen, 1);
});

test('unknown capture errors and strings normalized to known codes stay generic and actor-relative', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  db.overrides.set('capture', () => json({ error: 'authentication_required\n', detail: 'secret' }, 401));
  h.radius('5'); h.click('Capture a new 5-mile study'); await h.settle();
  assert.match(h.text(), /The neighborhood could not be updated\. Try again\./);
  assert.doesNotMatch(h.text(), /Sign in again|your report has not changed|secret/);
  assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
});

test('catalog city hash mismatch on fresh reopen blocks workspace without requesting capture or defaults', async t => {
  const initial = activeSection([]); initial.value.workspace_version = 4; initial.value.active.discovery = cityChoice(cityCatalog.cities[0]);
  const db = server(initial); db.overrides.set('catalog', async (_call, respond) => {
    const value = await respond().json(); value.discovery.city.asset_sha256 = 'f'.repeat(64); return json(value); });
  const h = harness(t, db, initial); await h.settle();
  assert.deepEqual(kinds(db), ['catalog']); assert.equal(h.workspace(), undefined); assert.equal(await h.controls.flush(), false);
  assert.match(h.html(), /role="alert"/); assert.deepEqual(db.file(TARGET).section, initial);
});

test('private CSV city capture uses the exact chosen polygon; save barrier still closes admission', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const scope = cityChoice(cityCatalog.cities[2]), reference = { batch_id: OLD, expected_review_revision: 7 };
  h.radius(cityKey(scope)); h.controls.setReadOnly(true); await h.settle();
  assert.equal(await h.controls.useReviewedSales(reference), false); assert.deepEqual(kinds(db), ['catalog']);
  h.controls.setReadOnly(false); await h.settle(); assert.equal(await h.controls.useReviewedSales(reference), true); await h.settle();
  const call = db.calls.find(c => c.kind === 'capture'); assert.deepEqual(call.body.discovery, scope);
  assert.deepEqual(call.body.private_sales_import, reference); assert.equal(db.file(TARGET).section.value.workspace_version, 6);
  assert.match(h.text(), /Displayed study: Duncanville city polygon/); assert.equal(db.maxOpen, 1); assert.equal(await h.controls.flush(), true);
});

test('changing local city options while an existing study rerenders does not reload or change saved scope', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  h.radius(cityKey(cityChoice(cityCatalog.cities[3])));
  h.render({ ...h.props, initialSection: copy(initial), target: copy(TARGET) }); await h.settle();
  assert.equal(h.button('Capture Garland city polygon (2026-01-01) study').props.disabled, false);
  assert.deepEqual(kinds(db), ['catalog']); assert.deepEqual(db.file(TARGET).section, initial);
});

test('radius chooser is intent-only until capture and then persists the exact expanded study', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const before = copy(db.file(TARGET).accepted);
  h.radius('5'); await h.settle(); assert.deepEqual(kinds(db), ['catalog']);
  assert.match(h.html(), /Displayed study: 3-mile radius/);
  h.click('Capture a new 5-mile study'); await h.settle();
  const capture = db.calls.find(call => call.kind === 'capture');
  assert.deepEqual(capture.body.discovery, { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' });
  assert.deepEqual(db.calls.find(call => call.kind === 'save').body.value.pending_capture.discovery, capture.body.discovery);
  assert.deepEqual(db.file(TARGET).section.value.active.discovery, capture.body.discovery);
  assert.match(h.html(), /Displayed study: 5-mile radius/); assert.equal(await h.controls.flush(), true);
  assert.deepEqual(db.file(TARGET).accepted, before);
  h.unmount(); const reopened = harness(t, db, copy(db.file(TARGET).section)); await reopened.settle();
  assert.match(reopened.html(), /Displayed study: 5-mile radius/);
  assert.ok(reopened.button('Capture a new 5-mile study'));
  const count = db.calls.filter(call => call.kind === 'capture').length;
  reopened.radius('3'); await reopened.settle(); assert.equal(db.calls.filter(call => call.kind === 'capture').length, count);
  reopened.click('Capture a new 3-mile study'); await reopened.settle();
  assert.equal(db.calls.filter(call => call.kind === 'capture').at(-1).body.discovery.radius_metres, '4828.032');
  assert.deepEqual(db.file(TARGET).accepted, before);
});

test('larger capture failure retains the displayed area and exact pending radius for retry', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const before = copy(db.file(TARGET).accepted);
  db.overrides.set('capture', () => json({ error: 'neighborhood_source_unavailable' }, 422));
  h.radius('10'); h.click('Capture a new 10-mile study'); await h.settle();
  const pending = copy(db.file(TARGET).section.value.pending_capture);
  assert.equal(pending.discovery.radius_metres, '16093.44');
  assert.equal(h.workspace().contextRef.context_id, OLD); assert.match(h.html(), /Displayed study: 3-mile radius/);
  assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, []);
  assert.equal(await h.controls.flush(), false); assert.deepEqual(db.file(TARGET).accepted, before);
  db.overrides.delete('capture'); h.click('Reload saved choices'); await h.settle();
  h.click('Resume saved capture'); await h.settle();
  const retry = db.calls.filter(call => call.kind === 'capture').at(-1);
  assert.equal(retry.body.operation_id, pending.operation_id); assert.deepEqual(retry.body.discovery, pending.discovery);
  assert.match(h.html(), /Displayed study: 10-mile radius/); assert.equal(await h.controls.flush(), true);
});

test('private CSV capture uses the displayed next radius without converting it to three miles', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  h.radius('5');
  const reference = { batch_id: '20000000-0000-4000-8000-000000000001', expected_review_revision: 3 };
  const task = h.controls.useReviewedSales(reference); await h.settle(); assert.equal(await task, true);
  const capture = db.calls.find(call => call.kind === 'capture');
  assert.deepEqual(capture.body.private_sales_import, reference); assert.equal(capture.body.discovery.radius_metres, '8046.72');
  assert.equal(db.file(TARGET).section.value.workspace_version, 6);
});

test('member pages share the owned lane, preserve report data, and quiesce with Save Everything', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const before = copy(db.file(TARGET)), held = deferred();
  db.overrides.set('members', async (_call, respond) => { await held.promise; return respond(); });
  const member = h.workspace().workspace.memberTransport;
  const input = { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId,
    contextRef: context(OLD), selection: { revision: 1, pockets: [] } };
  const population = { group: 'selected', kind: 'stock' }, page = { limit: 50, after_member_id: null };
  const options = () => ({ signal: new AbortController().signal });
  const running = member(input, population, page, options()); await h.settle();
  h.controls.setReadOnly(true); await h.settle();
  await assert.rejects(member(input, population, page, options()), /custom_workspace_read_only/);
  let finished = false; const flush = h.controls.flush().then(value => { finished = true; return value; });
  await h.settle(); assert.equal(finished, false); assert.deepEqual(kinds(db), ['catalog', 'members']);
  held.resolve(); await running; await h.settle(); assert.equal(await flush, true);
  assert.equal(db.maxOpen, 1); assert.deepEqual(db.file(TARGET), before);
  await assert.rejects(member(input, population, page, options()), /custom_workspace_read_only/);
  h.controls.setReadOnly(false); await h.settle();
  await assert.rejects(member({ ...input, assignmentFileId: '42' }, population, page, options()), /custom_workspace_target_changed/);
  await assert.rejects(member({ ...input, contextRef: context('20000000-0000-4000-8000-000000000002') }, population, page, options()), /custom_workspace_context_changed/);
  h.unmount(); await assert.rejects(member(input, population, page, options()), /custom_workspace_read_only/);
  assert.deepEqual(kinds(db), ['catalog', 'members']);
});

test('member inspection cannot admit new work while a checkpoint save is pending', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const held = deferred(); db.overrides.set('save', async (_call, respond) => { await held.promise; return respond(); });
  h.select([]); await h.settle();
  await assert.rejects(h.workspace().workspace.memberTransport({ accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId,
    contextRef: context(OLD), selection: { revision: 1, pockets: [] } }, { group: 'selected', kind: 'stock' },
  { limit: 50, after_member_id: null }, { signal: new AbortController().signal }), /custom_workspace_read_only/);
  assert.deepEqual(kinds(db), ['catalog', 'save']); held.resolve(); await h.settle();
  assert.equal(await h.controls.flush(), true);
});

test('explicit private source action saves exact selector before capture and preserves accepted report', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const reference = { batch_id: '20000000-0000-4000-8000-000000000001', expected_review_revision: 3 };
  const before = copy(db.file(TARGET).accepted), pending = h.controls.useReviewedSales(reference);
  await h.settle(); assert.equal(await pending, true);
  const capture = db.calls.find(call => call.kind === 'capture'); assert.deepEqual(capture.body.private_sales_import, reference);
  const savedPending = db.calls.find(call => call.kind === 'save').body.value;
  assert.equal(savedPending.workspace_version, 2); assert.deepEqual(savedPending.pending_capture.private_sales_import, reference);
  assert.deepEqual(capture.body.observation_period, PERIOD); assert.deepEqual(db.file(TARGET).accepted, before);
  assert.equal(await h.controls.flush(), true); assert.equal(db.maxOpen, 1);
  const count = db.calls.length; h.controls.setReadOnly(true); await h.settle();
  assert.equal(await h.controls.useReviewedSales(reference), false); assert.equal(db.calls.length, count);
});

test('rendered reopen preserves explicit empty selection without capture or save', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  assert.deepEqual(kinds(db), ['catalog']); assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
  assert.match(h.html(), /Neighborhood choices saved/); assert.equal(await h.controls.flush(), true);
  assert.equal(db.calls[0].body.context_ref.context_id, OLD); assert.equal(db.calls[0].body.selection.revision, 9);
  h.render({ ...h.props, initialSection: copy(initial), initialPeriod: copy(PERIOD) }); await h.settle();
  assert.deepEqual(kinds(db), ['catalog'], 'autosave prop object churn must not restart a keyed host');
});

test('first rendered capture durably saves pending before source read and exact catalog before active', async t => {
  const db = server(), h = harness(t, db); await h.settle();
  assert.deepEqual(kinds(db), ['save', 'capture', 'catalog', 'save']);
  const pending = db.calls[0].body.value.pending_capture;
  assert.equal(db.calls[0].body.expected_revision, 0); assert.equal(db.calls[1].body.operation_id, pending.operation_id);
  assert.equal(db.calls[2].body.context_ref.context_id, pending.operation_id);
  assert.deepEqual(db.file(TARGET).section.value.active.selection.included_recorded_group_ids, [groupId(1), groupId(2), 'discovery:unassigned']);
  assert.equal(db.file(TARGET).section.revision, 2); assert.equal(db.maxOpen, 1);
  assert.deepEqual(db.file(TARGET).accepted, { revision: 7, value: { synthetic_accepted_report_marker: 'unchanged' } });
  assert.equal(await h.controls.flush(), true); assert.equal(h.workspace().workspace.saving, false);
});

test('rendered grouping upgrade is explicit, preserves all 1475 accounts, and waits for CAS without capture or report changes', async t => {
  const initial = activeSection(['discovery:unassigned']); initial.value.workspace_version = 5;
  const db = server(initial), accounts = Array.from({ length: 1475 }, (_, i) => i ? `A${i}` : TARGET.accountId);
  db.overrides.set('catalog', call => {
    const response = catalog(call.account, call.body), c = response.catalog, latest = call.body.catalog_version === 3;
    c.pockets = latest ? accounts.map((id, i) => ({ id: groupId(i + 1), disposition: 'needs_review',
      label: `Synthetic ${i}`, county: 'Dallas', account_ids: [id], member_count: 1 })) : [];
    c.status = latest ? 'review_only' : 'incomplete';
    c.unassigned = { account_ids: latest ? [] : [...accounts].sort(), member_count: latest ? 0 : accounts.length, reason_counts: [] };
    c.coverage = { discovery_member_count: accounts.length, assigned_account_count: latest ? accounts.length : 0,
      unassigned_account_count: latest ? 0 : accounts.length };
    c.subject_membership.assigned_pocket_id = latest ? groupId(1) : null;
    c.subject_membership.status = latest ? 'matched' : 'catalog_incomplete';
    return json(response);
  });
  const h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted), held = deferred();
  assert.deepEqual(kinds(db), ['catalog']); assert.equal(db.calls[0].body.catalog_version, 2);
  assert.deepEqual(db.file(TARGET).section, initial);
  assert.ok(h.button('Update grouping from saved capture'));
  db.overrides.set('save', async (_call, respond) => { await held.promise; return respond(); });
  h.click('Update grouping from saved capture'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'catalog', 'save']);
  assert.equal(db.calls[1].body.catalog_version, 3); assert.deepEqual(db.calls[1].body.context_ref, initial.value.active.context_ref);
  assert.equal(db.calls[2].body.expected_revision, initial.revision);
  assert.deepEqual(db.file(TARGET).section, initial);
  assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
  held.resolve(); await h.settle();
  const saved = db.file(TARGET).section;
  assert.equal(saved.value.workspace_version, 6); assert.equal(saved.revision, initial.revision + 1);
  assert.deepEqual(saved.value.active.selection, { revision: 10,
    included_recorded_group_ids: accounts.map((_, i) => groupId(i + 1)) });
  assert.deepEqual(db.file(TARGET).accepted, accepted); assert.equal(h.button('Update grouping from saved capture'), undefined);
  assert.equal(await h.controls.flush(), true);
  h.click('Reload saved choices'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'catalog', 'save', 'read', 'catalog']);
  assert.equal(db.calls.at(-1).body.catalog_version, 3); assert.deepEqual(db.file(TARGET).section, saved);
});

test('selection intent renders saving immediately and flush waits for exact empty CAS acknowledgement', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const held = deferred(); db.overrides.set('save', async (_call, respond) => { await held.promise; return respond(); });
  h.select([]); assert.equal(h.workspace().workspace.saving, true); assert.match(h.html(), /Updating neighborhood workspace/);
  let finished = false; const flushed = h.controls.flush().then(value => { finished = true; return value; }); await h.settle();
  assert.equal(finished, false); assert.equal(db.file(TARGET).section.revision, 5);
  held.resolve(); await h.settle(); assert.equal(await flushed, true);
  assert.deepEqual(h.workspace().workspace.selection, { revision: 10, included_recorded_group_ids: [] });
  assert.equal(db.file(TARGET).section.revision, 6); assert.deepEqual(kinds(db), ['catalog', 'save']);
});

test('committed selection with lost acknowledgement blocks flush until explicit target-bound reload', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  db.overrides.set('save', (_call, respond) => { respond(); throw new Error('synthetic lost acknowledgement'); });
  h.select([]); await h.settle(); assert.equal(await h.controls.flush(), false); assert.match(h.html(), /role="alert"/);
  assert.equal(h.workspace().workspace.saving, false);
  assert.equal(h.workspace().workspace.blockedReason, 'reload_required');
  assert.doesNotMatch(h.html(), /Updating neighborhood workspace|Neighborhood choices saved/);
  assert.deepEqual(db.file(TARGET).section.value.active.selection.included_recorded_group_ids, []);
  assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, [groupId(2)]);
  h.click('Reload saved choices'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'save', 'read', 'catalog']);
  assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, []);
  assert.equal(await h.controls.flush(), true); assert.doesNotMatch(h.html(), /role="alert"/);
});

test('lost pending-save acknowledgement reload resumes the exact committed operation, never a replacement', async t => {
  const db = server(); db.overrides.set('save', (_call, respond) => { const result = respond(); db.overrides.delete('save'); throw new Error('synthetic lost pending ACK', { cause: result.status }); });
  const h = harness(t, db); await h.settle(); assert.deepEqual(kinds(db), ['save']);
  const pending = copy(db.file(TARGET).section.value.pending_capture); assert.equal(await h.controls.flush(), false);
  h.click('Reload saved choices'); await h.settle(); assert.deepEqual(kinds(db), ['save', 'read']);
  assert.equal(await h.controls.flush(), false); h.click('Resume saved capture'); await h.settle();
  assert.deepEqual(kinds(db), ['save', 'read', 'capture', 'catalog', 'save']);
  assert.equal(db.calls[2].body.operation_id, pending.operation_id); assert.deepEqual(db.calls[2].body.observation_period, pending.observation_period);
  assert.equal(await h.controls.flush(), true);
});

test('file and session changes dispose old lanes; late catalog replies cannot replace current choices', async t => {
  for (const change of ['file', 'session']) {
    const initial = activeSection(), db = server(initial), held = deferred();
    db.overrides.set('catalog', async (_call, respond) => { db.overrides.delete('catalog'); await held.promise; return respond(); });
    const h = harness(t, db, initial); await h.settle(); const oldControl = h.controls, oldCall = db.calls[0];
    const target = { ...TARGET, ...(change === 'file' ? { assignmentFileId: '42' } : { sessionKey: 'synthetic-session-2' }) };
    const next = activeSection([], '20000000-0000-4000-8000-000000000002'); db.install(target, next);
    h.render({ ...h.props, target, initialSection: next }); await h.settle();
    assert.equal(oldCall.signal.aborted, true); assert.equal(await oldControl.flush(), false);
    assert.deepEqual(h.controls.target, target); assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, []);
    held.resolve(); await h.settle(); assert.equal(h.workspace().contextRef.context_id, next.value.active.context_ref.context_id);
    assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, []);
    assert.equal(await h.controls.flush(), true); assert.equal(db.calls.filter(call => call.kind === 'capture').length, 0); h.unmount();
  }
});

test('StrictMode effect replay cancels the first generation and completes one fresh owned capture', async t => {
  const db = server(), h = harness(t, db), oldControl = h.controls; h.strictReplay(); await h.settle();
  assert.deepEqual(kinds(db), ['save', 'capture', 'catalog', 'save']);
  assert.equal(await oldControl.flush(), false); assert.equal(await h.controls.flush(), true);
  assert.equal(h.workspace().workspace.saving, false); assert.doesNotMatch(h.html(), /role="alert"/);
});

test('preview and selection checkpoint share one HTTP lane and flush waits for both', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const held = deferred(); db.overrides.set('preview', async (_call, respond) => { await held.promise; return respond(); });
  const preview = h.workspace().workspace.previewTransport({ accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId,
    contextRef: context(OLD), selection: { revision: 9, pockets: [] }, include_map: false }, { signal: new AbortController().signal });
  await h.settle(); h.select([]); let finished = false;
  const flushed = h.controls.flush().then(value => { finished = true; return value; }); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'preview']); assert.equal(finished, false);
  held.resolve(); await preview; await h.settle(); assert.equal(await flushed, true);
  assert.deepEqual(kinds(db), ['catalog', 'preview', 'save']); assert.equal(db.maxOpen, 1);
});

test('missing period, malformed checkpoint, signed and disabled hosts do not silently capture', async t => {
  for (const variant of ['missing_period', 'malformed', 'signed', 'disabled']) {
    const initial = variant === 'malformed' ? null : undefined, db = server(initial);
    const h = harness(t, db, initial, variant === 'missing_period' ? { initialPeriod: null }
      : variant === 'signed' ? { workfileStatus: 'signed' } : variant === 'disabled' ? { enabled: false } : {});
    await h.settle(); assert.deepEqual(kinds(db), []); assert.equal(h.workspace(), undefined);
    if (variant === 'malformed') { assert.match(h.html(), /role="alert"/); assert.equal(await h.controls.flush(), false); }
    if (variant === 'signed' || variant === 'disabled') assert.equal(h.controls, undefined); h.unmount();
  }
});

test('a canonical effective-date default enables an explicit fresh capture without starting one on page load', async t => {
  const db = server(), h = harness(t, db, undefined, {
    initialPeriod: null,
    defaultPeriod: { start_date: '2024-09-01', end_date: '2026-08-31' },
  });
  await h.settle();
  assert.deepEqual(kinds(db), []);
  assert.equal(h.button('Start 3-mile exploration').props.disabled, false);
  assert.match(h.html(), /2024-09-01/);
  assert.match(h.html(), /2026-08-31/);
  h.click('Start 3-mile exploration'); await h.settle();
  assert.deepEqual(db.calls.find(call => call.kind === 'capture').body.observation_period, {
    start_date: '2024-09-01', end_date: '2026-08-31',
  });
});

test('fresh signed workfile reload removes editable choices and refuses a successful save flush', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  db.file(TARGET).status = 'signed'; h.click('Reload saved choices'); await h.settle();
  assert.equal(h.workspace(), undefined); assert.match(h.html(), /no longer editable/);
  assert.equal(await h.controls.flush(), false); assert.deepEqual(kinds(db), ['catalog', 'read']);
});

test('a competing checkpoint revision is not overwritten and only explicit reload adopts it', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const competing = activeSection([groupId(1)]); competing.revision = 6; competing.value.active.selection.revision = 10;
  db.file(TARGET).section = copy(competing); h.select([]); await h.settle();
  assert.deepEqual(db.file(TARGET).section, competing); assert.equal(await h.controls.flush(), false);
  assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, [groupId(2)]);
  h.click('Reload saved choices'); await h.settle();
  assert.deepEqual(h.workspace().workspace.selection, competing.value.active.selection);
  assert.equal(await h.controls.flush(), true); assert.deepEqual(kinds(db), ['catalog', 'save', 'read', 'catalog']);
});

test('foreign catalog hashes and mismatched capture IDs never create an active checkpoint', async t => {
  for (const variant of ['catalog', 'capture']) {
    const db = server(); db.overrides.set(variant, (call) => {
      if (variant === 'capture') return json({ status: 'registered', context_ref: context(OLD) });
      const response = catalog(call.account, call.body); response.context_ref.context_sha256 = 'f'.repeat(64); return json(response);
    });
    const h = harness(t, db); await h.settle();
    assert.equal(h.workspace(), undefined); assert.match(h.html(), /role="alert"/); assert.equal(await h.controls.flush(), false);
    assert.equal(db.file(TARGET).section.revision, 1); assert.equal(db.file(TARGET).section.value.active, null);
    assert.equal(db.calls.filter(call => call.kind === 'save').length, 1); h.unmount();
  }
});

test('StrictMode after a committed but pending HTTP ACK fails closed and reload reuses its durable operation', async t => {
  const db = server(), held = deferred(); let oldCall;
  db.overrides.set('save', async (call, respond) => {
    db.overrides.delete('save'); oldCall = call; const response = respond(); await held.promise; return response;
  });
  const h = harness(t, db); await h.settle(); const pending = copy(db.file(TARGET).section.value.pending_capture);
  h.strictReplay(); await h.settle();
  assert.equal(oldCall.signal.aborted, true); assert.equal(db.calls.filter(call => call.kind === 'capture').length, 0);
  assert.deepEqual(db.file(TARGET).section.value.pending_capture, pending); assert.equal(await h.controls.flush(), false);
  held.resolve(); await h.settle(); assert.equal(await h.controls.flush(), false);
  h.click('Reload saved choices'); await h.settle(); h.click('Resume saved capture'); await h.settle();
  assert.equal(db.calls.find(call => call.kind === 'capture').body.operation_id, pending.operation_id);
  assert.equal(await h.controls.flush(), true); assert.equal(db.file(TARGET).section.value.active.context_ref.context_id, pending.operation_id);
});

test('host read-only quiescence waits for the pending owned save and prevents another edit', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const held = deferred(); db.overrides.set('save', async (_call, respond) => { await held.promise; return respond(); });
  h.select([]); h.controls.setReadOnly(true); await h.settle();
  assert.equal(h.workspace().workspace.saving, true); assert.equal(h.button('Reload saved choices').props.disabled, true);
  // Exercise the child callback directly too: disabled controls are not the only guard.
  h.workspace().workspace.onSelectionIntent([groupId(1)]); await h.settle();
  assert.equal(db.calls.filter(call => call.kind === 'save').length, 1);
  const flushed = h.controls.flush(); held.resolve(); await h.settle(); assert.equal(await flushed, true);
  assert.deepEqual(db.file(TARGET).section.value.active.selection.included_recorded_group_ids, []);
  assert.equal(h.workspace().workspace.saving, false); assert.equal(h.workspace().workspace.blockedReason, 'read_only');
  assert.doesNotMatch(h.html(), /Updating neighborhood workspace|Neighborhood choices saved/);
  h.controls.setReadOnly(false); await h.settle(); assert.equal(h.workspace().workspace.saving, false);
  assert.equal(h.workspace().workspace.blockedReason ?? null, null);
});

test('read-only quiescence closes NEW preview/inspection admission before and after flush while existing lane reads settle', async t => {
  const initial = activeSection(), db = server(initial), h = harness(t, db, initial); await h.settle();
  const held = deferred(); db.overrides.set('preview', async (_call, respond) => { await held.promise; return respond(); });
  const transport = h.workspace().workspace.previewTransport;
  const input = { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, contextRef: context(OLD),
    selection: { revision: 9, pockets: [] }, include_map: false };
  const options = () => ({ signal: new AbortController().signal });
  const admitted = transport(input, options()); await h.settle();
  h.controls.setReadOnly(true);
  await assert.rejects(transport(input, options()), /custom_workspace_read_only/);
  let flushed = false; const pendingFlush = h.controls.flush().then(value => { flushed = true; return value; }); await h.settle();
  assert.equal(flushed, false); assert.equal(db.calls.filter(call => call.kind === 'preview').length, 1);
  held.resolve(); await admitted; assert.equal(await pendingFlush, true);
  await assert.rejects(transport({ ...input, selection: { revision: 1, pockets: [] } }, options()), /custom_workspace_read_only/);
  assert.equal(db.calls.filter(call => call.kind === 'preview').length, 1);
  h.controls.setReadOnly(false); db.overrides.delete('preview');
  await transport(input, options()); assert.equal(db.calls.filter(call => call.kind === 'preview').length, 2);
  h.unmount(); await assert.rejects(transport(input, options()), /custom_workspace_read_only/);
});

test('failed fresh reload cannot report flush success from the previous ready lifecycle', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  assert.equal(await h.controls.flush(), true);
  db.overrides.set('read', () => { throw new Error('synthetic unavailable fresh workfile'); });
  h.click('Reload saved choices'); await h.settle();
  assert.match(h.html(), /role="alert"/); assert.equal(await h.controls.flush(), false);
  assert.equal(h.workspace().workspace.saving, false); assert.equal(h.workspace().workspace.blockedReason, 'reload_required');
  assert.doesNotMatch(h.html(), /Updating neighborhood workspace|Neighborhood choices saved/);
  assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
  assert.deepEqual(db.file(TARGET).section, initial); assert.deepEqual(kinds(db), ['catalog', 'read']);
  const start = h.button('Capture a new 3-mile study'); assert.equal(start.props.disabled, true);
  assert.equal(h.button('Reload saved choices').props.disabled, false);
  // Guards must hold for already-captured child/button callbacks as well as DOM disabled state.
  h.workspace().workspace.onSelectionIntent([groupId(1)]); start.props.onClick(); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'read']); assert.equal(await h.controls.flush(), false);
  assert.match(h.html(), /role="alert"/); assert.doesNotMatch(h.html(), /Neighborhood choices saved/);
  db.overrides.delete('read'); h.click('Reload saved choices'); await h.settle();
  assert.equal(await h.controls.flush(), true); assert.doesNotMatch(h.html(), /role="alert"/);
  assert.equal(h.workspace().workspace.blockedReason ?? null, null); assert.match(h.html(), /Neighborhood choices saved/);
  assert.deepEqual(kinds(db), ['catalog', 'read', 'read', 'catalog']);
});

test('a reopened active selection with durable pending capture is paused, not permanently saving', async t => {
  const initial = activeSection([]), operation = '20000000-0000-4000-8000-000000000001';
  initial.value.pending_capture = { operation_id: operation, observation_period: copy(PERIOD) };
  const db = server(initial), h = harness(t, db, initial); await h.settle();
  assert.deepEqual(kinds(db), ['catalog']); assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, []);
  assert.equal(h.workspace().workspace.saving, false); assert.equal(h.workspace().workspace.blockedReason, 'pending_capture');
  assert.doesNotMatch(h.html(), /Updating neighborhood workspace|Neighborhood choices saved/);
  assert.equal(await h.controls.flush(), false); assert.equal(h.button('Resume saved capture').props.disabled, false);
  h.workspace().workspace.onSelectionIntent([groupId(1)]); await h.settle(); assert.deepEqual(kinds(db), ['catalog']);
  h.click('Resume saved capture'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'capture', 'catalog', 'save']);
  assert.equal(db.calls[1].body.operation_id, operation); assert.equal(await h.controls.flush(), true);
  assert.equal(h.workspace().workspace.blockedReason ?? null, null);
});

test('pending capture cannot bypass a failed fresh reload, including its direct Resume callback', async t => {
  const initial = activeSection([]), operation = '20000000-0000-4000-8000-000000000001';
  initial.value.pending_capture = { operation_id: operation, observation_period: copy(PERIOD) };
  const db = server(initial), h = harness(t, db, initial); await h.settle();
  assert.equal(h.button('Resume saved capture').props.disabled, false);
  db.overrides.set('read', () => { throw new Error('synthetic unavailable fresh pending workfile'); });
  h.click('Reload saved choices'); await h.settle();
  assert.equal(h.workspace().workspace.blockedReason, 'reload_required');
  assert.equal(h.workspace().workspace.saving, false); assert.equal(await h.controls.flush(), false);
  const resume = h.button('Resume saved capture'); assert.equal(resume.props.disabled, true);
  resume.props.onClick(); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'read']); assert.deepEqual(db.file(TARGET).section, initial);
  assert.equal(h.workspace().workspace.blockedReason, 'reload_required'); assert.equal(await h.controls.flush(), false);
  assert.match(h.html(), /role="alert"/); assert.doesNotMatch(h.html(), /Neighborhood choices saved/);
  db.overrides.delete('read'); h.click('Reload saved choices'); await h.settle();
  assert.equal(h.workspace().workspace.blockedReason, 'pending_capture');
  assert.equal(h.button('Resume saved capture').props.disabled, false); assert.equal(await h.controls.flush(), false);
  assert.deepEqual(kinds(db), ['catalog', 'read', 'read', 'catalog']);
  h.click('Resume saved capture'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'read', 'read', 'catalog', 'capture', 'catalog', 'save']);
  assert.equal(db.calls[4].body.operation_id, operation); assert.deepEqual(db.calls[4].body.observation_period, PERIOD);
  assert.equal(db.file(TARGET).section.value.active.context_ref.context_id, operation);
  assert.equal(h.workspace().workspace.blockedReason ?? null, null); assert.equal(await h.controls.flush(), true);
});

test('setting aside a pending source choice keeps exact previous study and accepted report', async t => {
  const initial = activeSection([]), operation = '20000000-0000-4000-8000-000000000001';
  initial.value.workspace_version = 2;
  initial.value.pending_capture = { operation_id: operation, observation_period: copy(PERIOD),
    private_sales_import: { batch_id: '20000000-0000-4000-8000-000000000002', expected_review_revision: 3 } };
  const db = server(initial), h = harness(t, db, initial); await h.settle();
  const accepted = copy(db.file(TARGET).accepted);
  h.click('Set aside pending capture'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'save', 'catalog']);
  assert.equal(db.calls[1].body.expected_revision, initial.revision);
  assert.equal(db.file(TARGET).section.value.pending_capture, null);
  assert.deepEqual(db.file(TARGET).section.value.active, initial.value.active);
  assert.deepEqual(db.file(TARGET).accepted, accepted);
  assert.equal(h.button('Set aside pending capture'), undefined);
  assert.equal(await h.controls.flush(), true);
});

test('pending clear lost ACK requires reload and blocks direct repeated clear', async t => {
  const initial = activeSection([]);
  initial.value.pending_capture = { operation_id: '20000000-0000-4000-8000-000000000001', observation_period: copy(PERIOD) };
  const db = server(initial), h = harness(t, db, initial); await h.settle();
  db.overrides.set('save', (_call, respond) => { respond(); throw new Error('synthetic lost clear ACK'); });
  h.click('Set aside pending capture'); await h.settle();
  assert.equal(db.file(TARGET).section.value.pending_capture, null);
  assert.equal(await h.controls.flush(), false);
  const retry = h.button('Set aside pending capture'); assert.equal(retry.props.disabled, true);
  retry.props.onClick(); await h.settle(); assert.deepEqual(kinds(db), ['catalog', 'save']);
  db.overrides.delete('save'); h.click('Reload saved choices'); await h.settle();
  assert.deepEqual(kinds(db), ['catalog', 'save', 'read', 'catalog']);
  assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
  assert.equal(await h.controls.flush(), true);
});

test('idle read-only host shows no request progress and can become editable without a request', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  h.controls.setReadOnly(true); await h.settle();
  assert.equal(h.workspace().workspace.saving, false); assert.equal(h.workspace().workspace.blockedReason, 'read_only');
  assert.doesNotMatch(h.html(), /Updating neighborhood workspace|Neighborhood choices saved/);
  assert.equal(h.button('Reload saved choices').props.disabled, true);
  h.workspace().workspace.onSelectionIntent([groupId(1)]); await h.settle();
  assert.deepEqual(kinds(db), ['catalog']); assert.equal(await h.controls.flush(), true);
  h.controls.setReadOnly(false); await h.settle(); assert.equal(h.workspace().workspace.blockedReason ?? null, null);
  assert.deepEqual(h.workspace().workspace.selection.included_recorded_group_ids, []);
  assert.deepEqual(kinds(db), ['catalog']); assert.match(h.html(), /Neighborhood choices saved/);
});

test('report controls share the exact saved workspace, lane and save barrier without starting an automatic proposal', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const child = h.adoption(); assert.ok(child); assert.deepEqual(child.props.contextRef, initial.value.active.context_ref);
  assert.equal(child.props.workspaceRevision, initial.revision); assert.deepEqual(kinds(db), ['catalog']);
  const held = deferred(); let entered = false;
  const task = child.props.run(async io => { entered = true; assert.ok(io.signal instanceof AbortSignal); await held.promise; });
  await h.settle(); assert.equal(entered, true); assert.equal(h.adoption().props.disabled, true);
  let flushed = false; const wait = h.controls.flush().then(value => { flushed = true; return value; });
  await h.settle(); assert.equal(flushed, false);
  assert.equal(await child.props.run(async () => assert.fail('parallel report action')), false);
  held.resolve(); assert.equal(await task, true); assert.equal(await wait, true); await h.settle();
  assert.equal(h.adoption().props.disabled, false); assert.deepEqual(kinds(db), ['catalog']);
});

test('unconfirmed Apply blocks exploration and save/sign; workspace-only reload cannot discard its exact retry', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const child = h.adoption(); child.props.onOutcomeUncertain(true); await h.settle();
  assert.equal(await h.controls.flush(), false); assert.equal(h.workspace().workspace.blockedReason, 'reload_required');
  assert.equal(h.adoption().props.disabled, false);
  assert.equal(h.button('Reload saved choices').props.disabled, true);
  h.button('Reload saved choices').props.onClick(); await h.settle();
  assert.equal(h.adoption().key, child.key); assert.equal(await h.controls.flush(), false);
  assert.equal(await h.controls.useReviewedSales({ batch_id: OLD, expected_review_revision: 1 }), false);
  h.workspace().workspace.onSelectionIntent([groupId(1)]); await h.settle(); assert.deepEqual(kinds(db), ['catalog']);
  assert.equal(await h.adoption().props.run(async () => child.props.onOutcomeUncertain(false)), true);
  await h.settle(); assert.equal(await h.controls.flush(), true);
  h.click('Reload saved choices'); await h.settle();
  assert.notEqual(h.adoption().key, child.key); assert.equal(await h.controls.flush(), true);
});

test('save/sign quiescence closes report admission and file switch invalidates a running report lane', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const old = h.adoption(); h.controls.setReadOnly(true); await h.settle();
  assert.equal(await old.props.run(async () => assert.fail('read-only action')), false);
  h.controls.setReadOnly(false); await h.settle();
  const held = deferred(); let signal;
  const pending = old.props.run(async io => { signal = io.signal; await held.promise; }); await h.settle();
  h.unmount(); assert.equal(signal.aborted, true); held.resolve(); assert.equal(await pending, false);
});

for (const phase of ['unknown Apply', 'acknowledged Apply awaiting fresh read']) {
  test(`${phase} deadline permits only explicit report recovery after the actual lane settles`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
    const child = h.adoption(), staleWorkspace = h.workspace(), staleReload = h.button('Reload saved choices').props.onClick;
    const operationId = '30000000-0000-4000-8000-000000000001', calls = [], held = deferred(); let signal;
    // The real Adoption owns its UUID/known-ACK latch; this Host test exercises
    // that unchanged mounted child's report-task seam and the actual lane.
    const pending = child.props.run(async io => {
      signal = io.signal; calls.push({ operationId, phase }); child.props.onOutcomeUncertain(true);
      await held.promise;
    });
    await h.settle(); t.mock.timers.tick(65_000); await h.settle();
    assert.equal(await pending, false); assert.equal(signal.aborted, true);
    assert.equal(h.adoption().key, child.key); assert.equal(h.adoption().props.disabled, false);
    assert.equal(h.button('Reload saved choices').props.disabled, true);
    assert.equal(await h.controls.flush(), false); assert.match(h.text(), /report did not finish updating\. Try again/);
    assert.equal(await h.adoption().props.run(async () => assert.fail('retry before underlying operation settles')), false);
    staleReload(); staleWorkspace.workspace.onSelectionIntent([groupId(1)]);
    assert.equal(await h.controls.useReviewedSales({ batch_id: OLD, expected_review_revision: 1 }), false);
    await assert.rejects(staleWorkspace.workspace.previewTransport({ accountId: TARGET.accountId,
      assignmentFileId: TARGET.assignmentFileId, contextRef: context(OLD), selection: { revision: 9, pockets: [] } },
    { signal: new AbortController().signal }), /custom_workspace_read_only/);
    await h.settle(); assert.deepEqual(kinds(db), ['catalog']); assert.equal(calls.length, 1);
    held.resolve(); await h.settle();
    assert.equal(await h.controls.flush(), false, 'Settling alone never clears report uncertainty/recovery');
    assert.equal(h.adoption().key, child.key); assert.equal(h.adoption().props.disabled, false);
    h.controls.setReadOnly(true); await h.settle();
    assert.equal(await child.props.run(async () => assert.fail('save/sign quiescence bypass')), false);
    h.controls.setReadOnly(false); await h.settle();
    const retry = h.adoption().props.run(async () => {
      calls.push(phase === 'unknown Apply' ? { operationId, phase } : { readOnlyAcceptedRefresh: true });
      child.props.onOutcomeUncertain(false);
    });
    await h.settle(); assert.equal(await retry, true); assert.equal(await h.controls.flush(), true);
    assert.equal(h.adoption().key, child.key); assert.equal(h.button('Reload saved choices').props.disabled, false);
    assert.doesNotMatch(h.text(), /Saving and finalizing remain paused/);
    assert.deepEqual(calls, [{ operationId, phase }, phase === 'unknown Apply'
      ? { operationId, phase } : { readOnlyAcceptedRefresh: true }]);
    assert.deepEqual(kinds(db), ['catalog']); assert.deepEqual(db.file(TARGET).section, initial);
  });
}

test('report retry cannot recover a failed workspace save or a superseded file lane', async t => {
  const initial = activeSection([]), db = server(initial), h = harness(t, db, initial); await h.settle();
  const oldChild = h.adoption();
  db.overrides.set('save', () => { throw new Error('synthetic failed workspace save'); });
  h.select([groupId(1)]); await h.settle();
  assert.equal(await oldChild.props.run(async () => assert.fail('report cannot clear workspace recovery')), false);
  assert.equal(await h.controls.flush(), false); assert.equal(h.button('Reload saved choices').props.disabled, false);
  const nextTarget = { ...TARGET, assignmentFileId: '42' }; db.install(nextTarget, initial);
  h.render({ ...h.props, target: nextTarget }); await h.settle();
  assert.equal(await oldChild.props.run(async () => assert.fail('superseded report lane')), false);
  assert.equal(await h.controls.flush(), true); assert.deepEqual(h.workspace().workspace.selection, initial.value.active.selection);
});
