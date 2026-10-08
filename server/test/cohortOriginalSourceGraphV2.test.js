import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalAssessmentJson } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCohortOriginalSourceReferencesV2Store,
  COHORT_ORIGINAL_SOURCE_REFERENCES_V2_KINDS as KINDS } from '../src/services/neighborhoodAssessment/cohortOriginalSourceReferencesV2.js';
import { verifyCohortOriginalSourceGraphV2Step } from '../src/services/neighborhoodAssessment/cohortOriginalSourceGraphV2.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const original = { generation_id: '11111111-1111-4111-8111-111111111111' };
const definition = { fixture: 'not-a-provider-coverage-receipt' };
const binding = { organization_id: '22222222-2222-4222-8222-222222222222',
  report_file_id: '33333333-3333-4333-8333-333333333333', assignment_file_id: '7', account_id: 'SUBJECT',
  operation_id: '44444444-4444-4444-8444-444444444444', generation_id: original.generation_id,
  spatial_definition_sha256: sha(canonicalAssessmentJson(definition)), source_original_sha256: sha(canonicalAssessmentJson(original)) };
const sourceReference = { content_sha256: 'a'.repeat(64), canonical_utf8_bytes: '123' };
function page(kind, after, keys, end, payload = '{"price":9007199254740993}') {
  return JSON.stringify({ binding, page: { status: 'source_closure_page', authority: 'not_established', coverage: 'page_only',
    original, spatial_definition: definition, spatial_definition_sha256: binding.spatial_definition_sha256,
    stock_population: { subject_included: true }, source_scope: 'all_dates_one_hop_seeded_only_from_original_stock_accounts',
    additional_cadastral_accounts: false, kind, after, next_cursor: keys.at(-1) ?? after,
    rows: keys.map(row_key => ({ row_key, payload_text: payload })), end_of_layer: end, page_utf8_bytes: 1000 } });
}
async function fixture({ dense = false } = {}) {
  const blobs = new Map(), originals = new Map(), reads = [], puts = [];
  const repository = { async put(text) { const r = prepareNeighborhoodCohortBlob(text);
    puts.push(text); blobs.set(r.content_sha256, text); return r; }, async get(hash) { return blobs.get(hash) ?? null; } };
  const key = r => `${r.kind}:${r.after}:${r.row_limit}`;
  const chain = () => createCohortOriginalSourceReferencesV2Store(repository, binding, { readOriginal: async request => {
    reads.push(request); return originals.get(key(request)) ?? null; } });
  let root = (await chain().create()).root;
  for (const kind of KINDS) {
    const count = dense && kind === 'accounts' ? 60001 : kind === 'parcels' ? 501 : 0;
    let after = '';
    const pages = Math.max(1, Math.ceil(count / 250));
    for (let index = 0; index < pages; index++) {
      const keys = Array.from({ length: Math.min(250, count - index * 250) }, (_, j) => kind === 'accounts'
        ? 'A' + String(index * 250 + j).padStart(7, '0') : String(index * 250 + j + 1));
      const text = page(kind, after, keys, index === pages - 1);
      originals.set(key({ kind, after, row_limit: 250 }), text);
      root = (await chain().append({ root, original_text: text, row_limit: 250 })).root;
      after = keys.at(-1) ?? after;
    }
  }
  const step = (receipt = null, reference = null, overrides = {}) => verifyCohortOriginalSourceGraphV2Step({
    chain: chain(), binding, source_reference: sourceReference, root, issued_receipt: receipt,
    issued_reference: reference, checkBudget() {}, ...overrides });
  return { chain, root, blobs, originals, reads, puts, step, repository, key };
}

