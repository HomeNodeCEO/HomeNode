import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCohortOriginalSourceReferencesV2Store,
  COHORT_ORIGINAL_SOURCE_REFERENCES_V2_KINDS as KINDS,
  COHORT_ORIGINAL_SOURCE_REFERENCES_V2_LIMITS as LIMITS } from '../src/services/neighborhoodAssessment/cohortOriginalSourceReferencesV2.js';
import { createCohortOriginalSourceChainV1Store } from '../src/services/neighborhoodAssessment/cohortOriginalSourceChainV1.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const original = { generation_id: '11111111-1111-4111-8111-111111111111', source_snapshot: 'fixture-only' };
const definition = { geometry_input: { type: 'Point', coordinates: [-96.5, 32.5] }, discovery: { kind: 'radius', radius_metres: 4828.032 } };
const binding = Object.freeze({ organization_id: '22222222-2222-4222-8222-222222222222',
  report_file_id: '33333333-3333-4333-8333-333333333333', assignment_file_id: '7', account_id: 'SUBJECT',
  operation_id: '44444444-4444-4444-8444-444444444444', generation_id: original.generation_id,
  spatial_definition_sha256: sha(canonicalAssessmentJson(definition)), source_original_sha256: sha(canonicalAssessmentJson(original)) });
function page(kind, after, keys, end = true, payload = '{"price":9007199254740993}') {
  return JSON.stringify({ binding, page: { status: 'source_closure_page', authority: 'not_established', coverage: 'page_only',
    original, spatial_definition: definition, spatial_definition_sha256: binding.spatial_definition_sha256,
    stock_population: { subject_included: true }, source_scope: 'all_dates_one_hop_seeded_only_from_original_stock_accounts',
    additional_cadastral_accounts: false, kind, after, next_cursor: keys.at(-1) ?? after,
    rows: keys.map(row_key => ({ row_key, payload_text: payload })), end_of_layer: end, page_utf8_bytes: 1000 } });
}
/** Synthetic protocol DATA. Native CI separately reproduces actual fixed SQL. */
function fixture(hook = () => {}) {
  const blobs = new Map(), sources = new Map(), calls = [], reads = [];
  const repository = {
    async put(text) { calls.push({ kind: 'put', text }); await hook('put', text);
      const r = prepareNeighborhoodCohortBlob(text); blobs.set(r.content_sha256, text); return r; },
    async get(hash, size) { calls.push({ kind: 'get', hash, size }); await hook('get', hash); return blobs.get(hash) ?? null; },
  };
  const key = r => JSON.stringify([r.kind, r.after, r.row_limit]);
  const readOriginal = async request => { reads.push(request); await hook('source', request); return sources.get(key(request)) ?? null; };
  const store = options => createCohortOriginalSourceReferencesV2Store(repository, binding, { readOriginal, ...options });
  const append = async (root, text, rowLimit = 250) => {
    const p = JSON.parse(text).page; sources.set(key({ kind: p.kind, after: p.after, row_limit: rowLimit }), text);
    return (await store().append({ root, original_text: text, row_limit: rowLimit })).root;
  };
  return { blobs, sources, calls, reads, repository, readOriginal, store, append, key };
}
async function walk(f, root, kind, onPage = () => {}) {
  let position = null, rows = 0, pages = 0, bytes = 0;
  do {
    const step = await f.store().read({ root, kind, position });
    assert.equal(step.authority, 'not_established'); assert.equal(step.coverage, 'referenced_pages_only');
    rows += JSON.parse(step.original_text).page.rows.length; pages++; bytes += Buffer.byteLength(step.original_text);
    await onPage(step); position = step.next_position;
    if (position === null) {
      assert.equal(rows, step.layer.row_count); assert.equal(pages, step.layer.page_count); assert.equal(bytes, step.layer.original_utf8_bytes);
    }
  } while (position !== null);
  return { rows, pages, bytes };
}

