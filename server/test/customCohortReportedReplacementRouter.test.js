import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';

const principal = { userId: '10000000-0000-4000-8000-000000000001', organizations: [] };
const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const proposal = { assignment_file_id: '41', context_ref: context, expected_workspace_revision: 9,
  expected_editor_revision: 1, operation_id: '80000000-0000-4000-8000-000000000001' };
const intent = { kind: 'accepted_custom_reported_group' };
const replacement = { ...intent, predecessor: { acceptance_id: '90000000-0000-4000-8000-000000000001',
  operation_id: '90000000-0000-4000-8000-000000000002', accepted_editor_revision: 1, section_value_sha256: 'b'.repeat(64) } };
const apply = { ...proposal, proposal_operation_id: proposal.operation_id,
  attachment_id: '90000000-0000-4000-8000-000000000003', attachment_revision: 1, binding_digest: 'c'.repeat(64), adopt: true };

async function setup(t, { auth = principal, failure = null } = {}) {
  const app = express(), calls = [];
  app.use((req, _res, next) => { req.mobileAuth = auth; next(); });
  const execute = async (input, options) => { calls.push({ input, options }); if (failure) throw failure;
    return { status: 'synthetic', replacement }; };
  app.use(createCustomNeighborhoodCohortRouter({ cohortService: { capture: execute, present: execute,
    inspect: execute, catalog: execute, prepareReportedObservations: execute, applyReportedObservations: execute } }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, request: (action, body) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/R-001/neighborhood-cohort/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) };
}

for (const [action, body, expected] of [['reported-proposal', proposal, intent], ['reported-apply', apply, replacement]]) {
  test(`${action} forwards explicit replacement intent, not a browser principal or facts`, async t => {
    const h = await setup(t), response = await h.request(action, { ...body, replacement: expected });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json()).replacement, replacement);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].input.replacement, expected);
    assert.deepEqual(h.calls[0].input.auth, principal); assert.equal(h.calls[0].input.accountId, 'R-001');
    assert.equal(h.calls[0].input.assignmentFileId, '41'); assert.ok(h.calls[0].options.signal instanceof AbortSignal);
  });
  test(`${action} does not infer replacement when omitted`, async t => {
    const h = await setup(t); assert.equal((await h.request(action, body)).status, 200);
    assert.equal(Object.hasOwn(h.calls[0].input, 'replacement'), false);
  });
  test(`${action} rejects forged top-level replacement facts and unauthenticated requests`, async t => {
    const h = await setup(t);
    for (const key of ['auth', 'existing_values', 'predecessor_receipt', 'allow_overwrite', 'statistics']) {
      assert.equal((await h.request(action, { ...body, replacement: expected, [key]: {} })).status, 400);
    }
    assert.equal(h.calls.length, 0);
    const anonymous = await setup(t, { auth: null });
    assert.equal((await anonymous.request(action, { ...body, replacement: expected })).status, 401);
    assert.equal(anonymous.calls.length, 0);
  });
}

for (const [reason, status, error] of [['invalid_reported_input', 400, 'invalid_neighborhood_request'],
  ['report_replacement_conflict', 409, 'neighborhood_report_replacement_conflict']]) {
  test(`replacement owner ${reason} is sanitized`, async t => {
    const h = await setup(t, { failure: Object.assign(new Error('private predecessor/source data'), { reason }) });
    const response = await h.request('reported-apply', { ...apply, replacement });
    assert.equal(response.status, status); assert.deepEqual(await response.json(), { error });
  });
}
