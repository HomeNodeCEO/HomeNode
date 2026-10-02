import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import express from 'express';
import { createSfrepDocumentRouter } from '../src/modules/assignmentFiles/sfrepRouter.js';
import { decideAssignmentAccess } from '../src/security/assignmentAccess.js';

const body = { assignment_file_id: 14, document_ids: [2], include_documents: true, form_id: 'FNMA-1004-0911' };
const identity = { userId: 'user-1', organizations: [{ organizationId: 'org-1', roles: ['appraiser'] }] };
const assignment = { organization_id: 'org-1', assigned_appraiser_user_id: 'user-1' };
async function start(context, overrides = {}, auth = identity) {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.mobileAuth = auth; next(); });
  app.use(createSfrepDocumentRouter({
    pool: { query: async () => ({ rows: [] }) }, objectStorage: {}, ensureAvailable: async () => {},
    requireWorkflowAccess: () => true, resolveAccountId: async () => 'account-1',
    requireAssignmentAccess: async (req, res, accountId, assignmentFileId, permission) => {
      calls.push([accountId, assignmentFileId, permission]);
      if (decideAssignmentAccess(req.mobileAuth, assignment, permission)) return true;
      res.status(403).json({ error: 'assignment_file_access_denied' }); return false;
    },
    readDocuments: async () => { calls.push('read'); return []; },
    buildPreview: () => ({ preview_digest: 'a'.repeat(64), filename: 'HomeNode-SFREP-file-14.rpti', reportXml: '<Report/>', pdfAddenda: [] }),
    buildPackage: async () => ({ content: Buffer.from('package') }),
    logger: { error() {} }, ...overrides,
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const request = (action = 'preview', value = body) => fetch(`http://127.0.0.1:${server.address().port}/api/accounts/account-1/sfrep/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
  });
  return { request, calls };
}

test('anonymous and foreign-organization requests cannot preview or download documents', async context => {
  for (const [auth, expected] of [[null, 401], [{ ...identity, organizations: [{ organizationId: 'org-2', roles: ['homenode_admin'] }] }, 403]]) {
    const fixture = await start(context, {}, auth);
    for (const action of ['preview', 'export']) {
      const response = await fixture.request(action, { ...body, ...(action === 'export' ? { preview_digest: 'a'.repeat(64) } : {}) });
      assert.equal(response.status, expected);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.ok(!fixture.calls.includes('read'));
  }
});

test('preview scopes to the assignment and omits package-only internals', async context => {
  const fixture = await start(context);
  const response = await fixture.request();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reportXml, undefined);
  assert.equal(result.pdfAddenda, undefined);
  assert.deepEqual(fixture.calls, [['account-1', 14, 'read'], 'read']);
  assert.equal((await fixture.request('preview', { ...body, document_ids: [2, 2] })).status, 400);
});

test('download has an attachment filename and stale preview is a retryable review conflict', async context => {
  const fixture = await start(context);
  const response = await fixture.request('export', { ...body, preview_digest: 'a'.repeat(64) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="HomeNode-SFREP-file-14.rpti"');
  const changed = await start(context, { buildPackage: async () => { throw new Error('sfrep_preview_changed'); } });
  assert.equal((await changed.request('export', { ...body, preview_digest: 'a'.repeat(64) })).status, 409);
});

test('unexpected storage errors remain bounded even if diagnostics fail', async context => {
  const fixture = await start(context, { buildPackage: async () => { throw new Error('private-storage-key'); },
    logger: { error() { throw new Error('logging failed'); } } });
  const response = await fixture.request('export', { ...body, preview_digest: 'a'.repeat(64) });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'sfrep_transfer_failed' });
});

test('concurrent exports for the same assignment are rejected and the slot is released', async context => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = await start(context, { buildPackage: async () => { started(); await gate; return { content: Buffer.from('package') }; } });
  const first = fixture.request('export', { ...body, preview_digest: 'a'.repeat(64) });
  await entered;
  try {
    assert.equal((await fixture.request('export', { ...body, preview_digest: 'a'.repeat(64) })).status, 429);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await fixture.request('export', { ...body, preview_digest: 'a'.repeat(64) })).status, 200);
});

// A deterministic response double models backpressure without depending on
// platform-specific TCP buffers swallowing the whole package on loopback.
function responseLifecycle(context, overrides = {}) {
  const responses = [], signals = [];
  class Response extends EventEmitter {
    statusCode = 200;
    headersSent = false;
    writableFinished = false;
    destroyed = false;
    constructor(autoFinish) { super(); this.autoFinish = autoFinish; }
    set() { return this; }
    status(code) { this.statusCode = code; return this; }
    json(value) { return this.send(value); }
    send(value) {
      this.body = value; this.headersSent = true;
      if (this.autoFinish) this.finish();
      return this;
    }
    finish() { this.writableFinished = true; this.emit('finish'); }
    destroy() { this.destroyed = true; this.emit('close'); return this; }
  }
  const router = createSfrepDocumentRouter({
    pool: { query: async () => ({ rows: [] }) }, objectStorage: {}, ensureAvailable: async () => {},
    requireWorkflowAccess: () => true, requireAssignmentAccess: async () => true,
    resolveAccountId: async () => 'account-1', readDocuments: async () => [],
    buildPreview: () => ({ preview_digest: 'a'.repeat(64), filename: 'test.rpti', reportXml: '<Report/>', pdfAddenda: [] }),
    buildPackage: async (_pool, _storage, _documents, _preview, _input, { signal }) => {
      signals.push(signal); return { content: Buffer.from('package') };
    }, logger: { error() {} }, ...overrides,
  });
  const handler = router.stack.find(layer => layer.route?.path.endsWith('/export')).route.stack[0].handle;
  context.after(() => { for (const response of responses) response.destroy(); });
  return { signals, async request(assignmentFileId = 14, autoFinish = false) {
    const response = new Response(autoFinish); responses.push(response);
    await handler({ mobileAuth: identity, params: { id: 'account-1' },
      body: { ...body, assignment_file_id: assignmentFileId, preview_digest: 'a'.repeat(64) } }, response);
    return response;
  } };
}

test('queued response bytes retain both per-assignment and global export slots until finish or close', async context => {
  const fixture = responseLifecycle(context);
  const first = await fixture.request(14);
  assert.equal(first.statusCode, 200); assert.equal(first.writableFinished, false);
  assert.equal((await fixture.request(14, true)).statusCode, 429);
  const second = await fixture.request(15);
  assert.equal(second.statusCode, 200);
  assert.equal((await fixture.request(16, true)).statusCode, 429);
  first.finish();
  assert.equal((await fixture.request(14, true)).statusCode, 200);
  assert.equal(first.listenerCount('finish'), 0); assert.equal(first.listenerCount('close'), 0);
  second.destroy();
  assert.equal(fixture.signals[1].aborted, true);
  assert.equal((await fixture.request(15, true)).statusCode, 200);
  assert.equal(second.listenerCount('finish'), 0); assert.equal(second.listenerCount('close'), 0);
});

test('a stalled download reaches its deadline, aborts, closes and releases its slot', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const fixture = responseLifecycle(context);
  const stalled = await fixture.request();
  context.mock.timers.tick(59_999);
  assert.equal(stalled.destroyed, false); assert.equal(fixture.signals[0].aborted, false);
  context.mock.timers.tick(1);
  assert.equal(stalled.destroyed, true); assert.equal(fixture.signals[0].aborted, true);
  assert.equal(stalled.listenerCount('finish'), 0); assert.equal(stalled.listenerCount('close'), 0);
  assert.equal((await fixture.request(14, true)).statusCode, 200);
});

test('pre-send failures and successful responses do not leak slots or deadlines', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const fixture = responseLifecycle(context, { buildPackage: async () => {
    if (++attempts === 1) throw new Error('sfrep_preview_changed');
    return { content: Buffer.from('package') };
  } });
  const refused = await fixture.request(14, true);
  assert.equal(refused.statusCode, 409);
  const successful = await fixture.request(14, true);
  assert.equal(successful.statusCode, 200);
  context.mock.timers.tick(60_000);
  assert.equal(refused.destroyed, false); assert.equal(successful.destroyed, false);
  assert.equal(refused.listenerCount('close'), 0); assert.equal(successful.listenerCount('close'), 0);
  assert.equal((await fixture.request(14, true)).statusCode, 200);
});
