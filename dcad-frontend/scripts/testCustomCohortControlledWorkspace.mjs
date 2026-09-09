import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as controller from '../src/features/neighborhood/customCohortPreviewController.ts';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript');
const ref = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const groupId = n => `recorded-cad:${String(n).padStart(64, '0')}`;
const input = { accountId: 'A', assignmentFileId: '9007199254740993', contextRef: ref, selection: { revision: 1, pockets: [] } };
const hash = value => createHash('sha256').update(value).digest('hex');
const selectionHash = selection => hash(JSON.stringify({ pockets: selection.pockets.map(p => ({ account_ids: [...p.account_ids].sort(),
  id: p.id, label: p.label })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), revision: selection.revision }));
function catalogResponse() {
  return { status: 'catalog', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: ref, selection_revision: 1, subject_freshness: 'matched', apply: { status: 'blocked' }, catalog: {
      catalog_version: 1, status: 'review_only', binding: { context_ref: ref, selection_revision: 1 }, apply: { status: 'blocked' },
      pockets: ['A', 'B'].map((account, i) => ({ id: groupId(i + 1), label: i ? 'Beta' : 'Alpha', county: 'Dallas',
        account_ids: [account], member_count: 1, disposition: 'needs_review' })),
      unassigned: { account_ids: ['C'], member_count: 1, reason_counts: [] },
      coverage: { discovery_member_count: 3, assigned_account_count: 2, unassigned_account_count: 1 },
      subject_membership: { account_id: 'A', assigned_pocket_id: groupId(1), status: 'matched', recorded_label_match_only: true }, limitations: [],
    } };
}
const catalog = catalogHelpers.checkCustomCohortPocketCatalog(catalogResponse(), input);
function response(request) {
  return { status: 'preview', target: { account_id: request.accountId, assignment_file_id: request.assignmentFileId },
    context_ref: request.contextRef, selection_revision: request.selection.revision, subject_freshness: 'matched',
    summary: { presentation_version: 1, preview_version: 1, status: 'observations_only', members_included: false,
      contents: 'population_summaries_only', binding: { context_ref: request.contextRef, selection_revision: request.selection.revision,
        selection_sha256: selectionHash(request.selection) }, all: {}, selected: {}, apply: { status: 'blocked', reasons: ['observation_preview_only'] } },
    parcel_map: request.include_map ? { status: 'unavailable', reason: 'missing_parcel_geometry', geojson: null,
      geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary' }
      : { status: 'omitted', reason: 'geometry_not_requested' }, apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
}
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const children = node => (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(text).join('') : '';
function harness(name = 'CustomCohortWorkspace') {
  const cells = [], effects = [], calls = [], catalogCalls = [], intents = [], timers = new Map();
  let cursor = 0, dirty = false, tree, props, serial = 0;
  const react = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next;
        if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    useRef(value) { const i = cursor++; cells[i] ??= { current: value }; return cells[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn(), deps }; return cells[i].value; },
    useEffect(fn, deps) { const i = cursor++, old = cells[i]; if (!old || !same(old.deps, deps)) {
      cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { cells[i].cleanup?.(); cells[i].cleanup = fn(); });
    } },
  };
  const previewTransport = (request, options) => new Promise((resolve, reject) => calls.push({ request, ...options, resolve, reject }));
  const api = { requestCustomCohortObservationPreview: previewTransport,
    requestCustomCohortOperation: (...args) => { catalogCalls.push(args); return Promise.resolve(catalogResponse()); } };
  const stubs = Object.fromEntries(['CustomCohortParcelMap', 'CustomCohortStatistics', 'CustomCohortPocketInspector'].map(key => [key, function Stub() {}]));
  const file = fileURLToPath(new URL(`../src/features/neighborhood/components/${name}.tsx`, import.meta.url));
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, module = { exports: {} };
  new Script(`(function(require,module,exports,setTimeout,clearTimeout){${compiled}\n})`, { filename: file }).runInThisContext()(key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return requireRuntime(key);
    if (key === '../customCohortPreviewApi') return api;
    if (key === '../customCohortPocketCatalog') return catalogHelpers;
    if (key === '../customCohortPreviewController') return { ...controller,
      createCustomCohortPreviewController: options => controller.createCustomCohortPreviewController({ ...options, fingerprint: async value => hash(value) }) };
    const stub = stubs[key.slice(2)]; assert.ok(stub, `Unexpected component import ${key}`); return { default: stub, __esModule: true };
  }, module, module.exports, (fn, delay) => { timers.set(++serial, { fn, delay }); return serial; }, id => timers.delete(id));
  function render(next = props) {
    props = next; cursor = 0; dirty = false;
    const owner = module.exports.default(props); tree = owner.type(owner.props);
    effects.splice(0).forEach(fn => fn());
  }
  function flush() { let n = 0; while (dirty) { assert.ok(++n < 20, 'No render loop'); render(); } }
  return { calls, catalogCalls, intents, previewTransport,
    props(ids = [groupId(1)], revision = 7) { return { ...input, enabled: true, subjectLabel: 'Synthetic subject', sessionKey: 'session-1',
      workspace: { catalog, selection: { revision, included_recorded_group_ids: ids }, saving: false,
        previewTransport, onSelectionIntent: value => intents.push(value) } }; },
    render(value) { render(value); flush(); }, get propsNow() { return props; }, get tree() { return tree; },
    nodes: () => walk(tree), text: () => text(tree),
    child(key) { return walk(tree).find(node => node.type === stubs[key])?.props; },
    click(label) { const node = walk(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(node, label); node.props.onClick(); flush(); },
    check(label) { const node = walk(tree).find(node => node.type === 'input' && node.props['aria-label'] === label); assert.ok(node, label); node.props.onChange(); flush(); },
    async drain() { for (let i = 0; i < 16; i++) await Promise.resolve(); flush(); },
    async tick() { const list = [...timers.entries()].filter(([, t]) => t.delay === 250); list.forEach(([id, t]) => { timers.delete(id); t.fn(); }); await this.drain(); },
    async complete(index = calls.length - 1) { calls[index].resolve(response(calls[index].request)); await this.drain(); },
    async fail(index = calls.length - 1) { calls[index].reject(new Error('synthetic failure')); await this.drain(); },
    unmount() { cells.forEach(cell => cell?.cleanup?.()); },
  };
}

test('controlled restored empty selection stays empty and makes no catalog read', async () => {
  const h = harness(); h.render(h.props([])); await h.tick();
  assert.equal(h.catalogCalls.length, 0); assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].request.selection, { revision: 7, pockets: [] }); await h.complete();
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
  assert.ok(h.nodes().filter(n => n.props?.type === 'checkbox').every(n => n.props.checked === false)); h.unmount();
});
test('selection controls emit only intent; changed owner IDs and revision drive the next preview', async () => {
  const h = harness(); h.render(h.props()); await h.tick(); await h.complete();
  h.check('Include Beta'); assert.deepEqual(h.intents, [[groupId(1), groupId(2)]]);
  assert.equal(h.calls.length, 1); assert.equal(h.nodes().find(n => n.props['aria-label'] === 'Include Beta').props.checked, false);
  h.render(h.props([groupId(2)], 8)); assert.equal(h.child('CustomCohortStatistics').freshness, 'stale'); await h.tick();
  assert.deepEqual(h.calls[1].request.selection.pockets[0].account_ids, ['B']); await h.complete();
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); h.unmount();
});
test('saving retains the exact old map/statistics group as stale and disables all selection mutation', async () => {
  const h = harness(); h.render(h.props()); await h.tick(); await h.complete();
  const before = h.child('CustomCohortStatistics').group, next = h.props([groupId(2)], 8); next.workspace.saving = true;
  h.render(next); await h.tick(); assert.equal(h.calls.length, 1);
  assert.equal(h.child('CustomCohortStatistics').group, before); assert.equal(h.child('CustomCohortParcelMap').group, before);
  assert.equal(h.child('CustomCohortStatistics').freshness, 'stale'); assert.equal(h.child('CustomCohortParcelMap').freshness, 'stale');
  assert.match(h.text(), /Saving the group selection/); assert.doesNotMatch(h.text(), /match the current preview selection/);
  assert.ok(h.nodes().filter(n => n.props?.type === 'checkbox').every(n => n.props.disabled));
  h.click('Include all observations'); h.click('Exclude all'); h.check('Include Alpha'); assert.equal(h.intents.length, 0);
  h.render({ ...next, workspace: { ...next.workspace, saving: false } }); await h.tick(); assert.equal(h.calls.length, 2);
  await h.complete(); assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); h.unmount();
});
test('an in-flight old preview completing during a save is never labelled current', async () => {
  const h = harness(); h.render(h.props()); await h.tick(); const next = h.props([groupId(2)], 8); next.workspace.saving = true;
  h.render(next); await h.complete(); assert.equal(h.child('CustomCohortStatistics').freshness, 'stale'); h.unmount();
});

