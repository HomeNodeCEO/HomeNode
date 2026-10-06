import { createHash } from 'node:crypto';
import { setImmediate as yieldToRequests } from 'node:timers/promises';
import { isProxy } from 'node:util/types';
import { canonicalAssessmentJson as json } from './contract.js';
import { prepareNeighborhoodCohortBlobReference as blobRef } from './cohortEvidenceBlobRepository.js';
import { exactDistributionFromSortedPages, EXACT_PAGED_DISTRIBUTION_LIMITS } from './exactPagedDistribution.js';

export const EXACT_PAGED_OBSERVATION_RUN_LIMITS = Object.freeze({
  page_values: EXACT_PAGED_DISTRIBUTION_LIMITS.page_values,
  member_values: EXACT_PAGED_DISTRIBUTION_LIMITS.observation_values,
  merge_fan_in: 8, binding_bytes: 16384, page_bytes: 128000,
  metadata_bytes: 32768, manifest_bytes: 64000,
  blob_operations: 5000, staged_blobs: 1200, staged_bytes: 64000000, read_bytes: 128000000,
});
const L = EXACT_PAGED_OBSERVATION_RUN_LIMITS;
const SHA = /^[a-f0-9]{64}$/;
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const token = value => Object.is(value, -0) ? '-0' : String(value);
function fail(reason) { throw Object.assign(new TypeError(`Neighborhood observation runs invalid: ${reason}`),
  { code: 'NEIGHBORHOOD_OBSERVATION_RUN_INVALID', state: 'incomplete', reason }); }
function closed(value, keys) {
  if (isProxy(value) || !value || Object.getPrototypeOf(value) !== Object.prototype) fail('shape');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length) fail('shape');
  const copy = {};
  for (const key of keys) {
    const d = fields[key];
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('shape');
    copy[key] = d.value;
  }
  return copy;
}
function array(value, length) {
  if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail('page_shape');
  const fields = Object.getOwnPropertyDescriptors(value);
  if (fields.length?.value !== length || Reflect.ownKeys(fields).length !== length + 1) fail('page_length');
  return Array.from({ length }, (_, i) => {
    const d = fields[i];
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) fail('page_value');
    return d.value;
  });
}
function reference(value, maximum) {
  const v = closed(value, ['content_sha256', 'canonical_utf8_bytes']);
  let r; try { r = blobRef(v.content_sha256, v.canonical_utf8_bytes); } catch { fail('reference'); }
  if (Number(r.canonical_utf8_bytes) > maximum) fail('reference');
  return r;
}
function memberCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > L.member_values) fail('member_limit');
  return value;
}
function binding(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > L.binding_bytes) fail('binding');
  try { if (json(JSON.parse(value)) !== value) fail('binding'); } catch { fail('binding'); }
  return value;
}
const order = (a, b) => a.value < b.value ? -1 : a.value > b.value ? 1 : a.ordinal - b.ordinal;
const digest = () => createHash('sha256').update('[', 'utf8');
const add = (d, entry, index) => d.update(`${index ? ',' : ''}${json([entry.ordinal, entry.token])}`, 'utf8');
const finish = d => d.update(']', 'utf8').digest('hex');

/** Derived Number runs, NOT original member/source admission or authorization.
 * Use an organization-scoped immutable blob repository in the caller's owned
 * transaction. The caller supplies fully verified, uniquely ordered complete
 * observation cells (finite Number/null), and an exact canonical binding to its
 * original context, selection, population/metric, period, units and lineage.
 * This binding is opaque here, not proof of those semantics or current rights.
 * Raw decimals/IDs/source records must remain in their original graph, untouched.
 * Every cell including null is consumed before registration; only finite cells
 * enter stable sorted runs. Eight <=1000-entry cursors merge at a time; never a
 * whole-value array or average of page medians. Ordinal tie-breaks preserve the
 * legacy stable Number order, including signed zero encoded as an exact token.
 * Caller owns rollback, all staged/intermediate cleanup roots, aggregate work,
 * fresh source/assignment rights and final coherent registration/publication.
 * No live owner, schema, source cap, retained graph budget or cache is activated.
 */
