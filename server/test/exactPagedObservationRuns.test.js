import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { exactDistribution } from '../src/services/neighborhoodAssessment/statistics.js';
import { createExactPagedObservationRunStore as createStore,
  EXACT_PAGED_OBSERVATION_RUN_LIMITS as L } from '../src/services/neighborhoodAssessment/exactPagedObservationRuns.js';

const bindingJson = json({ context_original: 'synthetic-only', population: 'all',
  selection: 'synthetic-1', metric: 'synthetic-values', unit: 'unitless', period: 'synthetic-only' });
const ref = text => ({ content_sha256: createHash('sha256').update(text).digest('hex'), canonical_utf8_bytes: String(Buffer.byteLength(text)) });
const failed = reason => error => error.code === 'NEIGHBORHOOD_OBSERVATION_RUN_INVALID'
  && error.state === 'incomplete' && error.reason === reason;
function repository() {
  const originals = new Map(), calls = { writes: 0, reads: 0, bytes: 0, largestPage: 0 };
  const blobs = {
    async put(text) {
      const r = ref(text), parsed = JSON.parse(text); originals.set(r.content_sha256, text);
      calls.writes++; calls.bytes += Buffer.byteLength(text);
      if (Array.isArray(parsed)) calls.largestPage = Math.max(calls.largestPage, parsed.length);
      return r;
    },
    async get(hash, bytes) { calls.reads++; const text = originals.get(hash) ?? null;
      if (text !== null) assert.equal(String(Buffer.byteLength(text)), bytes); return text; },
  };
  return { blobs, originals, calls, store: createStore(blobs) };
}
const split = values => function* () {
  for (let start = 0; start < values.length; start += L.page_values) yield values.slice(start, start + L.page_values);
};
const stage = (r, values, extra = {}) => r.store.stage({ bindingJson, member_count: values.length, pages: split(values), ...extra });
const summarize = (r, staged, extra = {}) => r.store.distribution({ bindingJson, manifestRef: staged.manifest_ref, ...extra });
const pause = () => new Promise(resolve => setImmediate(resolve));

test('unordered retained runs preserve every legacy field, missing values, signed zero, and overflow', async () => {
  const cases = [[], [null, null], [0, -0], [-0, 0], [-0],
    [null, 20, -10, 4, 0], [Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE],
    [Number.MIN_VALUE, -0, -Number.MIN_VALUE],
    Array.from({ length: 3001 }, (_, i) => i % 11 ? (3001 - i) * (i % 2 ? 1 : -1) / 3 : null)];
  for (const values of cases) {
    const r = repository(), staged = await stage(r, values);
    assert.equal(staged.authority, 'not_established'); assert(Object.isFrozen(staged.manifest_ref));
    for (const minimum_count of [1, 3, 4000]) {
      const actual = await summarize(r, staged, { minimum_count });
      assert.deepEqual(actual, exactDistribution(values, { minimum_count }));
      assert(Object.isFrozen(actual)); assert(Object.isFrozen(actual.numeric_issues));
    }
    assert(r.calls.largestPage <= L.page_values);
    if (values.some(value => Object.is(value, -0))) assert([...r.originals.values()].some(text => text.includes('"-0"')));
  }
});

test('global merges combine unequal/missing/skewed pages, not page medians; duplicate values remain observations', async () => {
  const values = [...Array(1000).fill(100), ...Array(1000).fill(null), ...Array(1000).fill(1), 10000];
  const r = repository(), staged = await stage(r, values), actual = await summarize(r, staged);
  assert.deepEqual(actual, exactDistribution(values)); assert.equal(actual.median, 100);
  assert.equal(actual.member_count, 3001); assert.equal(actual.count, 2001); assert.equal(actual.missing_count, 1000);
  assert.notEqual(actual.mean, (100 + 1 + 10000) / 3);
  let seed = 831;
  for (let size = 1; size < 12000; size += 1733) {
    const rows = Array.from({ length: size }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % 17 ? (seed % 100001 - 50000) / 7 : null;
    });
    const q = repository(); assert.deepEqual(await summarize(q, await stage(q, rows)), exactDistribution(rows));
  }
});