test('seven layers reopen exact original bytes with only two small metadata puts per page', async () => {
  const f = fixture(); let root = (await f.store().create()).root;
  for (const kind of KINDS) {
    const keys = kind === 'accounts' ? ['SUBJECT'] : kind === 'sync_state' ? ['dcad_parcels']
      : kind === 'sync_runs' ? ['55555555-5555-4555-8555-555555555555'] : ['1', '10'];
    const text = page(kind, '', keys), from = f.calls.length;
    root = await f.append(root, text);
    const puts = f.calls.slice(from).filter(c => c.kind === 'put'); assert.equal(puts.length, 2);
    assert.ok(puts.every(c => Buffer.byteLength(c.text) < LIMITS.root_utf8_bytes && !c.text.includes('payload_text')));
    assert.equal(f.reads.length, KINDS.indexOf(kind), 'append does not pretend to verify a provider query');
    await walk(f, root, kind, r => assert.equal(r.original_text, text));
    assert.ok(Number(root.canonical_utf8_bytes) < 16000);
  }
  assert.ok(f.reads.every(r => Object.isFrozen(r) && r.plan === 'neighborhood_frozen_job_closure_v1' && r.row_limit === 250));
});

test('metadata-only describe never reads originals, chunks, or infers a complete acquisition', async () => {
  const f = fixture(); let root = (await f.store().create()).root;
  root = await f.append(root, page('parcels', '', ['1'], false));
  const from = f.calls.length, result = await f.store().describe(root);
  assert.equal(f.reads.length, 0); assert.equal(f.calls.slice(from).length, 1);
  assert.equal(result.layers.parcels.row_count, 1); assert.equal(result.layers.parcels.ended, false);
  assert.equal(result.layers.accounts.head, null); assert.equal(result.authority, 'not_established');
  assert.ok(Object.isFrozen(result.layers));
});

test('60001 synthetic rows in 241 pages keep one small checkpoint ref without any copied payloads', async () => {
  const f = fixture(); let root = (await f.store().create()).root;
  root = await f.append(root, page('parcels', '', []));
  let after = '', count = 0;
  for (let i = 0; i < 241; i++) {
    const size = Math.min(250, 60001 - count), keys = Array.from({ length: size }, (_, j) => 'A' + String(count + j).padStart(7, '0'));
    root = await f.append(root, page('accounts', after, keys, i === 240));
    after = keys.at(-1); count += size;
  }
  const complete = await walk(f, root, 'accounts'); assert.equal(complete.rows, 60001); assert.equal(complete.pages, 241);
  assert.ok(f.calls.filter(c => c.kind === 'put').every(c => !c.text.includes('payload_text') && Buffer.byteLength(c.text) < 16000));
  assert.equal(Object.keys(JSON.parse(f.blobs.get(root.content_sha256)).layers).length, 7);
});

test('heavily escaped >1.5MB text and unsafe decimal originals are exact but never uploaded to blobs', async () => {
  const f = fixture(), text = page('parcels', '', ['1'], true, '{"price":9007199254740993,"legal":"' + '\\\\'.repeat(480000) + '"}');
  assert.ok(Buffer.byteLength(text) > 1_500_000);
  const root = await f.append((await f.store().create()).root, text, 1);
  await walk(f, root, 'parcels', r => assert.equal(r.original_text, text));
  assert.equal(f.reads[0].row_limit, 1);
  assert.ok(f.calls.filter(c => c.kind === 'put').every(c => Buffer.byteLength(c.text) < 4000 && !c.text.includes('9007199254740993')));
});

test('lost final acknowledgment replay returns the same root without weakening page order', async () => {
  const f = fixture(), initial = (await f.store().create()).root, text = page('parcels', '', ['1'], false);
  const once = await f.append(initial, text), replay = await f.append(initial, text); assert.deepEqual(once, replay);
  await assert.rejects(f.append(once, text), /page_order/);
  const next = await f.append(once, page('parcels', '1', ['2'])); assert.equal((await walk(f, next, 'parcels')).rows, 2);
});

test('a full page preserves its separate empty terminal query and exact row limit', async () => {
  const f = fixture(), keys = Array.from({ length: 250 }, (_, i) => String(i + 1));
  let root = await f.append((await f.store().create()).root, page('parcels', '', keys, false));
  assert.equal((await f.store().describe(root)).layers.parcels.ended, false);
  root = await f.append(root, page('parcels', '250', [], true));
  const result = await walk(f, root, 'parcels'); assert.equal(result.pages, 2); assert.equal(result.rows, 250);
  assert.deepEqual(f.reads.map(r => [r.after, r.row_limit]), [['250', 250], ['', 250]]);
});

