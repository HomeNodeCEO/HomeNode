import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalog from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript');
function compile(name, imports, globals = {}) {
  const path = fileURLToPath(new URL(`../src/features/neighborhood/${name}`, import.meta.url));
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  }, reportDiagnostics: true });
  assert.equal((output.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports,${Object.keys(globals).join(',')}){${output.outputText}\n})`, { filename: path })
    .runInThisContext()(key => { assert.ok(Object.hasOwn(imports, key), `Unexpected bridge dependency: ${key}`); return imports[key]; },
      module, module.exports, ...Object.values(globals));
  return module.exports;
}
const checkpoint = compile('customWorkspaceCheckpoint.ts', { './customCohortPocketCatalog': catalog });
const api = compile('customWorkspaceApi.ts', { './customCohortPreviewTransport': transport, './customWorkspaceCheckpoint': checkpoint });
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
  const cells = [], effects = [], timers = new Map(), calls = [], credentials = [];
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
  return { calls, credentials, timers, get view() { return output; }, get props() { return currentProps; }, get uuidCount() { return uuidSerial; },
    render(value, beforeEffects) { render(value, beforeEffects); flush(); },
    async settle() { for (let i = 0; i < 40; i++) { await Promise.resolve(); flush(); } },
    async expire() { const pendingTimers = [...timers.entries()]; pendingTimers.forEach(([id, item]) => { timers.delete(id); item.fn(); }); await this.settle(); },
    mountControls(flushOperation = async () => true) {
      assert.ok(output.hostProps); const registrations = [], hostProps = output.hostProps;
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
  assert.equal(h.view.status, 'ready'); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].init.cache, 'no-store');
  assert.equal(h.calls[0].init.method, 'GET'); assert.ok(h.calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(h.view.hostProps.initialSection, { revision: 5, value: active().value });
  assert.deepEqual(h.view.hostProps.initialPeriod, period); assert.equal(h.credentials.length, 0);
  const original = h.view.hostProps, next = copy(h.props); next.auth.session.display_name = 'Other display name';
  next.auth.session.organizations[0].roles.reverse();
  h.render(next); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.view.hostProps.api, original.api);
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

test('automatic reads and host props introduce no print listener, guessed date, or accepted-report mutation seam', () => {
  const source = readFileSync(new URL('../src/features/neighborhood/useCustomNeighborhoodReportBridge.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /addEventListener\(['"](?:beforeprint|homenode:prepare-report)|localStorage|new Date\(/);
  assert.doesNotMatch(source, /neighborhood_assessment|assignment_details|onAccepted|setAssignmentDraft|requestEditorCredential/);
});
