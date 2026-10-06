import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { isProxy } from 'node:util/types';
import { NEIGHBORHOOD_STATISTICS_LIMITS } from './statistics.js';

export const EXACT_PAGED_DISTRIBUTION_LIMITS = Object.freeze({
  page_values: 1000,
  observation_values: NEIGHBORHOOD_STATISTICS_LIMITS.measurement_values,
});
const L = EXACT_PAGED_DISTRIBUTION_LIMITS;
function invalid(reason) {
  throw Object.assign(new TypeError(`Neighborhood sorted observations invalid: ${reason}`),
    { code: 'NEIGHBORHOOD_STATISTICS_PAGE_INVALID', state: 'incomplete', reason });
}
function limit(observed) {
  if (observed <= L.observation_values) return;
  throw Object.assign(new RangeError('Neighborhood statistics work limit exceeded: values'), {
    code: 'NEIGHBORHOOD_STATISTICS_WORK_LIMIT', state: 'incomplete',
    resource: 'values', observed, limit: L.observation_values,
  });
}
function snapshot(page, length) {
  // No getters, proxy traps, holes, inherited values or extra data are executed.
  // Detach this finite page before any budget callback or asynchronous yield.
  if (isProxy(page) || !Array.isArray(page) || Object.getPrototypeOf(page) !== Array.prototype) invalid('page_shape');
  const descriptors = Object.getOwnPropertyDescriptors(page), keys = Reflect.ownKeys(descriptors);
  if (descriptors.length?.value !== length || keys.length !== length + 1) invalid('page_length');
  const values = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
      || typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value)) invalid('page_value');
    values.push(descriptor.value);
  }
  return values;
}

/** Exact numerical kernel, not membership, source verification or authority.
 * The owner derives BOTH counts from a complete verified population and supplies
 * a fresh, repeatable iterator over all its globally sorted finite observations.
 * Each page must already have passed that owner's original/hash/lineage checks.
 * Missing observations remain in member_count, not in the sorted value stream.
 * Two complete passes use one owned <=1000-value copy and six quantile positions
 * (the supplying owner separately owns its iterator receipts/buffers), never
 * every observation or page medians. A changed second pass is refused. Its
 * numerical witness does not replace the owner's full source/lineage witness.
 * This does not create sorted runs, authorize/read a DB, raise live capture caps,
 * change legacy exactDistribution, or permit a prefix to be published. The owner
 * still owns aggregate work/deadline, current rights and coherent publication.
 */