test('changed/missing late original refuses rather than returning a smaller complete layer', async () => {
  for (const mutation of ['missing', 'payload', 'formatting', 'generation', 'after', 'limit']) {
    const f = fixture(); let root = (await f.store().create()).root;
    const old = page('parcels', '', ['1'], false); root = await f.append(root, old, 1);
    root = await f.append(root, page('parcels', '1', ['2']), 1);
    const first = await f.store().read({ root, kind: 'parcels', position: null });
    const key = f.key({ kind: 'parcels', after: '', row_limit: 1 });
    if (mutation === 'missing') f.sources.delete(key);
    else if (mutation === 'formatting') f.sources.set(key, old + '\n');
    else if (mutation === 'limit') { f.sources.delete(key); f.sources.set(f.key({ kind: 'parcels', after: '', row_limit: 250 }), old); }
    else { const raw = JSON.parse(old);
      if (mutation === 'payload') raw.page.rows[0].payload_text = '{"price":9007199254740994}';
      if (mutation === 'generation') raw.page.original.generation_id = binding.organization_id;
      if (mutation === 'after') raw.page.after = '0'; f.sources.set(key, JSON.stringify(raw)); }
    await assert.rejects(f.store().read({ root, kind: 'parcels', position: first.next_position }), /missing_original|original_changed|invalid_original/);
    assert.equal(first.layer.row_count, 2); assert.equal(first.layer.page_count, 2);
  }
});

test('corrupt metadata, altered plan and missing nodes refuse before the source callback', async () => {
  for (const mutation of ['plan', 'binding', 'index', 'row_limit', 'previous', 'missing', 'storage']) {
    const f = fixture(); let root = await f.append((await f.store().create()).root, page('parcels', '', ['1']));
    const header = JSON.parse(f.blobs.get(root.content_sha256)), head = header.layers.parcels.head;
    if (mutation === 'missing') f.blobs.delete(head.content_sha256);
    else if (mutation === 'storage') f.blobs.set(head.content_sha256, '{}');
    else { const node = JSON.parse(f.blobs.get(head.content_sha256));
      if (mutation === 'plan') node.plan = 'mutable_latest';
      if (mutation === 'binding') node.binding_sha256 = 'f'.repeat(64);
      if (mutation === 'index') node.index = 4;
      if (mutation === 'row_limit') node.row_limit = 251;
      if (mutation === 'previous') node.previous = head;
      header.layers.parcels.head = await f.repository.put(canonicalAssessmentJson(node));
      root = await f.repository.put(canonicalAssessmentJson(header)); }
    await assert.rejects(f.store().read({ root, kind: 'parcels', position: null }), /missing_original|storage_conflict|node_corrupt/);
    assert.equal(f.reads.length, 0);
  }
});

test('bad order, duplicate/native key order and scope/limit changes refuse before storage writes', async () => {
  const f = fixture(), root = (await f.store().create()).root, before = f.calls.filter(c => c.kind === 'put').length;
  for (const text of [page('accounts', '', ['A']), page('parcels', '1', ['2']), page('parcels', '', ['10', '2']),
    page('parcels', '', ['1', '1']), page('parcels', '', [], false)])
    await assert.rejects(f.store().append({ root, original_text: text, row_limit: 250 }), /page_order|invalid_original/);
  for (const row_limit of [0, 251, '250', NaN])
    await assert.rejects(f.store().append({ root, original_text: page('parcels', '', ['1']), row_limit }), /invalid_limit/);
  const changed = JSON.parse(page('parcels', '', ['1'])); changed.binding.report_file_id = binding.organization_id;
  await assert.rejects(f.store().append({ root, original_text: JSON.stringify(changed), row_limit: 250 }), /binding_changed/);
  assert.equal(f.calls.filter(c => c.kind === 'put').length, before);
});

