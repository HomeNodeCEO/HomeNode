import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as lane from '../src/features/neighborhood/customWorkspaceRequestLane.ts';
import { privateSalesSummaryFixture } from './fixtures/customPrivateSalesSummaryFixture.mjs';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
const ts = requireRuntime('typescript'), jsx = requireRuntime('react/jsx-runtime');
const { renderToStaticMarkup } = requireRuntime('react-dom/server');
function compile(name, imports) {
  const path = fileURLToPath(new URL(`../src/features/neighborhood/${name}`, import.meta.url));
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }, reportDiagnostics: true });
  assert.equal((output.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${output.outputText}\n})`, { filename: path }).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `Unexpected host test dependency: ${key}`); return imports[key];
  }, module, module.exports);
  return module.exports;
}
const checkpoint = compile('customWorkspaceCheckpoint.ts', { './customCohortPocketCatalog': catalogHelpers });
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
    context_ref: copy(body.context_ref), selection_revision: body.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: 1, status: 'review_only', apply: { status: 'blocked' },
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
  const files = new Map(), privateContexts = new Map(), calls = [], overrides = new Map(); let open = 0, maxOpen = 0;
  const key = target => `${target.accountId}/${target.assignmentFileId}`;
  const install = (target, section) => files.set(key(target), { section: copy(section), status: 'draft',
    accepted: { revision: 7, value: { synthetic_accepted_report_marker: 'unchanged' } } });
  install(TARGET, initialSection);
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
        return json({ status: 'registered', reused: false, context_ref: context(body.operation_id),
        source_query_complete: true, provider_coverage: 'not_established',
        discovery: { account_count: 3, parcel_count: 3, radius_metres: '4828.032' }, unsupported_capabilities: ['historical_characteristics'],
        ...(body.private_sales_import ? { private_sales_import: body.private_sales_import } : {}) });
      }
      if (kind === 'catalog') {
        const result = catalog(account, body), captured = privateContexts.get(body.context_ref.context_id);
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
    '../customWorkspaceRequestLane': lane, './CustomCohortWorkspace': { default: WorkspaceStub, __esModule: true },
    './CustomReportedObservationAdoption': { default: AdoptionStub, __esModule: true },
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
    button(label) { return walk(tree).find(node => node.type === 'button' && text(node) === label); },
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
    assert.equal(await h.controls.flush(), false); assert.match(h.text(), /Saving and finalizing remain paused/);
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
