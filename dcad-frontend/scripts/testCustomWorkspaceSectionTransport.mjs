import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomWorkspaceSectionTransport } from '../src/features/neighborhood/customCohortPreviewTransport.ts';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const signal = () => new AbortController().signal;
const input = () => ({ value: { workspace_version: 1, active: null, pending_capture: null }, expectedRevision: 4, editorKey: 'synthetic-key' });
const drain = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function harness(request = async () => json({ ok: true })) {
  const calls = [];
  const transport = createCustomWorkspaceSectionTransport({ urlFor: p => `https://example.invalid${p}`,
    request: async (url, init) => { calls.push({ url, init }); return request(url, init); } });
  return { calls, transport };
}

test('checkpoint save uses only the closed existing section, exact CAS and server reviewer', async () => {
  const h = harness(), raw = input(), abort = new AbortController();
  const done = h.transport.save('R-001', '17', raw, { signal: abort.signal }); raw.value.workspace_version = 99;
  assert.deepEqual(await done, { ok: true }); assert.equal(h.calls.length, 1);
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://example.invalid/api/accounts/R-001/assignment-files/17/workfile/sections/neighborhood_workspace');
  assert.equal(init.method, 'PUT'); assert.equal(init.cache, 'no-store'); assert.equal(init.signal, abort.signal);
  assert.deepEqual(init.headers, { accept: 'application/json', 'content-type': 'application/json', 'x-homenode-editor-key': 'synthetic-key' });
  assert.deepEqual(JSON.parse(init.body), { value: input().value, expected_revision: 4, save_reason: 'autosave' });
  assert.equal('reviewer' in JSON.parse(init.body), false);
});
test('fresh workfile GET is exact, uncached and carries caller cancellation', async () => {
  const h = harness(); const s = signal(); await h.transport.read('26355500170360000', '17', { signal: s });
  const { url, init } = h.calls[0];
  assert.equal(url, 'https://example.invalid/api/accounts/26355500170360000/assignment-files/17/workfile');
  assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.equal(init.signal, s);
  assert.equal(init.body, undefined); assert.deepEqual(init.headers, { accept: 'application/json' });
});
test('legacy numeric-ID endpoints refuse loss of precision, coercion and path traversal before any request', async () => {
  for (const [account, file] of [['R 1','1'],['a/b','1'],['R-1','01'],['R-1','9007199254740993'],['R-1','-1'],['R-1','1.0'],['R-1',1]]) {
    const h = harness(); assert.throws(() => h.transport.read(account, file, { signal: signal() }), /Invalid custom workspace target/);
    assert.equal(h.calls.length, 0);
  }
});
test('save rejects malformed revision, header injection and oversized value before network', () => {
  for (const override of [{expectedRevision:-1},{expectedRevision:1.5},{expectedRevision:2147483647},{editorKey:''},{editorKey:'x\r\ny'},
    {value:undefined},{value:{text:'€'.repeat(11000)}}]) {
    const h = harness(); assert.throws(() => h.transport.save('R-1', '17', {...input(),...override}, {signal:signal()}), /Invalid custom workspace/);
    assert.equal(h.calls.length, 0);
  }
});
test('conflict is returned once without a blind retry or leaking editor key', async () => {
  const h = harness(async () => json({error:'custom_appraisal_section_revision_conflict',current_revision:5},409));
  await assert.rejects(h.transport.save('R-1','17',input(),{signal:signal()}), error => error.status===409 && !error.message.includes('synthetic-key'));
  assert.equal(h.calls.length, 1);
});
test('abort before send never invokes request; ignored cancellation cannot deliver a late save acknowledgement', async () => {
  const h = harness(), stopped = new AbortController(); stopped.abort();
  assert.throws(() => h.transport.read('R-1','17',{signal:stopped.signal}),{name:'AbortError'}); assert.equal(h.calls.length,0);
  let finish; const late = harness(() => new Promise(resolve => {finish=resolve;})), owner=new AbortController();
  const pending=late.transport.save('R-1','17',input(),{signal:owner.signal}); await drain(); owner.abort();
  await assert.rejects(pending,{name:'AbortError'}); finish(json({ok:true})); await drain(); assert.equal(late.calls.length,1);
});
test('checkpoint acknowledgement is byte bounded and rejects non-JSON, invalid UTF-8, and malformed JSON', async () => {
  const cases = [() => json({padding:'x'.repeat(65536)}), () => new Response('<html>Login</html>',{headers:{'content-type':'text/html'}}),
    () => new Response(Uint8Array.from([0xc3,0x28]),{headers:{'content-type':'application/json'}}),
    () => new Response('{no}',{headers:{'content-type':'application/json'}})];
  for (const response of cases) {
    const h = harness(async () => response());
    await assert.rejects(h.transport.save('R-1','17',input(),{signal:signal()})); assert.equal(h.calls.length,1);
  }
});
