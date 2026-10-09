import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { exactDecimalDistributionFromSortedPagesV1, parseExactDecimalPagedObservationV1,
  EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS } from './exactDecimalPagedDistributionV1.js';

export const EXACT_DECIMAL_OBSERVATION_RUN_V1_LIMITS = Object.freeze({
  page_values: EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS.page_values,
  member_values: EXACT_DECIMAL_PAGED_DISTRIBUTION_V1_LIMITS.member_count,
  merge_fan_in: 8, binding_bytes: 16384, page_bytes: 128000,
  metadata_bytes: 32768, manifest_bytes: 64000,
  blob_operations: 5000, staged_blobs: 1200, staged_bytes: 64000000, read_bytes: 128000000,
});
const L = EXACT_DECIMAL_OBSERVATION_RUN_V1_LIMITS;
const FORMAT = 'exact_decimal_observation_runs_v1';
const STATES = ['observed', 'missing', 'invalid', 'conflicting', 'unsupported'];
const COUNT_KEYS = ['member_count', ...STATES.map(state => `${state}_count`)];
const SHA = /^[a-f0-9]{64}$/;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** Refuse the entire derived result; never return provisional/prefix statistics. */
function fail(reason) { throw Object.assign(new TypeError(`exact_decimal_observation_runs_${reason}`),
  { code: 'EXACT_DECIMAL_OBSERVATION_RUN_INVALID', state: 'incomplete', reason }); }
/** Snapshot closed DATA without getters, proxy traps, symbols or inherited fields. */
function data(value, required, optional = []) {
  if (!value || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('shape');
  const ds = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(ds);
  if (required.some(key => !Object.hasOwn(ds, key)) || keys.some(key => ![...required, ...optional].includes(key)
    || !ds[key].enumerable || !Object.hasOwn(ds[key], 'value'))) fail('shape');
  return Object.fromEntries(keys.map(key => [key, ds[key].value]));
}
/** Detach a bounded, dense ordinary array before any owner callback or yield. */
function array(value, length) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('page_shape');
  const ds = Object.getOwnPropertyDescriptors(value);
  if (ds.length?.value !== length || Reflect.ownKeys(ds).length !== length + 1) fail('page_length');
  return Array.from({ length }, (_, i) => {
    if (!ds[i]?.enumerable || !Object.hasOwn(ds[i], 'value')) fail('page_value'); return ds[i].value;
  });
}
/** Preserve every non-observed reason, not a lossy shared null bucket. */
function cell(value) {
  const c = data(value, ['state', 'exact_value']);
  if (!STATES.includes(c.state)) fail('cell_state');
  if (c.state === 'observed') parseExactDecimalPagedObservationV1(c.exact_value);
  else if (c.exact_value !== null) fail('cell_value');
  return Object.freeze(c);
}
/** All five independently owner-derived counts must exhaust the fixed denominator. */
function counts(value) {
  const c = data(value, COUNT_KEYS);
  if (Object.values(c).some(n => !Number.isSafeInteger(n) || n < 0 || n > L.member_values)
    || STATES.reduce((sum, state) => sum + c[`${state}_count`], 0) !== c.member_count) fail('counts');
  return Object.freeze(c);
}
/** Canonical opaque binding, NOT interpretation, membership or rights authority. */
function binding(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > L.binding_bytes) fail('binding');
  try { if (json(JSON.parse(value)) !== value) fail('binding'); } catch { fail('binding'); } return value;
}
/** Validate a bounded immutable content address; byte conversion is not economic arithmetic. */
function reference(value, maximum) {
  const v = data(value, ['content_sha256', 'canonical_utf8_bytes']); let r;
  try { r = blobRef(v.content_sha256, v.canonical_utf8_bytes); } catch { fail('reference'); }
  if (Number(r.canonical_utf8_bytes) > maximum) fail('reference'); return r;
}
const digest = () => createHash('sha256').update('[', 'utf8');
const finish = d => d.update(']', 'utf8').digest('hex');
const add = (d, value, index) => d.update(`${index ? ',' : ''}${json(value)}`, 'utf8');
const order = (a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : a.ordinal - b.ordinal;
/** Exact decimal pair admission and stable original-ordinal tie breaking. */
function entry(value, members) {
  const [ordinal, text] = array(value, 2);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= members) fail('ordinal');
  return { ordinal, text, value: parseExactDecimalPagedObservationV1(text) };
}

