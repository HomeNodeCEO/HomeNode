import assert from 'node:assert/strict';
import test from 'node:test';
import { exactDecimalDistributionFromSortedPagesV1 as summarize, getExactDecimalPagedDistributionV1Profile,
  EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS as L } from '../src/services/neighborhoodAssessment/exactDecimalPagedDistributionV1.js';

/** Owner-shaped DATA counts only; no source, unit, selected-union or rights proof. */
function counts(observed, other = {}) {
  const c = { observed_count: observed, missing_count: 0, invalid_count: 0, conflicting_count: 0, unsupported_count: 0, ...other };
  return { member_count: Object.values(c).reduce((a, b) => a + b, 0), ...c };
}
/** Fresh bounded sorted DATA pages for each independently exhausted pass. */
function input(values, other = {}, options = {}) {
  return { counts: counts(values.length, other), pages: () => Array.from({ length: Math.ceil(values.length / L.page_values) },
    (_, i) => values.slice(i * L.page_values, (i + 1) * L.page_values)), ...options };
}
/** Assert exact reduced rational output without rounding it into a Number. */
function rational(value, numerator, denominator) { assert.deepEqual(value, { numerator, denominator }); }

test('exact decimal quartiles retain >2^53 prices and 14-place interpolation, while mean and COD remain exact rationals', async () => {
  const tiny = await summarize(input(['0', '0.000000000001']));
  assert.equal(tiny.low, '0'); assert.equal(tiny.high, '0.000000000001');
  assert.equal(tiny.q1, '0.00000000000025'); assert.equal(tiny.median, '0.0000000000005'); assert.equal(tiny.q3, '0.00000000000075');
  rational(tiny.mean, '1', '2000000000000'); rational(tiny.mean_absolute_deviation_from_median, '1', '2000000000000');
  rational(tiny.cod_percent, '100', '1');
  const huge = await summarize(input(['9007199254740993.01', '9007199254740993.02']));
  assert.equal(huge.q1, '9007199254740993.0125'); assert.equal(huge.median, '9007199254740993.015');
  assert.equal(huge.q3, '9007199254740993.0175'); rational(huge.mean, '1801439850948198603', '200');
  rational(huge.mean_absolute_deviation_from_median, '1', '200'); rational(huge.cod_percent, '100', '1801439850948198603');
  const repeating = await summarize(input(['1', '2', '4']));
  rational(repeating.mean, '7', '3'); rational(repeating.mean_absolute_deviation_from_median, '1', '1'); rational(repeating.cod_percent, '50', '1');
  assert.equal(repeating.median, '2'); assert.equal(repeating.q1, '1.5'); assert.equal(repeating.q3, '3');
  // The mean is 7/3, not 2: deviation about that mean would be 10/9, not 1.
  assert.equal(Object.hasOwn(repeating, 'mean_absolute_deviation'), false);
  assert.equal(JSON.parse(getExactDecimalPagedDistributionV1Profile().definition_blob.canonical_json).mean_and_dispersion,
    'reduced_exact_nonnegative_rationals_no_display_rounding_absolute_deviation_about_exact_median');
});

test('every observation state remains in the denominator; zero medians, empty observations and explicit empty populations stay distinct', async () => {
  const all = await summarize(input(['0', '0', '3'], { missing_count: 1, invalid_count: 1, conflicting_count: 1, unsupported_count: 2 }));
  assert.equal(all.counts.member_count, 8); rational(all.coverage_percent, '75', '2');
  assert.equal(all.median, '0'); assert.equal(all.cod_percent, null); rational(all.mean, '1', '1');
  let calls = 0;
  const none = await summarize(input([], { missing_count: 2 }, { pages() { calls++; return []; } }));
  assert.equal(calls, 2); assert.equal(none.reason, 'no_observations'); assert.equal(none.median, null); assert.equal(none.mean, null);
  assert.equal(none.mean_absolute_deviation_from_median, null); assert.equal(none.cod_percent, null); rational(none.coverage_percent, '0', '1');
  const empty = await summarize(input([])); assert.equal(empty.coverage_percent, null); assert.equal(empty.counts.member_count, 0);
  assert.equal((await summarize(input(['1'], {}, { minimum_count: 2 }))).reason, 'below_minimum_count');
  assert.equal(empty.authority, 'not_established'); assert.equal(empty.population_verification, 'not_established'); assert.equal(empty.report_update, 'none');
  assert.ok(Object.isFrozen(all.counts)); assert.ok(Object.isFrozen(all.coverage_percent));
});

