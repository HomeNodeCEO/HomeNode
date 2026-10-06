import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as catalog from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as defaultPeriod from '../src/features/neighborhood/customWorkspaceDefaultPeriod.ts';
import * as groupSelection from '../src/features/neighborhood/customCohortRecordedGroupTransport.ts';
import { workspace, displayModule, mapView, groupMemberViewFixture } from './customCohortGroupMemberViewFixture.mjs';
import { loadTrustedRepositoryCommonJs } from './trustedRepositoryModuleHarness.mjs';

function compile(name, imports, globals = {}) {
  return loadTrustedRepositoryCommonJs(new URL(`../src/features/neighborhood/${name}`, import.meta.url), key => {
    assert.ok(Object.hasOwn(imports, key), `Unexpected bridge dependency: ${key}`); return imports[key];
  }, { environment: globals });
}
const checkpoint = compile('customWorkspaceCheckpoint.ts', { './customCohortPocketCatalog': catalog,
  './customWorkspaceDiscovery.ts': compile('customWorkspaceDiscovery.ts', {}) });
const api = compile('customWorkspaceApi.ts', { './customCohortPreviewTransport': transport, './customWorkspaceCheckpoint': checkpoint });
const groupApi = compile('customCohortGroupWorkspaceApi.ts', { './customWorkspaceApi.ts': api,
  './customCohortPreviewTransport.ts': transport, './customCohortGroupWorkspaceTransport.ts': workspace,
  './customCohortRecordedGroupTransport.ts': groupSelection, './customCohortGroupDisplay.ts': displayModule,
  './customCohortGroupMapView.ts': mapView });