export function createExactPagedObservationRunStore(blobs) {
  if (!blobs || isProxy(blobs) || typeof blobs.put !== 'function' || typeof blobs.get !== 'function') fail('repository');
  const put = blobs.put.bind(blobs), get = blobs.get.bind(blobs);
  function operation({ signal, checkBudget = () => {} } = {}) {
    if (typeof checkBudget !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))) fail('options');
    let operations = 0, staged = 0, stagedBytes = 0, readBytes = 0;
    const check = () => { if (signal?.aborted) fail('cancelled'); checkBudget(); if (signal?.aborted) fail('cancelled'); };
    const port = () => { check(); if (++operations > L.blob_operations) fail('blob_operations_limit'); };
    async function write(value, maximum) {
      const text = json(value), bytes = Buffer.byteLength(text);
      if (bytes > maximum || ++staged > L.staged_blobs || (stagedBytes += bytes) > L.staged_bytes) fail('stage_limit');
      port(); const actual = reference(await put(text), maximum); check();
      if (actual.content_sha256 !== hash(text) || actual.canonical_utf8_bytes !== String(bytes)) fail('storage_ack');
      return actual;
    }
    async function read(ref, maximum) {
      const expected = reference(ref, maximum);
      if ((readBytes += Number(expected.canonical_utf8_bytes)) > L.read_bytes) fail('read_bytes_limit');
      port(); const text = await get(expected.content_sha256, expected.canonical_utf8_bytes); check();
      if (typeof text !== 'string' || Buffer.byteLength(text) !== Number(expected.canonical_utf8_bytes)
        || hash(text) !== expected.content_sha256) fail('missing_or_changed_original');
      let value; try { value = JSON.parse(text); if (json(value) !== text) fail('noncanonical'); } catch { fail('noncanonical'); }
      return value;
    }
    const pause = async () => { check(); await yieldToRequests(); check(); };
    return { check, write, read, pause };
  }
  async function drain(pages, member_count, op, visit) {
    if (typeof pages !== 'function') fail('pages');
    op.check(); const stream = await pages();
    if (isProxy(stream) || !stream) fail('iterator');
    const am = stream[Symbol.asyncIterator], asynchronous = typeof am === 'function';
    if (am != null && !asynchronous) fail('iterator');
    const method = asynchronous ? am : stream[Symbol.iterator];
    if (typeof method !== 'function') fail('iterator');
    const iterator = method.call(stream);
    if (isProxy(iterator) || !iterator) fail('iterator');
    const next = iterator.next, close = iterator.return;
    if (typeof next !== 'function' || (close != null && typeof close !== 'function')) fail('iterator');
    let observed = 0, exhausted = false;
    try {
      op.check();
      while (true) {
        op.check(); const pending = next.call(iterator), receipt = asynchronous ? await pending : pending; op.check();
        // Await only trusted iterator receipts, never a raw page's `then`.
        if (!receipt || isProxy(receipt) || typeof receipt !== 'object') fail('iterator_receipt');
        const keys = Reflect.ownKeys(receipt);
        const r = closed(receipt, keys.includes('value') ? ['done', 'value'] : ['done']);
        if (typeof r.done !== 'boolean') fail('iterator_receipt');
        if (r.done) { exhausted = true; break; }
        if (!Object.hasOwn(r, 'value') || observed >= member_count) fail('extra_page');
        const values = array(r.value, Math.min(L.page_values, member_count - observed));
        if (values.some(value => value !== null && (typeof value !== 'number' || !Number.isFinite(value)))) fail('page_value');
        await visit(values, observed); op.check(); observed += values.length;
      }
      if (observed !== member_count) fail('missing_members');
    } finally { if (!exhausted && close) await close.call(iterator); }
  }
  function entry(pair, members) {
    const [ordinal, numberToken] = array(pair, 2);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= members
      || typeof numberToken !== 'string' || numberToken.length > 32) fail('entry');
    const value = Number(numberToken);
    if (!Number.isFinite(value) || token(value) !== numberToken) fail('number_token');
    return { ordinal, token: numberToken, value };
  }
  function cursor(run, members, op) {
    let index = 0, pageIndex = 0, page = [], position = 0, prior = null;
    const witness = digest();
    return { async next() {
      op.check();
      if (index === run.count) {
        if (pageIndex !== run.page_refs.length || finish(witness) !== run.sha256) fail('run_complete');
        return null;
      }
      if (position === page.length) {
        const raw = await op.read(run.page_refs[pageIndex++], L.page_bytes);
        page = array(raw, Math.min(L.page_values, run.count - index)).map(pair => entry(pair, members)); position = 0;
      }
      const current = page[position++];
      if (prior && order(prior, current) >= 0) fail('run_order');
      add(witness, current, index++); prior = current; return current;
    } };
  }
  async function merge(runs, members, op) {
    const cursors = runs.map(run => cursor(run, members, op));
    const heads = []; for (const c of cursors) heads.push(await c.next());
    let buffer = [], count = 0; const page_refs = [], witness = digest();
    while (heads.some(Boolean)) {
      let chosen = -1;
      for (let i = 0; i < heads.length; i++) if (heads[i] && (chosen < 0 || order(heads[i], heads[chosen]) < 0)) chosen = i;
      const current = heads[chosen]; add(witness, current, count++); buffer.push([current.ordinal, current.token]);
      if (buffer.length === L.page_values) { page_refs.push(await op.write(buffer, L.page_bytes)); buffer = []; }
      heads[chosen] = await cursors[chosen].next();
      if (count % 125 === 0) await op.pause();
    }
    if (buffer.length) page_refs.push(await op.write(buffer, L.page_bytes));
    if (count !== runs.reduce((sum, run) => sum + run.count, 0)) fail('merge_count');
    return { count, page_refs, sha256: finish(witness) };
  }
  async function header(manifestRef, bindingJson, op) {
    const manifest = closed(await op.read(manifestRef, L.manifest_bytes), ['version', 'metadata_ref', 'run']);
    const metadata = closed(await op.read(manifest.metadata_ref, L.metadata_bytes),
      ['version', 'binding_json', 'member_count', 'count', 'input_sha256']);
    const members = memberCount(metadata.member_count), run = closed(manifest.run, ['count', 'page_refs', 'sha256']);
    if (manifest.version !== 1 || metadata.version !== 1 || metadata.binding_json !== bindingJson
      || !Number.isSafeInteger(metadata.count) || metadata.count < 0 || metadata.count > members
      || run.count !== metadata.count || typeof metadata.input_sha256 !== 'string' || !SHA.test(metadata.input_sha256)
      || typeof run.sha256 !== 'string' || !SHA.test(run.sha256)) fail('manifest');
    run.page_refs = array(run.page_refs, Math.ceil(run.count / L.page_values)).map(ref => reference(ref, L.page_bytes));
    return { metadata, run };
  }
  async function calculate({ bindingJson, manifestRef, minimum_count = 1, ...options }, original = null) {
    const bound = binding(bindingJson), root = reference(manifestRef, L.manifest_bytes), op = operation(options);
    if (!Number.isSafeInteger(minimum_count) || minimum_count < 1) fail('minimum_count');
    if (original && (typeof original.pages !== 'function' || typeof original.valueAtOrdinal !== 'function')) fail('original_source');
    const members = original ? memberCount(original.member_count) : null;
    const initial = await header(root, bound, op);
    if (original) {
      if (members !== initial.metadata.member_count) fail('original_member_count');
      const input = digest(); let count = 0;
      await drain(original.pages, members, op, async (values, start) => {
        for (let i = 0; i < values.length; i++) {
          const value = values[i];
          if (!Object.is(original.valueAtOrdinal(start + i), value)) fail('original_value');
          input.update(`${start + i ? ',' : ''}${value === null ? 'null' : token(value)}`, 'utf8');
          if (value !== null) count++;
          if ((i + 1) % 125 === 0) await op.pause();
        }
      });
      if (count !== initial.metadata.count || finish(input) !== initial.metadata.input_sha256) fail('original_input');
    }
    return exactDistributionFromSortedPages({ member_count: initial.metadata.member_count,
      count: initial.metadata.count, minimum_count, signal: options.signal, checkBudget: op.check,
      pages: () => (async function* () {
        const { metadata, run } = await header(root, bound, op);
        const seen = new Uint8Array(Math.ceil(metadata.member_count / 8));
        const c = cursor(run, metadata.member_count, op); let page = [];
        for (let current = await c.next(); current; current = await c.next()) {
          const byte = Math.floor(current.ordinal / 8), bit = 1 << (current.ordinal % 8);
          if (seen[byte] & bit) fail('duplicate_ordinal'); seen[byte] |= bit;
          // A numeric digest or opaque binding alone does not prove a source
          // cell. The original-bound path compares EVERY finite ordinal/value
          // in BOTH passes with the freshly owned immutable source producer.
          if (original && !Object.is(original.valueAtOrdinal(current.ordinal), current.value)) fail('original_value');
          page.push(current.value);
          if (page.length === L.page_values) { yield page; page = []; }
        }
        if (page.length) yield page;
        // The immutable root and metadata must remain readable at the actual
        // end of EACH complete pass, not only before provisional observations.
        await header(root, bound, op); op.check();
      })() });
  }
  return Object.freeze({
    async stage({ bindingJson, member_count, pages, ...options } = {}) {
      const bound = binding(bindingJson), members = memberCount(member_count), op = operation(options);
      let runs = [], count = 0; const input = digest();
      await drain(pages, members, op, async (values, start) => {
        const sorted = [], witness = digest();
        for (let i = 0; i < values.length; i++) {
          const value = values[i]; input.update(`${start + i ? ',' : ''}${value === null ? 'null' : token(value)}`, 'utf8');
          if (value !== null) sorted.push({ ordinal: start + i, token: token(value), value });
          if ((i + 1) % 125 === 0) await op.pause();
        }
        sorted.sort(order);
        sorted.forEach((item, i) => add(witness, item, i)); count += sorted.length;
        if (sorted.length) runs.push({ count: sorted.length, sha256: finish(witness),
          page_refs: [await op.write(sorted.map(item => [item.ordinal, item.token]), L.page_bytes)] });
      });
      while (runs.length > 1) {
        const next = [];
        for (let i = 0; i < runs.length; i += L.merge_fan_in) {
          const group = runs.slice(i, i + L.merge_fan_in);
          next.push(group.length === 1 ? group[0] : await merge(group, members, op));
        }
        runs = next;
      }
      const run = runs[0] ?? { count: 0, page_refs: [], sha256: hash('[]') };
      const metadata_ref = await op.write({ version: 1, binding_json: bound, member_count: members,
        count, input_sha256: finish(input) }, L.metadata_bytes);
      const manifest_ref = await op.write({ version: 1, metadata_ref, run }, L.manifest_bytes);
      op.check(); return Object.freeze({ authority: 'not_established', manifest_ref });
    },
    async distribution({ bindingJson, manifestRef, minimum_count = 1, ...options } = {}) {
      return calculate({ bindingJson, manifestRef, minimum_count, ...options });
    },
    /** Internal supplying-owner bridge. Original pages must be a COMPLETE,
     * uniquely ordered, freshly verified immutable population, with a trusted
     * synchronous O(1) ordinal reader over those same originals. This checks the
     * input witness/null denominator AND each sorted pair, not merely the input
     * hash. It grants no source/member authority, rights or root registration.
     */
    async distributionFromOriginalPages({ member_count, pages, valueAtOrdinal, ...input } = {}) {
      return calculate(input, { member_count, pages, valueAtOrdinal });
    },
  });
}
