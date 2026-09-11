import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCohortBlob as prepare, createNeighborhoodCohortBlobRepository as repository,
  recheckNeighborhoodCohortBlob as recheck,
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

test('read batches preserve order, explicit missing values and organization isolation', async () => {
  const h = fixture(), entries = [entry(), entry('{"name":"Café 🏠"}')];
  await h.repo.putPreparedBatch(entries); h.calls.length = 0;
  const missing = prepare('{"missing":true}');
  const actual = await h.repo.getPreparedBatch([entries[1].reference, missing, entries[0].reference]);
  assert.ok(Object.isFrozen(actual)); assert.equal(actual[1], null);
  for (const [i, original] of [[0, entries[1]], [2, entries[0]]]) {
    assert.equal(actual[i].canonicalJson, original.canonicalJson);
    assert.deepEqual(actual[i].reference, original.reference);
    assert.ok(Object.isFrozen(actual[i])); assert.ok(Object.isFrozen(actual[i].reference));
    assert.equal(recheck(original.canonicalJson, actual[i].reference), actual[i].reference);
  }
  assert.deepEqual(await repository(h.client, OTHER).getPreparedBatch(entries.map(e => e.reference)), [null, null]);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(c => c.sql.includes('organization_id=$1') && c.sql.includes('octet_length(b.canonical_utf8)=input.bytes')));
});

test('read batches reject sparse, duplicate, oversized or malformed references before SQL', async () => {
  const h = fixture(), ref = entry().reference;
  for (const refs of [[], null, {}, Array(1), [ref, , ref], [ref, ref], Array(9).fill(ref), [ref, null],
    [{ ...ref, canonical_utf8_bytes: '1500001' }], [{ ...ref, canonical_utf8_bytes: '01' }],
    [prepare('"' + 'x'.repeat(1_100_000) + '"'), prepare('"' + 'y'.repeat(1_100_000) + '"')]]) {
    await assert.rejects(h.repo.getPreparedBatch(refs), /invalid_(read_batch|reference)/);
  }
  assert.equal(h.calls.length, 0);
});

test('read batches validate every original and reject driver/byte/hash conflicts atomically', async () => {
  const original = entry(), valid = { ...original.reference, canonical_utf8: original.canonicalJson };
  for (const returned of [null, {}, { rowCount: 1, rows: [] }, result([null]), result([valid, valid]),
    result([{ ...valid, content_sha256: 'f'.repeat(64) }]), result([{ ...valid, canonical_utf8_bytes: '1' }]),
    result([{ ...valid, canonical_utf8: original.canonicalJson.replace('00001', '00002') }]),
    result([{ ...valid, canonical_utf8: null }]), result([{ ...valid, canonical_utf8: '{"a":1,"a":1}' }])]) {
    const h = fixture(() => returned);
    await assert.rejects(h.repo.getPreparedBatch([original.reference]), /storage_conflict/);
    assert.equal(h.calls.length, 1);
  }
});

test('read batches detach refs before awaiting and never turn query errors into missing evidence', async () => {
  const original = entry(), refs = [{ ...original.reference }];
  const h = fixture(async () => {
    refs[0].content_sha256 = 'f'.repeat(64); refs.length = 0;
    return result([{ ...original.reference, canonical_utf8: original.canonicalJson }]);
  });
  assert.equal((await h.repo.getPreparedBatch(refs))[0].canonicalJson, original.canonicalJson);
  const error = new Error('synthetic read failure');
  const failed = fixture(() => { throw error; });
  await assert.rejects(failed.repo.getPreparedBatch([original.reference]), value => value === error);
  assert.equal(failed.calls.length, 1);
});

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
