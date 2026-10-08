import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { canonicalAssessmentJson } from './contract.js';
import { prepareNeighborhoodCohortBlobReference } from './cohortEvidenceBlobRepository.js';

export const COHORT_ORIGINAL_SOURCE_REFERENCES_V2_KINDS = Object.freeze([
  'parcels', 'accounts', 'source_records', 'sales', 'sale_links', 'sync_state', 'sync_runs',
]);
export const COHORT_ORIGINAL_SOURCE_REFERENCES_V2_LIMITS = Object.freeze({
  pages: 200_000, rows: 14_000_000, layer_rows: 2_000_000, original_utf8_bytes: 8_000_000_000,
  root_utf8_bytes: 16_000, node_utf8_bytes: 4_000, page_utf8_bytes: 4_000_000,
  queries: 1024, io_utf8_bytes: 32_000_000, operation_ms: 60_000,
});
const FORMAT = 'cohort_original_source_references_v2';
const PLAN = 'neighborhood_frozen_job_closure_v1';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KINDS = COHORT_ORIGINAL_SOURCE_REFERENCES_V2_KINDS;
const LIMITS = COHORT_ORIGINAL_SOURCE_REFERENCES_V2_LIMITS;
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
function fail(reason) { throw new TypeError(`cohort_original_source_references_v2_${reason}`); }
/** Closed metadata only. Never execute getters, proxies, or caller toJSON. */
function data(value, keys) {
  if (!value || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('invalid_input');
  const ds = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(ds);
  if (names.length !== keys.length || !keys.every(k => names.includes(k) && ds[k].enumerable && Object.hasOwn(ds[k], 'value')))
    fail('invalid_input');
  return Object.fromEntries(keys.map(k => [k, ds[k].value]));
}
function reference(value) {
  const r = data(value, ['content_sha256', 'canonical_utf8_bytes']);
  try { return prepareNeighborhoodCohortBlobReference(r.content_sha256, r.canonical_utf8_bytes); }
  catch { fail('invalid_reference'); }
}
const integer = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
function bindingOf(raw) {
  const b = data(raw, ['organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'operation_id',
    'generation_id', 'spatial_definition_sha256', 'source_original_sha256']);
  if (!['organization_id', 'report_file_id', 'operation_id', 'generation_id'].every(k => typeof b[k] === 'string' && UUID.test(b[k]))
    || typeof b.assignment_file_id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(b.assignment_file_id)
    || BigInt(b.assignment_file_id) > 9223372036854775807n || typeof b.account_id !== 'string'
    || !b.account_id || b.account_id.length > 64 || !b.account_id.isWellFormed() || b.account_id.trim() !== b.account_id
    || /[\u0000-\u001f\u007f]/.test(b.account_id)
    || !['spatial_definition_sha256', 'source_original_sha256'].every(k => typeof b[k] === 'string' && HASH.test(b[k]))) fail('invalid_binding');
  return Object.freeze(b);
}
function cursor(value, kind) {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value) > 256 || value.includes('\0')) fail('invalid_cursor');
  if (value && ['parcels', 'source_records', 'sales', 'sale_links'].includes(kind)
    && (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) < -9223372036854775808n
      || BigInt(value) > 9223372036854775807n)) fail('invalid_cursor');
  if (value && kind === 'sync_runs' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) fail('invalid_cursor');
  return value;
}
function advances(a, b, kind) {
  return a !== '' && (b === '' || (['parcels', 'source_records', 'sales', 'sale_links'].includes(kind)
    ? BigInt(a) > BigInt(b) : Buffer.compare(Buffer.from(a), Buffer.from(b)) > 0));
}
function layerOf(raw, kind) {
  const l = data(raw, ['head', 'page_count', 'row_count', 'original_utf8_bytes', 'cursor', 'ended']);
  if (!integer(l.page_count, LIMITS.pages) || !integer(l.row_count, LIMITS.layer_rows)
    || !integer(l.original_utf8_bytes, LIMITS.original_utf8_bytes) || typeof l.ended !== 'boolean') fail('invalid_root');
  cursor(l.cursor, kind);
  if (l.page_count === 0) {
    if (l.head !== null || l.row_count !== 0 || l.original_utf8_bytes !== 0 || l.cursor !== '' || l.ended) fail('invalid_root');
  } else if (l.head === null || l.original_utf8_bytes < 1
    || l.row_count === 0 && (!l.ended || l.cursor !== '' || l.page_count !== 1)) fail('invalid_root');
  return Object.freeze({ ...l, head: l.head === null ? null : reference(l.head) });
}
function rootOf(raw, bindingJson) {
  const r = data(raw, ['format', 'binding', 'layers']);
  if (r.format !== FORMAT || canonicalAssessmentJson(bindingOf(r.binding)) !== bindingJson) fail('binding_changed');
  const ls = data(r.layers, KINDS), layers = {};
  let pages = 0, rows = 0, bytes = 0, unfinished = false;
  for (const kind of KINDS) {
    const l = layerOf(ls[kind], kind);
    if (unfinished && l.page_count !== 0) fail('invalid_root');
    unfinished ||= !l.ended;
    pages += l.page_count; rows += l.row_count; bytes += l.original_utf8_bytes; layers[kind] = l;
  }
  if (pages > LIMITS.pages || rows > LIMITS.rows || bytes > LIMITS.original_utf8_bytes) fail('graph_limit');
  return Object.freeze({ format: FORMAT, binding: bindingOf(r.binding), layers: Object.freeze(layers) });
}
/** Exact supplied page text is inspected, never parsed into new numerical facts.
 * Original payloads remain opaque strings. This proves representation only;
 * the owner must independently establish query scope and complete acquisition.
 */
