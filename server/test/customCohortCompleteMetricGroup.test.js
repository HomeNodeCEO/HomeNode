import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortCompleteMetricGroup as group } from '../src/services/neighborhoodAssessment/customCohortCompleteMetricGroup.js';
import { customCohortMetricRunFixture as fixture } from './fixtures/customCohortMetricRunFixture.js';

const reference = text => ({ content_sha256: createHash('sha256').update(text).digest('hex'), canonical_utf8_bytes: String(Buffer.byteLength(text)) });
const input = f => ({ preview: f.preview, selectionRef: f.selectionRef });
function repository() {
  const originals = new Map(), calls = [];
  const blobs = { async put(text) { const r = reference(text); originals.set(r.content_sha256, text); calls.push(['put', r]); return r; },
    async get(hash, bytes) { calls.push(['get', hash, bytes]); return originals.get(hash) ?? null; } };
  return { originals, calls, blobs };
}
const expected = f => Object.fromEntries(['stock', 'transactions', 'source_reported'].map(kind => [kind, f.preview.selected[kind].metrics]));
const cloneRoot = async (r, staged, change) => {
  const value = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256)); change(value); return r.blobs.put(json(value));
};

test('all fifteen metrics reopen coherently with exact legacy semantics, fresh originals and ALL retention roots', async () => {
  const r = repository(), f = fixture({ count: 3001 }), o = group(r.blobs), before = JSON.stringify(f.preview);
  const staged = await o.stage(input(f));
  assert.deepEqual(new Set(staged.retention_refs.map(x => x.content_sha256)), new Set(r.originals.keys()));
  const root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
  assert.equal(root.metrics.length, 15); assert.equal(root.metric_group_version, 1);
  assert.equal(root.retention_refs.length + 1, staged.retention_refs.length);
  assert.deepEqual(root.source_binding.selection_ref, f.selectionRef);
  const fresh = fixture({ count: 3001 }), read = await group(r.blobs).reopen(input(fresh), staged.manifest_ref);
  assert.deepEqual(read.metrics, expected(fresh)); assert.deepEqual(read.retention_refs, staged.retention_refs);
  assert.deepEqual(read.selection_ref, fresh.selectionRef); assert.equal(read.authority, 'not_established');
  assert(Object.isFrozen(read.metrics.source_reported.days_on_market));
  for (const ref of staged.retention_refs) assert(r.calls.some(x => x[0] === 'get' && x[1] === ref.content_sha256));
  assert.equal(JSON.stringify(f.preview), before);
  assert.equal(read.metrics.transactions.recorded_total_price.conflicting_count, 1);
  assert.equal(read.metrics.source_reported.current_price.member_count, 4, 'all-date source observations remain distinct from canonical closed events');
});

test('empty selection preserves fifteen empty distributions; current revision/period/raw witness changes refuse old roots', async () => {
  const r = repository(), f = fixture({ empty: true }), staged = await group(r.blobs).stage(input(f));
  assert.deepEqual((await group(r.blobs).reopen(input(fixture({ empty: true })), staged.manifest_ref)).metrics, expected(f));
  for (const changed of [fixture(), fixture({ empty: true, selectionRevision: 3 }), fixture({ empty: true, periodEnd: '2024-05-01' })])
    await assert.rejects(group(r.blobs).reopen(input(changed), staged.manifest_ref), /binding/);
  const populated = fixture(), saved = await group(r.blobs).stage(input(populated));
  await assert.rejects(group(r.blobs).reopen(input(fixture({ price: '330000.250' })), saved.manifest_ref), /metric_binding/);
});

test('missing, reordered, substituted or changed metrics and retention descriptors cannot return a partial group', async () => {
  const r = repository(), f = fixture(), staged = await group(r.blobs).stage(input(f));
  for (const change of [v => v.metrics.pop(), v => v.metrics.reverse(), v => { v.metrics[0] = v.metrics[1]; },
    v => { v.metrics[14].binding_sha256 = 'a'.repeat(64); }, v => { v.metrics[0].member_count++; },
    v => { v.retention_refs = []; }, v => { v.retention_refs.reverse(); },
    v => { v.retention_refs.push(v.retention_refs.at(-1)); },
    v => { v.metrics[0].manifest_ref = v.metrics[1].manifest_ref; }]) {
    const root = await cloneRoot(r, staged, change);
    await assert.rejects(group(r.blobs).reopen(input(f), root));
  }
  const manifest = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
  const old = manifest.retention_refs.find(ref => !manifest.metrics.some(m => m.manifest_ref.content_sha256 === ref.content_sha256));
  const text = r.originals.get(old.content_sha256); r.originals.delete(old.content_sha256);
  await assert.rejects(group(r.blobs).reopen(input(f), staged.manifest_ref), /missing_or_changed_original/);
  r.originals.set(old.content_sha256, text + ' ');
  await assert.rejects(group(r.blobs).reopen(input(f), staged.manifest_ref), /missing_or_changed_original/);
});