const blockedMessages = {
  reload_required: 'Saved choices need to be reloaded before continuing. Any displayed map and statistics still match the preceding selection.',
  pending_capture: 'Resume the saved capture before changing groups. Any displayed map and statistics still match the preceding selection.',
  read_only: 'Neighborhood selection is read-only. Any displayed map and statistics reflect the saved selection.',
};
for (const [reason, message] of Object.entries(blockedMessages)) {
  test(`${reason} retains one stale map/statistics group without claiming an active save`, async t => {
    const h = harness(); t.after(() => h.unmount()); h.render(h.props()); await h.tick(); await h.complete();
    const before = h.child('CustomCohortStatistics').group, next = h.props(); next.workspace.blockedReason = reason;
    h.render(next); await h.tick();
    assert.equal(h.child('CustomCohortStatistics').group, before); assert.equal(h.child('CustomCohortParcelMap').group, before);
    assert.equal(h.child('CustomCohortStatistics').freshness, 'stale'); assert.equal(h.child('CustomCohortParcelMap').freshness, 'stale');
    assert.ok(h.text().includes(message));
    assert.doesNotMatch(h.text(), /Saving the group selection|Updating the map and statistics|match the current preview selection/);
    assert.ok(h.nodes().filter(n => n.props?.type === 'checkbox').every(n => n.props.disabled));
    h.click('Include all observations'); h.click('Exclude all'); h.check('Include Alpha');
    assert.equal(h.intents.length, 0); assert.equal(h.calls.length, 1);
    // Only the owner removes the block. The exact newly acknowledged [] must survive.
    h.render(h.props([], 8)); await h.tick(); assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1].request.selection, { revision: 8, pockets: [] }); await h.complete();
    assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
    assert.ok(h.nodes().filter(n => n.props?.type === 'checkbox').every(n => !n.props.checked && !n.props.disabled));
  });

  test(`${reason} blocks changed-selection scheduling, retry and late response current labels`, async t => {
    const h = harness(); t.after(() => h.unmount()); h.render(h.props()); await h.tick(); await h.complete();
    h.render(h.props([groupId(2)], 8)); await h.tick(); assert.equal(h.calls.length, 2);
    const next = h.props([groupId(1)], 9); next.workspace.blockedReason = reason;
    h.render(next); await h.tick(); assert.equal(h.calls.length, 2);
    await h.complete(1); assert.equal(h.child('CustomCohortStatistics').freshness, 'stale');
    assert.equal(h.child('CustomCohortStatistics').group, h.child('CustomCohortParcelMap').group);
    assert.ok(h.text().includes(message)); assert.doesNotMatch(h.text(), /Saving the group selection|match the current preview selection/);
    h.render(h.props([groupId(1)], 9)); await h.tick(); assert.equal(h.calls.length, 3); await h.fail(2);
    h.render(next); await h.tick();
    const retry = h.nodes().find(n => n.type === 'button' && text(n) === 'Retry preview'); assert.ok(retry); assert.equal(retry.props.disabled, true);
    h.click('Retry preview'); await h.tick(); assert.equal(h.calls.length, 3); assert.equal(h.intents.length, 0);
    assert.ok(h.text().includes(message));
  });
}
test('equivalent new catalog/selection/transport wrapper objects do not reset saved exclusions or request again', async () => {
  const h = harness(); h.render(h.props([groupId(2)])); await h.tick(); await h.complete();
  const next = h.props([groupId(2)]); next.workspace.catalog = structuredClone(catalog);
  next.workspace.previewTransport = (...args) => h.previewTransport(...args); h.render(next); await h.tick();
  assert.equal(h.catalogCalls.length, 0); assert.equal(h.calls.length, 1); assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); h.unmount();
});
test('same-revision owner membership change is stale until its exact response arrives', async () => {
  const h = harness(); h.render(h.props()); await h.tick(); await h.complete(); h.render(h.props([groupId(2)]));
  assert.equal(h.child('CustomCohortStatistics').freshness, 'stale'); await h.tick(); await h.complete();
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); h.unmount();
});
test('unknown restored IDs and foreign-context catalog fail visibly with no all-groups substitution', async () => {
  for (const variant of ['unknown', 'context']) {
    const h = harness(), p = h.props(); if (variant === 'unknown') p.workspace.selection.included_recorded_group_ids = [groupId(99)];
    else p.workspace.catalog = { ...catalog, binding: { ...catalog.binding, context_ref: { ...ref, context_sha256: 'f'.repeat(64) } } };
    h.render(p); await h.tick(); assert.equal(h.calls.length, 0); assert.equal(h.catalogCalls.length, 0);
    assert.match(h.text(), /no replacement selection has been inferred/); assert.equal(h.child('CustomCohortStatistics').group, null);
    h.click('Include all observations'); assert.equal(h.intents.length, 0); h.unmount();
  }
});
test('preview retry is read-only and preserves the exact saved selection revision', async () => {
  const h = harness(); h.render(h.props([groupId(2)], 19)); await h.tick(); await h.fail(); h.click('Retry preview'); await h.tick();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].request.selection, h.calls[0].request.selection);
  assert.equal(h.calls[1].request.selection.revision, 19); assert.equal(h.intents.length, 0); assert.equal(h.catalogCalls.length, 0);
  await h.complete(); assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); h.unmount();
});
test('independent inspection receives the shared transport and never selects its group', async () => {
  const h = harness(); h.render(h.props([groupId(1)])); await h.tick(); await h.complete(); h.click('Beta1 accounts · Dallas');
  const inspect = h.child('CustomCohortPocketInspector'); assert.equal(inspect.previewTransport, h.previewTransport);
  assert.equal(inspect.pocketId, groupId(2)); assert.equal(h.intents.length, 0); assert.equal(h.calls.length, 1); h.unmount();
});
test('standalone mode retains broad catalog loading and all-observations initialization', async () => {
  const h = harness(), p = h.props(); delete p.workspace; h.render(p); await h.drain(); await h.tick();
  assert.equal(h.catalogCalls.length, 1); assert.deepEqual(h.calls[0].request.selection.pockets[0].account_ids, ['A', 'B', 'C']);
  h.click('Exclude all'); await h.tick(); assert.deepEqual(h.calls[1].request.selection.pockets, []); assert.equal(h.intents.length, 0); h.unmount();
});
test('inspector uses its injected transport once, retains independent selection and aborts on cleanup', async () => {
  const h = harness('CustomCohortPocketInspector'); h.render({ input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport });
  for (let i = 0; i < 5 && !h.calls.length; i++) { await new Promise(resolve => setImmediate(resolve)); await h.drain(); }
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.include_map, false);
  assert.deepEqual(h.calls[0].request.selection.pockets[0].account_ids, ['B']); await h.complete();
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); h.render({ ...h.propsNow, label: 'Beta label' }); await h.drain();
  assert.equal(h.calls.length, 1); h.unmount(); assert.equal(h.calls[0].signal.aborted, true);
});