function pageOf(text, bindingJson, binding, rowLimit) {
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > 250) fail('invalid_limit');
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > LIMITS.page_utf8_bytes) fail('invalid_original');
  let raw;
  try { raw = JSON.parse(text); } catch { fail('invalid_original'); }
  const body = data(raw, ['binding', 'page']);
  if (canonicalAssessmentJson(bindingOf(body.binding)) !== bindingJson) fail('binding_changed');
  const p = data(body.page, ['status', 'authority', 'coverage', 'original', 'spatial_definition', 'spatial_definition_sha256',
    'stock_population', 'source_scope', 'additional_cadastral_accounts', 'kind', 'after', 'next_cursor', 'rows', 'end_of_layer', 'page_utf8_bytes']);
  if (p.status !== 'source_closure_page' || p.authority !== 'not_established' || p.coverage !== 'page_only'
    || !KINDS.includes(p.kind) || p.additional_cadastral_accounts !== false
    || p.source_scope !== 'all_dates_one_hop_seeded_only_from_original_stock_accounts'
    || p.original?.generation_id !== binding.generation_id
    || digest(canonicalAssessmentJson(p.original)) !== binding.source_original_sha256
    || p.spatial_definition_sha256 !== binding.spatial_definition_sha256
    || digest(canonicalAssessmentJson(p.spatial_definition)) !== binding.spatial_definition_sha256
    || p.stock_population?.subject_included !== true || typeof p.end_of_layer !== 'boolean'
    || !integer(p.page_utf8_bytes, 2_100_000) || p.page_utf8_bytes < 2 || !Array.isArray(p.rows) || p.rows.length > rowLimit) fail('invalid_original');
  let last = cursor(p.after, p.kind);
  for (const rawRow of p.rows) {
    const row = data(rawRow, ['row_key', 'payload_text']);
    cursor(row.row_key, p.kind);
    if (!advances(row.row_key, last, p.kind) || typeof row.payload_text !== 'string' || !row.payload_text.isWellFormed()
      || Buffer.byteLength(row.payload_text) > 1_000_000) fail('invalid_original');
    last = row.row_key;
  }
  if (cursor(p.next_cursor, p.kind) !== last || p.rows.length === 0 && !p.end_of_layer) fail('invalid_original');
  return { page: p, row_count: p.rows.length, original_utf8_bytes: Buffer.byteLength(text), original_sha256: digest(text) };
}

/** Internal V2 REPRESENTATION ONLY: retain two small metadata blobs per page,
 * never per-report copies of immutable generation payloads/chunks. readOriginal
 * is an owner-supplied fixed-plan adapter returning the exact {binding,page}
 * text from the pinned originals; it is not an authority callback or arbitrary
 * SQL plan. No legacy V1 receipt is accepted or silently upgraded.
 *
 * The owner must keep the generation AND geographic stock reachable/immutable,
 * hold the live job pin, authorize current actor/assignment/subject/source rights
 * before and after all I/O, and commit root/checkpoint together. Traverse from
 * each actual root head and follow EVERY returned edge: a supplied position is
 * DATA, not root reachability. Counts/digests/end flags establish no complete
 * provider/identity closure, geographic membership, grant or accepted report.
 * Missing originals refuse: no active/latest, payload copy or mutable fallback.
 */
