import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCustomNeighborhoodCohortRouter } from '../src/modules/accounts/customNeighborhoodCohortRouter.js';

const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const body = { assignment_file_id: '41', context_ref: context, expected_workspace_revision: 9, expected_editor_revision: 0,
  operation_id: '80000000-0000-4000-8000-000000000001' };
const auth = { userId: '10000000-0000-4000-8000-000000000001', organizations: [] };
async function setup(t, { failure = null, principal = auth } = {}) {
  const calls = [], app = express();
  app.use((req, _res, next) => { req.mobileAuth = principal; next(); });
  const callback = name => async (...args) => { calls.push({ name, args }); if (failure) throw failure; return { status: name }; };
  app.use(createCustomNeighborhoodCohortRouter({ cohortService: {
    capture: callback('capture'), catalog: callback('catalog'), present: callback('present'), inspect: callback('inspect'),
    prepareReportedObservations: callback('proposed'), applyReportedObservations: callback('accepted'),
  } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, request: (action, value) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/R-001/neighborhood-cohort/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  }) };
}
test('proposal transport forwards only exact saved-intent identifiers and authenticated principal', async t => {
  const f = await setup(t), response = await f.request('reported-proposal', body);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.calls[0].args[0], { auth, accountId: 'R-001', assignmentFileId: '41', contextRef: context,
    expectedWorkspaceRevision: 9, expectedEditorRevision: 0, operationId: body.operation_id });
  assert.ok(f.calls[0].args[1].signal instanceof AbortSignal);
});
test('Apply transport requires the full explicit adoption binding, never raw report data', async t => {
  const f = await setup(t), extra = { proposal_operation_id: body.operation_id,
    attachment_id: '90000000-0000-4000-8000-000000000001', attachment_revision: 1, binding_digest: 'b'.repeat(64), adopt: true };
  assert.equal((await f.request('reported-apply', { ...body, ...extra })).status, 200);
  assert.deepEqual(f.calls[0].args[0], { auth, accountId: 'R-001', assignmentFileId: '41', contextRef: context,
    expectedWorkspaceRevision: 9, expectedEditorRevision: 0, operationId: body.operation_id,
    proposalOperationId: extra.proposal_operation_id, attachmentId: extra.attachment_id,
    attachmentRevision: 1, bindingDigest: extra.binding_digest, adopt: true });
  assert.equal((await f.request('reported-apply', { ...body, ...extra, assessment: {} })).status, 400);
  assert.equal((await f.request('reported-apply', body)).status, 400); assert.equal(f.calls.length, 1);
});
for (const key of ['auth', 'selection', 'source_rows', 'statistics', 'report_geography', 'ready']) test(`proposal rejects browser ${key}`, async t => {
  const f = await setup(t); assert.equal((await f.request('reported-proposal', { ...body, [key]: {} })).status, 400);
  assert.equal(f.calls.length, 0);
});
for (const [reason, status, code] of [
  ['report_observation_access_denied', 403, 'neighborhood_access_denied'],
  ['report_policy_changed', 409, 'neighborhood_report_policy_changed'],
  ['report_editor_changed', 409, 'neighborhood_report_editor_changed'],
  ['report_proposal_changed', 409, 'neighborhood_report_proposal_changed'],
  ['workspace_changed', 409, 'neighborhood_workspace_changed'],
  ['report_group_conflict', 409, 'neighborhood_report_group_conflict'],
]) test(`sanitized ${reason} remains actionable`, async t => {
  const f = await setup(t, { failure: Object.assign(new Error('private original record detail'), { reason }) });
  const response = await f.request('reported-proposal', body); assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error: code });
});
test('unknown COMMIT retains existing409 same-operation recovery contract', async t => {
  const f = await setup(t, { failure: Object.assign(new Error('private error'), { outcome_unknown: true }) });
  const response = await f.request('reported-proposal', body); assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'neighborhood_operation_outcome_unknown', retry_same_operation: true });
});
test('unauthenticated requests never invoke the owner', async t => {
  const f = await setup(t, { principal: null }); assert.equal((await f.request('reported-proposal', body)).status, 401);
  assert.equal(f.calls.length, 0);
});
