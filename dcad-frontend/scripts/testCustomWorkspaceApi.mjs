import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';

const requireRuntime = createRequire(new URL('../package.json', import.meta.url)), ts = requireRuntime('typescript');
function compile(name, imports) {
  const file = fileURLToPath(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url));
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${result.outputText}\n})`, { filename: file }).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected API dependency (no auth/session/runtime lifecycle): ${key}`);
    return imports[key];
  }, module, module.exports);
  return module.exports;
}
const checkpoint = compile('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers });
const transport = compile('customCohortPreviewTransport', {});
const { createCustomWorkspaceApi: create } = compile('customWorkspaceApi', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': transport,
});
const TARGET = Object.freeze({ accountId: '000123_ABC', assignmentFileId: '37', sessionKey: 'synthetic-generation-1' });
const OPERATION = '10000000-0000-4000-8000-000000000001';
const PERIOD = Object.freeze({ start_date: '2023-01-01', end_date: '2024-02-29' });
const CONTEXT = Object.freeze({ context_id: OPERATION, context_revision: '1', context_sha256: 'a'.repeat(64) });
const KEY = 'synthetic-editor-key-not-a-credential';
const SECTION = 'neighborhood_workspace';
const copy = value => structuredClone(value);
const value = () => ({ workspace_version: 1, active: { context_ref: copy(CONTEXT), observation_period: copy(PERIOD),
  selection: { revision: 9, included_recorded_group_ids: [] } }, pending_capture: null });
const section = (revision = 3) => ({ value: value(), revision, updated_by: 'synthetic-reviewer', updated_at: '2026-09-09T00:00:00Z' });
const readResponse = () => ({ ok: true, account_id: TARGET.accountId, workfile: { assignment_file_id: 37, status: 'draft',
  sections: { [SECTION]: section(), assignment_details: { unrelated: 'not returned' } }, signed_snapshot: null } });