const copy = value => structuredClone(value);
const period = { start_date: '2024-01-01', end_date: '2024-12-31' };
const context = { context_id: '10000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const groupId = `recorded-cad:${'b'.repeat(64)}`;
const auth = () => ({ ready: true, bootstrapError: null, session: { user_id: 'synthetic-user', display_name: 'Not an identity key', email: null,
  organizations: [{ organization_id: 'synthetic-org', roles: ['appraiser', 'organization_admin'],
    permissions: { custom_appraisal: { read: true, write: true, sign: true } } }] } });
const props = () => ({ enabled: true, accountId: 'SUBJECT', assignmentFileId: 41, workfileStatus: 'draft', subjectLabel: 'Synthetic subject', auth: auth() });
const active = (ids = []) => ({ key: 'neighborhood_workspace', revision: 5, value: { workspace_version: 1,
  active: { context_ref: copy(context), observation_period: copy(period), selection: { revision: 9, included_recorded_group_ids: ids } }, pending_capture: null } });
const pending = () => ({ revision: 2, value: { workspace_version: 1, active: null,
  pending_capture: { operation_id: context.context_id, observation_period: copy(period) } } });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** Deterministic hook dispatcher, actual API/checkpoint/stream admission, injected
 * HTTP response boundary. Browser rendering and host lifecycle have their own
 * integration suites; this exercises the new report ownership boundary. */
function harness(t, options = {}) {
  const { initialProps = props(), request, credential = '__homenode_authenticated_session__' } = options;
  const section = Object.hasOwn(options, 'section') ? options.section : active();
  const cells = [], effects = [], timers = new Map(), calls = [], credentials = [], mapPreloads = [];
  let cursor = 0, dirty = false, output, currentProps = initialProps, live = true, serial = 0, uuidSerial = 0;
  const react = {
    useState(initial) { const i = cursor++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [cells[i].value, next => { if (!live) return; const value = typeof next === 'function' ? next(cells[i].value) : next;
        if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true; } }]; },
    useRef(value) { const i = cursor++; cells[i] ??= { current: value }; return cells[i]; },
    useMemo(fn, deps) { const i = cursor++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: fn(), deps }; return cells[i].value; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useEffect(setup, deps) { const i = cursor++, old = cells[i]; if (!old || !same(old.deps, deps)) {
      const effect = { deps, setup, cleanup: old?.cleanup }; cells[i] = effect;
      effects.push(() => { effect.cleanup?.(); effect.cleanup = setup(); });
    } },
  };
  const respond = call => {
    const match = /^\/api\/accounts\/([^/]+)\/assignment-files\/([0-9]+)\/workfile$/.exec(call.url);
    assert.ok(match, `Unexpected automatic route ${call.url}`);
    return json({ ok: true, account_id: decodeURIComponent(match[1]), workfile: { assignment_file_id: Number(match[2]), status: 'draft',
      sections: { neighborhood_assessment: { value: { accepted_marker: 'untouched' }, revision: 7 },
        ...(section === undefined ? {} : { neighborhood_workspace: copy(section) }) } } });
  };
  const exports = compile('useCustomNeighborhoodReportBridge.ts', { react, './customWorkspaceApi': api,
    './customCohortGroupWorkspaceApi': groupApi,
    './customWorkspaceDefaultPeriod': defaultPeriod,
    '@/lib/mapLibreRuntime': { loadMapLibreRuntime: () => { mapPreloads.push(true); return Promise.resolve({}); } },
    '@/lib/api': { makeUrl: value => value, fetchWithApplicationAuthentication: (url, init) => {
      const call = { url, init }; calls.push(call); return Promise.resolve(request ? request(call, respond) : respond(call));
    } },
    '@/lib/editorCredential': { editorCredentialForRequest: () => { credentials.push(true); return credential; } },
  }, { setTimeout: (fn, delay) => { timers.set(++serial, { fn, delay }); return serial; }, clearTimeout: id => timers.delete(id),
    crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++uuidSerial).padStart(12, '0')}` } });
  function render(value = currentProps, beforeEffects) {
    currentProps = value; cursor = 0; dirty = false; output = exports.useCustomNeighborhoodReportBridge(value);
    beforeEffects?.(); effects.splice(0).forEach(fn => fn());
  }
  function flush() { let count = 0; while (dirty) { assert.ok(++count < 30, 'Bridge render loop'); render(); } }
  function unmount() { if (!live) return; cells.forEach(cell => cell?.cleanup?.()); live = false; }
  render(); flush(); t.after(unmount);
  return { calls, credentials, timers, mapPreloads, get view() { return output; }, get props() { return currentProps; }, get uuidCount() { return uuidSerial; },
    render(value, beforeEffects) { render(value, beforeEffects); flush(); },
    async settle() { for (let i = 0; i < 40; i++) { await Promise.resolve(); flush(); } },
    async expire() { const pendingTimers = [...timers.entries()]; pendingTimers.forEach(([id, item]) => { timers.delete(id); item.fn(); }); await this.settle(); },
    mountControls(flushOperation = async () => true) {
      assert.ok(output.hostProps ?? output.groupHostProps); const registrations = [], hostProps = output.hostProps ?? output.groupHostProps;
      const controls = { target: copy(hostProps.target), flush: flushOperation, setReadOnly: value => registrations.push(value) };
      hostProps.registerControls(controls); return { controls, registrations, unmount: () => hostProps.registerControls(null) };
    },
    strictReplay() { const all = cells.filter(cell => cell?.setup); all.forEach(effect => effect.cleanup?.());
      all.forEach(effect => { effect.cleanup = effect.setup(); }); flush(); },
    unmount,
  };
}

test('fresh current-session workfile read preserves exact empty checkpoint and pins opaque local generation', async t => {
  const h = harness(t); assert.equal(h.view.beginSaveBarrier(), null); await h.settle();
  assert.equal(h.mapPreloads.length, 1, 'a saved active study starts the map bundle alongside catalog loading');
  assert.equal(h.view.status, 'ready'); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].init.cache, 'no-store');
  assert.equal(h.calls[0].init.method, 'GET'); assert.ok(h.calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(h.view.hostProps.initialSection, { revision: 5, value: active().value });
  assert.deepEqual(h.view.hostProps.initialPeriod, period); assert.equal(h.credentials.length, 0);
  const original = h.view.hostProps, next = copy(h.props); next.auth.session.display_name = 'Other display name';
  next.auth.session.organizations[0].roles.reverse();
  h.render(next); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.view.hostProps.api, original.api);
  assert.equal(h.mapPreloads.length, 1, 'an equivalent render does not restart the preload');
  assert.equal(h.view.hostProps.target, original.target); assert.ok(original.target.sessionKey.length <= 200);
  assert.doesNotMatch(original.target.sessionKey, /synthetic-user|synthetic-org/);
  assert.equal(h.view.beginSaveBarrier(), null, 'loaded data is not mounted controls');
});

for (const variant of ['active-empty', 'active-members', 'pending', 'intentionally-empty', 'absent']) {
  test(`${variant} restores only saved period/intent and never automatically captures or uses report values`, async t => {
    const section = variant === 'active-empty' ? active() : variant === 'active-members' ? active([groupId]) : variant === 'pending' ? pending()
      : variant === 'intentionally-empty' ? { revision: 1, value: { workspace_version: 1, active: null, pending_capture: null } } : undefined;
    const h = harness(t, { section }); await h.settle();
    assert.equal(h.calls.length, 1); assert.equal(h.view.status, 'ready');
    assert.equal(h.mapPreloads.length, Number(variant.startsWith('active')));
    assert.deepEqual(h.view.hostProps.initialPeriod, ['absent', 'intentionally-empty'].includes(variant) ? null : period);
    assert.equal(h.view.hostProps.initialSection?.value.active?.selection.included_recorded_group_ids.length,
      variant.startsWith('active') ? variant === 'active-members' ? 1 : 0 : undefined);
    assert.equal(h.view.hostProps.initialSection?.value.neighborhood_assessment, undefined);
    assert.equal(h.credentials.length, 0); assert.ok(h.calls.every(call => call.init.method === 'GET'));
  });
}

test('disabled is an exclusive generation-bound no-op even without session or valid target', async t => {
  const h = harness(t, { initialProps: { ...props(), enabled: false, accountId: null, assignmentFileId: null, auth: { ready: false, bootstrapError: null, session: null } } });
  const lease = h.view.beginSaveBarrier(); assert.ok(lease); assert.equal(h.view.beginSaveBarrier(), null);
  assert.equal(await lease.flush(), true); assert.equal(h.calls.length, 0); assert.equal(h.uuidCount, 0); assert.equal(h.view.hostProps, null);
  lease.release(); assert.equal(lease.isCurrent(), false); const next = h.view.beginSaveBarrier(); assert.ok(next);
  h.render({ ...h.props, accountId: 'NEXT' }, () => assert.equal(next.isCurrent(), false));
  assert.equal(await next.flush(), false); next.release(); assert.equal(h.calls.length, 0);
});

for (const [variant, change] of [
  ['bootstrap pending', p => { p.auth.ready = false; }], ['bootstrap failure', p => { p.auth.bootstrapError = 'private auth detail'; }],
  ['no session', p => { p.auth.session = null; }], ['no target', p => { p.assignmentFileId = null; }],
  ['unsafe numeric ID', p => { p.assignmentFileId = Number.MAX_SAFE_INTEGER + 1; }], ['noncanonical account', p => { p.accountId = ' SUBJECT '; }],
]) test(`${variant} cannot read, capture or acknowledge saving for an enabled bridge`, async t => {
  const initialProps = props(); change(initialProps); const h = harness(t, { initialProps }); await h.settle();
  assert.equal(h.calls.length, 0); assert.equal(h.view.hostProps, null); assert.equal(h.view.beginSaveBarrier(), null);
  assert.equal(h.mapPreloads.length, 0);
  assert.doesNotMatch(h.view.message ?? '', /private auth detail/);
});

for (const [variant, response] of [
  ['network failure', () => { throw new Error('private server body'); }],
  ['wrong account', () => json({ ok: true, account_id: 'OTHER', workfile: {} })],
  ['wrong file', () => json({ ok: true, account_id: 'SUBJECT', workfile: { assignment_file_id: 42, status: 'draft', sections: {} } })],
  ['null checkpoint', () => json({ ok: true, account_id: 'SUBJECT', workfile: { assignment_file_id: 41, status: 'draft', sections: { neighborhood_workspace: null } } })],
]) test(`${variant} stays unavailable without an implicit retry/default selection`, async t => {
  const h = harness(t, { request: response }); await h.settle();
  assert.equal(h.view.status, 'unavailable'); assert.equal(h.view.hostProps, null); assert.equal(h.view.beginSaveBarrier(), null);
  assert.equal(h.mapPreloads.length, 0);
  assert.equal(h.calls.length, 1); h.render(copy(h.props)); await h.settle(); assert.equal(h.calls.length, 1);
  assert.doesNotMatch(h.view.message, /private server body/);
});

test('read deadline is finite even if HTTP ignores cancellation; only explicit retry reads again', async t => {
  const held = deferred(); let count = 0;
  const h = harness(t, { request: (call, respond) => ++count === 1 ? held.promise.then(() => respond(call)) : respond(call) });
  await h.settle(); h.view.retry(); await h.settle(); assert.equal(h.calls.length, 1);
  await h.expire(); assert.equal(h.view.status, 'unavailable'); assert.equal(h.calls[0].init.signal.aborted, true);
  h.view.retry(); await h.settle(); assert.equal(h.calls.length, 2); assert.equal(h.view.status, 'ready');
  const target = h.view.hostProps.target; held.resolve(); await h.settle(); assert.equal(h.view.hostProps.target, target);
});

for (const change of ['account', 'file', 'logout', 'permissions']) test(`${change} invalidates old read/controls before effect cleanup`, async t => {
  const held = deferred(); let count = 0;
  const h = harness(t, { request: (call, respond) => ++count === 1 ? held.promise.then(() => respond(call)) : respond(call) });
  await h.settle(); const oldSignal = h.calls[0].init.signal, next = copy(h.props);
  if (change === 'account') next.accountId = 'OTHER'; if (change === 'file') next.assignmentFileId = 42;
  if (change === 'logout') next.auth.session = null;
  if (change === 'permissions') next.auth.session.organizations[0].permissions.custom_appraisal.write = false;
  h.render(next); await h.settle(); assert.equal(oldSignal.aborted, true);
  const newTarget = h.view.hostProps?.target; held.resolve(); await h.settle(); assert.equal(h.view.hostProps?.target, newTarget);
  assert.equal(h.calls.length, change === 'logout' ? 1 : 2);
});

test('same-user re-login starts a new local session and stale registration cannot clear new controls', async t => {
  const h = harness(t); await h.settle(); const oldTarget = h.view.hostProps.target, old = h.mountControls();
  h.render({ ...props(), auth: { ...auth(), session: null } }); await h.settle();
  h.render(props()); await h.settle(); const current = h.mountControls(); old.unmount();
  assert.notEqual(h.view.hostProps.target.sessionKey, oldTarget.sessionKey);
  const lease = h.view.beginSaveBarrier(); assert.ok(lease); assert.deepEqual(current.registrations, [true]);
  assert.equal(await lease.flush(), true); lease.release(); assert.equal(h.calls.length, 2);
});

for (const status of ['signed', 'archived']) test(`fresh ${status} status and immediate known lock prevent editable host/lease`, async t => {
  const h = harness(t, { request: () => json({ ok: true, account_id: 'SUBJECT', workfile: { assignment_file_id: 41, status, sections: {} } }) });
  await h.settle(); assert.equal(h.view.status, 'read_only'); assert.equal(h.view.hostProps.workfileStatus, status); assert.equal(h.view.beginSaveBarrier(), null);
  const next = harness(t); await next.settle(); next.mountControls(); const lease = next.view.beginSaveBarrier(); assert.ok(lease);
  next.render({ ...next.props, workfileStatus: status }, () => assert.equal(lease.isCurrent(), false));
  await next.settle(); assert.equal(next.view.hostProps.workfileStatus, status); assert.equal(next.view.beginSaveBarrier(), null);
  lease.release();
});

test('barrier pauses synchronously, waits once for flush, excludes concurrent leases, and releases only itself', async t => {
  const h = harness(t); await h.settle(); const held = deferred(); let count = 0;
  const owner = h.mountControls(() => { count++; return held.promise; });
  const lease = h.view.beginSaveBarrier(); assert.ok(lease); assert.deepEqual(owner.registrations, [true]);
  assert.equal(h.view.beginSaveBarrier(), null); let settled = false;
  const first = lease.flush(); assert.equal(lease.flush(), first); first.then(() => { settled = true; }); await h.settle();
  assert.equal(settled, false); assert.equal(count, 1); held.resolve(true); assert.equal(await first, true);
  lease.release(); lease.release(); assert.deepEqual(owner.registrations, [true, false]);
  assert.equal(await lease.flush(), false); const second = h.view.beginSaveBarrier(); assert.ok(second); lease.release();
  assert.deepEqual(owner.registrations, [true, false, true]); second.release();
});

test('false/failed host flush never reports successful save and cancellation releases current read-only state', async t => {
  for (const failed of [false, true]) {
    const h = harness(t); await h.settle(); const owner = h.mountControls(() => failed ? Promise.reject(new Error('private failure')) : Promise.resolve(false));
    const lease = h.view.beginSaveBarrier(); assert.equal(await lease.flush(), false); lease.release();
    assert.deepEqual(owner.registrations, [true, false]); assert.ok(h.view.beginSaveBarrier());
  }
});

test('retaining read-only after signing cannot be undone by finally release or a late re-registration', async t => {
  const h = harness(t); await h.settle(); const owner = h.mountControls(), lease = h.view.beginSaveBarrier();
  assert.equal(await lease.flush(), true); lease.retainReadOnly(); lease.release();
  assert.deepEqual(owner.registrations, [true, true]); assert.equal(h.view.beginSaveBarrier(), null);
  const replacement = h.mountControls(); assert.deepEqual(replacement.registrations, [true]);
});

test('generation change promptly rejects held flush and old release cannot unlock the new target', async t => {
  const h = harness(t); await h.settle(); const held = deferred(), old = h.mountControls(() => held.promise), lease = h.view.beginSaveBarrier();
  const flushed = lease.flush(); await h.settle(); h.render({ ...h.props, assignmentFileId: 42 });
  assert.equal(await flushed, false); await h.settle(); const owner = h.mountControls(), newLease = h.view.beginSaveBarrier();
  assert.ok(newLease); lease.release(); held.resolve(true); await h.settle(); assert.deepEqual(owner.registrations, [true]);
  assert.deepEqual(old.registrations, [true]); assert.equal(await newLease.flush(), true); newLease.release();
});

test('unmounted controls invalidate a lease; late old controls cannot replace foreign target', async t => {
  const h = harness(t); await h.settle(); const owner = h.mountControls(), lease = h.view.beginSaveBarrier(); owner.unmount();
  assert.equal(lease.isCurrent(), false); assert.equal(await lease.flush(), false); lease.release();
  h.view.hostProps.registerControls({ ...owner.controls, target: { ...owner.controls.target, assignmentFileId: '42' } });
  assert.equal(h.view.beginSaveBarrier(), null); assert.deepEqual(owner.registrations, [true]);
});

test('flush deadline keeps uncertain operations quiesced and blocks retry until the actual host flush settles', async t => {
  const h = harness(t); await h.settle(); const held = deferred(), owner = h.mountControls(() => held.promise), lease = h.view.beginSaveBarrier();
  const flushed = lease.flush(); await h.settle(); await h.expire(); assert.equal(await flushed, false);
  lease.release(); assert.deepEqual(owner.registrations, [true]); assert.equal(h.view.beginSaveBarrier(), null); assert.equal(h.view.status, 'unavailable');
  h.view.retry(); await h.settle(); assert.equal(h.calls.length, 1);
  held.resolve(true); await h.settle(); h.view.retry(); await h.settle(); assert.equal(h.calls.length, 2);
  assert.equal(h.view.status, 'ready'); assert.equal(h.view.beginSaveBarrier(), null, 'new host must register');
});

test('early release does not permit a second save lease while the previous flush still runs', async t => {
  const h = harness(t); await h.settle(); const held = deferred(); h.mountControls(() => held.promise);
  const lease = h.view.beginSaveBarrier(), flushed = lease.flush(); await h.settle(); lease.release();
  assert.equal(h.view.beginSaveBarrier(), null); held.resolve(true); assert.equal(await flushed, false); assert.ok(h.view.beginSaveBarrier());
});

test('StrictMode replay cannot revive a disabled lease from the discarded effect generation', async t => {
  const h = harness(t, { initialProps: { ...props(), enabled: false } }), old = h.view.beginSaveBarrier();
  h.strictReplay(); assert.equal(old.isCurrent(), false); assert.equal(await old.flush(), false);
  const next = h.view.beginSaveBarrier(); assert.ok(next); old.release(); assert.equal(next.isCurrent(), true); next.release();
});

test('disposed bridge cannot report success or issue a late editor-key save', async t => {
  const h = harness(t); await h.settle(); const old = h.view.hostProps; h.mountControls(); const lease = h.view.beginSaveBarrier();
  h.unmount(); assert.equal(lease.isCurrent(), false); assert.equal(await lease.flush(), false);
  await assert.rejects(old.api.save({ target: old.target, sectionKey: 'neighborhood_workspace', value: active().value, expectedRevision: 5 },
    { signal: new AbortController().signal, deadline: performance.now() + 65000 }));
  assert.equal(h.credentials.length, 0); assert.equal(h.calls.length, 1);
});

test('automatic reads introduce no print listener, guessed date, or browser report mutation', () => {
  const source = readFileSync(new URL('../src/features/neighborhood/useCustomNeighborhoodReportBridge.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /addEventListener\(['"](?:beforeprint|homenode:prepare-report)|localStorage|new Date\(/);
  assert.doesNotMatch(source, /neighborhood_assessment|assignment_details|setAssignmentDraft|requestEditorCredential/);
});

test('accepted notification is explicit, uses the latest callback without rebooting and rejects a switched file', async t => {
  let calls = 0;
  const h = harness(t, { initialProps: { ...props(), onAccepted: async () => { calls++; return true; } } });
  await h.settle(); assert.equal(calls, 0);
  const old = h.view.hostProps, target = old.target;
  h.render({ ...h.props, onAccepted: async () => { calls += 10; return true; } }); await h.settle();
  assert.equal(h.view.hostProps.target, target); assert.equal(h.calls.length, 1);
  assert.equal(await old.onAccepted(), true); assert.equal(calls, 10);
  h.render({ ...h.props, accountId: 'OTHER' });
  assert.equal(await old.onAccepted(), false); assert.equal(calls, 10);
});

test('file switch during accepted-group refetch cannot acknowledge the old report', async t => {
  const held = deferred();
  const h = harness(t, { initialProps: { ...props(), onAccepted: () => held.promise } }); await h.settle();
  const pending = h.view.hostProps.onAccepted();
  h.render({ ...h.props, assignmentFileId: 42 }); held.resolve(true);
  assert.equal(await pending, false);
});

test('private capture delegates only to current mounted draft controls and respects save/session barriers', async t => {
  const h = harness(t); await h.settle(); const calls = [], old = h.view;
  const reference = { batch_id: '20000000-0000-4000-8000-000000000001', expected_review_revision: 3 };
  assert.equal(await old.useReviewedSales(reference), false);
  const owner = h.mountControls(); owner.controls.useReviewedSales = async value => { calls.push(copy(value)); return true; };
  assert.equal(await h.view.useReviewedSales(reference), true); assert.deepEqual(calls, [reference]);
  const lease = h.view.beginSaveBarrier(); assert.ok(lease);
  assert.equal(await h.view.useReviewedSales(reference), false); lease.release();
  const changed = copy(h.props); changed.accountId = 'OTHER'; h.render(changed);
  assert.equal(await old.useReviewedSales(reference), false); assert.equal(calls.length, 1);
});

const groupProps = (fixture, initialGroups = () => []) => ({ ...props(), accountId: fixture.value.target.accountId,
  assignmentFileId: Number(fixture.value.target.assignmentFileId), recordedGroupWorkspace: { initialGroups } });
const groupSection = fixture => ({ revision: fixture.value.workspaceRevision, value: copy(fixture.value.checkpoint) });

test('explicit V7 report composition restores only the checked V7 host and preserves the shared signing barrier', async t => {
  const f = await groupMemberViewFixture({ empty: true }); let policyCalls = 0;
  const initialProps = groupProps(f, () => { policyCalls++; return []; });
  const h = harness(t, { initialProps, section: groupSection(f) }); await h.settle();
  assert.equal(h.view.status, 'ready'); assert.equal(h.view.hostProps, null); assert.ok(h.view.groupHostProps);
  assert.equal(h.view.groupHostProps.initialGroups, initialProps.recordedGroupWorkspace.initialGroups);
  assert.deepEqual(h.view.groupHostProps.initialPeriod, f.value.checkpoint.active.observation_period);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].init.method, 'GET'); assert.equal(h.credentials.length, 0);
  assert.equal(policyCalls, 0, 'report bridge is not the capture/selection owner');
  assert.equal(h.view.beginSaveBarrier(), null, 'fresh workfile is not mounted host controls');
  const held = deferred(), mounted = h.mountControls(() => held.promise), lease = h.view.beginSaveBarrier();
  assert.ok(lease); assert.deepEqual(mounted.registrations, [true]);
  const operation = lease.flush(); await h.settle(); assert.equal(h.view.beginSaveBarrier(), null);
  held.resolve(true); assert.equal(await operation, true); lease.release(); assert.deepEqual(mounted.registrations, [true, false]);
});

for (const variant of ['legacy', 'null', 'future']) test(`V7 composition refuses ${variant} data rather than converting it or falling back`, async t => {
  const f = await groupMemberViewFixture();
  const section = variant === 'legacy' ? active() : variant === 'null' ? null
    : { ...groupSection(f), value: { ...f.value.checkpoint, workspace_version: 8 } };
  const h = harness(t, { initialProps: groupProps(f), section }); await h.settle();
  assert.equal(h.view.status, 'unavailable'); assert.equal(h.view.hostProps, null); assert.equal(h.view.groupHostProps, null);
  assert.equal(h.view.beginSaveBarrier(), null); assert.equal(h.calls.length, 1); assert.equal(h.credentials.length, 0);
});

test('omitted V7 policy retains legacy mode; missing policy cannot silently choose a default owner', async t => {
  const ordinary = harness(t); await ordinary.settle(); assert.ok(ordinary.view.hostProps); assert.equal(ordinary.view.groupHostProps, null);
  for (const recordedGroupWorkspace of [null, {}, { initialGroups: null }, { initialGroups: [] }]) {
    const h = harness(t, { initialProps: { ...props(), recordedGroupWorkspace } }); await h.settle();
    assert.equal(h.view.status, 'unavailable'); assert.equal(h.calls.length, 0);
    assert.equal(h.view.hostProps, null); assert.equal(h.view.groupHostProps, null); assert.equal(h.view.beginSaveBarrier(), null);
  }
});

test('fresh absent V7 draft passes an explicit policy and canonical period without starting capture in the bridge', async t => {
  const f = await groupMemberViewFixture(), initialProps = { ...groupProps(f), effectiveDate: '2024-12-31' };
  const h = harness(t, { initialProps, section: undefined }); await h.settle();
  assert.equal(h.view.status, 'ready'); assert.equal(h.view.hostProps, null); assert.equal(h.view.groupHostProps.initialPeriod, null);
  assert.deepEqual(h.view.groupHostProps.defaultPeriod, defaultPeriod.customWorkspaceDefaultObservationPeriod('2024-12-31'));
  assert.equal(h.calls.length, 1); assert.equal(h.credentials.length, 0);
});

test('V7 mode and policy generation changes invalidate old reads, controls, leases and accepted callbacks before cleanup', async t => {
  const f = await groupMemberViewFixture(), held = deferred(); let calls = 0;
  const initialProps = groupProps(f), h = harness(t, { initialProps, section: groupSection(f),
    request: (call, respond) => ++calls === 1 ? held.promise.then(() => respond(call)) : respond(call) });
  await h.settle(); const oldSignal = h.calls[0].init.signal;
  h.render({ ...initialProps, recordedGroupWorkspace: { initialGroups: () => [] } }); await h.settle();
  assert.equal(oldSignal.aborted, true); const currentTarget = h.view.groupHostProps.target;
  held.resolve(); await h.settle(); assert.equal(h.view.groupHostProps.target, currentTarget);
  const oldProps = h.view.groupHostProps, mounted = h.mountControls(), lease = h.view.beginSaveBarrier(); assert.ok(lease);
  h.render({ ...initialProps, recordedGroupWorkspace: undefined }, () => assert.equal(lease.isCurrent(), false));
  assert.equal(await oldProps.onAccepted(), false); mounted.unmount(); lease.release(); await h.settle();
  assert.equal(h.view.status, 'unavailable', 'legacy reader refuses a V7 checkpoint rather than resetting it');
  assert.equal(h.view.groupHostProps, null); assert.equal(h.view.hostProps, null); assert.equal(h.credentials.length, 0);
});

for (const status of ['signed', 'archived']) test(`fresh V7 ${status} file remains read-only and cannot acquire a save lease`, async t => {
  const f = await groupMemberViewFixture(), initialProps = groupProps(f);
  const h = harness(t, { initialProps, section: groupSection(f), request: (call, respond) => respond(call).json().then(body => json({ ...body,
    workfile: { ...body.workfile, status } })) }); await h.settle();
  assert.equal(h.view.status, 'read_only'); assert.equal(h.view.groupHostProps.workfileStatus, status);
  assert.equal(h.view.hostProps, null); assert.equal(h.view.beginSaveBarrier(), null); assert.equal(h.calls.length, 1);
});

test('V7 flush deadline preserves actual pending ownership and blocks retry until settlement', async t => {
  const f = await groupMemberViewFixture(), h = harness(t, { initialProps: groupProps(f), section: groupSection(f) }); await h.settle();
  const held = deferred(), mounted = h.mountControls(() => held.promise), lease = h.view.beginSaveBarrier();
  const operation = lease.flush(); await h.settle(); await h.expire(); assert.equal(await operation, false);
  lease.release(); assert.deepEqual(mounted.registrations, [true]); assert.equal(h.view.status, 'unavailable');
  h.view.retry(); await h.settle(); assert.equal(h.calls.length, 1); assert.equal(h.view.beginSaveBarrier(), null);
  held.resolve(true); await h.settle(); h.view.retry(); await h.settle(); assert.equal(h.calls.length, 2);
  assert.equal(h.view.status, 'ready'); assert.equal(h.view.beginSaveBarrier(), null, 'new exact host must register');
});

test('characteristics mounts one chosen host inside the existing layout, not both owners', () => {
  const runtime = createRequire(new URL('../package.json', import.meta.url)), jsx = runtime('react/jsx-runtime');
  const { renderToStaticMarkup } = runtime('react-dom/server');
  const Section = compile('components/CustomNeighborhoodCharacteristicsSection.tsx', {
    react: { useMemo: fn => fn(), Suspense: ({ children }) => children, lazy: loader => {
      const match = /(?:import|require)\(['"](.+?)['"]\)/.exec(String(loader)); assert.ok(match);
      const name = match[1].split('/').at(-1);
      return function Stub() { return jsx.jsx('div', { 'data-host': name }); };
    } }, 'react/jsx-runtime': jsx,
    '@/components/PropertyReportControls': { SummarySection: ({ children }) => jsx.jsx('section', { children }) },
  }).default;
  const props = { neighborhoodSummary: '', onNeighborhoodSummaryChange() {}, acceptedNeighborhood: null,
    assignmentFilesLoaded: false, assignmentFilesError: false, hasActiveAssignmentFile: false,
    workspace: { status: 'ready', message: null, hostProps: {}, groupHostProps: null } };
  const legacy = renderToStaticMarkup(jsx.jsx(Section, props));
  assert.match(legacy, /data-host="CustomNeighborhoodWorkspaceHost"/);
  assert.doesNotMatch(legacy, /data-host="CustomCohortGroupWorkspaceHost"/);
  const exact = renderToStaticMarkup(jsx.jsx(Section, { ...props, workspace: { ...props.workspace, groupHostProps: {} } }));
  assert.match(exact, /data-host="CustomCohortGroupWorkspaceHost"/);
  assert.doesNotMatch(exact, /data-host="CustomNeighborhoodWorkspaceHost"/);
  assert.match(exact, /Neighborhood summary/); assert.match(exact, /Applied neighborhood characteristics and market observations/);
});