test('global numeric order and exact population quantiles do not average page medians', async () => {
  const values = [...Array(1000).fill('1'), ...Array(1000).fill('100'), '10000'];
  const r = await summarize(input(values)); assert.equal(r.median, '100'); rational(r.mean, '37000', '667');
  // Numeric 2 precedes 10, although C-text 10 precedes 2.
  assert.equal((await summarize(input(['2', '10']))).median, '6');
  await assert.rejects(summarize(input(['10', '2'])), /invalid_order/);
  const span = await summarize(input(['0', '999999999999999999999999999999']));
  assert.equal(span.median, '499999999999999999999999999999.5');
});

test('deterministic dense integer oracle reconciles every quartile and exact mean/COD across odd/even and page boundaries', async () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 17, 999, 1000, 1001, 2001]) {
    const values = Array.from({ length: n }, (_, i) => String((i * 71 + 19) % 997)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
    const r = await summarize(input(values)), native = values.map(BigInt);
    for (const [field, k] of [['q1', 1], ['median', 2], ['q3', 3]]) {
      const rank = (n - 1) * k, lower = Math.floor(rank / 4), remainder = rank % 4;
      const expected = native[lower] * BigInt(4 - remainder) + (remainder ? native[lower + 1] * BigInt(remainder) : 0n);
      const [whole, fraction = ''] = r[field].split('.');
      assert.equal((BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * 4n, expected * 100n);
    }
    const sum = native.reduce((a, b) => a + b, 0n);
    assert.equal(BigInt(r.mean.numerator) * BigInt(n), sum * BigInt(r.mean.denominator));
    const mid = n % 2 ? native[(n - 1) / 2] * 2n : native[n / 2 - 1] + native[n / 2];
    const deviationTwice = native.reduce((total, value) => { const d = value * 2n - mid; return total + (d < 0n ? -d : d); }, 0n);
    assert.equal(BigInt(r.mean_absolute_deviation_from_median.numerator) * BigInt(n) * 2n,
      deviationTwice * BigInt(r.mean_absolute_deviation_from_median.denominator));
    if (mid === 0n) assert.equal(r.cod_percent, null);
    else assert.equal(BigInt(r.cod_percent.numerator) * BigInt(n) * mid,
      deviationTwice * 100n * BigInt(r.cod_percent.denominator));
  }
});

test('both passes must exhaust exactly every declared observation and repeat the full ordered stream', async () => {
  const first = Array.from({ length: 1000 }, (_, i) => String(i));
  for (const [pages, n, reason] of [[() => [], 1, /missing_observations/], [() => [first], 1001, /missing_observations/],
    [() => [first, ['1000', '1001']], 1001, /invalid_page/], [() => [first, ['1000'], []], 1001, /extra_page/],
    [() => [['1']], 0, /extra_page/], [() => [first, ['998']], 1001, /invalid_order/]])
    await assert.rejects(summarize({ counts: counts(n), pages }), reason);
  let pass = 0;
  await assert.rejects(summarize({ counts: counts(3), pages: () => [++pass === 1 ? ['0', '1', '3'] : ['0', '1', '4']] }), /observations_changed/);
  assert.equal(pass, 2);
  pass = 0;
  await assert.rejects(summarize({ counts: counts(1001), pages: () => ++pass === 1 ? [first, ['1000']] : [first] }), /missing_observations/);
});

test('closed canonical decimal pages and options reject getters, proxy traps, holes, aliases, rounding and unsupported signs/types', async () => {
  let effects = 0, ports = 0;
  const pages = () => { ports++; return []; };
  for (const bad of [{ pages, counts: counts(0), unit: 'USD' }, { pages, counts: { ...counts(0), member_count: 1 } },
    { pages, counts: counts(L.member_count + 1) }, { pages, counts: counts(0), minimum_count: 0 },
    { pages, counts: counts(0), signal: {} }, { pages, counts: counts(0), get checkBudget() { effects++; } },
    new Proxy({ pages, counts: counts(0) }, { ownKeys() { effects++; assert.fail('proxy'); } })])
    await assert.rejects(summarize(bad), /invalid_/);
  assert.equal(ports, 0);
  const getter = ['1']; Object.defineProperty(getter, '0', { enumerable: true, get() { effects++; } });
  const then = ['1']; Object.defineProperty(then, 'then', { get() { effects++; } });
  const proxy = new Proxy(['1'], { get() { effects++; assert.fail('proxy'); } });
  const extra = ['1']; extra.x = 1;
  for (const page of [getter, then, proxy, extra, new Array(1), [1], ['01'], ['1.0'], ['1.'], ['+1'], ['-0'], ['1e2'],
    ['0.0000000000001'], ['1000000000000000000000000000000'], [' 1'], ['NaN'], [null]])
    await assert.rejects(summarize({ counts: counts(1), pages: () => [page] }), /invalid_/);
  assert.equal(effects, 0);
});