const saveInput = () => ({ target: copy(TARGET), sectionKey: SECTION, value: value(), expectedRevision: 2 });
const saveResponse = () => ({ ok: true, account_id: TARGET.accountId, assignment_file_id: 37, section: { key: SECTION, ...section() } });
const previewInput = () => ({ accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId,
  contextRef: copy(CONTEXT), selection: { revision: 9, pockets: [] } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(reply = readResponse(), editor = () => KEY) {
  const requests = [], keys = [];
  const api = create({
    urlFor: path => `/injected${path}`,
    editorKeyForSave: (bound, options) => { keys.push({ bound, options }); return editor(bound, options); },
    request: async (url, init) => { requests.push({ url, init }); return typeof reply === 'function' ? reply(url, init) : json(reply); },
  });
  return { api, requests, keys };
}
const invalidResponse = error => error.workspaceCode === 'invalid_response' && error.message === 'custom_workspace_invalid_response';
const invalidTarget = error => error.workspaceCode === 'invalid_target';

test('actual GET envelope yields only a detached frozen target and prepared checkpoint; no cache is retained', async () => {
  let revision = 3;
  const f = fixture(() => { const body = readResponse(); body.workfile.sections[SECTION].revision = revision++; return json(body); });
  const sourceTarget = copy(TARGET), options = io(), first = await f.api.read(sourceTarget, options);
  sourceTarget.sessionKey = 'different-generation'; sourceTarget.accountId = 'different-account';
  assert.deepEqual(first, { target: TARGET, status: 'draft', section: { value: value(), revision: 3 } });
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.target)); assert.ok(Object.isFrozen(first.section));
  assert.ok(Object.isFrozen(first.section.value.active.selection.included_recorded_group_ids));
  assert.equal((await f.api.read(TARGET, options)).section.revision, 4);
  assert.equal(f.keys.length, 0); assert.equal(f.requests.length, 2);
  for (const { url, init } of f.requests) {
    assert.equal(url, '/injected/api/accounts/000123_ABC/assignment-files/37/workfile');
    assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.equal(init.signal, options.signal);
    assert.equal(init.body, undefined); assert.equal(init.headers['x-homenode-editor-key'], undefined);
    assert.ok(!JSON.stringify(init).includes(TARGET.sessionKey));
  }
});
test('only a genuinely missing section is absent; intentional empty checkpoint remains present', async () => {
  const body = readResponse(); delete body.workfile.sections[SECTION];
  const missing = await fixture(body).api.read(TARGET, io());
  assert.equal(missing.section, undefined); assert.equal(missing.status, 'draft');
  body.workfile.sections[SECTION] = { value: { workspace_version: 1, active: null, pending_capture: null }, revision: 4 };
  assert.deepEqual((await fixture(body).api.read(TARGET, io())).section, body.workfile.sections[SECTION]);
});
for (const status of ['draft', 'signed', 'archived']) {
  test(`known workfile status ${status} is preserved for host admission, not turned into editable status`, async () => {
    const body = readResponse(); body.workfile.status = status;
    const f = fixture(body), result = await f.api.read(TARGET, io());
    assert.equal(result.status, status); assert.equal(f.requests.length, 1); assert.equal(f.keys.length, 0);
  });
}
for (const [name, mutate] of [
  ['ok missing', b => { delete b.ok; }], ['ok false', b => { b.ok = false; }], ['ok string', b => { b.ok = 'true'; }],
  ['canonical account differs', b => { b.account_id = 'CANONICAL-ALIAS'; }], ['account missing', b => { delete b.account_id; }],
  ['account numeric', b => { b.account_id = 123; }], ['file differs', b => { b.workfile.assignment_file_id = 38; }],
  ['file string', b => { b.workfile.assignment_file_id = '37'; }], ['file zero', b => { b.workfile.assignment_file_id = 0; }],
  ['file fractional', b => { b.workfile.assignment_file_id = 37.5; }], ['file unsafe', b => { b.workfile.assignment_file_id = 9007199254740992; }],
  ['workfile missing', b => { delete b.workfile; }], ['workfile null', b => { b.workfile = null; }],
  ['sections missing', b => { delete b.workfile.sections; }], ['sections null', b => { b.workfile.sections = null; }],
  ['sections array', b => { b.workfile.sections = []; }], ['status missing', b => { delete b.workfile.status; }],
  ['status unknown', b => { b.workfile.status = 'approved'; }], ['status case changed', b => { b.workfile.status = 'SIGNED'; }],
  ['null checkpoint section', b => { b.workfile.sections[SECTION] = null; }],
  ['null checkpoint value', b => { b.workfile.sections[SECTION].value = null; }],
  ['malformed checkpoint', b => { b.workfile.sections[SECTION].value.workspace_version = 2; }],
  ['zero checkpoint revision', b => { b.workfile.sections[SECTION].revision = 0; }],
  ['wrong section key', b => { b.workfile.sections[SECTION].key = 'neighborhood_assessment'; }],
  ['extra saved metrics', b => { b.workfile.sections[SECTION].value.active.statistics = []; }],
]) {
  test(`read fails closed on ${name}`, async () => {
    const body = readResponse(); mutate(body);
    await assert.rejects(fixture(body).api.read(TARGET, io()), invalidResponse);
  });
}
for (const bad of [null, [], true, 'server private text']) {
  test(`read rejects non-envelope ${JSON.stringify(bad)}`, async () => {
    await assert.rejects(fixture(bad).api.read(TARGET, io()), invalidResponse);
  });
}
for (const patch of [
  { accountId: ' ALIAS ' }, { accountId: '' }, { accountId: 'A/B' }, { accountId: 'x'.repeat(51) },
  { assignmentFileId: '037' }, { assignmentFileId: '0' }, { assignmentFileId: '37.0' }, { assignmentFileId: 37 },
  { assignmentFileId: '9007199254740992' }, { assignmentFileId: '9223372036854775807' },
  { sessionKey: '' }, { sessionKey: ' leading' }, { sessionKey: 'bad\nkey' },
]) {
  test(`invalid legacy target ${JSON.stringify(patch)} never requests or obtains an editor key`, async () => {
    const bound = { ...TARGET, ...patch }, f = fixture(saveResponse());
    await assert.rejects(f.api.read(bound, io()), invalidTarget);
    await assert.rejects(f.api.save({ ...saveInput(), target: bound }, io()), invalidTarget);
    await assert.rejects(f.api.capture({ target: bound, operationId: OPERATION, observationPeriod: PERIOD }, io()), invalidTarget);
    assert.equal(f.requests.length, 0); assert.equal(f.keys.length, 0);
  });
}
test('largest safe numeric response identity is exact rather than rounded', async () => {
  const bound = { ...TARGET, assignmentFileId: String(Number.MAX_SAFE_INTEGER) }, body = readResponse();
  body.workfile.assignment_file_id = Number.MAX_SAFE_INTEGER;
  assert.equal((await fixture(body).api.read(bound, io())).target.assignmentFileId, bound.assignmentFileId);
});
test('save uses exact legacy payload/key and returns lifecycle ack with independently parsed value and revision', async () => {
  const f = fixture(saveResponse()), input = saveInput(), options = io(), ack = await f.api.save(input, options);
  assert.deepEqual(ack, { accountId: TARGET.accountId, assignmentFileId: '37', section: { value: value(), revision: 3 } });
  assert.ok(Object.isFrozen(ack)); assert.ok(Object.isFrozen(ack.section.value));
  assert.deepEqual(f.keys[0].bound, TARGET); assert.equal(f.keys[0].options, options);
  assert.ok(Object.isFrozen(f.keys[0].bound));
  const { url, init } = f.requests[0];
  assert.equal(url, '/injected/api/accounts/000123_ABC/assignment-files/37/workfile/sections/neighborhood_workspace');
  assert.equal(init.method, 'PUT'); assert.equal(init.cache, 'no-store'); assert.equal(init.signal, options.signal);
  assert.equal(init.headers['x-homenode-editor-key'], KEY);
  assert.deepEqual(JSON.parse(init.body), { value: value(), expected_revision: 2, save_reason: 'autosave' });
  for (const privateValue of [KEY, TARGET.sessionKey, 'synthetic-reviewer']) assert.ok(!JSON.stringify(ack).includes(privateValue));
});
test('save snapshots target, revision, and checkpoint before asynchronous key acquisition', async () => {
  const key = defer(), f = fixture(saveResponse(), () => key.promise), input = saveInput();
  const saving = f.api.save(input, io()); await tick();
  input.target.accountId = 'OTHER'; input.target.assignmentFileId = '99'; input.target.sessionKey = 'other-session';
  input.expectedRevision = 999; input.value.active.selection.revision = 999;
  key.resolve(KEY); const ack = await saving;
  assert.equal(ack.accountId, TARGET.accountId); assert.equal(ack.section.value.active.selection.revision, 9);
  assert.equal(JSON.parse(f.requests[0].init.body).expected_revision, 2);
});
test('save accepts reordered JSON object fields but not changed checkpoint semantics', async () => {
  const body = saveResponse(), initial = body.section.value;
  body.section.value = { pending_capture: initial.pending_capture, active: initial.active, workspace_version: 1 };
  assert.equal((await fixture(body).api.save(saveInput(), io())).section.revision, 3);
});
for (const [name, mutate] of [
  ['missing ok', b => { delete b.ok; }], ['false ok', b => { b.ok = false; }],
  ['different canonical account', b => { b.account_id = 'OTHER'; }],
  ['different file', b => { b.assignment_file_id = 38; }], ['string file', b => { b.assignment_file_id = '37'; }],
  ['unsafe file', b => { b.assignment_file_id = 9007199254740992; }],
  ['missing section', b => { delete b.section; }], ['null section', b => { b.section = null; }],
  ['different section key', b => { b.section.key = 'neighborhood_assessment'; }],
  ['stale revision', b => { b.section.revision = 2; }], ['skipped revision', b => { b.section.revision = 4; }],
  ['changed selection', b => { b.section.value.active.selection.revision = 10; }],
  ['changed context', b => { b.section.value.active.context_ref.context_sha256 = 'b'.repeat(64); }],
  ['malformed checkpoint', b => { b.section.value.active.selection.included_recorded_group_ids = ['unknown']; }],
]) {
  test(`save rejects ${name} acknowledgement`, async () => {
    const body = saveResponse(); mutate(body);
    await assert.rejects(fixture(body).api.save(saveInput(), io()), invalidResponse);
  });
}
for (const [name, mutate] of [
  ['other section', v => { v.sectionKey = 'assignment_details'; }], ['negative CAS', v => { v.expectedRevision = -1; }],
  ['fractional CAS', v => { v.expectedRevision = 1.2; }], ['string CAS', v => { v.expectedRevision = '2'; }],
  ['CAS overflow', v => { v.expectedRevision = 2147483647; }], ['malformed checkpoint', v => { v.value.active = {}; }],
]) {
  test(`invalid save ${name} is rejected before key acquisition or request`, async () => {
    const input = saveInput(); mutate(input); const f = fixture(saveResponse());
    await assert.rejects(f.api.save(input, io()), error => error.workspaceCode === 'invalid_input');
    assert.equal(f.requests.length, 0); assert.equal(f.keys.length, 0);
  });
}
test('capture emits only exact target, pending operation and period; source response goes to lifecycle admission', async () => {
  const result = { status: 'registered', reused: false, context_ref: CONTEXT, source_query_complete: true };
  const f = fixture(result), input = { target: TARGET, operationId: OPERATION, observationPeriod: PERIOD,
    auth: { userId: 'untrusted' }, assignment_file_id: 'wrong', account_id: 'wrong' };
  assert.deepEqual(await f.api.capture(input, io()), result);
  assert.equal(f.requests[0].url, '/injected/api/accounts/000123_ABC/neighborhood-cohort/capture');
  assert.deepEqual(JSON.parse(f.requests[0].init.body), { assignment_file_id: '37', operation_id: OPERATION, observation_period: PERIOD });
  assert.equal(f.keys.length, 0); assert.equal(f.requests[0].init.headers['x-homenode-editor-key'], undefined);
});
test('invalid operation or period cannot initiate capture', async () => {
  for (const changes of [{ operationId: 'bad' }, { observationPeriod: { ...PERIOD, end_date: '2023-02-29' } },
    { observationPeriod: { ...PERIOD, source: 'untrusted' } }]) {
    const f = fixture();
    await assert.rejects(f.api.capture({ target: TARGET, operationId: OPERATION, observationPeriod: PERIOD, ...changes }, io()),
      error => error.workspaceCode === 'invalid_input');
    assert.equal(f.requests.length, 0); assert.equal(f.keys.length, 0);
  }
});
for (const operation of ['catalog', 'preview']) {
  test(`${operation} preserves exact selection/context and actual shared transport shape without trusting the response`, async () => {
    const result = { observation: 'synthetic response retained for owner validation' }, f = fixture(result), options = io();
    const input = { ...previewInput(), include_map: false, auth: { userId: 'untrusted' }, reviewer: 'untrusted' };
    assert.deepEqual(await f.api[operation](input, options), result);
    assert.equal(f.requests[0].url, `/injected/api/accounts/000123_ABC/neighborhood-cohort/${operation}`);
    const expected = { assignment_file_id: '37', context_ref: CONTEXT, selection: input.selection };
    if (operation === 'preview') expected.include_map = false;
    else expected.include_recommendation = true;
    assert.deepEqual(JSON.parse(f.requests[0].init.body), expected);
    assert.equal(f.requests[0].init.signal, options.signal); assert.equal(f.requests[0].init.cache, 'no-store');
    assert.equal(f.keys.length, 0); assert.equal(f.requests[0].init.headers['x-homenode-editor-key'], undefined);
  });
}
test('preview preserves the existing cohort int64 string identity without generic workfile numeric narrowing', async () => {
  const f = fixture({ preview: 'owner validates this response' });
  const input = { ...previewInput(), assignmentFileId: '9223372036854775807', include_map: true };
  await f.api.preview(input, io());
  assert.equal(JSON.parse(f.requests[0].init.body).assignment_file_id, '9223372036854775807');
  assert.equal(f.requests[0].url, '/injected/api/accounts/000123_ABC/neighborhood-cohort/preview');
});
test('all HTTP methods sanitize private server messages while preserving HTTP status', async () => {
  const secret = 'raw provider evidence and private server credential';
  for (const operation of ['read', 'save', 'capture', 'catalog', 'preview']) {
    for (const status of [401, 403, 404, 409, 500, 503]) {
      const f = fixture(() => json({ error: secret }, status));
      const inputs = { read: TARGET, save: saveInput(), capture: { target: TARGET, operationId: OPERATION, observationPeriod: PERIOD },
        catalog: previewInput(), preview: { ...previewInput(), include_map: true } };
      await assert.rejects(f.api[operation](inputs[operation], io()), error => {
        assert.equal(error.message, 'custom_workspace_request_failed'); assert.equal(error.workspaceCode, 'request_failed');
        assert.equal(error.status, status); assert.equal(error.cause, undefined); assert.ok(!String(error.stack).includes(secret)); return true;
      });
      assert.equal(f.requests.length, 1, 'no implicit retry');
    }
  }
});
test('network, invalid JSON, wrong content type, and editor lookup failures expose no raw message', async () => {
  const cases = [
    fixture(() => { throw new Error('network-private'); }),
    fixture(() => new Response('{ private malformed', { headers: { 'content-type': 'application/json' } })),
    fixture(() => new Response('private HTML', { headers: { 'content-type': 'text/html' } })),
    fixture(saveResponse(), () => { throw new Error('editor-private'); }),
  ];
  for (let i = 0; i < cases.length; i++) {
    const f = cases[i];
    await assert.rejects(i === 3 ? f.api.save(saveInput(), io()) : f.api.read(TARGET, io()), error => {
      assert.equal(error.message, 'custom_workspace_request_failed'); assert.equal(error.status, undefined); return true;
    });
  }
});
test('cancelled key acquisition settles promptly and never saves with a late key', async () => {
  const key = defer(), controller = new AbortController(), f = fixture(saveResponse(), () => key.promise);
  const options = { signal: controller.signal, deadline: performance.now() + 60_000 };
  const saving = f.api.save(saveInput(), options); await tick();
  assert.equal(f.keys.length, 1); controller.abort();
  await assert.rejects(saving, error => error.name === 'AbortError' && error.message === 'Custom workspace request cancelled');
  key.resolve(KEY); await tick(); assert.equal(f.requests.length, 0);
});
test('already cancelled operations do not acquire a key or call injected request', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(), options = { signal: controller.signal, deadline: 1 };
  await assert.rejects(f.api.read(TARGET, options), { name: 'AbortError' });
  await assert.rejects(f.api.save(saveInput(), options), { name: 'AbortError' });
  assert.equal(f.requests.length, 0); assert.equal(f.keys.length, 0);
});
test('late GET cannot return a saved section after cancellation', async () => {
  const response = defer(), f = fixture(() => response.promise), controller = new AbortController();
  const reading = f.api.read(TARGET, { signal: controller.signal, deadline: performance.now() + 60_000 });
  await tick(); controller.abort(); await assert.rejects(reading, { name: 'AbortError' });
  response.resolve(json(readResponse())); await tick(); assert.equal(f.requests.length, 1);
});