test('closed input/reference admission never executes getters/proxies; detached copies do not acquire source authority', async () => {
  const r = repository(), f = fixture(); let effects = 0;
  const trapped = input(f); Object.defineProperty(trapped, 'preview', { enumerable: true, get() { effects++; return f.preview; } });
  await assert.rejects(group(r.blobs).stage(trapped), /shape/);
  await assert.rejects(group(r.blobs).stage(new Proxy(input(f), { getPrototypeOf() { effects++; return Object.prototype; } })), /shape/);
  await assert.rejects(group(r.blobs).stage({ ...input(f), metrics: ['gla_sqft'] }), /shape/);
  await assert.rejects(group(r.blobs).stage({ ...input(f), preview: structuredClone(f.preview) }), /source/);
  const ref = { get content_sha256() { effects++; return 'a'.repeat(64); }, canonical_utf8_bytes: '10' };
  await assert.rejects(group(r.blobs).reopen(input(f), ref), /shape/);
  assert.equal(effects, 0); assert.equal(r.calls.length, 0);
});

test('late metric/root read failure and an ending deadline discard the whole provisional result', async () => {
  const r = repository(), f = fixture(), staged = await group(r.blobs).stage(input(f));
  const root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
  const last = root.metrics.at(-1).manifest_ref.content_sha256; let seen = 0;
  await assert.rejects(group({ put: r.blobs.put, async get(hash, bytes) {
    const text = await r.blobs.get(hash, bytes); if (hash === last && ++seen === 2) return null; return text;
  } }).reopen(input(f), staged.manifest_ref), /missing_or_changed_original/);
  let rootReads = 0, expired = false;
  await assert.rejects(group({ put: r.blobs.put, async get(hash, bytes) {
    const text = await r.blobs.get(hash, bytes); if (hash === staged.manifest_ref.content_sha256 && ++rootReads === 2) expired = true; return text;
  } }, { checkBudget() { if (expired) throw Error('synthetic ending deadline'); } }).reopen(input(f), staged.manifest_ref), /ending deadline/);
});

test('one owner keeps aggregate work/ports across groups and serializes actual pending I/O settlement', async () => {
  const r = repository(), f = fixture(); let resolve, enteredResolve;
  const entered = new Promise(r => { enteredResolve = r; }), pending = new Promise(r => { resolve = r; });
  const controller = new AbortController();
  const o = group({ get: r.blobs.get, async put(text) { enteredResolve(); await pending; return r.blobs.put(text); } }, { signal: controller.signal });
  let settled = false; const running = o.stage(input(f)).finally(() => { settled = true; });
  await entered; await assert.rejects(o.stage(input(f)), /busy/); await assert.rejects(o.reopen(input(f), reference('{}')), /busy/);
  controller.abort(); await Promise.resolve(); assert.equal(settled, false, 'ignored abort does not release ownership of unresolved port');
  resolve(); await assert.rejects(running, /cancelled/); assert.equal(settled, true);
  // Each group reports its own actual stage graph, not the preceding group's
  // root. Work/I/O budgets, unlike these retention lists, remain shared.
  const clean = repository(), owner = group(clean.blobs), first = await owner.stage(input(f));
  const alternate = fixture({ selectionRevision: 3 }), second = await owner.stage(input(alternate));
  assert(!second.retention_refs.some(ref => ref.content_sha256 === first.manifest_ref.content_sha256));
  assert.deepEqual((await owner.reopen(input(alternate), second.manifest_ref)).metrics, expected(alternate));
});

test('aggregate finite port budget is not reset by another identical group', async () => {
  const r = repository(), f = fixture(), o = group(r.blobs); let failed = false, successes = 0;
  // Even with content-addressed duplicate rows, staging calls one root port
  // for each of the fifteen metrics. Bound the fixture loop by that minimum,
  // not an assumed number of pages for this particular tiny source population.
  for (let i = 0; i <= Math.ceil(5000 / 15); i++) {
    try { await o.stage(input(f)); successes++; }
    catch (error) { assert.match(error.message, /operations_limit/); failed = true; break; }
  }
  assert(failed, 'one transaction-local owner cannot silently restart its port budget for each group');
  assert(successes > 1); assert(r.calls.length <= 5000, 'over-limit request is refused before the next actual port');
});
