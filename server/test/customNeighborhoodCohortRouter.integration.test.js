import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { prepareCustomCohortContextReference } from '../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { assessmentDate, canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';

const auth = { userId: 'authenticated-appraiser', organizations: [{ organizationId: 'org', roles: ['appraiser'] }] };
const contextRef = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const assignment = '9007199254740993';
const selection = { revision: 2, pockets: [] };
const bodies = {
  capture: { assignment_file_id: assignment, operation_id: contextRef.context_id,
    observation_period: { start_date: '2024-01-01', end_date: '2024-06-30' } },
  preview: { assignment_file_id: assignment, context_ref: contextRef, selection, include_map: false },
  catalog: { assignment_file_id: assignment, context_ref: contextRef, selection },
  members: { assignment_file_id: assignment, context_ref: contextRef, selection,
    population: { group: 'selected', kind: 'stock' }, page: { limit: 20, after_member_id: null } },
};
async function start(t, { principal = auth, methods = {}, parsed = false } = {}) {
  const calls = [], fallthroughErrors = [];
  const service = Object.fromEntries(['capture', 'present', 'inspect', 'catalog'].map(name => [name, methods[name] ?? (async (...args) => {
    calls.push({ name, args }); return { status: name, marker: 'compact-only' };
  })]));
  service.preview = () => assert.fail('raw preview must never reach HTTP');
  const app = express();
  app.use((req, _res, next) => { req.mobileAuth = principal; next(); });
  if (parsed) app.use(express.json({ limit: 10_000_000 }));
  app.use(createCustomNeighborhoodCohortRouter({ cohortService: service }));
  app.post('/api/unrelated-report', (_req, res) => res.json({ owner: 'unrelated-report' }));
  app.use((error, req, res, _next) => {
    fallthroughErrors.push({ error, path: req.path });
    res.status(400).set('x-test-error-owner', 'application').json({ error: 'application_json_invalid' });
  });
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/accounts/R-001/neighborhood-cohort`;
  const request = (action, body = bodies[action], extra = {}) => fetch(`${url}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...extra,
  });
  return { request, calls, origin, fallthroughErrors };
}

test('cohort router requires actual display/inspection owner methods', () => {
  assert.throws(() => createCustomNeighborhoodCohortRouter({
    cohortService: { capture() {}, preview() {} } }), /dependencies_required/);
});

test('capture forwards only the explicit private batch reference; omitted old requests stay unchanged', async t => {
  const { request, calls } = await start(t);
  const private_sales_import = { batch_id: '20000000-0000-4000-8000-000000000001', expected_review_revision: 3 };
  assert.equal((await request('capture', { ...bodies.capture, private_sales_import })).status, 200);
  assert.deepEqual(calls[0].args[0].privateSalesImport, private_sales_import);
  assert.equal((await request('capture')).status, 200);
  assert.equal(Object.hasOwn(calls[1].args[0], 'privateSalesImport'), false);
  assert.equal((await request('capture', { ...bodies.capture, private_sales_import, source_rows: [] })).status, 400);
  assert.equal(calls.length, 2);
});

for (const [code, status, error] of [
  ['assignment_sales_import_revision_conflict', 409, 'neighborhood_private_review_changed'],
  ['assignment_sales_import_capture_changed', 409, 'neighborhood_private_review_changed'],
  ['assignment_sales_import_source_not_reviewed', 422, 'neighborhood_private_source_review_required'],
  ['assignment_sales_import_source_use_not_confirmed', 422, 'neighborhood_private_source_review_required'],
  ['assignment_sales_import_preparation_limit', 422, 'neighborhood_private_source_limit'],
]) test(`private capture ${code} returns an actionable bounded response without private details`, async t => {
  const { request } = await start(t, { methods: { capture() { throw Object.assign(new Error('private database details'), { code }); } } });
  const response = await request('capture'); assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
});
test('cohort endpoints preserve exact IDs, principal and explicit empty selection', async t => {
  const { request, calls } = await start(t);
  for (const action of ['capture', 'preview', 'members', 'catalog']) {
    const response = await request(action);
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).marker, 'compact-only');
  }
  assert.deepEqual(calls.map(call => call.name), ['capture', 'present', 'inspect', 'catalog']);
  for (const { args } of calls) {
    assert.equal(args[0].auth, auth); assert.equal(args[0].assignmentFileId, assignment);
    assert.equal(args[0].accountId, 'R-001');
    assert.ok(args.at(-1).signal instanceof AbortSignal);
  }
  assert.deepEqual(calls[1].args[0].selection, selection);
  assert.deepEqual(calls[1].args[1], { includeMap: false });
  assert.deepEqual(calls[2].args[1], { population: bodies.members.population, page: bodies.members.page });
  assert.deepEqual(calls[3].args[0].contextRef, contextRef);
  assert.deepEqual(calls[3].args[0].selection, selection);
  assert.equal(calls[3].args.length, 2);
});
test('body auth, source authority, numeric file IDs and unknown fields never reach owner', async t => {
  const { request, calls } = await start(t);
  for (const key of ['auth', 'organization_id', 'source_rows', 'source_grant', 'target']) {
    assert.equal((await request('preview', { ...bodies.preview, [key]: {} })).status, 400);
  }
  for (const id of [9007199254740992, '01', '9223372036854775808', null]) {
    assert.equal((await request('preview', { ...bodies.preview, assignment_file_id: id })).status, 400);
  }
  assert.equal((await request('preview', { ...bodies.preview, include_map: 'false' })).status, 400);
  assert.equal(calls.length, 0);
});