test('60001 cells and the exact existing 250k ceiling stage multiple bounded merge levels and reopen on a fresh store', async () => {
  for (const members of [60001, L.member_values]) {
    const r = repository(); let factoryCalls = 0, inputPages = 0;
    const value = i => i % 19 ? members - i + (i % 5) / 10 : null;
    const staged = await r.store.stage({ bindingJson, member_count: members, pages() {
      factoryCalls++; return (async function* () {
        for (let start = 0; start < members; start += L.page_values) {
          inputPages++; yield Array.from({ length: Math.min(L.page_values, members - start) }, (_, i) => value(start + i));
        }
      })();
    } });
    assert.equal(factoryCalls, 1); assert.equal(inputPages, Math.ceil(members / L.page_values));
    assert(r.calls.writes <= L.staged_blobs); assert(r.calls.bytes <= L.staged_bytes);
    assert.equal(r.calls.largestPage, L.page_values);
    const reopened = createStore(r.blobs);
    assert.deepEqual(await reopened.distribution({ bindingJson, manifestRef: staged.manifest_ref }),
      exactDistribution(Array.from({ length: members }, (_, i) => value(i))));
    assert(r.calls.reads + r.calls.writes < L.blob_operations);
  }
});

test('invalid count/binding/options refuse before storage or source I/O; one-over does not raise any live limit', async () => {
  const r = repository(); let sourceCalls = 0; const pages = () => { sourceCalls++; return []; };
  for (const extra of [{ member_count: L.member_values + 1 }, { member_count: -1 }, { member_count: 1.5 },
    { bindingJson: ' {"a":1}' }, { bindingJson: json('x'.repeat(L.binding_bytes)) }, { checkBudget: 4 }, { signal: {} }]) {
    await assert.rejects(r.store.stage({ bindingJson, member_count: 0, pages, ...extra }), /invalid/);
  }
  assert.equal(sourceCalls, 0); assert.equal(r.calls.reads, 0); assert.equal(r.calls.writes, 0);
  for (const minimum_count of [0, 1.5, NaN]) await assert.rejects(r.store.distribution({ bindingJson,
    manifestRef: ref('{}'), minimum_count }), failed('minimum_count'));
  assert.equal(r.calls.reads, 0);
  assert.throws(() => createStore({ put() {} }), failed('repository'));
});

test('empty and all-missing streams retain their exact denominator and still recheck both complete endings', async () => {
  for (const values of [[], Array(1001).fill(null)]) {
    const r = repository(), staged = await stage(r, values), before = r.calls.reads;
    assert.deepEqual(await summarize(r, staged), exactDistribution(values));
    assert.equal(r.calls.reads - before, 10, 'initial header and both pass beginnings/endings open root+metadata freshly');
    const root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
    assert.deepEqual(root.run.page_refs, []); assert.equal(root.run.count, 0);
  }
});

test('closed source iterator receipts reject accessors, proxies, malformed endings and extras without data execution', async () => {
  let effects = 0;
  const getter = { done: false }; Object.defineProperty(getter, 'value', { enumerable: true, get() { effects++; return [1]; } });
  const done = {}; Object.defineProperty(done, 'done', { enumerable: true, get() { effects++; return true; } });
  for (const receipt of [getter, done, new Proxy({}, { ownKeys() { effects++; throw Error('trap'); } }),
    { done: false, value: [1], extra: 1 }, { done: 1 }, true, null]) {
    const r = repository(); let closed = 0;
    await assert.rejects(r.store.stage({ bindingJson, member_count: 1, pages: () => ({ [Symbol.iterator]() {
      return { next: () => receipt, return() { closed++; return { done: true }; } };
    } }) }), /invalid/);
    assert.equal(closed, 1);
  }
  assert.equal(effects, 0);
});

test('missing, extra, short, nonfinite or non-Number cells cannot stage a complete manifest', async () => {
  const full = Array.from({ length: 1000 }, (_, i) => 1000 - i);
  for (const [pages, member_count] of [[() => [], 1], [() => [full], 1001], [() => [[1]], 0],
    [() => [[1]], 2], [() => [[Infinity]], 1], [() => [[NaN]], 1], [() => [['2']], 1], [() => [[undefined]], 1],
    [() => [full, [1, 2]], 1001]]) {
    const r = repository(); await assert.rejects(r.store.stage({ bindingJson, pages, member_count }), /invalid/);
    assert(![...r.originals.values()].some(text => JSON.parse(text)?.metadata_ref));
  }
});

