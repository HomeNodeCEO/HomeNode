import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as catalogHelpers from '../src/features/neighborhood/customCohortPocketCatalog.ts';
import * as discovery from '../src/features/neighborhood/customWorkspaceDiscovery.ts';

const ts = createRequire(new URL('../package.json', import.meta.url))('typescript');
function compile(name, imports) {
  const file = fileURLToPath(new URL(`../src/features/neighborhood/${name}.ts`, import.meta.url));
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const module = { exports: {} };
  new Script(`(function(require,module,exports){${result.outputText}\n})`, { filename: file }).runInThisContext()(key => {
    assert.ok(Object.hasOwn(imports, key), `unexpected dependency: ${key}`); return imports[key];
  }, module, module.exports);
  return module.exports;
}
const checkpoint = compile('customWorkspaceCheckpoint', { './customCohortPocketCatalog': catalogHelpers,
  './customWorkspaceDiscovery.ts': discovery });
const transport = compile('customCohortPreviewTransport', {});
const { createCustomWorkspaceApi: createApi } = compile('customWorkspaceApi', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPreviewTransport': transport,
});
const { createCustomWorkspaceLifecycle: createLifecycle } = compile('customWorkspaceLifecycle', {
  './customWorkspaceCheckpoint': checkpoint, './customCohortPocketCatalog': catalogHelpers,
});
const REFUSALS = [
  [401, 'authentication_required', 'capture_authentication_required'],
  [403, 'neighborhood_access_denied', 'capture_access_denied'],
  [503, 'custom_neighborhood_workspace_disabled', 'capture_disabled'],
  [404, 'neighborhood_context_unavailable', 'capture_context_unavailable'],
  [422, 'neighborhood_source_unavailable', 'capture_source_unavailable'],
  [422, 'neighborhood_capture_capacity_exceeded', 'capture_capacity_exceeded'],
  [422, 'neighborhood_private_source_review_required', 'capture_private_source_review_required'],
  [422, 'neighborhood_private_source_limit', 'capture_private_source_limit'],
  [409, 'neighborhood_private_review_changed', 'capture_private_review_changed'],
  [409, 'neighborhood_private_source_read_only', 'capture_private_source_read_only'],
  [409, 'neighborhood_operation_conflict', 'capture_operation_conflict'],
  [409, 'neighborhood_subject_changed', 'capture_subject_changed'],
  [409, 'neighborhood_target_changed', 'capture_target_changed'],
  [409, 'neighborhood_market_policy_changed', 'capture_market_policy_changed'],
  [409, 'neighborhood_operation_outcome_unknown', 'capture_outcome_unknown'],
  [503, 'neighborhood_request_interrupted', 'capture_interrupted'],
  [503, 'neighborhood_service_busy', 'capture_service_busy'],
];
const TARGET = { accountId: 'SUBJECT', assignmentFileId: '37', sessionKey: 'capture-refusal-test' };
const PERIOD = { start_date: '2026-01-01', end_date: '2026-09-10' };
const OP = '10000000-0000-4000-8000-000000000001', OLD = '10000000-0000-4000-8000-000000000002';
const GROUP = `recorded-cad:${'a'.repeat(64)}`;
const context = id => ({ context_id: id, context_revision: '1', context_sha256: 'b'.repeat(64) });
const copy = value => structuredClone(value);
const initialSection = () => ({ revision: 5, value: { workspace_version: 1, active: { context_ref: context(OLD),
  observation_period: PERIOD, selection: { revision: 4, included_recorded_group_ids: [] } }, pending_capture: null } });
const input = () => ({ target: TARGET, operationId: OP, observationPeriod: PERIOD });
const io = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
const json = (value, status) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const previewInput = { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId,
  contextRef: context(OLD), selection: { revision: 1, pockets: [] } };
