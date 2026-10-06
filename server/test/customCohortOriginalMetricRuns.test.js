import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { prepareCustomCohortOriginalMetricSource as prepare, createCustomCohortOriginalMetricRunOwner as owner } from '../src/services/neighborhoodAssessment/customCohortOriginalMetricRuns.js';
import { createExactPagedObservationRunStore } from '../src/services/neighborhoodAssessment/exactPagedObservationRuns.js';
import { customCohortObservationMemberReader, customCohortObservationMembers,
  restoreCustomCohortIndexedObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { customCohortMetricRunFixture as fixture } from './fixtures/customCohortMetricRunFixture.js';

const reference = text => ({ content_sha256: createHash('sha256').update(text).digest('hex'), canonical_utf8_bytes: String(Buffer.byteLength(text)) });
const request = (f, kind = 'stock', metric = 'gla_sqft') => ({ preview: f.preview, selectionRef: f.selectionRef, kind, metric });
function repository() {
  const originals = new Map(), calls = [];
  const blobs = { async put(text) { const r = reference(text); originals.set(r.content_sha256, text); calls.push(['put', r]); return r; },
    async get(hash, bytes) { calls.push(['get', hash, bytes]); return originals.get(hash) ?? null; } };
  return { originals, calls, blobs };
}
const failed = reason => e => e.code === 'CUSTOM_COHORT_ORIGINAL_METRIC_INVALID' && e.reason === reason;

test('all fifteen owned metrics match legacy fields and null reasons without invented units or package allocation', async () => {
  const f = fixture(), before = JSON.stringify(f.preview), r = repository(), o = owner(r.blobs);
  for (const kind of ['stock', 'transactions', 'source_reported']) for (const metric of Object.keys(f.preview.selected[kind].metrics)) {
    const source = await prepare(request(f, kind, metric)), staged = await o.stage(source);
    assert.equal(source.authority, 'not_established'); assert(Object.isFrozen(source));
    assert.deepEqual(await o.distribution(await prepare(request(f, kind, metric)), staged.manifest_ref), f.preview.selected[kind].metrics[metric]);
    const bound = JSON.parse(source.binding_json);
    assert.equal(bound.kind, kind); assert.equal(bound.metric, metric); assert.equal(bound.currency, null);
    assert.deepEqual(bound.selection_ref, f.selectionRef); assert.deepEqual(bound.observation_period, f.preview.observation_period);
    assert.equal(bound.ordered_member_original_sha256.length, 64);
    assert(staged.retention_refs.some(ref => ref.content_sha256 === staged.manifest_ref.content_sha256));
    assert(Object.isFrozen(staged.retention_refs));
  }
  assert.equal(JSON.stringify(f.preview), before);
  assert.equal(f.preview.selected.transactions.member_count, 2, 'canonical duplicate price rows are ONE event, not two sales');
  assert.equal(f.preview.selected.transactions.metrics.recorded_total_price.conflicting_count, 1, 'raw unequal decimals remain conflicting despite same Number');
  assert.equal(f.preview.selected.source_reported.member_count, 4, 'outside-period source observations do not become completed-sale samples');
  assert.equal(f.preview.selected.transactions.package_evidence_transaction_count, 1);
});

test('O(1) reader visits original indices without row/value array expansion and retains cross-population defenses', () => {
  const f = fixture(), reader = customCohortObservationMemberReader(f.preview, f.preview.selected, 'stock');
  const rows = customCohortObservationMembers(f.preview, f.preview.selected, 'stock');
  assert.equal(reader.member_count, rows.length); assert(Object.isFrozen(reader));
  for (let i = rows.length - 1; i >= 0; i--) assert.strictEqual(reader.at(i), rows[i]);
  for (const ordinal of [-1, rows.length, 0.5, '0']) assert.throws(() => reader.at(ordinal), /member_ordinal/);
  assert.throws(() => customCohortObservationMemberReader(f.preview, fixture().preview.selected, 'stock'), /population_ownership/);
  assert.throws(() => customCohortObservationMemberReader(JSON.parse(JSON.stringify(f.preview)), f.preview.selected, 'stock'), /unsupported_representation/);
});

test('empty union remains explicit empty; complete 11001-member runs retain ALL intermediate graph roots', async () => {
  for (const f of [fixture({ empty: true }), fixture({ count: 11001 })]) {
    const r = repository(), o = owner(r.blobs), source = await prepare(request(f)), staged = await o.stage(source);
    assert.deepEqual(await owner(r.blobs).distribution(await prepare(request(f)), staged.manifest_ref), f.preview.selected.stock.metrics.gla_sqft);
    assert.deepEqual(new Set(staged.retention_refs.map(x => x.content_sha256)), new Set(r.calls.filter(x => x[0] === 'put').map(x => x[1].content_sha256)));
    assert(staged.retention_refs.length > 1);
  }
});

test('foreign/changed selection, metric, original cells, decimal witnesses and effective period refuse the old root', async () => {
  const f = fixture(), r = repository(), o = owner(r.blobs), staged = await o.stage(await prepare(request(f)));
  const revision = fixture({ selectionRevision: 3 });
  await assert.rejects(o.distribution(await prepare(request(revision)), staged.manifest_ref), /manifest/);
  await assert.rejects(o.distribution(await prepare(request(f, 'stock', 'year_built')), staged.manifest_ref), /manifest/);
  const period = fixture({ periodEnd: '2024-03-10' });
  await assert.rejects(o.distribution(await prepare(request(period)), staged.manifest_ref), /manifest/);
  const changed = structuredClone(f.preview); changed.member_tables.stock[0].observations.gla_sqft.raw_values = ['1500.000'];
  const fresh = { ...f, preview: restoreCustomCohortIndexedObservationPreview(changed) };
  await assert.rejects(o.distribution(await prepare(request(fresh)), staged.manifest_ref), /manifest/);
  const altered = { ...f, selectionRef: { ...f.selectionRef, selection_sha256: 'f'.repeat(64) } };
  await assert.rejects(prepare(request(altered)), failed('selection_mismatch'));
});

test('copied receipts and data getters/proxy/request supplied cells cannot become owned sources', async () => {
  const f = fixture(), source = await prepare(request(f)), r = repository(), o = owner(r.blobs);
  await assert.rejects(o.stage({ ...source }), failed('issued_source_required'));
  await assert.rejects(o.distribution(JSON.parse(JSON.stringify(source)), reference('{}')), failed('issued_source_required'));
  let effects = 0;
  const input = request(f); Object.defineProperty(input, 'metric', { enumerable: true, get() { effects++; return 'gla_sqft'; } });
  await assert.rejects(prepare(input), failed('shape'));
  await assert.rejects(prepare(new Proxy(request(f), { getPrototypeOf() { effects++; return Object.prototype; } })), failed('shape'));
  const forged = { get preview_version() { effects++; return 2; } };
  await assert.rejects(prepare({ ...request(f), preview: forged }), failed('source'));
  await assert.rejects(prepare({ ...request(f), preview: new Proxy(f.preview, { get() { effects++; return 2; } }) }), failed('source'));
  await assert.rejects(prepare({ ...request(f), selectionRef: new Proxy(f.selectionRef, { getPrototypeOf() { effects++; return Object.prototype; } }) }), failed('shape'));
  const nested = { ...f.selectionRef, manifest_ref: new Proxy(f.selectionRef.manifest_ref, { getPrototypeOf() { effects++; return Object.prototype; } }) };
  await assert.rejects(prepare({ ...request(f), selectionRef: nested }), failed('shape'));
  assert.equal(effects, 0); assert.equal(r.calls.length, 0);
  await assert.rejects(prepare({ ...request(f), values: [999999] }), failed('shape'));
  await assert.rejects(prepare(request(f, 'transactions', 'current_price')), failed('source'));
});

test('stored normalized cells must still agree with the existing exact raw-decimal policy before staging', async () => {
  const f = fixture();
  for (const change of [cell => { cell.value += 1; }, cell => { cell.exact_value = '1500.001'; },
    cell => { cell.raw_values = ['1800']; }, cell => { cell.observed_record_count = 0; },
    cell => { cell.missing_record_count = 1; }]) {
    const copy = structuredClone(f.preview); change(copy.member_tables.stock[0].observations.gla_sqft);
    const preview = restoreCustomCohortIndexedObservationPreview(copy), r = repository();
    await assert.rejects(prepare({ ...request(f), preview }), /metric_cell_(normalization|count)/);
    assert.equal(r.calls.length, 0);
  }
  // Real repeated observations retain occurrence counts even though their raw
  // value witness stores unique primitive values. Do not collapse that count.
  const copy = structuredClone(f.preview), cell = copy.member_tables.stock[0].observations.gla_sqft;
  cell.observed_record_count = 3;
  const preview = restoreCustomCohortIndexedObservationPreview(copy), r = repository(), o = owner(r.blobs);
  const source = await prepare({ ...request(f), preview }), staged = await o.stage(source);
  assert.deepEqual(await o.distribution(source, staged.manifest_ref), f.preview.selected.stock.metrics.gla_sqft);
});

test('original-bound sorted reopen checks exact input/null witness AND every finite ordinal/value', async () => {
  const r = repository(), store = createExactPagedObservationRunStore(r.blobs), values = [null, -0, 10, 20];
  const bindingJson = json({ synthetic: 'direct-original-check' }), pages = () => [values];
  const staged = await store.stage({ bindingJson, member_count: values.length, pages });
  const original = { bindingJson, manifestRef: staged.manifest_ref, member_count: values.length, pages, valueAtOrdinal: i => values[i] };
  const result = await store.distributionFromOriginalPages(original); assert.equal(result.count, 3); assert.equal(result.missing_count, 1);
  await assert.rejects(store.distributionFromOriginalPages({ ...original, member_count: 3 }), /original_member_count/);
  await assert.rejects(store.distributionFromOriginalPages({ ...original, valueAtOrdinal: i => i === 1 ? 0 : values[i] }), /original_value/);
  const different = [null, -0, 11, 20];
  await assert.rejects(store.distributionFromOriginalPages({ ...original, pages: () => [different], valueAtOrdinal: i => different[i] }), /original_input/);
  // A self-consistent swapped pair/run digest with an unchanged input witness
  // is rejected, rather than treating that witness as proof of actual values.
  const root = JSON.parse(r.originals.get(staged.manifest_ref.content_sha256));
  const pairs = JSON.parse(r.originals.get(root.run.page_refs[0].content_sha256)); pairs[1][1] = '11';
  const text = json(pairs), pageRef = await r.blobs.put(text);
  root.run.page_refs[0] = pageRef; root.run.sha256 = createHash('sha256').update(text).digest('hex');
  const changedRoot = await r.blobs.put(json(root));
  await assert.rejects(store.distributionFromOriginalPages({ ...original, manifestRef: changedRoot }), /original_value/);
});

test('aggregate member work applies across metrics; cancellation and ending deadlines refuse provisional results', async () => {
  const f = fixture({ count: 11001 }), r = repository(), o = owner(r.blobs), source = await prepare(request(f));
  const staged = await o.stage(source);
  let trips = 0;
  while (true) {
    try { await o.distribution(source, staged.manifest_ref); trips++; }
    catch (e) { assert(failed('work_limit')(e), e.message); break; }
  }
  assert(trips > 0 && trips < 20, 'the same owner cannot reset aggregate work for each metric or repeat');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepare(request(f), { signal: controller.signal }), failed('cancelled'));
  let checks = 0;
  await assert.rejects(prepare(request(f), { checkBudget() { if (++checks === 200) throw new Error('owned_source_deadline'); } }), /owned_source_deadline/);
  const small = fixture(), receipt = await prepare(request(small)), sql = repository();
  const cancelled = new AbortController(); let settle, admitted = false, returned = false;
  const pending = owner({ get: sql.blobs.get, put(text) { admitted = true; return new Promise(resolve => { settle = async () => resolve(await sql.blobs.put(text)); }); } }, { signal: cancelled.signal })
    .stage(receipt).finally(() => { returned = true; });
  while (!admitted) await new Promise(resolve => setImmediate(resolve));
  cancelled.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false);
  await settle(); await assert.rejects(pending, failed('cancelled'));
});