export async function exactDistributionFromSortedPages({
  pages, member_count, count, minimum_count = 1, signal, checkBudget = () => {},
} = {}) {
  if (typeof pages !== 'function' || typeof checkBudget !== 'function'
    || (signal !== undefined && !(signal instanceof AbortSignal))) invalid('options');
  if (!Number.isSafeInteger(member_count) || member_count < 0
    || !Number.isSafeInteger(count) || count < 0 || count > member_count) invalid('counts');
  limit(member_count);
  if (!Number.isSafeInteger(minimum_count) || minimum_count < 1) invalid('minimum_count');
  const check = () => {
    if (signal?.aborted) invalid('cancelled');
    checkBudget();
    if (signal?.aborted) invalid('cancelled');
  };
  check();
  const positions = [0.25, 0.5, 0.75].map(fraction => (count - 1) * fraction);
  const sought = new Set(count ? positions.flatMap(position => [Math.floor(position), Math.ceil(position)]) : []);
  const quantileValues = new Map();
  let low = null, high = null, mean = count ? 0 : null, absoluteDeviation = count ? 0 : null;
  async function pass(onValue) {
    check();
    const stream = await pages();
    if (isProxy(stream) || stream === null || !['object', 'function'].includes(typeof stream)) invalid('page_iterator');
    const asyncMethod = stream[Symbol.asyncIterator];
    if (asyncMethod != null && typeof asyncMethod !== 'function') invalid('page_iterator');
    const asynchronous = typeof asyncMethod === 'function';
    const method = asynchronous ? asyncMethod : stream[Symbol.iterator];
    if (typeof method !== 'function') invalid('page_iterator');
    const iterator = method.call(stream);
    if (isProxy(iterator) || !iterator) invalid('page_iterator');
    const nextMethod = iterator.next, close = iterator.return;
    if (typeof nextMethod !== 'function' || (close != null && typeof close !== 'function')) invalid('page_iterator');
    const next = nextMethod.bind(iterator);
    let observed = 0, previous = null;
    const digest = createHash('sha256').update('[', 'utf8');
    let exhausted = false;
    try {
      // Capture the lazy owner iterator before the post-factory check, so a
      // settled factory followed by cancellation/deadline still closes it.
      check();
      // Await the owner's iterator receipt, NEVER a raw page. Async-from-sync
      // iteration otherwise assimilates a page's untrusted `then` property
      // before its closed-array grammar can reject that extra accessor/proxy.
      while (true) {
        check();
        const pending = next(), receipt = asynchronous ? await pending : pending;
        check();
        if (isProxy(receipt) || !receipt || Object.getPrototypeOf(receipt) !== Object.prototype) invalid('iterator_receipt');
        const fields = Object.getOwnPropertyDescriptors(receipt), keys = Reflect.ownKeys(fields);
        if (!fields.done || !Object.hasOwn(fields.done, 'value') || typeof fields.done.value !== 'boolean'
          || keys.some(key => key !== 'done' && key !== 'value')
          || (fields.value && !Object.hasOwn(fields.value, 'value'))) invalid('iterator_receipt');
        if (fields.done.value) { exhausted = true; break; }
        if (!fields.value) invalid('iterator_receipt');
        if (observed >= count) invalid('extra_page');
        const values = snapshot(fields.value.value, Math.min(L.page_values, count - observed));
        // Signed zero must not disappear from the repeatability witness. String
        // numbers preserve each finite Number exactly, including exponent forms.
        digest.update(`${observed ? ',' : ''}${values.map(value => Object.is(value, -0) ? '-0' : String(value)).join(',')}`, 'utf8');
        for (const value of values) {
          if (observed > 0 && value < previous) invalid('observation_order');
          onValue(value, observed);
          previous = value;
          observed++;
          if (observed % 125 === 0) { check(); await yieldToRequests(); check(); }
        }
        check();
      }
    } finally {
      if (!exhausted && typeof close === 'function') {
        const closing = close.call(iterator);
        if (asynchronous) await closing;
      }
    }
    check();
    if (observed !== count) invalid('missing_observations');
    return digest.update(']', 'utf8').digest('hex');
  }
  const first = await pass((value, index) => {
    if (index === 0) low = value;
    high = value;
    if (sought.has(index)) quantileValues.set(index, value);
    // Match legacy ascending reduction order and per-value division exactly.
    mean += value / count;
  });
  const quantile = position => {
    if (!count) return null;
    const lower = Math.floor(position), fraction = position - lower;
    return quantileValues.get(lower) * (1 - fraction) + quantileValues.get(Math.ceil(position)) * fraction;
  };
  const median = quantile(positions[1]);
  const second = await pass(value => { absoluteDeviation += Math.abs(value - median) / count; });
  check();
  if (second !== first) invalid('observations_changed');
  const numeric_issues = [];
  const finite = (value, field) => {
    if (value === null || Number.isFinite(value)) return value;
    numeric_issues.push(field);
    return null;
  };
  const metrics = {
    low, q1: finite(quantile(positions[0]), 'q1'), median: finite(median, 'median'),
    q3: finite(quantile(positions[2]), 'q3'), high, mean: finite(mean, 'mean'),
    cod_percent: finite(median !== null && median !== 0 ? absoluteDeviation / Math.abs(median) * 100 : null, 'cod_percent'),
  };
  finite(absoluteDeviation, 'absolute_deviation');
  return Object.freeze({
    state: numeric_issues.length ? 'incomplete' : count >= minimum_count ? 'ready' : 'insufficient',
    reason: numeric_issues.length ? 'numeric_overflow' : count === 0 ? 'no_observations'
      : count < minimum_count ? 'below_minimum_count' : null,
    numeric_issues: Object.freeze(numeric_issues), estimator: 'exact_member_type_7_quantiles',
    member_count, count, missing_count: member_count - count,
    coverage_percent: member_count ? count / member_count * 100 : null, minimum_count, ...metrics,
  });
}
