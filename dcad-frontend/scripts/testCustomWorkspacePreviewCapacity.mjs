import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import * as transport from '../src/features/neighborhood/customCohortPreviewTransport.ts';
import * as catalog from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';

const ts = createRequire(new URL('../package.json', import.meta.url))('typescript');
function compile(name, imports) {
  const file = new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url);
  const result = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }), module = { exports: {} };
  new Script(`(function(require,module,exports){${result.outputText}\n})`).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), key); return imports[key];
  }, module, module.exports);
  return module.exports;
}
const checkpoint = compile('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalog,
  './customWorkspaceDiscovery.ts': discovery });
const { createCustomWorkspaceApi } = compile('customWorkspaceApi', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': transport,
});
const CODE = 'neighborhood_preview_capacity_exceeded';
const target = { accountId: 'SUBJECT', assignmentFileId: '37', sessionKey: 'synthetic-capacity' };
const period = { start_date: '2026-01-01', end_date: '2026-09-10' };
const operationId = '10000000-0000-4000-8000-000000000001';
const input = { accountId: target.accountId, assignmentFileId: target.assignmentFileId,
  contextRef: { context_id: operationId, context_revision: '1', context_sha256: 'a'.repeat(64) },
  selection: { revision: 7, pockets: [] } };
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60000 });
function fixture(status = 422, payload = { error: CODE, detail: 'SECRET retained data' }) {
  const calls = [];
  const api = createCustomWorkspaceApi({ urlFor: path => path, editorKeyForSave: () => 'synthetic-editor',
    request: async (url, init) => { calls.push({ url, init });
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }); } });
  return { api, calls };
}
const reads = {
  catalog: api => api.catalog(input, io()),
  preview: api => api.preview({ ...input, include_map: true }, io()),
  members: api => api.members(input, { group: 'selected', kind: 'stock' }, { limit: 50, after_member_id: null }, io()),
};
function refused(expected, status) {
  return error => {
    assert.equal(error.workspaceCode, expected); assert.equal(error.status, status);
    assert.equal(error.message, `custom_workspace_${expected}`); assert.equal(error.cause, undefined);
    assert.equal(transport.isCustomCohortPreviewCapacityError(error), expected === 'preview_capacity_exceeded');
    assert.doesNotMatch(String(error.stack), /SECRET/); return true;
  };
}
for (const [name, read] of Object.entries(reads)) {
  test(`${name} maps only exact settled 422 capacity; one request and no automatic retry`, async () => {
    const f = fixture(); await assert.rejects(read(f.api), refused('preview_capacity_exceeded', 422));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(JSON.parse(f.calls[0].init.body).selection, input.selection);
  });
  test(`${name} wrong HTTP status remains generic`, async () => {
    for (const status of [400, 401, 403, 404, 409, 413, 500, 503]) {
      await assert.rejects(read(fixture(status).api), refused('request_failed', status));
    }
  });
  test(`${name} malformed, normalized-looking and unknown error bodies remain generic`, async () => {
    for (const payload of [{ error: `${CODE} ` }, { error: ` ${CODE}` }, { error: `${CODE}\n` },
      { error: `${CODE}\u0000` }, { error: CODE.toUpperCase() }, { error: `${CODE}_SECRET` },
      { error: [CODE] }, { error: { code: CODE } }, { message: CODE }, { error: null }, [CODE], null,
      { error: 'invalid_neighborhood_request', message: CODE }, { error: 'SECRET database content' }]) {
      await assert.rejects(read(fixture(422, payload).api), refused('request_failed', 422));
    }
  });
}
test('capacity response does not alter capture, section, editor, proposal or Apply failures', async () => {
  const f = fixture(), value = { workspace_version: 1, active: null, pending_capture: null };
  for (const run of [() => f.api.capture({ target, operationId, observationPeriod: period }, io()),
    () => f.api.read(target, io()), () => f.api.readReportEditor(target, io()),
    () => f.api.save({ target, sectionKey: 'neighborhood_workspace', value, expectedRevision: 0 }, io()),
    ...['reported-proposal', 'reported-apply'].map(operation => () => f.api.reportedOperation({ target, operation, body: {} }, io()))]) {
    await assert.rejects(run(), refused('request_failed', 422));
  }
  assert.equal(f.calls.length, 6);
});
test('network rejection cannot forge a settled capacity response; aborted reads stay aborted', async () => {
  const forged = Object.assign(new Error(CODE), { status: 422, errorCode: CODE });
  const api = createCustomWorkspaceApi({ urlFor: path => path, editorKeyForSave: () => 'synthetic-editor', request: async () => { throw forged; } });
  for (const read of Object.values(reads)) await assert.rejects(read(api), refused('request_failed', undefined));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fixture().api.preview({ ...input, include_map: true }, { signal: abort.signal }), { name: 'AbortError' });
});