test('catalog recommendation flag is optional, boolean-only, and forwarded without identity or grant overrides', async t => {
  const { request, calls } = await start(t);
  for (const value of [true, false]) {
    const response = await request('catalog', { ...bodies.catalog, include_recommendation: value });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const input = calls.at(-1).args[0];
    assert.equal(input.includeRecommendation, value); assert.equal(input.auth, auth);
    assert.equal(input.accountId, 'R-001'); assert.equal(input.assignmentFileId, assignment);
  }
  const count = calls.length;
  for (const value of [null, 'true', 1, [], {}]) {
    assert.equal((await request('catalog', { ...bodies.catalog, include_recommendation: value })).status, 400);
  }
  assert.equal((await request('catalog', { ...bodies.catalog, include_recommendation: true, summary_grant: true })).status, 400);
  assert.equal((await request('preview', { ...bodies.preview, include_recommendation: true })).status, 400);
  assert.equal(calls.length, count);
});

test('optional catalog recommendation response is still bounded by the complete catalog transport limit', async t => {
  const { request } = await start(t, { methods: { catalog: async () => ({ status: 'catalog',
    catalog: { marker: 'membership-not-clipped' }, recommendation: { marker: 'x'.repeat(4_000_000) } }) } });
  const response = await request('catalog', { ...bodies.catalog, include_recommendation: true });
  assert.equal(response.status, 422); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'neighborhood_catalog_incomplete', reason: 'catalog_response_byte_limit', membership_returned: false });
});
test('anonymous requests cannot parse/read source or reach the owner', async t => {
  const { request, calls } = await start(t, { principal: null });
  const response = await request('capture', { ...bodies.capture, auth });
  assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'authentication_required' });
  assert.equal(calls.length, 0);
});
test('cohort error responses hide SQL/policy details and distinguish uncertain commits', async t => {
  const reasons = [
    ['assignment_access_denied', 403, 'neighborhood_access_denied'],
    ['market_data_access_denied', 403, 'neighborhood_access_denied'],
    ['context_unavailable', 404, 'neighborhood_context_unavailable'],
    ['subject_changed', 409, 'neighborhood_subject_changed'],
    ['market_policy_changed', 409, 'neighborhood_market_policy_changed'],
    ['source_incomplete', 422, 'neighborhood_source_unavailable'],
    ['deadline_exceeded', 503, 'neighborhood_request_interrupted'],
    ['unknown_database_error', 500, 'neighborhood_request_failed'],
  ];
  let failure;
  const { request } = await start(t, { methods: { capture: async () => { throw failure; } } });
  for (const [reason, status, code] of reasons) {
    failure = Object.assign(new Error('SQL password-sensitive diagnostic'), { reason, detail: 'private source' });
    const response = await request('capture'); assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
  }
  failure = Object.assign(new Error('connection lost'), { outcome_unknown: true });
  const response = await request('capture'); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true });
  for (const error of [new Error('custom_cohort_context_invalid_reference'), new Error('custom_cohort_context_invalid_shape'),
    new TypeError('invalid_neighborhood_assessment:effective_date'), new TypeError('custom_cohort_observation_preview_pockets_limit')]) {
    failure = error;
    const invalidResponse = await request('capture'); assert.equal(invalidResponse.status, 400);
    assert.deepEqual(await invalidResponse.json(), { error: 'invalid_neighborhood_request' });
  }
});
test('malformed and oversized JSON are bounded even after an existing parser', async t => {
  const direct = await start(t), alreadyParsed = await start(t, { parsed: true });
  assert.equal((await direct.request('preview', null, { body: '{broken' })).status, 400);
  const oversized = { ...bodies.preview, selection: { revision: 1, pockets: ['x'.repeat(4_000_001)] } };
  for (const server of [direct, alreadyParsed]) {
    const response = await server.request('preview', oversized); assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'neighborhood_request_too_large' });
    assert.equal(server.calls.length, 0);
  }
});
test('real context, date and canonical-size validation errors remain private client errors', async t => {
  let observed;
  const validate = fn => async input => {
    try { fn(input); return { unexpected: 'valid' }; }
    catch (error) { observed = error; throw error; }
  };
  const { request, fallthroughErrors } = await start(t, { methods: {
    capture: validate(input => assessmentDate(input.observationPeriod.start_date)),
    present: validate(input => {
      prepareCustomCohortContextReference(canonicalAssessmentJson(input.contextRef));
      canonicalAssessmentJson(input.selection);
    }),
  } });
  // Invoke real validators rather than manufacturing their message/class shape.
  // This tests the transport error contract, not source/assignment authorization.
  for (const [action, body, message, isTypeError] of [
    ['capture', { ...bodies.capture, observation_period: { start_date: '2024-02-30', end_date: '2024-06-30' } },
      'invalid_neighborhood_assessment:effective_date', true],
    ['preview', { ...bodies.preview, context_ref: { context_id: contextRef.context_id } },
      'custom_cohort_context_invalid_shape', false],
    ['preview', { ...bodies.preview, context_ref: { ...contextRef, context_id: 'not-a-uuid' } },
      'custom_cohort_context_invalid_identity', false],
    ['preview', { ...bodies.preview, context_ref: { ...contextRef, context_sha256: 'not-a-hash' } },
      'custom_cohort_context_invalid_reference', false],
    ['preview', { ...bodies.preview, context_ref: { ...contextRef, context_sha256: 'x'.repeat(4_100) } },
      'custom_cohort_context_input_limit', false],
    ['preview', { ...bodies.preview, selection: { revision: 1, pockets: ['x'.repeat(1_500_001)] } },
      'invalid_neighborhood_assessment:json_bytes', true],
  ]) {
    observed = null;
    const response = await request(action, body);
    assert.equal(response.status, 400, message);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'invalid_neighborhood_request' });
    assert.ok(observed instanceof Error, 'the actual validator must have executed');
    assert.equal(observed instanceof TypeError, isTypeError, message);
    assert.equal(observed.message, message);
  }
  assert.equal(fallthroughErrors.length, 0, 'cohort validation stays inside its route owner');
});

