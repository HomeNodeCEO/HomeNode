import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createExactDecimalObservationRunStoreV1 as createStore,
  EXACT_DECIMAL_OBSERVATION_RUN_V1_LIMITS as L } from '../src/services/neighborhoodAssessment/exactDecimalObservationRunsV1.js';
import { exactDecimalDistributionFromSortedPagesV1 as calculate,
  parseExactDecimalPagedObservationV1 as scaled } from '../src/services/neighborhoodAssessment/exactDecimalPagedDistributionV1.js';

const STATES = ['observed', 'missing', 'invalid', 'conflicting', 'unsupported'];
const bindingJson = json({ synthetic_only: true, metric: 'DATA_decimal', unit: 'unitless', selected_union_authority: false });
const ref = text => ({ content_sha256: createHash('sha256').update(text).digest('hex'), canonical_utf8_bytes: String(Buffer.byteLength(text)) });
const failed = reason => error => error.code === 'EXACT_DECIMAL_OBSERVATION_RUN_INVALID' && error.state === 'incomplete' && error.reason === reason;
const observed = exact_value => ({ state: 'observed', exact_value });
const absent = state => ({ state, exact_value: null });
function counts(cells) {
  const result = { member_count: cells.length, ...Object.fromEntries(STATES.map(s => [`${s}_count`, 0])) };
  for (const c of cells) result[`${c.state}_count`]++; return result;
}
const pagesOf = values => function* () {
  for (let start = 0; start < values.length; start += L.page_values) yield values.slice(start, start + L.page_values);
};
function repository(options = {}) {
  const originals = new Map(), calls = { reads: 0, puts: 0, maxPage: 0, bytes: 0 };
  const blobs = {
    async put(text) {
      const r = ref(text); originals.set(r.content_sha256, text); calls.puts++; calls.bytes += Buffer.byteLength(text);
      const parsed = JSON.parse(text); if (Array.isArray(parsed)) calls.maxPage = Math.max(calls.maxPage, parsed.length); return r;
    },
    async get(hash, bytes) { calls.reads++; const text = originals.get(hash) ?? null;
      if (text !== null) assert.equal(String(Buffer.byteLength(text)), bytes); return text; },
  };
  return { originals, calls, blobs, store: createStore(blobs, options) };
}
const stage = (r, cells, extra = {}) => r.store.stage({ bindingJson, counts: counts(cells), pages: pagesOf(cells), ...extra });
const reopen = (r, staged, cells, extra = {}) => r.store.distributionFromOriginalPages({ bindingJson,
  manifestRef: staged.manifest_ref, counts: counts(cells), pages: pagesOf(cells), cellAtOrdinal: ordinal => cells[ordinal], ...extra });
