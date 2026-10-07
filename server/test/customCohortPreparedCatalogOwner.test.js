import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortPreparedCatalogOwner } from '../src/services/neighborhoodAssessment/customCohortPreparedCatalogOwner.js';
import { customCohortPreparedCatalogSqlFixture as fixture } from './fixtures/customCohortPreparedCatalogSqlFixture.js';

function setup() {
  const h = fixture(), calls = [], auth = { userId: 'synthetic-actor', organizations: [] };
  let rejectEnding = false;
  const owner = createCustomCohortPreparedCatalogOwner({
    identityOf: value => ({ auth: structuredClone(value.auth), accountId: value.accountId, assignmentFileId: value.assignmentFileId }),
    execute: async (input, options, writing, work, projection) => {
      calls.push({ input, writing, projection });
      const result = await work({ client: h.client, scopeJson: json(h.f.scope), budget: { signal: options.signal,
        check() { if (options.signal?.aborted) throw new Error('synthetic_cancelled'); } } });
      if (rejectEnding) throw new Error('synthetic_ending_rights_denied');
      return result;
    },
  });
  const read = { auth, accountId: h.f.scope.account_id, assignmentFileId: h.f.scope.assignment_file_id, contextRef: h.f.context };
  return { h, calls, owner, read, endingDenied: () => { rejectEnding = true; } };
}

test('closed owner returns an explicit cache miss without compiling or writing; reads stay read-only', async () => {
  const f = setup(), out = await f.owner.openPreparedRecordedCatalog(f.read);
  assert.equal(out.status, 'not_prepared'); assert.equal(out.catalog, null); assert.equal(out.authority, 'not_established');
  assert.deepEqual(out.context_ref, f.read.contextRef); assert.equal(f.calls[0].writing, false);
  assert.equal(f.h.originals.size, 0);
  assert.ok(!f.h.calls.some(c => /registry:(originals|insert|pins)|blob:insert/.test(c.sql)));
});

test('whole membership commands choose an independent internal projection and do not masquerade as a selected head', async () => {
  const f = setup();
  assert.deepEqual(await f.owner.prepareRecordedCatalogMembership(f.read), {
    authority: 'not_established', target: { account_id: f.read.accountId, assignment_file_id: f.read.assignmentFileId },
    context_ref: f.read.contextRef, status: 'prepared' });
  assert.deepEqual(f.calls.map(c => [c.writing,c.projection]), [[true,'membership']]);
  const originals = [...f.h.originals], from = f.h.calls.length;
  const out = await f.owner.reopenPreparedRecordedCatalogMembership(f.read);
  assert.equal(out.status,'available'); assert.equal(out.membership.status,'complete_catalog_membership');
  assert.equal(out.membership.account_count,f.h.f.preview.all.account_ids.length);
  assert.equal(out.authority,'not_established'); assert.equal(Object.hasOwn(out,'catalog'),false);
  assert.equal(Object.hasOwn(out,'selection_ref'),false); assert.equal(Object.hasOwn(out,'summary'),false);
  assert.deepEqual(f.calls.at(-1).projection,'membership'); assert.equal(f.calls.at(-1).writing,false);
  assert.deepEqual([...f.h.originals],originals);
  assert.ok(!f.h.calls.slice(from).some(c => /registry:(originals|insert|pins)|membership:insert|blob:insert/.test(c.sql)));
});

test('member cache misses never compile, even when the display registry is present', async () => {
  const f = setup(); await f.owner.prepareRecordedCatalog(f.read);
  const from = f.h.calls.length, originals = [...f.h.originals];
  const out = await f.owner.reopenPreparedRecordedCatalogMembership(f.read);
  assert.equal(out.status,'not_prepared'); assert.equal(out.membership,null);
  assert.deepEqual([...f.h.originals],originals);
  assert.ok(!f.h.calls.slice(from).some(c => /registry:(originals|insert|pins)|blob:insert/.test(c.sql)));
});

