import assert from 'node:assert/strict';
import test from 'node:test';
import { exactDistribution, finiteNumberOrNull, NEIGHBORHOOD_STATISTICS_LIMITS } from '../src/services/neighborhoodAssessment/statistics.js';
import { exactDistributionFromSortedPages as summarize, EXACT_PAGED_DISTRIBUTION_LIMITS as L } from '../src/services/neighborhoodAssessment/exactPagedDistribution.js';

const failure = reason => error => error.code === 'NEIGHBORHOOD_STATISTICS_PAGE_INVALID'
  && error.state === 'incomplete' && error.reason === reason;
const split = values => Array.from({ length: Math.ceil(values.length / L.page_values) },
  (_, index) => values.slice(index * L.page_values, (index + 1) * L.page_values));
function from(values, options = {}) {
  const sorted = values.map(finiteNumberOrNull).filter(value => value !== null).sort((a, b) => a - b);
  return { member_count: values.length, count: sorted.length, pages: () => split(sorted), ...options };
}

test('exact paged observations preserve every legacy distribution field, including missing, signed zero and overflow', async () => {
  const cases = [[], [null, '', undefined, NaN, Infinity, {}, '1e3'], [0, -0], [-0],
    [null, '', 0, 10], [100], [' 42.50 ', 45, '-12.5', '0.0001', false, '+3'],
    [-Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_VALUE],
    [Number.MAX_VALUE, Number.MAX_VALUE], [Number.MIN_VALUE, -Number.MIN_VALUE, -0],
    Array.from({ length: 3001 }, (_, i) => i % 11 ? (i % 2 ? 1 : -1) * i / 3 : null)];
  for (const values of cases) for (const minimum_count of [1, 3, 4000]) {
    const result = await summarize(from(values, { minimum_count }));
    assert.deepEqual(result, exactDistribution(values, { minimum_count }));
    assert(Object.isFrozen(result)); assert(Object.isFrozen(result.numeric_issues));
  }
});

test('deterministic differently sized populations match legacy, not page medians or page means', async () => {
  let seed = 731;
  for (let size = 0; size <= 4200; size += 137) {
    const values = Array.from({ length: size }, () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % 13 === 0 ? null : (seed % 100001 - 50000) * (seed % 7 + 1) / 10;
    });
    assert.deepEqual(await summarize(from(values)), exactDistribution(values));
  }
  const skewed = [...Array(1000).fill(1), ...Array(1000).fill(100), 10000];
  const result = await summarize(from(skewed));
  assert.deepEqual(result, exactDistribution(skewed));
  assert.equal(result.median, 100); assert.notEqual(result.mean, (1 + 100 + 10000) / 3);
});

test('60001 observations and the exact existing 250k ceiling use repeatable lazy finite pages', async () => {
  for (const count of [60001, NEIGHBORHOOD_STATISTICS_LIMITS.measurement_values]) {
    let factoryCalls = 0, yielded = 0, largest = 0;
    const result = await summarize({ member_count: count, count, pages() {
      factoryCalls++;
      return (async function* () {
        for (let start = 0; start < count; start += L.page_values) {
          const page = Array.from({ length: Math.min(L.page_values, count - start) }, (_, i) => start + i);
          largest = Math.max(largest, page.length); yielded++; yield page;
        }
      })();
    } });
    assert.deepEqual(result, exactDistribution(Array.from({ length: count }, (_, i) => i)));
    assert.equal(factoryCalls, 2); assert.equal(yielded, 2 * Math.ceil(count / L.page_values));
    assert.equal(largest, L.page_values);
  }
  let calls = 0;
  await assert.rejects(summarize({ member_count: L.observation_values + 1, count: 0,
    pages() { calls++; return []; } }), error => error.code === 'NEIGHBORHOOD_STATISTICS_WORK_LIMIT'
      && error.observed === L.observation_values + 1 && error.limit === L.observation_values);
  assert.equal(calls, 0);
});