test('synchronous receipts never assimilate a raw page or receipt then getter, and failures close the owner iterator', async () => {
  let effects = 0;
  const then = { done: false, value: ['1'] }; Object.defineProperty(then, 'then', { get() { effects++; } });
  const getter = { value: ['1'] }; Object.defineProperty(getter, 'done', { enumerable: true, get() { effects++; } });
  const valueGetter = { done: false }; Object.defineProperty(valueGetter, 'value', { enumerable: true, get() { effects++; } });
  for (const receipt of [then, getter, valueGetter, new Proxy({ done: false, value: ['1'] }, {}), null,
    { done: false }, { done: 0 }, { done: true, extra: 1 }]) {
    let closed = 0;
    await assert.rejects(summarize({ counts: counts(1), pages: () => ({ [Symbol.iterator]() { return {
      next: () => receipt, return() { closed++; return { done: true }; },
    }; } }) }), /invalid_/);
    assert.equal(closed, 1);
  }
  assert.equal(effects, 0);
});

test('bounded snapshots survive caller page mutation, cancellation and deadlines settle cleanup without partial output', async () => {
  const initial = Array.from({ length: 1000 }, (_, i) => String(i)); let pass = 0;
  const r = await summarize({ counts: counts(1000), pages() { pass++; return [pass === 1 ? initial : Array.from({ length: 1000 }, (_, i) => String(i))]; },
    checkBudget() { if (pass === 1) setImmediate(() => initial.fill('0')); } });
  assert.equal(r.median, '499.5');
  for (const targetPass of [1, 2]) {
    let calls = 0, closed = 0, ticks = 0;
    await assert.rejects(summarize({ counts: counts(1001), pages() { calls++; return (async function* () {
      try { yield Array.from({ length: 1000 }, (_, i) => String(i)); yield ['1000']; } finally { closed++; }
    })(); }, checkBudget() { if (calls === targetPass && ++ticks === 6) throw new Error('owner_deadline'); } }), /owner_deadline/);
    assert.equal(calls, targetPass); assert.equal(closed, targetPass);
  }
  for (const ending of [false, true]) {
    const controller = new AbortController(); let closed = 0;
    await assert.rejects(summarize({ counts: counts(ending ? 0 : 1), signal: controller.signal, pages: () => ({ [Symbol.asyncIterator]() { return {
      async next() { await new Promise(resolve => setImmediate(resolve)); controller.abort(); return ending ? { done: true } : { done: false, value: ['1'] }; },
      async return() { closed++; return { done: true }; },
    }; } }) }), /cancelled/); assert.equal(closed, 1);
  }
  const controller = new AbortController(); let closed = 0;
  await assert.rejects(summarize({ counts: counts(0), signal: controller.signal, async pages() {
    controller.abort(); return { [Symbol.asyncIterator]() { return { next() { assert.fail('cancelled'); }, async return() { closed++; } }; } };
  } }), /cancelled/); assert.equal(closed, 1);
});

test('large lazy decimal DATA stream exceeds 50k and reaches the unchanged numerical cap without a complete value array', async () => {
  for (const n of [60001, L.member_count]) {
    let calls = 0, largest = 0, pagesRead = 0;
    const r = await summarize({ counts: counts(n), pages() { calls++; return (async function* () {
      for (let start = 0; start < n; start += L.page_values) {
        const page = Array.from({ length: Math.min(L.page_values, n - start) }, (_, i) => String(start + i));
        largest = Math.max(largest, page.length); pagesRead++; yield page;
      }
    })(); } });
    assert.equal(calls, 2); assert.equal(largest, L.page_values); assert.equal(pagesRead, 2 * Math.ceil(n / L.page_values));
    assert.equal(r.median, n === 60001 ? '30000' : '124999.5'); assert.equal(r.high, String(n - 1));
    assert.equal(r.counts.observed_count, n); assert.equal(r.population_verification, 'not_established');
  }
  const p = getExactDecimalPagedDistributionV1Profile(); assert.equal(p.profile_ref.content_sha256, p.definition_blob.ref.content_sha256);
  assert.ok(Object.isFrozen(p.definition_blob));
});