test('member commands refuse caller roots, changed identities and cancellation before delivering the graph', async () => {
  const f = setup();
  for (const method of ['prepareRecordedCatalogMembership','reopenPreparedRecordedCatalogMembership']) {
    for (const extra of [{ projection:'catalog' }, { witnessRef:{} }, { membership:{} }, { pageIndex:0 }])
      await assert.rejects(f.owner[method]({ ...f.read,...extra }));
  }
  assert.equal(f.calls.length,0);
  await f.owner.prepareRecordedCatalogMembership(f.read);
  const request = structuredClone(f.read), running = f.owner.reopenPreparedRecordedCatalogMembership(request);
  request.contextRef.context_sha256 = '0'.repeat(64); request.auth.userId = 'changed';
  assert.deepEqual((await running).context_ref,f.read.contextRef);
  assert.equal(f.calls.at(-1).input.auth.userId,f.read.auth.userId);
  f.endingDenied(); await assert.rejects(f.owner.reopenPreparedRecordedCatalogMembership(f.read),/ending_rights_denied/);
  const controller = new AbortController(); controller.abort(); const from = f.h.calls.length;
  await assert.rejects(f.owner.prepareRecordedCatalogMembership(f.read,{ signal:controller.signal }),/cancelled/);
  assert.equal(f.h.calls.length,from);
});

test('explicit internal preparation uses actual source compiler; bounded reads expose only display originals', async () => {
  const f = setup(); assert.equal((await f.owner.prepareRecordedCatalog(f.read)).status, 'prepared');
  assert.equal(f.calls[0].writing, true);
  const originals = [...f.h.originals], before = f.h.calls.length;
  const opened = await f.owner.openPreparedRecordedCatalog(f.read);
  const page = await f.owner.pagePreparedRecordedCatalog({ ...f.read, pageIndex: 0 });
  assert.equal(opened.status, 'available'); assert.equal(opened.catalog.status, 'display_directory');
  assert.equal(page.page_index, 0); assert.equal(JSON.parse(page.catalog.page_json).groups.length, 100);
  assert.ok(!JSON.stringify([opened, page]).includes('"account_ids":'));
  assert.deepEqual([...f.h.originals], originals);
  assert.ok(!f.h.calls.slice(before).some(c => /registry:(originals|insert|pins)|blob:insert/.test(c.sql)));
  assert.ok(f.calls.slice(1).every(c => c.writing === false));
});

test('member/root/role/viewport commands, accessors, proxies and malformed page syntax never enter the executor', async () => {
  const f = setup();
  for (const extra of [{ account_ids: [] }, { manifestRef: {} }, { selectionRef: {} }, { sourceRows: [] }, { viewport: {} }])
    await assert.rejects(f.owner.openPreparedRecordedCatalog({ ...f.read, ...extra }));
  const getter = Object.defineProperty({ ...f.read }, 'contextRef', { enumerable: true, get() { assert.fail('getter invoked'); } });
  await assert.rejects(f.owner.openPreparedRecordedCatalog(getter));
  await assert.rejects(f.owner.openPreparedRecordedCatalog(new Proxy(f.read, { getPrototypeOf() { assert.fail('proxy invoked'); } })));
  for (const index of [-1, 21, 1.1, '0', null]) await assert.rejects(f.owner.pagePreparedRecordedCatalog({ ...f.read, pageIndex: index }));
  assert.equal(f.calls.length, 0);
});

test('ending authorization rejection and cancellation return no previously valid directory', async () => {
  const f = setup(); await f.owner.prepareRecordedCatalog(f.read); f.endingDenied();
  await assert.rejects(f.owner.openPreparedRecordedCatalog(f.read), /ending_rights_denied/);
  const controller = new AbortController(); controller.abort(); const before = f.h.calls.length;
  await assert.rejects(f.owner.openPreparedRecordedCatalog(f.read, { signal: controller.signal }), /cancelled/);
  assert.equal(f.h.calls.length, before);
});

test('owner detaches context and identity before asynchronous work; a missing page is never a partial catalog', async () => {
  const f = setup(); await f.owner.prepareRecordedCatalog(f.read);
  const request = structuredClone(f.read), running = f.owner.openPreparedRecordedCatalog(request);
  request.contextRef.context_sha256 = '0'.repeat(64); request.auth.userId = 'changed';
  assert.deepEqual((await running).context_ref, f.read.contextRef);
  assert.equal(f.calls.at(-1).input.auth.userId, f.read.auth.userId);
  await assert.rejects(f.owner.pagePreparedRecordedCatalog({ ...f.read, pageIndex: 20 }), /page_index/);
});