test('unrelated upstream parser errors pass through without neighborhood relabeling', async t => {
  const { request, origin, calls, fallthroughErrors } = await start(t, { parsed: true });
  for (const path of ['/api/unrelated-report', '/api/accounts/R-001/neighborhood-cohort-other/preview']) {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-test-error-owner'), 'application');
    assert.deepEqual(await response.json(), { error: 'application_json_invalid' });
    assert.equal(fallthroughErrors.at(-1).path, path);
    assert.equal(fallthroughErrors.at(-1).error.type, 'entity.parse.failed');
  }
  assert.equal(fallthroughErrors.length, 2);
  // Express skips a nested normal router when the app's preceding parser has
  // already failed, even for a cohort URL. The app still owns that exception.
  const upstreamCohortFailure = await request('preview', null, { body: '{broken' });
  assert.equal(upstreamCohortFailure.status, 400);
  assert.equal(upstreamCohortFailure.headers.get('x-test-error-owner'), 'application');
  assert.deepEqual(await upstreamCohortFailure.json(), { error: 'application_json_invalid' });
  assert.equal(fallthroughErrors.length, 3);
  const direct = await start(t);
  const ownFailure = await direct.request('preview', null, { body: '{broken' });
  assert.equal(ownFailure.status, 400);
  assert.equal(ownFailure.headers.get('x-test-error-owner'), null);
  assert.deepEqual(await ownFailure.json(), { error: 'invalid_neighborhood_request' });
  assert.equal(direct.fallthroughErrors.length, 0, 'the neighborhood-owned parser handles its own matching errors');
  assert.equal(calls.length, 0);
  const normal = await fetch(`${origin}/api/unrelated-report`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.deepEqual(await normal.json(), { owner: 'unrelated-report' });
});

test('disconnect cancels in-flight preview and removes request listeners', async t => {
  let observed, started;
  const running = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { observed = resolve; });
  const { request } = await start(t, { methods: { present: async (_input, _presentation, { signal }) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', () => { observed(signal.aborted); resolve(); }, { once: true }));
    return { never: 'sent' };
  } } });
  const controller = new AbortController();
  const response = request('preview', bodies.preview, { signal: controller.signal });
  await running; controller.abort(); await assert.rejects(response, { name: 'AbortError' });
  assert.equal(await cancelled, true);
});