test('cross-scope and legacy V1 references cannot be cast into V2 authority', async () => {
  const f = fixture(), root = (await f.store().create()).root;
  for (const key of ['organization_id', 'report_file_id', 'operation_id', 'generation_id']) {
    const other = createCohortOriginalSourceReferencesV2Store(f.repository, { ...binding, [key]: '99999999-9999-4999-8999-999999999999' }, { readOriginal: f.readOriginal });
    await assert.rejects(other.describe(root), /binding_changed/);
  }
  const legacy = createCohortOriginalSourceChainV1Store(f.repository, binding), v1 = await legacy.create();
  await assert.rejects(f.store().describe(v1.root), /binding_changed/);
  await assert.rejects(legacy.describe(root), /binding_changed/);
  assert.equal(f.reads.length, 0);
});

test('proxy/getter inputs never execute and captured continuation remains stable during pending I/O', async () => {
  const f = fixture(), root = (await f.store().create()).root;
  assert.throws(() => createCohortOriginalSourceReferencesV2Store(f.repository, new Proxy(binding, { get() { throw Error('getter'); } }), { readOriginal: f.readOriginal }), /invalid_input/);
  assert.throws(() => createCohortOriginalSourceReferencesV2Store(f.repository, binding, { get readOriginal() { throw Error('getter'); } }), /invalid_input/);
  await assert.rejects(f.store().append({ root, get original_text() { throw Error('getter'); }, row_limit: 250 }), /invalid_input/);
  let next = await f.append(root, page('parcels', '', ['1'], false)); next = await f.append(next, page('parcels', '1', ['2']));
  const first = await f.store().read({ root: next, kind: 'parcels', position: null });
  const position = { ...first.next_position, node: { ...first.next_position.node } };
  let release, start; const waiting = new Promise(r => { release = r; }), ready = new Promise(r => { start = r; });
  const repo = { ...f.repository, async get(hash, size) { start(); await waiting; return f.repository.get(hash, size); } };
  const store = createCohortOriginalSourceReferencesV2Store(repo, binding, { readOriginal: f.readOriginal });
  const pending = store.read({ root: next, kind: 'parcels', position }); await ready;
  position.node.content_sha256 = 'f'.repeat(64); position.index = 999; position.next_cursor = '999'; release();
  assert.equal((await pending).index, 0);
});

test('cancellation, source errors, wrong ACK and pending settlement do not return a usable prefix', async () => {
  const controller = new AbortController(), f = fixture(kind => { if (kind === 'source') controller.abort(); });
  const root = await f.append((await f.store().create()).root, page('parcels', '', ['1']));
  await assert.rejects(f.store({ signal: controller.signal }).read({ root, kind: 'parcels', position: null }), /cancelled/);
  const throwing = f.store({ readOriginal: async () => { throw Error('current rights revoked'); } });
  await assert.rejects(throwing.read({ root, kind: 'parcels', position: null }), /current rights revoked/);
  const wrong = createCohortOriginalSourceReferencesV2Store({ ...f.repository, async put(text) {
    const r = await f.repository.put(text); return { ...r, content_sha256: 'f'.repeat(64) };
  } }, binding, { readOriginal: f.readOriginal });
  await assert.rejects(wrong.create(), /storage_conflict/);
  let release, start; const waiting = new Promise(r => { release = r; }), ready = new Promise(r => { start = r; });
  const blocked = f.store({ readOriginal: async request => { start(); await waiting; return f.sources.get(f.key(request)); } });
  const pending = blocked.read({ root, kind: 'parcels', position: null }); await ready;
  await assert.rejects(blocked.describe(root), /concurrent_operation/); release(); await pending;
});

test('finite shared original I/O budget is charged before callbacks and never resets between calls', async () => {
  const f = fixture(), text = page('parcels', '', ['1'], true, '{"x":"' + 'x'.repeat(900000) + '"}');
  const root = await f.append((await f.store().create()).root, text), store = f.store(); let failed = false;
  for (let i = 0; i < 50 && !failed; i++) {
    const from = f.reads.length;
    try { await store.read({ root, kind: 'parcels', position: null }); }
    catch (error) { assert.match(error.message, /operation_limit/); assert.equal(f.reads.length, from); failed = true; }
  }
  assert.equal(failed, true);
});