function apiFor(status, value) {
  const requests = [], api = createApi({ urlFor: path => path, editorKeyForSave: () => 'synthetic-editor',
    request: async (url, init) => { requests.push({ url, init }); return json(value, status); } });
  return { api, requests };
}
function rejection(code, status) {
  return error => {
    assert.equal(error.workspaceCode, code); assert.equal(error.message, `custom_workspace_${code}`);
    assert.equal(error.status, status); assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes('secret')); return true;
  };
}
for (const [status, serverCode, workspaceCode] of REFUSALS) {
  test(`exact capture refusal ${status}/${serverCode} preserves only fixed code and status`, async () => {
    const f = apiFor(status, { error: serverCode, detail: 'secret database/provider content' });
    await assert.rejects(f.api.capture(input(), io()), rejection(workspaceCode, status));
    assert.equal(f.requests.length, 1);
    for (const wrong of [400, 401, 403, 404, 409, 422, 500, 503].filter(value => value !== status)) {
      await assert.rejects(apiFor(wrong, { error: serverCode }).api.capture(input(), io()), rejection('request_failed', wrong));
    }
  });
  test(`${serverCode} does not widen other API methods or report Apply errors`, async () => {
    const f = apiFor(status, { error: serverCode, detail: 'secret' });
    const requests = [() => f.api.read(TARGET, io()),
      () => f.api.save({ target: TARGET, sectionKey: 'neighborhood_workspace', value: initialSection().value, expectedRevision: 5 }, io()),
      () => f.api.catalog(previewInput, io()), () => f.api.preview({ ...previewInput, include_map: true }, io()),
      () => f.api.members(previewInput, { group: 'selected', kind: 'stock' }, { limit: 50, after_member_id: null }, io()),
      () => f.api.reportedOperation({ target: TARGET, operation: 'reported-apply', body: {} }, io())];
    for (const request of requests) await assert.rejects(request(), rejection('request_failed', status));
    assert.equal(f.requests.length, requests.length);
  });
}
for (const value of ['authentication_required ', ' authentication_required', 'authentication_required\n',
  'authentication_required\r\n', 'authentication_required\t', 'authentication_required\u0000', 'authentication_required: secret',
  'AUTHENTICATION_REQUIRED', 'authentication_required_secret', ['authentication_required'], { error: 'authentication_required' }, null]) {
  test(`malformed or normalized-looking refusal is generic: ${JSON.stringify(value)}`, async () => {
    await assert.rejects(apiFor(401, { error: value }).api.capture(input(), io()), rejection('request_failed', 401));
  });
}
test('message fallback and unknown/report-only codes cannot become capture guidance', async () => {
  for (const [status, value] of [[401, { message: 'authentication_required' }],
    [409, { error: 'neighborhood_report_editor_changed' }], [409, { error: 'neighborhood_report_replacement_conflict' }],
    [503, { error: 'secret_source' }], [500, { error: 'neighborhood_request_failed' }]]) {
    await assert.rejects(apiFor(status, value).api.capture(input(), io()), rejection('request_failed', status));
  }
});
test('transport retains existing display message cleanup while machine-code extraction never normalizes it', async () => {
  const call = value => transport.createCustomCohortJsonTransport({ urlFor: path => path, request: async () => json(value, 401) })
    ('SUBJECT', 'capture', {}, io());
  await assert.rejects(call({ error: 'authentication_required\n' }), error => {
    assert.equal(error.message, 'authentication_required'); assert.equal(Object.hasOwn(error, 'errorCode'), false); return true;
  });
  await assert.rejects(call({ error: 'authentication_required' }), error => {
    assert.equal(error.message, 'authentication_required'); assert.equal(error.errorCode, 'authentication_required'); return true;
  });
});
function catalog(input) {
  return { status: 'catalog', subject_freshness: 'matched', target: { account_id: input.accountId, assignment_file_id: input.assignmentFileId },
    context_ref: copy(input.contextRef), selection_revision: input.selection.revision, apply: { status: 'blocked' }, catalog: {
      catalog_version: 1, status: 'review_only', apply: { status: 'blocked' },
      binding: { context_ref: copy(input.contextRef), selection_revision: input.selection.revision },
      pockets: [{ id: GROUP, label: 'Synthetic group', county: 'Synthetic', account_ids: ['SUBJECT'], member_count: 1, disposition: 'needs_review' }],
      unassigned: { account_ids: [], member_count: 0, reason_counts: [] },
      coverage: { discovery_member_count: 1, assigned_account_count: 1, unassigned_account_count: 0 },
      subject_membership: { account_id: 'SUBJECT', assigned_pocket_id: GROUP, recorded_label_match_only: true, status: 'matched' }, limitations: [],
    } };
}
for (const [status, serverCode, workspaceCode] of REFUSALS) test(`${serverCode} retains pending UUID/CAS/empty old study; only explicit recovery resumes it`, async () => {
  const initial = initialSection(), db = { section: copy(initial) }, calls = []; let failures = 1, ids = 0;
  const api = createApi({ urlFor: path => path, editorKeyForSave: () => assert.fail('no API saves in this fixture'),
    request: async (url, init) => {
      assert.match(url, /\/capture$/); const body = JSON.parse(init.body); calls.push({ kind: 'capture', body });
      return failures-- > 0 ? json({ error: serverCode, retry_same_operation: true }, status)
        : json({ status: 'registered', reused: true, context_ref: context(body.operation_id), source_query_complete: true,
          discovery: { radius_metres: '4828.032', account_count: 1, parcel_count: 1 } }, 200);
    } });
  const owner = createLifecycle({ target: TARGET, initialSection: initial, onChange() {}, operationId: () => { ids++; return OP; },
    capture: api.capture,
    save: async input => { calls.push({ kind: 'save', input: copy(input) }); assert.equal(input.expectedRevision, db.section.revision);
      db.section = { revision: input.expectedRevision + 1, value: copy(input.value) };
      return { accountId: TARGET.accountId, assignmentFileId: TARGET.assignmentFileId, section: copy(db.section) }; },
    catalog: async input => { calls.push({ kind: 'catalog' }); return catalog(input); },
  });
  try {
    await assert.rejects(owner.start(PERIOD), rejection(workspaceCode, status));
    assert.deepEqual(calls.map(c => c.kind), ['save', 'capture']); assert.equal(ids, 1);
    assert.deepEqual(db.section.value.active, initial.value.active); assert.equal(db.section.value.pending_capture.operation_id, OP);
    assert.equal(owner.getState().recovery, 'resume_pending'); assert.equal(owner.getState().error, workspaceCode);
    assert.equal(owner.isSettled(), true); assert.equal(db.section.revision, initial.revision + 1);
    await assert.rejects(owner.start({ ...PERIOD, start_date: '2025-01-01' }), error => error.workspaceCode === 'recovery_required');
    assert.equal(calls.length, 2); await owner.reload({ target: TARGET, section: copy(db.section) });
    assert.deepEqual(owner.getState().selection.pockets, []); assert.equal(calls.filter(c => c.kind === 'capture').length, 1);
    await owner.resumePending(); assert.equal(ids, 1);
    assert.deepEqual(calls.filter(c => c.kind === 'capture').map(c => c.body.operation_id), [OP, OP]);
    assert.equal(owner.getState().status, 'ready'); assert.equal(db.section.value.pending_capture, null);
    assert.equal(db.section.revision, initial.revision + 2);
  } finally { owner.dispose(); }
});
