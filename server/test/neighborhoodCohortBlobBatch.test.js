import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCohortBlob as prepare, createNeighborhoodCohortBlobRepository as repository,
  NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS as limits } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

const ORG = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002';
const entry = (canonicalJson = '{"id":"00001","price":"1.00"}') => ({ canonicalJson, reference: prepare(canonicalJson) });
const result = rows => ({ rows, rowCount: rows.length });
function fixture(intercept) {
  const rows = new Map(), calls = [];
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    const overridden = await intercept?.(sql, params);
    if (overridden !== undefined) return overridden;
    const [org, hashes, bytes, texts] = params;
    if (sql.includes('insert-batch')) {
      const inserted = [];
      hashes.forEach((hash, i) => {
        const key = `${org}/${hash}`;
        if (rows.has(key)) return;
        const row = { content_sha256: hash, canonical_utf8_bytes: String(bytes[i]), canonical_utf8: texts[i] };
        rows.set(key, row); inserted.push(row);
      });
      return result(inserted.reverse()); // Never rely on database row order.
    }
    if (sql.includes('read-batch')) return result(hashes.map(hash => rows.get(`${org}/${hash}`)).filter(Boolean).reverse());
    throw new Error('unexpected query');
  } };
  return { rows, calls, client, repo: repository(client, ORG) };
}

test('prepared batches retain exact bytes, return input order and isolate organizations', async () => {
  const h = fixture(), entries = [entry(), entry('{"name":"Café 🏠","year":"1960"}')];
  assert.deepEqual(await h.repo.putPreparedBatch(entries), entries.map(e => e.reference));
  assert.equal(h.calls.length, 1); assert.equal(h.rows.size, 2);
  assert.deepEqual(await h.repo.putPreparedBatch(entries), entries.map(e => e.reference));
  assert.equal(h.calls.length, 3); assert.equal(h.rows.size, 2);
  const mixed = [entries[0], entry('{"id":"new"}')];
  assert.deepEqual(await h.repo.putPreparedBatch(mixed), mixed.map(e => e.reference));
  assert.equal(h.calls.length, 5); assert.equal(h.rows.size, 3);
  await repository(h.client, OTHER).putPreparedBatch(entries);
  assert.equal(h.rows.size, 5);
  assert.ok(h.calls.every(call => call.sql.includes('organization_id')));
  assert.ok(h.calls.every(call => !/BEGIN|COMMIT|ROLLBACK|UPDATE |DELETE |TRUNCATE/.test(call.sql)));
});

test('batch receipts cannot be forged, copied or used for different/noncanonical bytes', async () => {
  const h = fixture(), original = entry();
  for (const value of [null, {}, { ...original.reference }, structuredClone(original.reference), Object.create(original.reference)]) {
    await assert.rejects(h.repo.putPreparedBatch([{ ...original, reference: value }]), /invalid_prepared_batch/);
  }
  for (const canonicalJson of [null, new String(original.canonicalJson), ' ' + original.canonicalJson,
    original.canonicalJson.replace('00001', '00002')]) {
    await assert.rejects(h.repo.putPreparedBatch([{ ...original, canonicalJson }]), /invalid_prepared_batch/);
  }
  assert.equal(h.calls.length, 0);
});

test('all batch admission is bounded and validated before SQL, including the last entry', async () => {
  const h = fixture(), original = entry();
  for (const values of [null, [], Array(1), [original, , original], Array(9).fill(original), [original, original],
    [original, { canonicalJson: '{}', reference: {} }]]) {
    await assert.rejects(h.repo.putPreparedBatch(values), /invalid_prepared_batch/);
  }
  const big = entry('"' + 'x'.repeat(1_100_000) + '"');
  await assert.rejects(h.repo.putPreparedBatch([big, entry('"' + 'y'.repeat(1_100_000) + '"')]), /invalid_prepared_batch/);
  assert.equal(h.calls.length, 0);
  const eight = Array.from({ length: limits.records }, (_, i) => entry(`{"id":"${i}"}`));
  await h.repo.putPreparedBatch(eight); assert.equal(h.calls.length, 1);
});

test('prepared batches reject incomplete, duplicate, unknown and corrupted acknowledgments', async () => {
  const original = entry(), valid = { content_sha256: original.reference.content_sha256,
    canonical_utf8_bytes: original.reference.canonical_utf8_bytes, canonical_utf8: original.canonicalJson };
  for (const returned of [null, {}, { rowCount: 1, rows: [] }, result([null]), result([valid, valid]),
    result([{ ...valid, content_sha256: 'f'.repeat(64) }]), result([{ ...valid, canonical_utf8_bytes: '1' }]),
    result([{ ...valid, canonical_utf8: original.canonicalJson.replace('00001', '00002') }]), result([])]) {
    const h = fixture(() => returned);
    await assert.rejects(h.repo.putPreparedBatch([original]), /storage_conflict/);
    assert.ok(h.calls.length <= 2);
  }
});

test('conflict reads verify all original bytes instead of accepting matching digests alone', async () => {
  const h = fixture(), original = entry(); await h.repo.putPreparedBatch([original]);
  h.rows.get(`${ORG}/${original.reference.content_sha256}`).canonical_utf8 = '{"wrong":true}';
  await assert.rejects(h.repo.putPreparedBatch([original]), /storage_conflict/);
  assert.equal(h.calls.length, 3); assert.equal(h.rows.size, 1);
});

test('batch snapshots survive caller mutation while SQL is pending; failures are never retried', async () => {
  const original = entry(), expected = original.reference, originalText = original.canonicalJson, entries = [original];
  const h = fixture(() => { entries[0].canonicalJson = '{}'; entries[0].reference = {}; entries.length = 0; });
  assert.deepEqual(await h.repo.putPreparedBatch(entries), [expected]);
  assert.equal(h.rows.get(`${ORG}/${expected.content_sha256}`).canonical_utf8, originalText);
  const failure = new Error('synthetic rollback required'), failed = fixture(() => { throw failure; });
  await assert.rejects(failed.repo.putPreparedBatch([entry()]), error => error === failure);
  assert.equal(failed.calls.length, 1);
});