test('untrusted pages, refs and acknowledgments execute no getters/proxy traps/then assimilation', async () => {
  let effects = 0;
  const getter = [1]; Object.defineProperty(getter, '0', { enumerable: true, get() { effects++; return 1; } });
  const then = [1]; Object.defineProperty(then, 'then', { get() { effects++; throw Error('must not run'); } });
  const proxy = new Proxy([1], { get() { effects++; throw Error('must not run'); }, ownKeys() { effects++; throw Error('must not run'); } });
  const extra = [1]; extra.extra = 4; const symbol = [1]; symbol[Symbol('extra')] = 1;
  for (const page of [getter, then, proxy, extra, symbol, Array(1)]) {
    const r = repository(); await assert.rejects(r.store.stage({ bindingJson, member_count: 1, pages: () => [page] }), /invalid/);
  }
  const ack = { canonical_utf8_bytes: '1' }; Object.defineProperty(ack, 'content_sha256', { enumerable: true, get() { effects++; return 'a'.repeat(64); } });
  const r = repository(), bad = createStore({ get: r.blobs.get, async put() { return ack; } });
  await assert.rejects(bad.stage({ bindingJson, member_count: 1, pages: split([1]) }), failed('shape'));
  await assert.rejects(r.store.distribution({ bindingJson, manifestRef: new Proxy({}, { get() { effects++; } }) }), /invalid/);
  assert.equal(effects, 0);
});

test('finite source pages are detached before budget callbacks/yields and storage ACKs must match their actual bytes', async () => {
  const r = repository(), values = [9, -0, 1], pages = () => [values]; let visits = 0;
  const staged = await r.store.stage({ bindingJson, member_count: 3, pages, checkBudget() {
    if (++visits > 7) values[0] = 999;
  } });
  assert.deepEqual(await summarize(r, staged), exactDistribution([9, -0, 1]));
  for (const key of ['content_sha256', 'canonical_utf8_bytes']) {
    const q = repository(), bad = createStore({ get: q.blobs.get, async put(text) {
      return { ...ref(text), [key]: key === 'content_sha256' ? 'a'.repeat(64) : String(Buffer.byteLength(text) + 1) };
    } });
    await assert.rejects(bad.stage({ bindingJson, member_count: 1, pages: split([2]) }), failed('storage_ack'));
  }
});

test('reopen refuses foreign binding, missing/changed late originals and corrupted immutable metadata', async () => {
  const rows = Array.from({ length: 3001 }, (_, i) => 3001 - i);
  for (const mutate of ['missing_page', 'changed_page', 'missing_metadata', 'changed_root']) {
    const r = repository(), staged = await stage(r, rows), root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
    const chosen = mutate.includes('page') ? root.run.page_refs.at(-1).content_sha256
      : mutate === 'missing_metadata' ? root.metadata_ref.content_sha256 : staged.manifest_ref.content_sha256;
    if (mutate.startsWith('missing')) r.originals.delete(chosen); else r.originals.set(chosen, ' '.repeat(Number(ref(r.originals.get(chosen)).canonical_utf8_bytes)));
    await assert.rejects(summarize(r, staged), failed('missing_or_changed_original'));
  }
  const r = repository(), staged = await stage(r, rows);
  await assert.rejects(summarize(r, staged, { bindingJson: json({ foreign: true }) }), failed('manifest'));
});

test('structurally self-consistent replaced directories cannot hide duplicate ordinals, wrong order, count or Number spelling', async () => {
  for (const kind of ['duplicate', 'order', 'token', 'count', 'short', 'extra']) {
    const r = repository(), staged = await stage(r, [2, 1]);
    const root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
    let pairs = [[1, '1'], [0, '2']];
    if (kind === 'duplicate') pairs = [[0, '1'], [0, '2']];
    if (kind === 'order') pairs.reverse();
    if (kind === 'token') pairs[0][1] = '1.0';
    if (kind === 'short') pairs.pop();
    root.run.page_refs = [await r.blobs.put(json(pairs))]; root.run.sha256 = createHash('sha256').update(json(pairs)).digest('hex');
    if (kind === 'count') root.run.count = 1;
    if (kind === 'extra') root.run.page_refs.push(root.run.page_refs[0]);
    const malformed = await r.blobs.put(json(root));
    await assert.rejects(summarize(r, { manifest_ref: malformed }), /invalid/);
  }
});