test('catalog denies unauthenticated access and refuses client source identity before its owner', async t => {
  const anonymous = await start(t, { principal: null });
  const denied = await anonymous.request('catalog');
  assert.equal(denied.status, 401); assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.equal(anonymous.calls.length, 0);
  const owned = await start(t);
  for (const key of ['auth', 'organization_id', 'account_ids', 'source_rows', 'retained_inputs', 'include_map']) {
    const response = await owned.request('catalog', { ...bodies.catalog, [key]: 'client authority' });
    assert.equal(response.status, 400); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(owned.calls.length, 0);
});

test('catalog ignores query identity and passes only exact route/file/session identity to its owner', async t => {
  const { calls, origin } = await start(t);
  const response = await fetch(`${origin}/api/accounts/R-001/neighborhood-cohort/catalog?account_id=OTHER&assignment_file_id=42&auth=FORGED`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies.catalog),
  });
  assert.equal(response.status, 200); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args[0], { auth, accountId: 'R-001', assignmentFileId: assignment, contextRef, selection });
});

test('catalog policy and freshness errors are private and all statuses remain no-store', async t => {
  let failure;
  const { request } = await start(t, { methods: { catalog: async () => { throw failure; } } });
  for (const [reason, status, error] of [
    ['assignment_access_denied', 403, 'neighborhood_access_denied'],
    ['market_data_access_denied', 403, 'neighborhood_access_denied'],
    ['market_policy_changed', 409, 'neighborhood_market_policy_changed'],
    ['subject_changed', 409, 'neighborhood_subject_changed'],
    ['target_changed', 409, 'neighborhood_target_changed'],
    ['context_unavailable', 404, 'neighborhood_context_unavailable'],
    ['cancelled', 503, 'neighborhood_request_interrupted'],
    ['stock_roster_mismatch', 500, 'neighborhood_request_failed'],
  ]) {
    failure = Object.assign(new Error('private retained source diagnostic'), { reason });
    const response = await request('catalog');
    assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error });
  }
});

test('catalog returns complete or explicit incomplete owner results without clipping memberships', async t => {
  let result;
  const { request } = await start(t, { methods: { catalog: async () => result } });
  for (const status of ['review_only', 'incomplete']) {
    result = { status: 'catalog', context_ref: contextRef, selection_revision: selection.revision,
      catalog: { status, catalog_complete: status === 'review_only', pockets: [],
        unassigned: { account_ids: ['0001', 'r-002'], member_count: 2 },
        reasons: status === 'incomplete' ? ['pocket_count_limit'] : [] }, apply: { status: 'blocked' } };
    const response = await request('catalog');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), result);
  }
});

test('catalog enforces actual UTF-8 response bytes and returns no partial roster on transport overflow', async t => {
  let result;
  const { request } = await start(t, { methods: { catalog: async () => {
    if (result instanceof Error) throw result; return result;
  } } });
  // Multibyte text proves the limit is bytes rather than JS string length.
  for (const overflow of [{ text: 'é'.repeat(2_000_000) },
    Object.assign(new Error('private oversized roster'), { reason: 'catalog_transport_limit' })]) {
    result = overflow;
    const response = await request('catalog');
    assert.equal(response.status, 422); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'neighborhood_catalog_incomplete',
      reason: 'catalog_response_byte_limit', membership_returned: false });
  }
  result = { text: 'x'.repeat(4_000_000 - Buffer.byteLength(JSON.stringify({ text: '' }))) };
  const boundary = await request('catalog');
  assert.equal(boundary.status, 200); assert.equal(Buffer.byteLength(await boundary.text()), 4_000_000);
});

test('disconnect cancels catalog authorization work through the same owner signal', async t => {
  let started, aborted;
  const running = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const { request } = await start(t, { methods: { catalog: async (_input, { signal }) => {
    started(); await new Promise(resolve => signal.addEventListener('abort', () => {
      aborted(signal.aborted); resolve();
    }, { once: true }));
    return { never: 'sent' };
  } } });
  const controller = new AbortController();
  const response = request('catalog', bodies.catalog, { signal: controller.signal });
  await running; controller.abort(); await assert.rejects(response, { name: 'AbortError' });
  assert.equal(await cancelled, true);
});