test('invalid counts, options and minimums refuse before any page port', async () => {
  let calls = 0; const pages = () => { calls++; return []; };
  for (const options of [{ count: -1 }, { count: 1 }, { member_count: -1 }, { member_count: 0.5 },
    { count: NaN }, { minimum_count: 0 }, { minimum_count: 1.5 }, { checkBudget: 4 }, { signal: {} }, { pages: [] }]) {
    await assert.rejects(summarize({ member_count: 0, count: 0, pages, ...options }), /invalid/);
  }
  assert.equal(calls, 0);
});

test('both passes must exhaust the declared complete stream; missing, extra, short and out-of-order pages never return a prefix', async () => {
  const first = Array.from({ length: 1000 }, (_, i) => i);
  for (const [pages, count, reason] of [
    [() => [], 1001, 'missing_observations'], [() => [first], 1001, 'missing_observations'],
    [() => [first, [1000, 1001]], 1001, 'page_length'],
    [() => [first, [1000], []], 1001, 'extra_page'],
    [() => [[1]], 0, 'extra_page'], [() => [[1, 0]], 2, 'observation_order'],
    [() => [first, [998]], 1001, 'observation_order'],
  ]) await assert.rejects(summarize({ member_count: count, count, pages }), failure(reason));
  let calls = 0;
  await assert.rejects(summarize({ member_count: 1001, count: 1001,
    pages: () => ++calls === 1 ? [first, [1000]] : [first] }), failure('missing_observations'));
  assert.equal(calls, 2);
});

test('second-pass changes are rejected even when count, median and ordering still match', async () => {
  for (const second of [[0, 1, 4], [0, 1, 3]]) {
    let calls = 0;
    // Last case distinguishes +0 from -0 even though both serialize as JSON 0.
    const first = Object.is(second[2], 3) ? [-0, 1, 3] : [0, 1, 3];
    await assert.rejects(summarize({ member_count: 3, count: 3,
      pages: () => [++calls === 1 ? first : second] }), failure('observations_changed'));
  }
  let calls = 0;
  await assert.rejects(summarize({ member_count: 1, count: 1, pages: () => {
    if (++calls === 2) throw new Error('original unavailable');
    return [[20]];
  } }), /original unavailable/);
});

test('page grammar never executes untrusted getters or proxy traps and rejects malformed numeric values', async () => {
  let effects = 0;
  const getter = [1]; Object.defineProperty(getter, '0', { enumerable: true, get() { effects++; return 1; } });
  const proxy = new Proxy([1], { get() { effects++; throw new Error('trap'); }, ownKeys() { effects++; throw new Error('trap'); } });
  const extra = [1]; extra.extra = 2;
  const symbol = [1]; symbol[Symbol('extra')] = 2;
  const inherited = new Array(1); Object.setPrototypeOf(inherited, { 0: 1 });
  const hidden = [1]; Object.defineProperty(hidden, '0', { enumerable: false, value: 1 });
  const then = [1]; Object.defineProperty(then, 'then', { get() { effects++; throw new Error('then getter'); } });
  for (const page of [getter, proxy, extra, symbol, inherited, hidden, then, new Array(1), new Float64Array([1]),
    [null], ['1'], [NaN], [Infinity], [-Infinity]]) {
    await assert.rejects(summarize({ member_count: 1, count: 1, pages: () => [page] }), /invalid/);
  }
  assert.equal(effects, 0);
});