/** Dormant, transaction-local derived DATA runs, deliberately separate from the
 * unchanged Number store. The actual supplying owner must provide complete,
 * immutable, currently authorized original cells, one homogeneous metric/unit,
 * retained dates and exact selected-union binding. None is minted here.
 *
 * One store shares all blob-operation/byte/staging budgets across every method.
 * Its cleanup roots include intermediate and attempted puts, even if an ACK,
 * cancellation or deadline fails; caller MUST roll back or register all roots
 * in its versioned graph. It does not BEGIN/COMMIT, register, publish, authorize,
 * change a current head or activate a worker/route/default. No originals are
 * copied, and every economic value remains an exact decimal string/BigInt.
 */
export function createExactDecimalObservationRunStoreV1(blobs, rawOptions = {}) {
  if (!blobs || isProxy(blobs) || typeof blobs.put !== 'function' || typeof blobs.get !== 'function') fail('repository');
  const o = data(rawOptions, [], ['signal', 'checkBudget']);
  const budget = o.checkBudget === undefined ? () => {} : o.checkBudget;
  if (typeof budget !== 'function' || o.signal !== undefined && (isProxy(o.signal) || !(o.signal instanceof AbortSignal))) fail('options');
  const put = blobs.put.bind(blobs), get = blobs.get.bind(blobs), retained = new Map();
  let operations = 0, staged = 0, stagedBytes = 0, readBytes = 0;
  /** Apply enclosing owner lifetime/current-rights work checks at suspension boundaries. */
  function check() { if (o.signal?.aborted) fail('cancelled'); budget(); if (o.signal?.aborted) fail('cancelled'); }
  /** Charge each actual repository operation, including repeated reads/writes. */
  function port() { check(); if (++operations > L.blob_operations) fail('blob_operations_limit'); }
  /** Return owned root snapshots even after failure so the caller can clean up. */
  function roots() { return Object.freeze([...retained.values()]); }
  /** Store only canonical derived bytes; remember attempted roots before awaiting ACK. */
  async function write(value, maximum) {
    check(); const text = json(value), bytes = Buffer.byteLength(text);
    if (bytes > maximum || ++staged > L.staged_blobs || (stagedBytes += bytes) > L.staged_bytes) fail('stage_limit');
    port(); const expected = blobRef(hash(text), String(bytes)); retained.set(expected.content_sha256, expected);
    const actual = reference(await put(text), maximum);
    if (actual.content_sha256 !== expected.content_sha256 || actual.canonical_utf8_bytes !== expected.canonical_utf8_bytes) fail('storage_ack');
    check(); return expected;
  }
  /** Reopen exact immutable bytes, never trust stored hashes without content checks. */
  async function read(ref, maximum) {
    const expected = reference(ref, maximum);
    if ((readBytes += Number(expected.canonical_utf8_bytes)) > L.read_bytes) fail('read_bytes_limit');
    port(); const text = await get(expected.content_sha256, expected.canonical_utf8_bytes); check();
    if (typeof text !== 'string' || Buffer.byteLength(text) !== Number(expected.canonical_utf8_bytes)
      || hash(text) !== expected.content_sha256) fail('missing_or_changed_blob');
    let value; try { value = JSON.parse(text); if (json(value) !== text) fail('noncanonical'); } catch { fail('noncanonical'); }
    return value;
  }
  /** Cooperatively yield bounded numerical work without escaping cancellation checks. */
  async function pause() { check(); await yieldToRequests(); check(); }
  /** Exhaust all five-state cells, detach each full page before callbacks and close on refusal. */
  async function drain(pages, declared, visit) {
    if (typeof pages !== 'function') fail('pages');
    check(); const stream = await pages(); if (!stream || isProxy(stream)) fail('iterator');
    const am = stream[Symbol.asyncIterator], asynchronous = typeof am === 'function';
    if (am != null && !asynchronous) fail('iterator');
    const method = asynchronous ? am : stream[Symbol.iterator]; if (typeof method !== 'function') fail('iterator');
    const iterator = method.call(stream); if (!iterator || isProxy(iterator)) fail('iterator');
    const next = iterator.next, close = iterator.return;
    if (typeof next !== 'function' || close != null && typeof close !== 'function') fail('iterator');
    const actual = Object.fromEntries(COUNT_KEYS.map(key => [key, 0])); let exhausted = false;
    try {
      check();
      while (true) {
        check(); const pending = next.call(iterator), receipt = asynchronous ? await pending : pending; check();
        const r = data(receipt, ['done'], ['value']); if (typeof r.done !== 'boolean') fail('iterator_receipt');
        if (r.done) { exhausted = true; break; }
        if (!Object.hasOwn(r, 'value') || actual.member_count >= declared.member_count) fail('extra_page');
        const page = array(r.value, Math.min(L.page_values, declared.member_count - actual.member_count)).map(cell);
        for (const c of page) actual[`${c.state}_count`]++;
        await visit(page, actual.member_count); check(); actual.member_count += page.length;
      }
      if (COUNT_KEYS.some(key => actual[key] !== declared[key])) fail('original_counts');
    } finally { if (!exhausted && close) { const closing = close.call(iterator); if (asynchronous) await closing; } }
    check();
  }
  /** One <=1000-entry cursor; each run verifies complete order, length and digest. */
  function cursor(run, members) {
    let index = 0, pageIndex = 0, position = 0, page = [], prior = null; const witness = digest();
    return { async next() {
      check();
      if (index === run.count) {
        if (pageIndex !== run.page_refs.length || finish(witness) !== run.sha256) fail('run_complete'); return null;
      }
      if (position === page.length) {
        page = array(await read(run.page_refs[pageIndex++], L.page_bytes), Math.min(L.page_values, run.count - index))
          .map(pair => entry(pair, members)); position = 0;
      }
      const current = page[position++]; if (prior && order(prior, current) >= 0) fail('run_order');
      add(witness, [current.ordinal, current.text], index++); prior = current; return current;
    } };
  }
  /** Merge at most eight cursors into bounded pages, never a full-value array. */
  async function merge(runs, members) {
    const cursors = runs.map(run => cursor(run, members)), heads = [];
    for (const c of cursors) heads.push(await c.next());
    const witness = digest(), page_refs = []; let count = 0, buffer = [];
    while (heads.some(Boolean)) {
      let chosen = -1;
      for (let i = 0; i < heads.length; i++) if (heads[i] && (chosen < 0 || order(heads[i], heads[chosen]) < 0)) chosen = i;
      const current = heads[chosen]; add(witness, [current.ordinal, current.text], count++); buffer.push([current.ordinal, current.text]);
      if (buffer.length === L.page_values) { page_refs.push(await write(buffer, L.page_bytes)); buffer = []; }
      heads[chosen] = await cursors[chosen].next(); if (count % 125 === 0) await pause();
    }
    if (buffer.length) page_refs.push(await write(buffer, L.page_bytes));
    if (count !== runs.reduce((sum, run) => sum + run.count, 0)) fail('merge_count');
    return { count, page_refs, sha256: finish(witness) };
  }
  /** Fixed new-format metadata cannot be substituted with legacy Number runs. */
  async function header(root, bound, declared) {
    const manifest = data(await read(root, L.manifest_bytes), ['format', 'metadata_ref', 'run']);
    const metadata = data(await read(manifest.metadata_ref, L.metadata_bytes), ['format', 'binding_json', 'counts', 'input_sha256']);
    const actual = counts(metadata.counts), run = data(manifest.run, ['count', 'page_refs', 'sha256']);
    if (manifest.format !== FORMAT || metadata.format !== FORMAT || metadata.binding_json !== bound
      || COUNT_KEYS.some(key => actual[key] !== declared[key]) || run.count !== actual.observed_count
      || typeof metadata.input_sha256 !== 'string' || !SHA.test(metadata.input_sha256)
      || typeof run.sha256 !== 'string' || !SHA.test(run.sha256)) fail('manifest');
    run.page_refs = array(run.page_refs, Math.ceil(run.count / L.page_values)).map(ref => reference(ref, L.page_bytes));
    return { metadata, run };
  }
  return Object.freeze({
    retentionReferences: roots,
    /** Stage all original reasons and every exact observation before root delivery. */
    async stage(input) {
      const a = data(input, ['bindingJson', 'counts', 'pages']), bound = binding(a.bindingJson), declared = counts(a.counts);
      let runs = []; const inputDigest = digest();
      await drain(a.pages, declared, async (page, start) => {
        const sorted = [], witness = digest();
        for (let i = 0; i < page.length; i++) {
          const c = page[i]; add(inputDigest, [c.state, c.exact_value], start + i);
          if (c.state === 'observed') sorted.push({ ordinal: start + i, text: c.exact_value, value: parseExactDecimalPagedObservationV1(c.exact_value) });
          if ((i + 1) % 125 === 0) await pause();
        }
        sorted.sort(order); sorted.forEach((item, i) => add(witness, [item.ordinal, item.text], i));
        if (sorted.length) runs.push({ count: sorted.length, sha256: finish(witness),
          page_refs: [await write(sorted.map(item => [item.ordinal, item.text]), L.page_bytes)] });
      });
      while (runs.length > 1) {
        const next = [];
        for (let i = 0; i < runs.length; i += L.merge_fan_in) {
          const group = runs.slice(i, i + L.merge_fan_in); next.push(group.length === 1 ? group[0] : await merge(group, declared.member_count));
        }
        runs = next;
      }
      const run = runs[0] ?? { count: 0, page_refs: [], sha256: hash('[]') };
      const metadata_ref = await write({ format: FORMAT, binding_json: bound, counts: declared, input_sha256: finish(inputDigest) }, L.metadata_bytes);
      const manifest_ref = await write({ format: FORMAT, metadata_ref, run }, L.manifest_bytes); check();
      return Object.freeze({ authority: 'not_established', manifest_ref, retention_refs: roots() });
    },
    /** Reconcile complete fresh originals initially and at BOTH pass endings,
     * and EVERY sorted ordinal/value in BOTH passes, not just an opaque hash.
     * The ordinal reader must be trusted synchronous O(1) over those SAME
     * immutable originals, not a request callback. Actual owner issuance and
     * current source/selection/unit rights remain outside this DATA helper. */
    async distributionFromOriginalPages(input) {
      const a = data(input, ['bindingJson', 'manifestRef', 'counts', 'pages', 'cellAtOrdinal'], ['minimum_count']);
      const bound = binding(a.bindingJson), root = reference(a.manifestRef, L.manifest_bytes), declared = counts(a.counts);
      const minimum = a.minimum_count === undefined ? 1 : a.minimum_count;
      if (!Number.isSafeInteger(minimum) || minimum < 1 || typeof a.pages !== 'function' || typeof a.cellAtOrdinal !== 'function') fail('options');
      const initial = await header(root, bound, declared);
      /** Reopen the complete original sequence, preserving all five dispositions. */
      async function reconcile() {
        const witness = digest();
        await drain(a.pages, declared, async (page, start) => {
          for (let i = 0; i < page.length; i++) {
            const c = page[i], actual = cell(a.cellAtOrdinal(start + i));
            if (actual.state !== c.state || actual.exact_value !== c.exact_value) fail('original_cell');
            add(witness, [c.state, c.exact_value], start + i); if ((i + 1) % 125 === 0) await pause();
          }
        });
        if (finish(witness) !== initial.metadata.input_sha256) fail('original_input'); check();
      }
      await reconcile();
      return exactDecimalDistributionFromSortedPagesV1({ counts: declared, minimum_count: minimum, signal: o.signal, checkBudget: check,
        pages: () => (async function* () {
          const { run } = await header(root, bound, declared), seen = new Uint8Array(Math.ceil(declared.member_count / 8));
          const c = cursor(run, declared.member_count); let page = [];
          for (let current = await c.next(); current; current = await c.next()) {
            const byte = Math.floor(current.ordinal / 8), bit = 1 << (current.ordinal % 8);
            if (seen[byte] & bit) fail('duplicate_ordinal'); seen[byte] |= bit;
            const original = cell(a.cellAtOrdinal(current.ordinal));
            if (original.state !== 'observed' || original.exact_value !== current.text) fail('original_cell');
            page.push(current.text); if (page.length === L.page_values) { yield page; page = []; }
          }
          if (page.length) yield page;
          await reconcile(); await header(root, bound, declared); check();
        })() });
    },
  });
}