test('a changed late second pass or removed root at its ending cannot return the already processed prefix', async () => {
  for (const ending of [false, true]) {
    const r = repository(), rows = Array.from({ length: 2001 }, (_, i) => 2001 - i), staged = await stage(r, rows);
    const root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256)), last = root.run.page_refs.at(-1);
    const originalGet = r.blobs.get; let lastReads = 0;
    const store = createStore({ put: r.blobs.put, async get(hash, bytes) {
      if (hash === last.content_sha256 && ++lastReads === 2) {
        if (ending) { const text = await originalGet(hash, bytes); r.originals.delete(staged.manifest_ref.content_sha256); return text; }
        return null;
      }
      return originalGet(hash, bytes);
    } });
    await assert.rejects(store.distribution({ bindingJson, manifestRef: staged.manifest_ref }), failed('missing_or_changed_original'));
    assert.equal(lastReads, 2);
  }
});

test('cancellation/deadline waits for actual owned I/O settlement and closes admitted source iterators', async () => {
  const r = repository(), controller = new AbortController(); let release, entered, closed = 0, settled = false;
  const portEntered = new Promise(resolve => { entered = resolve; });
  const store = createStore({ get: r.blobs.get, async put(text) { entered(); await new Promise(resolve => { release = resolve; }); return ref(text); } });
  const pending = store.stage({ bindingJson, member_count: 1, signal: controller.signal,
    pages: () => ({ [Symbol.iterator]() { let first = true; return { next() {
      if (first) { first = false; return { done: false, value: [1] }; } return { done: true };
    }, return() { closed++; return { done: true }; } }; } }) }).finally(() => { settled = true; });
  await portEntered; controller.abort(); await pause(); assert.equal(settled, false); assert.equal(closed, 0);
  release(); await assert.rejects(pending, failed('cancelled')); assert.equal(closed, 1);
  const c = new AbortController(); let factoryClosed = 0;
  await assert.rejects(r.store.stage({ bindingJson, member_count: 1, signal: c.signal, async pages() {
    c.abort(); return { [Symbol.iterator]() { return { next() { return { done: false, value: [1] }; },
      return() { factoryClosed++; return { done: true }; } }; } };
  } }), failed('cancelled')); assert.equal(factoryClosed, 1);
  const q = repository(), staged = await stage(q, [2, 1]); let deadline = false;
  const checked = createStore({ put: q.blobs.put, async get(hash, bytes) { const value = await q.blobs.get(hash, bytes); deadline = true; return value; } });
  await assert.rejects(checked.distribution({ bindingJson, manifestRef: staged.manifest_ref,
    checkBudget() { if (deadline) throw Error('deadline'); } }), /deadline/);
});

test('merge read cancellation waits for settlement after source exhaustion, and ending deadlines never publish', async () => {
  const r = repository(), signal = new AbortController(); let release, entered, settled = false;
  const enteredPort = new Promise(resolve => { entered = resolve; });
  const checked = createStore({ put: r.blobs.put, async get(hash, bytes) {
    entered(); await new Promise(resolve => { release = resolve; }); return r.blobs.get(hash, bytes);
  } });
  const pending = checked.stage({ bindingJson, member_count: 1001,
    pages: split(Array.from({ length: 1001 }, (_, i) => 1001 - i)), signal: signal.signal }).finally(() => { settled = true; });
  await enteredPort; signal.abort(); await pause(); assert.equal(settled, false);
  release(); await assert.rejects(pending, failed('cancelled'));
  assert(![...r.originals.values()].some(text => JSON.parse(text)?.metadata_ref));
  const q = repository(), staged = await stage(q, [1]), root = staged.manifest_ref.content_sha256;
  let roots = 0, expired = false;
  const ending = createStore({ put: q.blobs.put, async get(hash, bytes) {
    const result = await q.blobs.get(hash, bytes); if (hash === root && ++roots === 5) expired = true; return result;
  } });
  await assert.rejects(ending.distribution({ bindingJson, manifestRef: staged.manifest_ref,
    checkBudget() { if (expired) throw Error('ending-deadline'); } }), /ending-deadline/);
  assert.equal(roots, 5);
});