test('finite pages detach before cooperative yields; cancellation and budget failure close iterators without partial summaries', async () => {
  const controller = new AbortController(); let closed = 0, calls = 0, ticks = 0;
  await assert.rejects(summarize({ member_count: 2000, count: 2000, signal: controller.signal,
    pages() { calls++; return (async function* () {
      try { yield Array.from({ length: 1000 }, (_, i) => i); yield Array.from({ length: 1000 }, (_, i) => i + 1000); }
      finally { closed++; }
    })(); }, checkBudget() { if (++ticks === 5) controller.abort(); } }), failure('cancelled'));
  assert.equal(calls, 1); assert.equal(closed, 1);
  for (const stage of [1, 2]) {
    let pass = 0, close = 0, seen = 0;
    await assert.rejects(summarize({ member_count: 1001, count: 1001, pages() {
      pass++; return (async function* () {
        try { yield Array.from({ length: 1000 }, (_, i) => i); yield [1000]; }
        finally { close++; }
      })();
    }, checkBudget() { if (pass === stage && ++seen === 6) throw new Error('deadline'); } }), /deadline/);
    assert.equal(pass, stage); assert.equal(close, stage);
  }
  const initial = Array.from({ length: 1000 }, (_, i) => i);
  let factoryCalls = 0;
  const result = await summarize({ member_count: 1000, count: 1000, pages() {
    factoryCalls++; return [factoryCalls === 1 ? initial : Array.from({ length: 1000 }, (_, i) => i)];
  }, checkBudget() { if (factoryCalls === 1) setImmediate(() => initial.fill(-100)); } });
  assert.deepEqual(result, exactDistribution(Array.from({ length: 1000 }, (_, i) => i)));
});

test('empty populations still verify both complete iterator endings, and settlement cancellation is checked', async () => {
  let calls = 0;
  assert.deepEqual(await summarize({ member_count: 3, count: 0, pages: () => { calls++; return []; } }),
    exactDistribution([null, null, null]));
  assert.equal(calls, 2);
  const controller = new AbortController();
  let factoryCleanup = 0;
  await assert.rejects(summarize({ member_count: 0, count: 0, signal: controller.signal,
    async pages() { controller.abort(); return { [Symbol.asyncIterator]() { return {
      next() { assert.fail('cancelled factory must not pull observations'); },
      async return() { factoryCleanup++; return { done: true }; },
    }; } }; } }), failure('cancelled'));
  assert.equal(factoryCleanup, 1);
  for (const stream of [null, undefined, 1, '']) {
    await assert.rejects(summarize({ member_count: 0, count: 0, pages: () => stream }), /invalid|iterable/);
  }
});

test('closed iterator receipts reject accessors, proxies and extras without executing data getters', async () => {
  let effects = 0;
  const getter = { value: [1] }; Object.defineProperty(getter, 'done', { get() { effects++; return false; } });
  const valueGetter = { done: false }; Object.defineProperty(valueGetter, 'value', { get() { effects++; return [1]; } });
  const proxy = new Proxy({ done: false, value: [1] }, { ownKeys() { effects++; throw new Error('receipt trap'); } });
  const then = { done: false, value: [1] }; Object.defineProperty(then, 'then', { get() { effects++; throw new Error('receipt then'); } });
  for (const receipt of [getter, valueGetter, proxy, then, null, { done: false }, { done: 0, value: [1] },
    { done: false, value: [1], extra: true }]) {
    let close = 0;
    const pages = () => ({ [Symbol.iterator]() { return { next: () => receipt, return() { close++; return { done: true }; } }; } });
    await assert.rejects(summarize({ member_count: 1, count: 1, pages }), failure('iterator_receipt'));
    assert.equal(close, 1);
  }
  assert.equal(effects, 0);
});

test('an actual asynchronous page settle and iterator ending cannot escape current cancellation or owner deadline', async () => {
  for (const ending of [false, true]) {
    const controller = new AbortController(); let close = 0;
    const pages = () => ({ [Symbol.asyncIterator]() { return {
      async next() { await new Promise(resolve => setImmediate(resolve)); controller.abort();
        return ending ? { done: true } : { done: false, value: [42] }; },
      async return() { close++; return { done: true }; },
    }; } });
    await assert.rejects(summarize({ member_count: ending ? 0 : 1, count: ending ? 0 : 1,
      pages, signal: controller.signal }), failure('cancelled'));
    assert.equal(close, 1);
  }
  let factoryCalled = false;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(summarize({ member_count: 0, count: 0, signal: controller.signal,
    pages() { factoryCalled = true; return []; } }), failure('cancelled'));
  assert.equal(factoryCalled, false);
  await assert.rejects(summarize({ member_count: 0, count: 0,
    checkBudget() { throw new Error('initial deadline'); }, pages() { factoryCalled = true; return []; } }), /initial deadline/);
  assert.equal(factoryCalled, false);
});
