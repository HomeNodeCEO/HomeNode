import assert from 'node:assert/strict';
import test from 'node:test';
import * as previewTransportHelpers from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as controller from '../src/features/neighborhood/customCohortPreviewController.ts';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as cadEvidenceHelpers from '../src/features/neighborhood/customCohortCadEvidence.ts';
import * as subdivisionFamilies from '../src/features/neighborhood/customCohortSubdivisionFamilies.ts';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url));
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
function denseCatalog() {
  const r = catalogResponse(), c = r.catalog; c.catalog_version = 2;
  c.pockets = Array.from({ length: 887 }, (_, i) => ({ id: groupId(i + 1), label: `Dense group ${i}`, county: 'Dallas',
    account_ids: [i === 0 ? 'A' : `Account${i}`], member_count: 1, disposition: 'needs_review' }));
  c.unassigned = { account_ids: [], member_count: 0, reason_counts: [] };
  c.coverage = { discovery_member_count: 887, assigned_account_count: 887, unassigned_account_count: 0 };
  return catalogHelpers.checkCustomCohortPocketCatalog(r, input);
}
function withRecommendation(props, { suggested = [groupId(2)], status = 'recommendation_for_review' } = {}) {
  const rows = [groupId(2), groupId(1), catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP].map((id, index) => ({
    id, member_count: 1, review_rank: index + 1, contains_subject: id === groupId(1), subject_group_review: id === groupId(1),
    suggested_for_review: suggested.includes(id), meets_review_policy: suggested.includes(id),
    similarity: { lower: index ? 20 : 73.3333, upper: index ? 46.6667 : 100, known_weight_percent: 73.3333 },
  }));
  return { ...props, workspace: { ...props.workspace, catalog: { ...props.workspace.catalog, recommendation: {
    status, policy: { id: 'custom-current-observation-review-v1', revision: 1, minimum_mean_lower_bound: 55, minimum_mean_known_weight_percent: 70 },
    subject: { in_discovery: true, recorded_group_review_ids: [groupId(1)] }, pockets: rows,
    all: { member_count: 3, similarity: { lower: 37.7778, upper: 64.4444, known_weight_percent: 73.3333 } },
    recommended_recorded_group_ids: suggested, limitations: [],
  } } } };
}
function response(request) {
  return { status: 'preview', target: { account_id: request.accountId, assignment_file_id: request.assignmentFileId },
    context_ref: request.contextRef, selection_revision: request.selection.revision, subject_freshness: 'matched',
    summary: { presentation_version: 1, preview_version: 1, status: 'observations_only', members_included: false,
      contents: 'population_summaries_only', binding: { context_ref: request.contextRef, selection_revision: request.selection.revision,
        selection_sha256: selectionHash(request.selection) }, all: {}, selected: {},
      pockets: request.selection.pockets.map(p => ({ id: p.id, label: p.label, result: { account_count: p.account_ids.length } })),
      apply: { status: 'blocked', reasons: ['observation_preview_only'] } },
    parcel_map: request.include_map ? { status: 'unavailable', reason: 'missing_parcel_geometry', geojson: null,
      geometry_semantics: 'current_observed_cached_parcels_not_legal_subdivision_boundary' }
      : { status: 'omitted', reason: 'geometry_not_requested' }, apply: { status: 'blocked', reasons: ['observation_preview_only'] } };
}
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const children = node => (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).flat(Infinity);
const walk = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(walk)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node && typeof node === 'object' ? children(node).map(text).join('') : '';
function harness(name = 'CustomCohortWorkspace', { onSerialize } = {}) {
  const cells = [], effects = [], calls = [], catalogCalls = [], intents = [], timers = new Map();
  const requestWaiters = new Map(), fingerprints = new Set();
  let cursor = 0, dirty = false, tree, props, serial = 0, now = 0, fingerprintCount = 0, ownerKey;
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
  const previewTransport = (request, options) => new Promise((resolve, reject) => {
    const call = { request, ...options, resolve, reject }, index = calls.length;
    calls.push(call); requestWaiters.get(index)?.forEach(notify => notify(call)); requestWaiters.delete(index);
  });
  const api = { requestCustomCohortObservationPreview: previewTransport,
    requestCustomCohortOperation: (...args) => { catalogCalls.push(args); return Promise.resolve(catalogResponse()); } };
  const stubs = Object.fromEntries(['CustomCohortParcelMap', 'CustomCohortStatistics', 'CustomCohortCompactStatistics',
    'CustomCohortPocketInspector', 'CustomCohortMemberBrowser', 'CustomCohortSubdivisionDialog', 'CustomCohortMapSnapshot'].map(key => [key, function Stub() {}]));
  const component = loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/components/${name}.tsx`, import.meta.url), key => {
    if (key === 'react') return react;
    if (key === 'react/jsx-runtime') return requireRuntime(key);
    if (key === '../customCohortPreviewApi') return api;
    if (key === '../customCohortPreviewTransport') return previewTransportHelpers;
    if (key === '../customCohortPocketCatalog') return catalogHelpers;
    if (key === '../customCohortCadEvidence') return cadEvidenceHelpers;
    if (key === '../customCohortSubdivisionFamilies') return subdivisionFamilies;
    if (key === '../customCohortPreviewController') return { ...controller,
      fingerprintCustomCohortSelection: value => {
        fingerprintCount++;
        const task = controller.fingerprintCustomCohortSelection(value); fingerprints.add(task);
        void task.then(() => fingerprints.delete(task), () => fingerprints.delete(task)); return task;
      },
      createCustomCohortPreviewController: options => controller.createCustomCohortPreviewController({ ...options, fingerprint: async value => hash(value) }) };
    if (key === './CustomCohortStatistics') return { default: stubs.CustomCohortStatistics,
      CustomCohortCompactStatistics: stubs.CustomCohortCompactStatistics, __esModule: true };
    const stub = stubs[key.slice(2)]; assert.ok(stub, `Unexpected component import ${key}`); return { default: stub, __esModule: true };
  }, { environment: {
    setTimeout: (fn, delay) => { timers.set(++serial, { fn, delay, at: now + delay }); return serial; },
    clearTimeout: id => timers.delete(id),
    JSON: { parse: JSON.parse, stringify: (...args) => { onSerialize?.(args[0]); return JSON.stringify(...args); } },
  } });
  function render(next = props) {
    props = next; cursor = 0; dirty = false;
    const owner = component.default(props);
    if (name === 'CustomCohortPocketInspector' && ownerKey !== owner.key) {
      // A keyed child remount does not discard the outer component's memo hooks.
      cells.slice(cursor).forEach(cell => cell?.cleanup?.()); cells.length = cursor; effects.length = 0; ownerKey = owner.key;
    }
    tree = owner.type(owner.props);
    effects.splice(0).forEach(fn => fn());
  }
  function flush() { let n = 0; while (dirty) { assert.ok(++n < 20, 'No render loop'); render(); } }
  return { calls, catalogCalls, intents, previewTransport, api,
    get fingerprintCount() { return fingerprintCount; }, get sessionKey() { return ownerKey; },
    pendingTimers: () => [...timers.values()],
    props(ids = [groupId(1)], revision = 7) { return { ...input, enabled: true, subjectLabel: 'Synthetic subject', sessionKey: 'session-1',
      workspace: { catalog, selection: { revision, included_recorded_group_ids: ids }, saving: false,
        previewTransport, onSelectionIntent: value => intents.push(value) } }; },
    render(value) { render(value); flush(); }, get propsNow() { return props; }, get tree() { return tree; },
    nodes: () => walk(tree), text: () => text(tree),
    child(key) { if (key === 'CustomCohortMapSnapshot') return walk(tree).find(node => node.type === stubs.CustomCohortParcelMap)?.props.overlay?.props;
      return walk(tree).find(node => node.type === stubs[key])?.props; },
    click(label) { const node = walk(tree).find(node => node.type === 'button' && text(node) === label); assert.ok(node, label); node.props.onClick(); flush(); },
    check(label) { const node = walk(tree).find(node => node.type === 'input' && node.props['aria-label'] === label); assert.ok(node, label); node.props.onChange(); flush(); },
    async drain() { for (let i = 0; i < 16; i++) await Promise.resolve(); flush(); },
    // WebCrypto uses asynchronous runtime work, not a fixed number of event-loop
    // turns. Positive assertions wait for the actual injected transport call.
    async waitForRequest(index) {
      if (!calls[index]) await new Promise(resolve => {
        const waiters = requestWaiters.get(index) ?? []; waiters.push(resolve); requestWaiters.set(index, waiters);
      });
      await this.drain(); return calls[index];
    },
    // Negative request assertions first await any real digest already started,
    // so they cannot pass merely because a busy CI worker has not finished it.
    async settleFingerprints() { await Promise.allSettled([...fingerprints]); await this.drain(); },
    async tick() { const list = [...timers.entries()].filter(([, t]) => t.delay === 250); list.forEach(([id, t]) => { timers.delete(id); t.fn(); }); await this.drain(); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at; timers.delete(id); timer.fn(); await this.drain();
      }
      now = until; await this.drain();
    },
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

test('unassigned CAD evidence is distinguished from a grouping capacity failure', () => {
  const review = harness(); review.render(review.props());
  assert.match(review.text(), /CAD subdivision not confirmed/);
  assert.doesNotMatch(review.text(), /Subdivision grouping reached a capacity limit/);
  review.unmount();

  const response = catalogResponse(), c = response.catalog;
  c.status = 'incomplete'; c.pockets = [];
  c.unassigned = { account_ids: ['A', 'B', 'C'], member_count: 3,
    reason_counts: [{ reason: 'pocket_count_limit', member_count: 3 }] };
  c.coverage = { discovery_member_count: 3, assigned_account_count: 0, unassigned_account_count: 3 };
  c.subject_membership = { account_id: 'A', assigned_pocket_id: null, status: 'catalog_incomplete', recorded_label_match_only: true };
  const incomplete = catalogHelpers.checkCustomCohortPocketCatalog(response, input);
  const capacity = harness(), props = capacity.props([]); props.workspace.catalog = incomplete;
  capacity.render(props);
  assert.match(capacity.text(), /Grouping unavailable — capture limit/);
  assert.match(capacity.text(), /Subdivision grouping reached a capacity limit: Too many distinct recorded names/);
  assert.doesNotMatch(capacity.text(), /CAD subdivision not confirmed/);
  capacity.unmount();
});

test('dense list pages50 groups while map selection and Include all retain887; map inspection can open an off-page group', async () => {
  const h = harness(), dense = denseCatalog(), all = catalogHelpers.customCohortCatalogGroupIds(dense);
  const props = h.props(all); props.workspace.catalog = dense;
  h.render(props); await h.tick(); await h.waitForRequest(0);
  assert.equal(h.calls[0].request.selection.pockets[0].account_ids.length, 887);
  const checkboxes = () => h.nodes().filter(n => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(checkboxes().length, 50); assert.match(h.text(), /Page 1 of 18/);
  h.click('Next groups'); assert.equal(checkboxes().length, 50); assert.match(h.text(), /Page 2 of 18/);
  h.click('Include all observations'); assert.deepEqual(h.intents.at(-1), all);
  await h.complete();
  h.child('CustomCohortParcelMap').onInspectPocket(groupId(887)); h.render(props);
  assert.equal(h.child('CustomCohortPocketInspector').pocketId, groupId(887));
  const search = h.nodes().find(n => n.type === 'input' && n.props.maxLength === 200);
  search.props.onChange({ target: { value: 'Dense group 886' } }); h.render(props);
  assert.equal(checkboxes().length, 1); assert.equal(checkboxes()[0].props['aria-label'], 'Include Dense group 886');
  assert.equal(h.calls.length, 1, 'paging/search/inspection does not refetch main statistics');
  h.check('Include Dense group 886'); assert.equal(h.intents.at(-1).length, 886);
  assert.ok(!h.intents.at(-1).includes(groupId(887))); h.unmount();
});

test('county-name review finds off-page variants; explicit union and exclusion retain every unrelated saved choice', async () => {
  const h = harness(), dense = denseCatalog();
  const aliased = { ...dense, pockets: dense.pockets.map((p, i) => i === 886
    ? { ...p, label: dense.pockets[0].label, county: 'DALLAS COUNTY' } : p) };
  const props = h.props([groupId(1), groupId(2)]); props.workspace.catalog = aliased;
  h.render(props); await h.tick(); await h.waitForRequest(0); await h.complete();
  assert.equal(h.intents.length, 0, 'opening never merges saved groups');
  assert.deepEqual(h.calls[0].request.selection.pockets[0].account_ids, ['A', 'Account1']);
  h.child('CustomCohortParcelMap').onInspectPocket(groupId(1)); h.render(props);
  assert.match(h.text(), /Dallas \/ DALLAS COUNTY/);
  assert.match(h.text(), /2 groups · 2 accounts/);
  assert.equal(h.intents.length, 0, 'inspection never changes inclusion');
  h.click('Include matching groups');
  assert.deepEqual(h.intents.at(-1), [groupId(1), groupId(2), groupId(887)]);
  assert.equal(h.calls.length, 1, 'wait for the owner save before requesting a new union');
  h.render({ ...props, workspace: { ...props.workspace, selection: { revision: 8,
    included_recorded_group_ids: h.intents.at(-1) } } });
  h.click('Exclude matching groups'); assert.deepEqual(h.intents.at(-1), [groupId(2)]);
  h.click('Preview subject’s matching county-name groups');
  assert.deepEqual(h.intents.at(-1), [groupId(1), groupId(887)]);
  assert.equal(h.catalogCalls.length, 0); h.unmount();
});

for (const blockedReason of ['read_only', 'pending_capture', 'reload_required']) {
  test(`county-name controls preserve ${blockedReason} ownership barriers`, async () => {
    const h = harness(), props = h.props();
    props.workspace.catalog = { ...catalog, pockets: catalog.pockets.map((p, i) => i
      ? { ...p, label: catalog.pockets[0].label, county: 'DALLAS COUNTY' } : p) };
    props.workspace.blockedReason = blockedReason;
    h.render(props); h.click('Preview subject’s matching county-name groups');
    assert.equal(h.intents.length, 0); await h.tick(); assert.equal(h.calls.length, 0); h.unmount();
  });
}

test('capacity refusal preserves stale map and stats, and narrowing stays an explicit save-gated intent', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(h.props([groupId(1)], 7)); await h.tick(); await h.complete();
  const old = h.child('CustomCohortStatistics').group;
  h.render(h.props([groupId(1), groupId(2)], 8)); await h.tick();
  h.calls[1].reject(Object.assign(new Error('SECRET'), { status: 422, workspaceCode: 'preview_capacity_exceeded' })); await h.drain();
  assert.match(h.text(), /selection exceeds the preview capacity/); assert.match(h.text(), /No groups were automatically removed/);
  assert.doesNotMatch(h.text(), /SECRET|Map and statistics match the current preview selection/);
  assert.equal(h.child('CustomCohortStatistics').group, old); assert.equal(h.child('CustomCohortParcelMap').group, old);
  assert.equal(h.child('CustomCohortStatistics').freshness, 'stale'); assert.equal(h.child('CustomCohortParcelMap').freshness, 'stale');
  assert.ok(h.nodes().filter(n => n.props?.type === 'checkbox').every(n => n.props.disabled === false));
  h.render(h.props([groupId(1), groupId(2)], 8)); await h.tick(); assert.equal(h.calls.length, 2); assert.equal(h.intents.length, 0);
  h.click('Exclude all'); assert.deepEqual(h.intents, [[]]); assert.equal(h.calls.length, 2);
  const saving = h.props([groupId(1), groupId(2)], 8); saving.workspace.saving = true; h.render(saving);
  h.click('Preview subject’s recorded group'); await h.tick(); assert.deepEqual(h.intents, [[]]); assert.equal(h.calls.length, 2);
  assert.equal(h.child('CustomCohortStatistics').group, old);
  h.render(h.props([], 9)); await h.tick(); assert.deepEqual(h.calls[2].request.selection, { revision: 9, pockets: [] });
  assert.equal(h.child('CustomCohortStatistics').freshness, 'stale'); await h.complete(2);
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
  assert.equal(h.child('CustomCohortStatistics').group.binding.selectionRevision, 9);
  assert.equal(h.child('CustomCohortParcelMap').group, h.child('CustomCohortStatistics').group);
  h.click('Preview subject’s recorded group'); assert.deepEqual(h.intents, [[], [groupId(1)]]);
});

test('capacity retry does not silently narrow or increment the saved revision', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(h.props([groupId(1), groupId(2)], 17)); await h.tick();
  h.calls[0].reject(Object.assign(new Error('SECRET'), { status: 422, errorCode: 'neighborhood_preview_capacity_exceeded' })); await h.drain();
  assert.equal(h.child('CustomCohortParcelMap'), undefined); assert.equal(h.child('CustomCohortStatistics').group, null);
  h.click('Retry preview'); await h.tick();
  assert.deepEqual(h.calls[1].request.selection, h.calls[0].request.selection);
  assert.equal(h.intents.length, 0); assert.equal(h.catalogCalls.length, 0);
});

test('independent capacity refusal does not substitute a summary, load members or change inclusion', { timeout: 10000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const props = { input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport };
  h.render(props); await h.tick(); await h.waitForRequest(0);
  h.calls[0].reject(Object.assign(new Error('SECRET'), { status: 422, workspaceCode: 'preview_capacity_exceeded' })); await h.drain();
  assert.match(h.text(), /group exceeds the preview capacity/); assert.match(h.text(), /does not undo saved inclusion choices/);
  assert.doesNotMatch(h.text(), /SECRET/); assert.equal(h.child('CustomCohortStatistics'), undefined);
  assert.equal(h.child('CustomCohortMemberBrowser'), undefined); assert.equal(h.intents.length, 0);
  h.render({ ...props }); await h.settleFingerprints(); assert.equal(h.calls.length, 1);
  h.render({ ...props, paused: true }); h.click('Retry inspection'); await h.settleFingerprints(); assert.equal(h.calls.length, 1);
  h.render(props); h.click('Retry inspection'); await h.tick(); await h.waitForRequest(1);
  assert.deepEqual(h.calls[1].request, h.calls[0].request); await h.complete(1); assert.ok(h.child('CustomCohortStatistics'));
});

test('standalone catalog capacity is explicit and cannot invent all/empty groups or auto-retry', async t => {
  const h = harness(); t.after(() => h.unmount()); let calls = 0;
  h.api.requestCustomCohortOperation = async () => { calls++; throw Object.assign(new Error('SECRET'), {
    status: 422, errorCode: 'neighborhood_preview_capacity_exceeded' }); };
  const props = h.props(); delete props.workspace; h.render(props); await h.drain(); await h.tick();
  assert.equal(calls, 1); assert.equal(h.calls.length, 0); assert.equal(h.intents.length, 0);
  assert.match(h.text(), /even before groups are selected/); assert.doesNotMatch(h.text(), /SECRET/);
  assert.ok(!h.nodes().some(node => node.props?.type === 'checkbox'));
  h.render({ ...props }); await h.drain(); assert.equal(calls, 1);
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
  const h = harness(), props = h.props([groupId(1)]), memberTransport = () => assert.fail('Member reads must be explicit');
  props.workspace.memberTransport = memberTransport;
  h.render(props); await h.tick(); await h.complete(); h.click('Beta1 accounts · Dallas');
  const inspect = h.child('CustomCohortPocketInspector'); assert.equal(inspect.previewTransport, h.previewTransport);
  assert.equal(inspect.memberTransport, memberTransport); assert.equal(inspect.membersPaused, false);
  assert.equal(inspect.pocketId, groupId(2)); assert.equal(h.intents.length, 0); assert.equal(h.calls.length, 1);
  h.render({ ...props, workspace: { ...props.workspace, saving: true } });
  assert.equal(h.child('CustomCohortPocketInspector').membersPaused, true);
  assert.equal(h.child('CustomCohortPocketInspector').memberTransport, memberTransport); h.unmount();
});
test('standalone mode retains broad catalog loading and all-observations initialization', async () => {
  const h = harness(), p = h.props(); delete p.workspace; h.render(p); await h.drain(); await h.tick();
  assert.equal(h.catalogCalls.length, 1); assert.deepEqual(h.calls[0].request.selection.pockets[0].account_ids, ['A', 'B', 'C']);
  assert.equal(h.catalogCalls[0][2].include_recommendation, true);
  h.click('Exclude all'); await h.tick(); assert.deepEqual(h.calls[1].request.selection.pockets, []); assert.equal(h.intents.length, 0); h.unmount();
});

test('recommendation display preserves restored [] and does not auto-select or create extra preview requests', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(withRecommendation(h.props([]))); await h.tick(); await h.complete();
  assert.equal(h.intents.length, 0); assert.equal(h.calls.length, 1); assert.equal(h.catalogCalls.length, 0);
  assert.deepEqual(h.calls[0].request.selection.pockets, []);
  assert.match(h.text(), /Recommended area for review/); assert.match(h.text(), /37.8–64.4 \/ 100/);
  assert.match(h.text(), /73.3%/); assert.match(h.text(), /not confidence or reliability/);
  assert.match(h.text(), /subject’s recorded group is flagged separately/i);
  assert.ok(h.nodes().filter(n => n.props?.type === 'checkbox').every(n => n.props.checked === false));
});

test('Use suggested selection emits one exact intent and updates map/statistics only after owner save and matching preview', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(withRecommendation(h.props([]))); await h.tick(); await h.complete();
  const old = h.child('CustomCohortStatistics').group;
  h.click('Use recommended area'); assert.deepEqual(h.intents, [[groupId(2)]]);
  assert.equal(h.calls.length, 1); assert.equal(h.child('CustomCohortStatistics').group, old);
  const pending = withRecommendation(h.props([])); pending.workspace.saving = true; h.render(pending); await h.tick();
  assert.equal(h.calls.length, 1); assert.equal(h.child('CustomCohortStatistics').freshness, 'stale');
  assert.equal(h.child('CustomCohortParcelMap').group, old);
  h.render(withRecommendation(h.props([groupId(2)], 8))); await h.tick();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].request.selection.pockets[0].account_ids, ['B']);
  assert.equal(h.child('CustomCohortStatistics').group, old); await h.complete();
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
  assert.equal(h.child('CustomCohortParcelMap').group, h.child('CustomCohortStatistics').group);
  assert.equal(h.child('CustomCohortStatistics').group.binding.selectionRevision, 8);
  assert.equal(h.intents.length, 1); assert.equal(h.catalogCalls.length, 0);
});

for (const state of ['saving', 'read_only', 'reload_required', 'pending_capture']) test(`${state} blocks Use suggested selection without mutating existing choices`, async t => {
  const h = harness(); t.after(() => h.unmount()); const p = withRecommendation(h.props([]));
  if (state === 'saving') p.workspace.saving = true; else p.workspace.blockedReason = state;
  h.render(p); const use = h.nodes().find(n => n.type === 'button' && text(n) === 'Use recommended area');
  assert.ok(use.props.disabled); h.click('Use recommended area'); await h.tick();
  assert.equal(h.intents.length, 0); assert.equal(h.calls.length, 0);
});

test('empty/insufficient suggestion cannot implicitly clear a saved selection; manual Exclude all remains explicit', async t => {
  const h = harness(); t.after(() => h.unmount());
  for (const value of [{ suggested: [] }, { status: 'insufficient_observations' }]) {
    h.render(withRecommendation(h.props([groupId(1)]), value));
    assert.equal(h.nodes().find(n => n.type === 'button' && text(n) === 'Use recommended area').props.disabled, true);
    h.click('Use recommended area'); assert.equal(h.intents.length, 0);
  }
  h.click('Exclude all'); assert.deepEqual(h.intents, [[]]);
});

test('an already active suggestion does not increment selection revision or write again', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(withRecommendation(h.props([groupId(2)], 19))); await h.tick(); await h.complete();
  assert.match(h.text(), /suggested selection is already active/);
  assert.equal(h.nodes().find(n => n.type === 'button' && text(n) === 'Use recommended area').props.disabled, true);
  h.click('Use recommended area'); assert.equal(h.intents.length, 0); assert.equal(h.calls.length, 1);
});

test('recommended group inspection remains independent and fresh equivalent recommendation objects do not cause request loops', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(withRecommendation(h.props([]))); await h.tick(); await h.complete();
  const beta = h.nodes().find(n => n.type === 'button' && text(n).startsWith('Beta1 accounts'));
  assert.ok(beta); beta.props.onClick(); await h.drain();
  assert.equal(h.child('CustomCohortPocketInspector').pocketId, groupId(2)); assert.equal(h.intents.length, 0);
  h.render(withRecommendation(h.props([]))); await h.tick();
  assert.equal(h.calls.length, 1); assert.equal(h.catalogCalls.length, 0); assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
});
test('inspector uses its injected transport once, retains independent selection and aborts on cleanup', { timeout: 10_000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); h.render({ input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport });
  t.after(() => h.unmount()); await h.tick(); await h.waitForRequest(0);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.include_map, false);
  assert.deepEqual(h.calls[0].request.selection.pockets[0].account_ids, ['B']); await h.complete();
  const members = h.child('CustomCohortMemberBrowser'); assert.ok(members);
  assert.deepEqual(members.input, h.calls[0].request.include_map === false
    ? { accountId: input.accountId, assignmentFileId: input.assignmentFileId, contextRef: input.contextRef,
      selection: h.calls[0].request.selection } : null);
  assert.equal(members.group, h.child('CustomCohortStatistics').group);
  h.render({ ...h.propsNow, membersPaused: true });
  assert.equal(h.child('CustomCohortMemberBrowser').paused, true);
  assert.equal(h.child('CustomCohortMemberBrowser').group, members.group);
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); h.render({ ...h.propsNow, label: 'Beta label' }); await h.drain();
  assert.equal(h.calls.length, 1); h.unmount(); assert.equal(h.calls[0].signal.aborted, true);
});

test('inspector admits once at250ms, not on render or249ms, without restarting on a label render', { timeout: 10_000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const props = { input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport };
  h.render(props); await h.settleFingerprints();
  assert.equal(h.calls.length, 0); assert.equal(h.fingerprintCount, 0);
  assert.deepEqual(h.pendingTimers().map(timer => timer.at).sort((a, b) => a - b), [250, 65_000]);
  await h.advance(249); h.render({ ...props, label: 'Beta retained label' }); await h.settleFingerprints();
  assert.equal(h.calls.length, 0); assert.equal(h.fingerprintCount, 0);
  await h.advance(1); await h.waitForRequest(0);
  assert.equal(h.fingerprintCount, 1); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.include_map, false);
  assert.deepEqual(h.calls[0].request.selection.pockets[0].account_ids, ['B']);
  await h.complete(); await h.advance(65_000); await h.settleFingerprints();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
  assert.deepEqual(h.intents, []); assert.deepEqual(h.catalogCalls, []);
});

test('brief keyed inspection is cancelled before hashing or lane admission; only the replacement is requested', { timeout: 10_000 }, async t => {
  // Separate harness instances represent React unmounting the old keyed session.
  const first = harness('CustomCohortPocketInspector'), next = harness('CustomCohortPocketInspector');
  t.after(() => { first.unmount(); next.unmount(); });
  first.render({ input, catalog, pocketId: groupId(1), label: 'Alpha', previewTransport: first.previewTransport });
  const staleAdmission = first.pendingTimers().find(timer => timer.delay === 250).fn;
  await first.advance(249); first.unmount();
  assert.deepEqual(first.pendingTimers(), []);
  staleAdmission(); await first.settleFingerprints(); await first.advance(65_000);
  assert.equal(first.fingerprintCount, 0); assert.equal(first.calls.length, 0);
  next.render({ input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: next.previewTransport });
  await next.advance(249); assert.equal(next.calls.length, 0);
  await next.advance(1); await next.waitForRequest(0); await next.complete();
  assert.deepEqual(next.calls[0].request.selection.pockets[0].account_ids, ['B']);
  assert.equal(next.calls.length, 1); assert.equal(first.child('CustomCohortStatistics'), undefined);
});

test('pausing before admission cancels both timers; resume debounces only the unfinished inspection', { timeout: 10_000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const props = { input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport };
  h.render(props); await h.advance(249); h.render({ ...props, paused: true });
  assert.deepEqual(h.pendingTimers(), []); await h.advance(65_000); await h.settleFingerprints();
  assert.equal(h.fingerprintCount, 0); assert.equal(h.calls.length, 0);
  assert.doesNotMatch(h.text(), /could not be inspected/);
  h.render(props); await h.advance(249); assert.equal(h.calls.length, 0);
  await h.advance(1); await h.waitForRequest(0); await h.complete();
  const completed = h.child('CustomCohortStatistics').group;
  h.render({ ...props, paused: true }); h.render(props); await h.advance(65_000); await h.settleFingerprints();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.pendingTimers(), []);
  assert.equal(h.child('CustomCohortStatistics').group, completed);
});

test('admission consumes the original65s deadline; late success cannot publish and explicit retry debounces again', { timeout: 10_000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const props = { input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport };
  h.render(props); await h.advance(250); await h.waitForRequest(0);
  await h.advance(64_749); assert.equal(h.calls[0].signal.aborted, false);
  await h.advance(1); assert.equal(h.calls[0].signal.aborted, true);
  assert.match(h.text(), /could not be inspected/); await h.complete(0);
  assert.equal(h.child('CustomCohortStatistics'), undefined); assert.equal(h.child('CustomCohortMemberBrowser'), undefined);
  h.render(props); await h.advance(250); assert.equal(h.calls.length, 1, 'timeout does not implicitly retry');
  h.click('Retry inspection'); await h.advance(249); assert.equal(h.calls.length, 1);
  await h.advance(1); await h.waitForRequest(1);
  assert.deepEqual(h.calls[1].request, h.calls[0].request); assert.equal(h.calls[1].signal.aborted, false);
  await h.complete(1); assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
  assert.deepEqual(h.intents, []);
});

test('read-only quiescence disables direct group/map inspection callbacks and preserves cached inspector identity', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(h.props()); await h.tick(); await h.complete();
  const paused = h.props(); paused.workspace.blockedReason = 'read_only'; h.render(paused);
  const groupButton = h.nodes().find(n => n.type === 'button' && text(n).startsWith('Beta1 accounts'));
  assert.equal(groupButton.props.disabled, true); groupButton.props.onClick();
  h.child('CustomCohortParcelMap').onInspectPocket(groupId(2));
  h.child('CustomCohortParcelMap').onInspectAccount('C'); await h.drain();
  assert.equal(h.child('CustomCohortPocketInspector'), undefined); assert.equal(h.calls.length, 1);
  h.render(h.props()); h.child('CustomCohortParcelMap').onInspectPocket(groupId(2)); await h.drain();
  assert.equal(h.child('CustomCohortPocketInspector').pocketId, groupId(2));
  h.render(paused); assert.equal(h.child('CustomCohortPocketInspector').paused, true);
  h.render(h.props()); assert.equal(h.child('CustomCohortPocketInspector').paused, false); assert.equal(h.calls.length, 1);
});

test('a paused transport failure can explicitly retry the unchanged saved selection after release without an implicit retry loop', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(h.props([groupId(1)], 19)); await h.tick();
  const paused = h.props([groupId(1)], 19); paused.workspace.blockedReason = 'read_only'; h.render(paused); await h.fail();
  assert.equal(h.nodes().find(n => n.type === 'button' && text(n) === 'Retry preview').props.disabled, true);
  h.render(h.props([groupId(1)], 19)); await h.tick(); assert.equal(h.calls.length, 1, 'same selection does not retry by render');
  h.click('Retry preview'); await h.drain(); await h.tick(); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].request.selection.revision, 19); assert.equal(h.intents.length, 0); await h.complete();
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current'); assert.equal(h.child('CustomCohortParcelMap').freshness, 'current');
});

test('inspector pause prevents new requests; release resumes only unfinished inspection and preserves completed cached observations', { timeout: 10_000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const props = { input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport, paused: true };
  h.render(props); await h.settleFingerprints(); assert.equal(h.calls.length, 0); assert.match(h.text(), /inspection is paused/);
  h.render({ ...props, paused: false }); await h.tick(); await h.waitForRequest(0); assert.equal(h.calls.length, 1);
  h.render(props); assert.equal(h.calls[0].signal.aborted, true); await h.complete(0); assert.equal(h.child('CustomCohortStatistics'), undefined);
  h.render({ ...props, paused: false }); await h.tick(); await h.waitForRequest(1); assert.equal(h.calls.length, 2); await h.complete(1);
  const completed = h.child('CustomCohortStatistics').group;
  h.render(props); assert.equal(h.child('CustomCohortStatistics').group, completed); assert.equal(h.child('CustomCohortStatistics').freshness, 'stale');
  h.render({ ...props, paused: false }); await h.settleFingerprints(); assert.equal(h.calls.length, 2);
  assert.equal(h.child('CustomCohortStatistics').group, completed); assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
});

test('an earlier inspector failure does not implicitly retry on unpause; explicit retry is disabled only while paused', { timeout: 10_000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const props = { input, catalog, pocketId: groupId(2), label: 'Beta', previewTransport: h.previewTransport, paused: false };
  h.render(props); await h.tick(); await h.waitForRequest(0); await h.fail(0); assert.equal(h.calls.length, 1);
  h.render({ ...props, paused: true }); h.click('Retry inspection'); await h.settleFingerprints(); assert.equal(h.calls.length, 1);
  assert.equal(h.nodes().find(n => n.type === 'button' && text(n) === 'Retry inspection').props.disabled, true);
  h.render(props); await h.settleFingerprints(); assert.equal(h.calls.length, 1);
  h.click('Retry inspection'); await h.tick(); await h.waitForRequest(1); assert.equal(h.calls.length, 2); await h.complete(1);
  assert.equal(h.child('CustomCohortStatistics').freshness, 'current');
});

function phasedProps(h, ids = [groupId(1), catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP], revision = 7) {
  const props = h.props(ids, revision);
  props.workspace.catalog = { ...catalog, pockets: catalog.pockets.map((p, i) => ({ ...p, label: `MONICA PARK ${i + 1}` })) };
  return props;
}
function mixedWillowProps(h, ids = [groupId(1), groupId(3), catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP], revision = 7) {
  const props = h.props(ids, revision), r = catalogResponse();
  const rows = [['WILLOW RUN NO 5', 1], ['WILLOW RUN 3', 1], ['WILLOW RUN 5', 145],
    ['WILLOW RUN PH 2', 67], ['WILLOW RUN 4', 26], ['WILLOW RUN PH 1', 65], ['WILLOW RUN PH 3', 3]];
  r.catalog.pockets = rows.map(([label, member_count], index) => ({ id: groupId(index + 1), label,
    county: index % 2 ? 'DALLAS COUNTY' : 'Dallas', member_count, disposition: 'needs_review',
    account_ids: Array.from({ length: member_count }, (_, member) => index === 2 && member === 0 ? 'A' : `Willow-${index}-${member}`) }));
  r.catalog.coverage = { discovery_member_count: 309, assigned_account_count: 308, unassigned_account_count: 1 };
  r.catalog.subject_membership.assigned_pocket_id = groupId(3);
  props.workspace.catalog = catalogHelpers.checkCustomCohortPocketCatalog(r, input);
  return props;
}

test('mixed bare/PH Willow list review opens the complete 307-account family without saving; explicit union retains unrelated leaves', async t => {
  const h = harness(); t.after(() => h.unmount()); const props = mixedWillowProps(h), before = JSON.stringify(props.workspace.catalog);
  h.render(props); await h.tick(); await h.waitForRequest(0); await h.complete();
  const originalGroup = h.child('CustomCohortStatistics').group;
  const card = h.nodes().find(node => node.type === 'button' && text(node).startsWith('WILLOW RUN 5145 accounts'));
  assert.ok(card, 'the literal WILLOW RUN 5 row remains inspectable'); card.props.onClick(); await h.drain();
  assert.equal(h.child('CustomCohortPocketInspector').pocketId, groupId(3));
  h.click('Review subdivision and phases');
  const dialog = h.child('CustomCohortSubdivisionDialog');
  assert.equal(dialog.family.label, 'WILLOW RUN'); assert.equal(dialog.family.basis, 'candidate_numbered_name');
  assert.equal(dialog.family.member_count, 307);
  assert.deepEqual([...dialog.family.pocket_ids].sort(), [2, 3, 4, 5, 6, 7].map(groupId));
  assert.equal(dialog.family.pocket_ids.includes(groupId(1)), false, 'NO 5 remains a separate original leaf');
  assert.deepEqual(h.intents, []); assert.equal(h.calls.length, 1, 'opening family review is not a save or main-preview request');
  dialog.onInspectPhase(groupId(2)); await h.drain();
  assert.deepEqual(h.child('CustomCohortParcelMap').inspectedPocketIds, [groupId(2)]);
  h.child('CustomCohortSubdivisionDialog').onInspectPhase(groupId(7)); await h.drain();
  assert.deepEqual(h.child('CustomCohortParcelMap').inspectedPocketIds, [groupId(7)], 'bare 3 and PH 3 are not one phase');
  assert.deepEqual(h.intents, []);
  h.child('CustomCohortSubdivisionDialog').onInclude(dialog.family.pocket_ids); await h.drain();
  const expected = [1, 2, 3, 4, 5, 6, 7].map(groupId).concat(catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP).sort();
  assert.equal(h.intents.length, 1); assert.deepEqual([...h.intents[0]].sort(), expected);
  assert.deepEqual(h.intents[0].slice(0, 3), props.workspace.selection.included_recorded_group_ids,
    'the unrelated NO 5 leaf and unassigned group retain their original IDs and ordering');
  assert.equal(h.child('CustomCohortStatistics').group, originalGroup, 'saved statistics wait for coherent selection acknowledgment');
  h.render({ ...props, workspace: { ...props.workspace, selection: { revision: 8, included_recorded_group_ids: h.intents[0] } } });
  await h.tick(); await h.waitForRequest(1); await h.complete();
  const allAccounts = [...props.workspace.catalog.pockets.flatMap(pocket => pocket.account_ids), 'C'].sort();
  assert.equal(allAccounts.length, 309); assert.deepEqual(h.calls[1].request.selection.pockets[0].account_ids, allAccounts);
  assert.equal(JSON.stringify(props.workspace.catalog), before, 'review never rewrites original labels, counts, account arrays or leaf IDs');
});

test('closing full review restores list inspection even when no map snapshot is available', async t => {
  const h = harness(); t.after(() => h.unmount()); const props = phasedProps(h);
  h.render(props); await h.tick(); await h.complete();
  const card = h.nodes().find(node => node.type === 'button' && text(node).startsWith('MONICA PARK 1'));
  assert.ok(card); card.props.onClick(); await h.drain();
  h.click('Review subdivision and phases');
  assert.ok(h.child('CustomCohortSubdivisionDialog'));
  h.child('CustomCohortSubdivisionDialog').onClose(); await h.drain();
  assert.equal(h.child('CustomCohortSubdivisionDialog'), undefined);
  assert.equal(h.child('CustomCohortMapSnapshot'), undefined);
  assert.equal(h.child('CustomCohortPocketInspector').pocketId, groupId(1));
  assert.deepEqual(h.intents, []);
});

test('mixed bare/PH Willow broad activation unions all six original leaves once and preserves separate NO 5 plus unrelated selection', async t => {
  const h = harness(); t.after(() => h.unmount());
  const unrelated = [groupId(1), catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP], props = mixedWillowProps(h, unrelated);
  h.render(props); await h.tick(); await h.waitForRequest(0); await h.complete();
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(3), 'subdivision'); await h.drain();
  const snapshot = h.child('CustomCohortMapSnapshot');
  assert.equal(snapshot.family.member_count, 307); assert.equal(snapshot.family.pocket_ids.length, 6);
  assert.equal(h.intents.length, 1); assert.deepEqual(h.intents[0], [...unrelated, ...snapshot.family.pocket_ids]);
  assert.deepEqual([...h.intents[0]].sort(), [1, 2, 3, 4, 5, 6, 7].map(groupId).concat(catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP).sort());
  assert.deepEqual(snapshot.included, unrelated, 'no optimistic saved membership is invented');
  assert.deepEqual(h.child('CustomCohortParcelMap').inspectedPocketIds, snapshot.family.pocket_ids);
  h.render({ ...props, workspace: { ...props.workspace, selection: { revision: 8, included_recorded_group_ids: h.intents[0] } } });
  await h.tick(); await h.waitForRequest(1); await h.complete();
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(7), 'subdivision'); await h.drain();
  assert.equal(h.intents.length, 1, 'an already included mixed family is not written again');
});

test('broad click includes entire subdivision in one saved intent, preserves unrelated IDs and awaits coherent ACK', async t => {
  const h = harness(); t.after(() => h.unmount()); const props = phasedProps(h);
  h.render(props); await h.tick(); await h.complete();
  const prior = h.child('CustomCohortStatistics').group;
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(1), 'subdivision'); await h.drain();
  assert.deepEqual(h.intents, [[groupId(1), catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP, groupId(2)]]);
  const snapshot = h.child('CustomCohortMapSnapshot');
  assert.equal(snapshot.family.label, 'MONICA PARK'); assert.equal(snapshot.phaseId, null);
  assert.deepEqual(snapshot.family.pocket_ids, [groupId(1), groupId(2)]);
  assert.deepEqual(snapshot.included, props.workspace.selection.included_recorded_group_ids, 'not optimistic saved choices');
  assert.deepEqual(h.child('CustomCohortParcelMap').inspectedPocketIds, [groupId(1), groupId(2)]);
  assert.equal(h.child('CustomCohortStatistics').group, prior); assert.equal(h.calls.length, 1);
  h.render({ ...props, workspace: { ...props.workspace, saving: true } });
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(2), 'phase'); assert.equal(h.intents.length, 1);
  h.render(phasedProps(h, h.intents[0], 8)); await h.tick(); await h.complete();
  assert.deepEqual(h.calls[1].request.selection.pockets[0].account_ids, ['A', 'B', 'C']);
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(2), 'subdivision'); await h.drain();
  assert.equal(h.intents.length, 1, 'already included does not write again');
});
test('near click includes a phase, right-click excludes it, and reopening never fills it silently', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(phasedProps(h, [groupId(1), groupId(2)])); await h.tick(); await h.complete();
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(2), 'phase'); await h.drain();
  assert.equal(h.intents.length, 0); assert.equal(h.child('CustomCohortMapSnapshot').phaseId, groupId(2));
  assert.deepEqual(h.child('CustomCohortParcelMap').inspectedPocketIds, [groupId(2)]);
  const highlights = h.child('CustomCohortParcelMap').inspectedPocketIds;
  h.render(h.propsNow); assert.equal(h.child('CustomCohortParcelMap').inspectedPocketIds, highlights,
    'unrelated owner renders do not rebuild the full map just to highlight a phase');
  h.child('CustomCohortParcelMap').onExcludePocket(groupId(2), 'phase'); assert.deepEqual(h.intents, [[groupId(1)]]);
  h.render(phasedProps(h, [groupId(1)], 8)); await h.tick(); await h.complete();
  h.child('CustomCohortMapSnapshot').onClose(); await h.drain();
  assert.equal(h.intents.length, 1); assert.equal(h.child('CustomCohortMapSnapshot'), undefined);
  h.render(phasedProps(h, [groupId(1)], 8)); await h.tick(); assert.equal(h.intents.length, 1);
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(2), 'phase'); await h.drain();
  assert.deepEqual(h.intents[1], [groupId(1), groupId(2)], 'near click deliberately includes the excluded phase');
  h.child('CustomCohortMapSnapshot').onClose(); await h.drain();
  assert.equal(h.child('CustomCohortMapSnapshot'), undefined);
  h.render(phasedProps(h, [groupId(1)], 8)); await h.tick(); assert.equal(h.intents.length, 2);
  assert.equal(h.calls.length, 2, 'same selection on render does not refetch');
});
for (const blocked of ['saving', 'read_only', 'reload_required', 'pending_capture']) test(`broad subdivision click respects ${blocked}`, async t => {
  const h = harness(); t.after(() => h.unmount()); const props = phasedProps(h);
  h.render(props); await h.tick(); await h.complete();
  const next = phasedProps(h); if (blocked === 'saving') next.workspace.saving = true; else next.workspace.blockedReason = blocked;
  h.render(next); h.child('CustomCohortParcelMap').onActivatePocket(groupId(2), 'subdivision'); await h.drain();
  assert.equal(h.intents.length, 0); assert.equal(h.calls.length, 1);
});
test('unknown map pocket does not change selection or open a family', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(phasedProps(h)); await h.tick(); await h.complete();
  h.child('CustomCohortParcelMap').onActivatePocket('not-in-catalog', 'subdivision'); await h.drain();
  assert.equal(h.intents.length, 0); assert.equal(h.child('CustomCohortSubdivisionDialog'), undefined);
});
test('keyboard/list family review opens the same modal without silently selecting phases', async t => {
  const h = harness(); t.after(() => h.unmount()); h.render(phasedProps(h)); await h.tick(); await h.complete();
  const card = h.nodes().find(n => n.type === 'button' && text(n).startsWith('MONICA PARK 11 accounts'));
  assert.ok(card); card.props.onClick(); await h.drain(); h.click('Review subdivision and phases');
  assert.equal(h.child('CustomCohortSubdivisionDialog').family.pocket_ids.length, 2); assert.equal(h.intents.length, 0);
  h.child('CustomCohortSubdivisionDialog').onInclude([groupId(1), groupId(2)]);
  assert.deepEqual(h.intents, [[groupId(1), catalogHelpers.CUSTOM_COHORT_UNASSIGNED_GROUP, groupId(2)]]);
});
test('near click on a county-name variant selects its exact phase; right-click excludes all phase leaves once', async t => {
  const h = harness(); t.after(() => h.unmount());
  const props = phasedProps(h, [groupId(1), groupId(2), groupId(3)]);
  const original = props.workspace.catalog;
  props.workspace.catalog = { ...original, pockets: [...original.pockets,
    { ...original.pockets[0], id: groupId(3), county: 'DALLAS COUNTY', account_ids: ['D'], member_count: 1 }],
    coverage: { discovery_member_count: 4, assigned_account_count: 3, unassigned_account_count: 1 } };
  h.render(props); await h.tick(); await h.complete();
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(3), 'phase'); await h.drain();
  assert.equal(h.intents.length, 0); assert.equal(h.child('CustomCohortMapSnapshot').phaseId, groupId(3));
  assert.deepEqual([...h.child('CustomCohortParcelMap').inspectedPocketIds].sort(), [groupId(1), groupId(3)]);
  h.child('CustomCohortParcelMap').onExcludePocket(groupId(3), 'phase');
  assert.deepEqual(h.intents, [[groupId(2)]]);
  const saved = { ...props, workspace: { ...props.workspace, selection: { revision: 8, included_recorded_group_ids: [groupId(2)] } } };
  h.render(saved); await h.tick(); await h.complete();
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(1), 'phase'); await h.drain(); assert.equal(h.intents.length, 2);
  assert.deepEqual([...h.intents[1]].sort(), [groupId(1), groupId(2), groupId(3)]);
  assert.deepEqual(h.calls.at(-1).request.selection.pockets[0].account_ids, ['B']);
  h.child('CustomCohortParcelMap').onActivatePocket(groupId(3), 'subdivision'); await h.drain();
  assert.deepEqual([...h.intents.at(-1)].sort(), [groupId(1), groupId(2), groupId(3)]);
});
test('subdivision inspector requests one exact union without map or per-phase median averaging', { timeout: 10_000 }, async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const props = { input, catalog, pocketId: groupId(1), pocketIds: [groupId(1), groupId(2)], label: 'Parent', previewTransport: h.previewTransport };
  h.render(props); await h.tick(); await h.waitForRequest(0);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.include_map, false);
  assert.deepEqual(h.calls[0].request.selection.pockets[0].account_ids, ['A', 'B']);
  await h.complete(); assert.equal(h.child('CustomCohortStatistics').selectedOnly, true);
  assert.deepEqual(h.child('CustomCohortMemberBrowser').input.selection, h.calls[0].request.selection);
  h.render({ ...props, pocketIds: [...props.pocketIds] }); await h.drain(); assert.equal(h.calls.length, 1);
});

test('batch inspector switches parent and phases without requests, preserving exact original input and response binding', async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const inspectionSelection = { revision: 1, pockets: catalog.pockets.map(p => ({ id: p.id, label: p.label, account_ids: p.account_ids })) };
  const props = { input, catalog, pocketId: groupId(1), pocketIds: [groupId(1), groupId(2)], label: 'Parent', inspectionSelection,
    previewTransport: h.previewTransport };
  h.render(props); await h.tick(); await h.waitForRequest(0);
  h.render({ ...props, pocketId: groupId(2), pocketIds: undefined, label: 'Beta', inspectedPocketId: groupId(2) });
  assert.equal(h.calls[0].signal.aborted, false, 'phase switching does not abandon the shared response');
  await h.complete(); const group = h.child('CustomCohortStatistics').group;
  assert.equal(h.child('CustomCohortStatistics').pocketOnly, true);
  assert.equal(h.child('CustomCohortMemberBrowser').pocketId, groupId(2));
  assert.equal(h.child('CustomCohortMemberBrowser').input.selection, inspectionSelection);
  h.render({ ...props, inspectionSelection: structuredClone(inspectionSelection) }); await h.tick(); await h.settleFingerprints();
  assert.equal(h.calls.length, 1); assert.equal(h.child('CustomCohortStatistics').group, group);
  assert.equal(h.child('CustomCohortStatistics').pocketOnly, false);
  assert.equal(h.child('CustomCohortMemberBrowser').pocketId, undefined);
  h.render({ ...props, input: { ...input, selection: { revision: 9, pockets: [] } }, inspectedPocketId: groupId(1) });
  assert.equal(h.child('CustomCohortStatistics').group, group, 'main inclusion changes do not relabel immutable inspection results');
  assert.equal(h.intents.length, 0);
});

test('changed context or batch membership clears checked observations and ignores old responses', async t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const inspectionSelection = { revision: 1, pockets: catalog.pockets.map(p => ({ id: p.id, label: p.label, account_ids: p.account_ids })) };
  const props = { input, catalog, pocketId: groupId(1), label: 'Parent', inspectionSelection, previewTransport: h.previewTransport };
  h.render(props); await h.tick(); await h.waitForRequest(0);
  const next = { ...props, input: { ...input, contextRef: { ...ref, context_sha256: 'b'.repeat(64) } } };
  h.render(next); assert.equal(h.calls[0].signal.aborted, true); await h.complete(0);
  assert.equal(h.child('CustomCohortStatistics'), undefined);
  await h.tick(); await h.waitForRequest(1); await h.complete(1);
  h.render({ ...next, inspectionSelection: { ...inspectionSelection, pockets: inspectionSelection.pockets.slice(1) } });
  assert.equal(h.child('CustomCohortStatistics'), undefined); await h.tick(); await h.waitForRequest(2); await h.complete(2);
  assert.equal(h.child('CustomCohortMemberBrowser').input.selection.pockets.length, 1);
});

test('frozen batch identity serializes once across phase-only renders; equal copies preserve the structural session', async t => {
  const serialized = [];
  const h = harness('CustomCohortPocketInspector', { onSerialize(value) {
    if (Array.isArray(value) && value[5]?.[0] === 'phase-batch') serialized.push(value[5][1]);
  } }); t.after(() => h.unmount());
  const freezeSelection = value => Object.freeze({ revision: value.revision,
    pockets: Object.freeze(value.pockets.map(p => Object.freeze({ ...p, account_ids: Object.freeze([...p.account_ids]) }))) });
  const inspectionSelection = freezeSelection({ revision: 1,
    pockets: catalog.pockets.map(p => ({ id: p.id, label: p.label, account_ids: p.account_ids })) });
  const props = { input, catalog, pocketId: groupId(1), label: 'Parent', inspectionSelection, previewTransport: h.previewTransport };
  h.render(props); const originalKey = h.sessionKey;
  assert.deepEqual(serialized, [inspectionSelection]);
  assert.equal(originalKey, JSON.stringify([input.accountId, input.assignmentFileId, ref.context_id,
    ref.context_revision, ref.context_sha256, ['phase-batch', inspectionSelection]]), 'original key bytes are unchanged');
  await h.tick(); await h.waitForRequest(0);
  for (let i = 0; i < 12; i++) h.render({ ...props, pocketId: groupId(i % 2 + 1),
    inspectedPocketId: groupId(i % 2 + 1), label: `Phase ${i % 2 + 1}` });
  assert.equal(serialized.length, 1); assert.equal(h.sessionKey, originalKey); assert.equal(h.calls[0].signal.aborted, false);
  await h.complete(); const group = h.child('CustomCohortStatistics').group;
  assert.equal(serialized.length, 1, 'response state renders do not traverse the frozen batch again');
  const copied = freezeSelection(structuredClone(inspectionSelection));
  const copiedProps = { ...props, inspectionSelection: copied };
  h.render(copiedProps); h.render({ ...copiedProps, membersPaused: true, inspectedPocketId: groupId(2) });
  h.render({ ...copiedProps, input: { ...input, selection: { revision: 9, pockets: [] } } });
  await h.tick(); await h.settleFingerprints();
  assert.deepEqual(serialized, [inspectionSelection, copied]); assert.equal(h.sessionKey, originalKey);
  assert.equal(h.child('CustomCohortStatistics').group, group); assert.equal(h.calls.length, 1);
  const changed = freezeSelection({ ...copied, pockets: copied.pockets.slice(1) });
  h.render({ ...copiedProps, inspectionSelection: changed });
  assert.deepEqual(serialized, [inspectionSelection, copied, changed]); assert.notEqual(h.sessionKey, originalKey);
  assert.equal(h.child('CustomCohortStatistics'), undefined); assert.equal(h.calls[0].signal.aborted, true);
  await h.tick(); await h.waitForRequest(1); await h.complete(1);
  assert.equal(h.child('CustomCohortMemberBrowser').input.selection, changed); assert.equal(serialized.length, 3);
});

test('memoized batch key retains every original account, assignment and context binding', t => {
  const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
  const inspectionSelection = Object.freeze({ revision: 1, pockets: Object.freeze([]) });
  const props = { input, catalog, pocketId: groupId(1), label: 'Parent', inspectionSelection, paused: true };
  h.render(props); const originalKey = h.sessionKey;
  for (const changedInput of [{ ...input, accountId: 'B' }, { ...input, assignmentFileId: '9007199254740994' },
    ...Object.entries({ context_id: '10000000-0000-4000-8000-000000000002', context_revision: '2', context_sha256: 'b'.repeat(64) })
      .map(([key, value]) => ({ ...input, contextRef: { ...ref, [key]: value } }))]) {
    h.render({ ...props, input: changedInput }); const changedRef = changedInput.contextRef;
    assert.notEqual(h.sessionKey, originalKey);
    assert.equal(h.sessionKey, JSON.stringify([changedInput.accountId, changedInput.assignmentFileId,
      changedRef.context_id, changedRef.context_revision, changedRef.context_sha256, ['phase-batch', inspectionSelection]]));
    h.render(props); assert.equal(h.sessionKey, originalKey);
  }
  assert.equal(h.calls.length, 0);
});

test('only capacity failure requests standalone fallback; malformed, auth and timeout failures stay closed', async t => {
  const inspectionSelection = { revision: 1, pockets: catalog.pockets.map(p => ({ id: p.id, label: p.label, account_ids: p.account_ids })) };
  for (const kind of ['capacity', 'missing', 'count', 'duplicate', 'wrong-label', 'authentication', 'authorization', 'transport-timeout', 'deadline']) {
    let fallback = 0;
    const h = harness('CustomCohortPocketInspector'); t.after(() => h.unmount());
    h.render({ input, catalog, pocketId: groupId(1), label: 'Parent', inspectionSelection,
      previewTransport: h.previewTransport, onBatchUnavailable: () => fallback++ });
    await h.tick(); await h.waitForRequest(0);
    if (kind === 'capacity') h.calls[0].reject(Object.assign(new Error('secret'), { status: 422, workspaceCode: 'preview_capacity_exceeded' }));
    else if (kind === 'authentication' || kind === 'authorization') h.calls[0].reject(Object.assign(new Error('secret'), {
      status: kind === 'authentication' ? 401 : 403, workspaceCode: 'request_failed' }));
    else if (kind === 'transport-timeout') h.calls[0].reject(Object.assign(new Error('secret'), { status: 504, name: 'TimeoutError' }));
    else if (kind === 'deadline') { await h.advance(65_000); assert.equal(h.calls[0].signal.aborted, true); await h.complete(0); }
    else {
      const bad = response(h.calls[0].request);
      if (kind === 'missing') bad.summary.pockets.pop();
      if (kind === 'count') bad.summary.pockets[0].result.account_count++;
      if (kind === 'duplicate') bad.summary.pockets[1] = bad.summary.pockets[0];
      if (kind === 'wrong-label') bad.summary.pockets[0].label = 'different';
      h.calls[0].resolve(bad);
    }
    await h.drain(); assert.equal(h.child('CustomCohortStatistics'), undefined); assert.equal(h.child('CustomCohortMemberBrowser'), undefined);
    const expectedFallback = kind === 'capacity' ? 1 : 0;
    assert.equal(fallback, expectedFallback, kind); assert.doesNotMatch(h.text(), /secret/);
    await h.tick(); await h.settleFingerprints();
    assert.equal(h.calls.length, 1, `${kind} does not retry implicitly`); assert.equal(fallback, expectedFallback, kind); h.unmount();
  }
});