test('V2 graph starts at actual heads and follows every issued edge with exact page/row/byte reconciliation', async () => {
  const f = await fixture(); let receipt = null, reference = null, pages = 0;
  const prefix = await f.chain().describe(f.root), seen = new Map();
  do {
    const result = await f.step(receipt, reference);
    assert.equal(result.authority, 'not_established'); assert.equal(result.coverage, 'representation_only');
    assert.equal(result.advanced, true); pages++;
    const r = result.receipt, kind = KINDS[r.before.kind_index];
    assert.equal(r.sequence, pages); assert.deepEqual(r.previous, reference);
    assert.deepEqual(r.before, receipt?.after ?? { kind_index: 0, position: null, page_count: 0, row_count: 0, original_utf8_bytes: 0 });
    assert.deepEqual(r.consumed_node, r.before.position?.node ?? prefix.layers[kind].head);
    seen.set(kind, (seen.get(kind) ?? 0) + 1);
    receipt = r; reference = await f.repository.put(canonicalAssessmentJson(r));
  } while (receipt.after.kind_index < KINDS.length);
  assert.equal(pages, 9); assert.equal(f.reads.length, 9);
  for (const kind of KINDS) assert.equal(seen.get(kind), prefix.layers[kind].page_count);
  const ended = await f.step(receipt, reference);
  assert.equal(ended.advanced, false); assert.equal(ended.all_layers_verified, true);
  assert.equal(f.reads.length, 9, 'ended replay reads only bounded metadata');
  assert.ok(f.puts.every(text => !text.includes('payload_text') && !text.includes('9007199254740993')));
});

test('60001-row traversal has constant metadata/source work per step, not quadratic head replay', async () => {
  const f = await fixture({ dense: true }); let receipt = null, reference = null;
  const prefix = await f.chain().describe(f.root), expected = Object.values(prefix.layers).reduce((n, l) => n + l.page_count, 0);
  for (let i = 0; i < expected; i++) {
    const result = await f.step(receipt, reference); receipt = result.receipt;
    reference = await f.repository.put(canonicalAssessmentJson(receipt));
    assert.equal(f.reads.length, i + 1); assert.ok(Number(reference.canonical_utf8_bytes) < 4000);
  }
  assert.equal(receipt.after.kind_index, 7); assert.equal(receipt.sequence, expected);
  assert.equal(expected, 249);
});

test('changed original and missing next node refuse rather than completing a shortened graph', async () => {
  for (const corrupt of ['original', 'node']) {
    const f = await fixture(), first = await f.step(), receipt = first.receipt;
    const reference = await f.repository.put(canonicalAssessmentJson(receipt));
    if (corrupt === 'node') f.blobs.delete(receipt.after.position.node.content_sha256);
    else { const key = f.key({ kind: 'parcels', after: '250', row_limit: 250 });
      f.originals.set(key, f.originals.get(key).replace('9007199254740993', '9007199254740994')); }
    await assert.rejects(f.step(receipt, reference), /missing_original|original_changed/);
  }
});

test('receipt shape/binding/count/edge tampering refuses before any new original query', async () => {
  const f = await fixture(), first = await f.step(), reference = await f.repository.put(canonicalAssessmentJson(first.receipt));
  for (const mutation of [r => { r.format = 'cohort_original_source_graph_progress_v1'; },
    r => { r.binding.operation_id = binding.organization_id; }, r => { r.source_reference = r.root; },
    r => { r.sequence = 1; }, r => { r.after.page_count = 2; }, r => { r.after.row_count = -1; },
    r => { r.after.position.index = 0; }, r => { r.after.kind_index = 7; }, r => { r.previous = reference; }]) {
    const r = JSON.parse(JSON.stringify(first.receipt)); mutation(r);
    const before = f.reads.length;
    // A receipt's previous pointer alone is checked by the independent issued
    // anchor/DB transition guard, not authenticated by this DATA function.
    if (canonicalAssessmentJson(r) === canonicalAssessmentJson(first.receipt)) continue;
    await assert.rejects(f.step(r, reference), /invalid_receipt/);
    assert.equal(f.reads.length, before);
  }
});

test('no untrusted extra fields, hidden hooks, proxy or getter can supply graph progress', async () => {
  const f = await fixture();
  for (const overrides of [{ progress: {} }, { plan: 'skip' }, { issued_receipt: {} }, { issued_reference: sourceReference }])
    await assert.rejects(f.step(null, null, overrides), /invalid_input|invalid_receipt/);
  const raw = { chain: f.chain(), binding, source_reference: sourceReference, root: f.root,
    issued_receipt: null, issued_reference: null, checkBudget() {} };
  for (const input of [new Proxy(raw, { getPrototypeOf() { assert.fail('proxy ran'); } }),
    { ...raw, get issued_receipt() { assert.fail('getter ran'); } },
    Object.defineProperty({ ...raw }, 'hidden', { value: () => assert.fail('hidden hook ran') })])
    await assert.rejects(verifyCohortOriginalSourceGraphV2Step(input), /invalid_input/);
});