export function createCohortOriginalSourceReferencesV2Store(repository, rawBinding, options) {
  const repo = data(repository, ['put', 'get']);
  if (typeof repo.put !== 'function' || typeof repo.get !== 'function') fail('repository_required');
  const binding = bindingOf(rawBinding), bindingJson = canonicalAssessmentJson(binding), bindingSha = digest(bindingJson);
  if (!options || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) fail('invalid_input');
  const keys = Reflect.ownKeys(options);
  if (!keys.includes('readOriginal') || keys.some(k => !['readOriginal', 'signal', 'checkBudget'].includes(k))) fail('invalid_input');
  const opts = data(options, keys), readOriginal = opts.readOriginal, signal = opts.signal, checkBudget = opts.checkBudget ?? (() => {});
  if (typeof readOriginal !== 'function' || typeof checkBudget !== 'function'
    || signal !== undefined && !(signal instanceof AbortSignal)) fail('invalid_input');
  let busy = false, queries = 0, bytes = 0;
  const deadline = performance.now() + LIMITS.operation_ms;
  const check = () => {
    if (signal?.aborted) fail('cancelled'); checkBudget();
    if (signal?.aborted) fail('cancelled'); if (performance.now() >= deadline) fail('deadline');
  };
  const charge = n => { check(); if (++queries > LIMITS.queries || (bytes += n) > LIMITS.io_utf8_bytes) fail('operation_limit'); };
  const put = async (value, maximum) => {
    const text = canonicalAssessmentJson(value), size = Buffer.byteLength(text);
    if (size > maximum) fail('metadata_limit'); charge(size);
    const expected = prepareNeighborhoodCohortBlobReference(digest(text), String(size));
    const actual = reference(await repo.put(text)); check();
    if (canonicalAssessmentJson(actual) !== canonicalAssessmentJson(expected)) fail('storage_conflict'); return actual;
  };
  const get = async (raw, maximum) => {
    const expected = reference(raw), size = Number(expected.canonical_utf8_bytes);
    if (size > maximum) fail('metadata_limit'); charge(size);
    const text = await repo.get(expected.content_sha256, expected.canonical_utf8_bytes); check();
    if (text === null) fail('missing_original');
    if (typeof text !== 'string' || Buffer.byteLength(text) !== size || digest(text) !== expected.content_sha256) fail('storage_conflict');
    let value;
    try { value = JSON.parse(text); if (canonicalAssessmentJson(value) !== text) fail('storage_conflict'); }
    catch { fail('storage_conflict'); } return value;
  };
  const exclusive = async work => { check(); if (busy) fail('concurrent_operation'); busy = true;
    try { return await work(); } finally { busy = false; } };
  const output = (root, more = {}) => Object.freeze({ status: 'source_reference_prefix_data', authority: 'not_established',
    coverage: 'referenced_pages_only', root, ...more });
  return Object.freeze({
    /** Metadata only. Does not read originals or establish a complete graph. */
    describe: raw => exclusive(async () => { const rootRef = reference(raw);
      return output(rootRef, { layers: rootOf(await get(rootRef, LIMITS.root_utf8_bytes), bindingJson).layers }); }),
    /** Empty prefix with the same fixed seven ordered layers. */
    create: () => exclusive(async () => {
      const layers = Object.fromEntries(KINDS.map(k => [k, { head: null, page_count: 0, row_count: 0,
        original_utf8_bytes: 0, cursor: '', ended: false }]));
      return output(await put(rootOf({ format: FORMAT, binding, layers }, bindingJson), LIMITS.root_utf8_bytes));
    }),
    /** Store only the exact page query/digest/bounds and the new small root.
     * Neither the supplied original nor its parsed rows are sent to blob.put. */
    append: input => exclusive(async () => {
      const admitted = data(input, ['root', 'original_text', 'row_limit']), expected = reference(admitted.root);
      if (typeof admitted.original_text !== 'string' || Buffer.byteLength(admitted.original_text) > LIMITS.page_utf8_bytes) fail('invalid_original');
      charge(Buffer.byteLength(admitted.original_text));
      const original = pageOf(admitted.original_text, bindingJson, binding, admitted.row_limit);
      const root = rootOf(await get(expected, LIMITS.root_utf8_bytes), bindingJson), kind = original.page.kind, old = root.layers[kind];
      if (KINDS.find(k => !root.layers[k].ended) !== kind || old.cursor !== original.page.after) fail('page_order');
      const layer = { ...old, page_count: old.page_count + 1, row_count: old.row_count + original.row_count,
        original_utf8_bytes: old.original_utf8_bytes + original.original_utf8_bytes,
        cursor: original.page.next_cursor, ended: original.page.end_of_layer };
      rootOf({ ...root, layers: { ...root.layers, [kind]: { ...layer, head: expected } } }, bindingJson);
      const head = await put({ format: FORMAT, binding_sha256: bindingSha, plan: PLAN, kind, index: old.page_count,
        previous: old.head, after: original.page.after, next_cursor: original.page.next_cursor, row_limit: admitted.row_limit,
        row_count: original.row_count, end_of_layer: original.page.end_of_layer, page_utf8_bytes: original.page.page_utf8_bytes,
        original_utf8_bytes: original.original_utf8_bytes, original_sha256: original.original_sha256 }, LIMITS.node_utf8_bytes);
      return output(await put(rootOf({ ...root, layers: { ...root.layers, [kind]: { ...layer, head } } }, bindingJson), LIMITS.root_utf8_bytes));
    }),
    /** Reproduce exactly one stored fixed-plan page against pinned originals.
     * No returned edge may be skipped by an owner claiming full reachability. */
    read: input => exclusive(async () => {
      const admitted = data(input, ['root', 'kind', 'position']), rootRef = reference(admitted.root), kind = admitted.kind;
      if (!KINDS.includes(kind)) fail('invalid_kind');
      const supplied = admitted.position === null ? null : data(admitted.position, ['node', 'index', 'next_cursor']);
      const detached = supplied === null ? null : { node: reference(supplied.node), index: supplied.index, next_cursor: supplied.next_cursor };
      const root = rootOf(await get(rootRef, LIMITS.root_utf8_bytes), bindingJson), layer = root.layers[kind];
      if (layer.head === null) fail('empty_layer');
      const position = detached ?? { node: layer.head, index: layer.page_count - 1, next_cursor: layer.cursor };
      if (!integer(position.index, layer.page_count - 1)) fail('invalid_position'); cursor(position.next_cursor, kind);
      if (position.index === layer.page_count - 1 && (canonicalAssessmentJson(position.node) !== canonicalAssessmentJson(layer.head)
        || position.next_cursor !== layer.cursor)) fail('invalid_position');
      const node = data(await get(position.node, LIMITS.node_utf8_bytes), ['format', 'binding_sha256', 'plan', 'kind', 'index',
        'previous', 'after', 'next_cursor', 'row_limit', 'row_count', 'end_of_layer', 'page_utf8_bytes', 'original_utf8_bytes', 'original_sha256']);
      if (node.format !== FORMAT || node.binding_sha256 !== bindingSha || node.plan !== PLAN || node.kind !== kind || node.index !== position.index
        || node.next_cursor !== position.next_cursor || typeof node.end_of_layer !== 'boolean'
        || node.end_of_layer !== (node.index === layer.page_count - 1 && layer.ended)
        || !integer(node.row_limit, 250) || node.row_limit < 1 || !integer(node.row_count, node.row_limit)
        || !integer(node.original_utf8_bytes, LIMITS.page_utf8_bytes) || node.original_utf8_bytes < 1
        || !integer(node.page_utf8_bytes, 2_100_000) || node.page_utf8_bytes < 2
        || typeof node.original_sha256 !== 'string' || !HASH.test(node.original_sha256)
        || node.index === 0 && (node.previous !== null || node.after !== '') || node.index > 0 && node.previous === null) fail('node_corrupt');
      cursor(node.after, kind); const previous = node.previous === null ? null : reference(node.previous);
      charge(node.original_utf8_bytes);
      const request = Object.freeze({ plan: PLAN, kind, after: node.after, row_limit: node.row_limit });
      const text = await readOriginal(request); check();
      if (text === null) fail('missing_original');
      const original = pageOf(text, bindingJson, binding, node.row_limit);
      if (original.page.kind !== kind || original.page.after !== node.after || original.page.next_cursor !== node.next_cursor
        || original.row_count !== node.row_count || original.page.end_of_layer !== node.end_of_layer
        || original.page.page_utf8_bytes !== node.page_utf8_bytes || original.original_utf8_bytes !== node.original_utf8_bytes
        || original.original_sha256 !== node.original_sha256) fail('original_changed');
      const next = previous === null ? null : Object.freeze({ node: previous, index: node.index - 1, next_cursor: node.after });
      check(); return output(rootRef, { kind, layer, index: node.index, original_text: text, next_position: next });
    }),
  });
}