async function oracle(cells) {
  const values = cells.filter(c => c.state === 'observed').map(c => c.exact_value)
    .sort((a, b) => scaled(a) < scaled(b) ? -1 : scaled(a) > scaled(b) ? 1 : 0);
  return calculate({ counts: counts(cells), pages: pagesOf(values) });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('separate decimal runs preserve >2^53 values, all five states, global exact statistics and stable ordinal ties', async () => {
  const cases = [[], STATES.slice(1).map(absent), [observed('0'), observed('0')],
    ['9007199254740993.01', '9007199254740992.99', '0.000000000001', '10', '2', '2'].map(observed),
    Array.from({ length: 2001 }, (_, i) => i % 13 ? observed(String(2001 - i)) : absent(STATES[1 + i % 4]))];
  for (const cells of cases) {
    const r = repository(), staged = await stage(r, cells), actual = await reopen(r, staged, cells);
    assert.deepEqual(actual, await oracle(cells)); assert.equal(staged.authority, 'not_established');
    assert(Object.isFrozen(staged.retention_refs)); assert(Object.isFrozen(staged.manifest_ref));
    assert.equal(staged.retention_refs.length, r.originals.size); assert(r.calls.maxPage <= L.page_values);
    assert(r.store.retentionReferences().some(x => x.content_sha256 === staged.manifest_ref.content_sha256));
    const root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
    assert.equal(root.format, 'exact_decimal_observation_runs_v1');
    const pairs = root.run.page_refs.flatMap(x => JSON.parse(r.originals.get(x.content_sha256)));
    for (let i = 1; i < pairs.length; i++) if (pairs[i][1] === pairs[i - 1][1]) assert(pairs[i][0] > pairs[i - 1][0]);
  }
});

test('fresh reopen checks every original reason initially and at both endings, not merely a sorted numeric digest', async () => {
  const cells = [observed('2'), absent('unsupported'), observed('9'), absent('conflicting')];
  const r = repository(), staged = await stage(r, cells); let factories = 0, accesses = 0;
  const actual = await reopen(r, staged, cells, { pages() { factories++; return pagesOf(cells)(); },
    cellAtOrdinal(i) { accesses++; return cells[i]; } });
  assert.deepEqual(actual, await oracle(cells)); assert.equal(factories, 3);
  assert.equal(accesses, cells.length * 3 + counts(cells).observed_count * 2);
  for (const where of ['original_pages', 'ordinal', 'missing_reason']) {
    const q = repository(), saved = await stage(q, cells), changed = cells.map(c => ({ ...c }));
    if (where === 'missing_reason') changed[1] = absent('missing'); else changed[0] = observed('3');
    await assert.rejects(reopen(q, saved, cells, where === 'original_pages' ? { pages: pagesOf(changed) }
      : { cellAtOrdinal: i => changed[i] }), /exact_decimal_observation_runs_(original_cell|original_counts)/);
  }
  const q = repository(), saved = await stage(q, cells); let calls = 0;
  const altered = cells.map(c => ({ ...c })); altered[1] = absent('missing');
  await assert.rejects(reopen(q, saved, cells, { pages() { return pagesOf(++calls === 3 ? altered : cells)(); },
    cellAtOrdinal: i => (calls === 3 ? altered : cells)[i] }), failed('original_counts'));
  assert.equal(calls, 3, 'a changed non-observed reason at the second ending cannot deliver statistics');
});

test('closed counts/options/refs and hostile DATA refuse without getter/proxy/then execution or source I/O', async () => {
  let effects = 0, factories = 0;
  const getter = {}; Object.defineProperty(getter, 'state', { enumerable: true, get() { effects++; return 'observed'; } });
  getter.exact_value = '1';
  const proxy = new Proxy({}, { ownKeys() { effects++; throw Error('trap'); }, get() { effects++; throw Error('trap'); } });
  const pageThen = [observed('1')]; Object.defineProperty(pageThen, 'then', { get() { effects++; throw Error('then'); } });
  const cellThen = observed('1'); Object.defineProperty(cellThen, 'then', { get() { effects++; throw Error('then'); } });
  for (const item of [getter, proxy, cellThen, { state: 'observed', exact_value: 1 },
    { state: 'missing', exact_value: '0' }, observed('1.0'), observed('01'), observed('1e2'), observed('-0')]) {
    const r = repository(); await assert.rejects(r.store.stage({ bindingJson, counts: counts([observed('1')]), pages: () => [[item]] }), /exact_decimal_/);
  }
  const r = repository(); await assert.rejects(r.store.stage({ bindingJson, counts: counts([observed('1')]), pages: () => [pageThen] }), /exact_decimal_/);
  for (const extra of [{ counts: proxy }, { counts: { ...counts([]), member_count: L.member_values + 1 } },
    { counts: { ...counts([]), observed_count: 1 } }, { extra: true }, { bindingJson: ' {}' }]) {
    await assert.rejects(r.store.stage({ bindingJson, counts: counts([]), pages() { factories++; return []; }, ...extra }), /exact_decimal_/);
  }
  assert.throws(() => createStore(r.blobs, { signal: proxy }), /exact_decimal_/);
  assert.throws(() => createStore(r.blobs, { checkBudget: 1 }), /exact_decimal_/);
  await assert.rejects(r.store.distributionFromOriginalPages({ bindingJson, manifestRef: proxy, counts: counts([]),
    pages: () => [], cellAtOrdinal() {} }), /exact_decimal_/);
  assert.equal(effects, 0); assert.equal(factories, 0); assert.equal(r.calls.puts, 0); assert.equal(r.calls.reads, 0);
});

test('short/extra/sparse/getter pages, changed counts and omitted originals never produce a manifest', async () => {
  const full = Array.from({ length: 1000 }, () => observed('1'));
  const getter = [observed('1')]; let effects = 0;
  Object.defineProperty(getter, '0', { enumerable: true, get() { effects++; return observed('1'); } });
  for (const [pages, declared] of [[() => [], counts([observed('1')])], [() => [[observed('1')]], counts([])],
    [() => [[observed('1')]], counts([observed('1'), observed('2')])], [() => [full], counts([...full, observed('2')])],
    [() => [Array(1)], counts([observed('1')])], [() => [getter], counts([observed('1')])],
    [() => [[absent('missing')]], counts([absent('unsupported')])]]) {
    const r = repository(); await assert.rejects(r.store.stage({ bindingJson, counts: declared, pages }), /exact_decimal_/);
    assert(![...r.originals.values()].some(text => JSON.parse(text)?.metadata_ref));
  }
  assert.equal(effects, 0);
});

test('reopen refuses wrong binding, missing late bytes, Number-format metadata and self-consistent forged ordinals/values', async () => {
  const cells = Array.from({ length: 1001 }, (_, i) => observed(String(1001 - i)));
  for (const change of ['binding', 'missing', 'changed', 'format', 'duplicate', 'value', 'order', 'count']) {
    const r = repository(), staged = await stage(r, cells), root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
    let selected = staged;
    if (change === 'binding') { await assert.rejects(reopen(r, staged, cells, { bindingJson: json({ foreign: true }) }), failed('manifest')); continue; }
    if (change === 'missing' || change === 'changed') {
      const key = root.run.page_refs.at(-1).content_sha256;
      if (change === 'missing') r.originals.delete(key); else r.originals.set(key, ' '.repeat(Number(root.run.page_refs.at(-1).canonical_utf8_bytes)));
    } else {
      if (change === 'format') root.format = 'legacy_Number';
      else if (change === 'count') root.run.count--;
      else {
        const pairs = root.run.page_refs.flatMap(x => JSON.parse(r.originals.get(x.content_sha256)));
        if (change === 'duplicate') pairs[1][0] = pairs[0][0];
        if (change === 'value') pairs[0][1] = '0';
        if (change === 'order') [pairs[0], pairs[1]] = [pairs[1], pairs[0]];
        root.run.sha256 = ref(json(pairs)).content_sha256; root.run.page_refs = [];
        for (let start = 0; start < pairs.length; start += L.page_values) root.run.page_refs.push(await r.blobs.put(json(pairs.slice(start, start + L.page_values))));
      }
      selected = { manifest_ref: await r.blobs.put(json(root)) };
    }
    await assert.rejects(reopen(r, selected, cells), /exact_decimal_observation_runs_/);
  }
});

test('ending root removal and second sorted-pass mutation refuse rather than returning the processed prefix', async () => {
  for (const ending of [false, true]) {
    const r = repository(), cells = Array.from({ length: 1001 }, (_, i) => observed(String(1001 - i))), saved = await stage(r, cells);
    const root = JSON.parse(r.originals.get(saved.manifest_ref.content_sha256)), last = root.run.page_refs.at(-1); let reads = 0;
    const q = { ...r, store: createStore({ put: r.blobs.put, async get(hash, bytes) {
      if (hash === last.content_sha256 && ++reads === 2) {
        if (!ending) return null;
        const text = await r.blobs.get(hash, bytes); r.originals.delete(saved.manifest_ref.content_sha256); return text;
      }
      return r.blobs.get(hash, bytes);
    } }) };
    await assert.rejects(reopen(q, saved, cells), failed('missing_or_changed_blob')); assert.equal(reads, 2);
  }
});

test('all intermediate and attempted write cleanup roots survive ACK failure or cancellation after actual I/O settlement', async () => {
  const cells = Array.from({ length: 1001 }, (_, i) => observed(String(1001 - i)));
  const r = repository(), staged = await stage(r, cells), root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
  const final = new Set([staged.manifest_ref.content_sha256, root.metadata_ref.content_sha256, ...root.run.page_refs.map(x => x.content_sha256)]);
  assert(staged.retention_refs.some(x => !final.has(x.content_sha256)), 'initial sorted pages remain cleanup roots');
  const q = repository(), bad = createStore({ get: q.blobs.get, async put(text) {
    await q.blobs.put(text); return { ...ref(text), content_sha256: 'a'.repeat(64) };
  } });
  await assert.rejects(bad.stage({ bindingJson, counts: counts([observed('1')]), pages: pagesOf([observed('1')]) }), failed('storage_ack'));
  assert.equal(bad.retentionReferences().length, 1); assert(q.originals.has(bad.retentionReferences()[0].content_sha256));
  const controller = new AbortController(); let entered, release, closed = 0, settled = false;
  const waiting = new Promise(resolve => { entered = resolve; });
  const store = createStore({ get: r.blobs.get, async put(text) {
    const ack = await r.blobs.put(text); entered(); await new Promise(resolve => { release = resolve; }); return ack;
  } }, { signal: controller.signal });
  const pending = store.stage({ bindingJson, counts: counts([observed('7')]), pages: () => ({ [Symbol.iterator]() {
    return { next: () => ({ done: false, value: [observed('7')] }), return() { closed++; return { done: true }; } };
  } }) }).finally(() => { settled = true; });
  await waiting; controller.abort(); await tick(); assert.equal(settled, false); assert.equal(closed, 0);
  release(); await assert.rejects(pending, failed('cancelled')); assert.equal(closed, 1); assert.equal(store.retentionReferences().length, 1);
});

test('source factory/iterator settlement cancellation captures cleanup and ending deadline refuses the result', async () => {
  const controller = new AbortController(); let closed = 0;
  const r = repository({ signal: controller.signal });
  await assert.rejects(r.store.stage({ bindingJson, counts: counts([observed('1')]), async pages() {
    controller.abort(); return { [Symbol.iterator]() { return { next: () => ({ done: false, value: [observed('1')] }),
      return() { closed++; return { done: true }; } }; } };
  } }), failed('cancelled')); assert.equal(closed, 1);
  const q = repository(), cells = [observed('1')], saved = await stage(q, cells); let roots = 0, expired = false;
  const ending = { ...q, store: createStore({ put: q.blobs.put, async get(hash, bytes) {
    const text = await q.blobs.get(hash, bytes); if (hash === saved.manifest_ref.content_sha256 && ++roots === 5) expired = true; return text;
  } }, { checkBudget() { if (expired) throw Error('ending_deadline'); } }) };
  await assert.rejects(reopen(ending, saved, cells), /ending_deadline/); assert.equal(roots, 5);
});

test('one store enforces aggregate staging operations and keeps immutable owned source pages before callbacks', async () => {
  let mutable, armed = false;
  const r = repository({ checkBudget() { if (armed) mutable[0].exact_value = '999'; } });
  mutable = Array.from({ length: 126 }, (_, i) => observed(String(126 - i)));
  const staged = await stage(r, mutable, { pages() { return { [Symbol.iterator]() {
    let once = false; return { next() { if (once) return { done: true }; once = true;
      // Mutations begin at the first cooperative yield, after whole-page cell copying.
      setImmediate(() => { armed = true; }); return { done: false, value: mutable }; } };
  } }; } });
  assert.equal(armed, true); assert.equal(mutable[0].exact_value, '999');
  armed = false;
  const original = Array.from({ length: 126 }, (_, i) => observed(String(126 - i)));
  assert.deepEqual(await reopen(r, staged, original), await oracle(original));
  const q = repository(); let successful = 0;
  await assert.rejects(async () => {
    while (true) { await stage(q, []); successful++; }
  }, failed('stage_limit'));
  assert.equal(successful, L.staged_blobs / 2); assert.equal(q.calls.puts, L.staged_blobs);
});

test('cloud-only lazy synthetic 60001 and unchanged 250000 member cap merge/reopen through bounded decimal runs',
  { skip: process.env.CI !== 'true' }, async () => {
    for (const members of [60001, L.member_values]) {
      const c = i => i % 19 ? observed(String(members - i)) : absent(STATES[1 + i % 4]);
      const declared = { member_count: members, ...Object.fromEntries(STATES.map(s => [`${s}_count`, 0])) };
      for (let i = 0; i < members; i++) declared[`${c(i).state}_count`]++;
      let factories = 0, inputPages = 0;
      const pages = () => { factories++; return (function* () {
        for (let start = 0; start < members; start += L.page_values) {
          inputPages++; yield Array.from({ length: Math.min(L.page_values, members - start) }, (_, i) => c(start + i));
        }
      })(); };
      const r = repository(), saved = await r.store.stage({ bindingJson, counts: declared, pages });
      const fresh = createStore(r.blobs);
      const actual = await fresh.distributionFromOriginalPages({ bindingJson, manifestRef: saved.manifest_ref,
        counts: declared, pages, cellAtOrdinal: c });
      const expected = await calculate({ counts: declared, pages: function* () {
        let page = [];
        for (let i = members - 1; i >= 0; i--) if (c(i).state === 'observed') {
          page.push(c(i).exact_value); if (page.length === L.page_values) { yield page; page = []; }
        }
        if (page.length) yield page;
      } });
      assert.deepEqual(actual, expected); assert.equal(factories, 4);
      assert.equal(inputPages, 4 * Math.ceil(members / L.page_values));
      assert.equal(r.calls.maxPage, L.page_values); assert(r.calls.puts <= L.staged_blobs);
      assert(r.calls.bytes <= L.staged_bytes); assert.equal(saved.retention_refs.length, r.originals.size);
    }
  });
