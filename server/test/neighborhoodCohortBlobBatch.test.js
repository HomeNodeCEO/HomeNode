import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNeighborhoodCohortBlob as prepare, createNeighborhoodCohortBlobRepository as repository,
  recheckNeighborhoodCohortBlob as recheck,
  NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS as limits,
  NEIGHBORHOOD_COHORT_BLOB_READ_BATCH_LIMITS as readLimits } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

const ORG = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002';
const entry = (canonicalJson = '{"id":"00001","price":"1.00"}') => ({ canonicalJson, reference: prepare(canonicalJson) });
const result = rows => ({ rows, rowCount: rows.length });
const acknowledgment = (stored, bytes, text) => ({ content_sha256: stored.content_sha256,
  canonical_utf8_bytes: stored.canonical_utf8_bytes,
  exact_original: stored.canonical_utf8_bytes === String(bytes) && typeof stored.canonical_utf8 === 'string'
    && Buffer.byteLength(stored.canonical_utf8) === bytes && stored.canonical_utf8 === text });
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
        rows.set(key, row); inserted.push(acknowledgment(row, bytes[i], texts[i]));
      });
      return result(inserted.reverse()); // Never rely on database row order.
    }
    if (sql.includes('read-batch')) return result(hashes.map((hash, index) => {
      const stored = rows.get(`${org}/${hash}`);
      return stored && texts ? acknowledgment(stored, bytes[index], texts[index]) : stored;
    }).filter(Boolean).reverse());
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
  for (const refs of [[], null, {}, Array(1), [ref, , ref], [ref, ref],
    Array.from({ length: readLimits.records + 1 }, (_, i) => entry(`{"id":"${i}"}`).reference), [ref, null],
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
  for (const values of [null, [], Array(1), [original, , original], Array(limits.records + 1).fill(original), [original, original],
    [original, { canonicalJson: '{}', reference: {} }]]) {
    await assert.rejects(h.repo.putPreparedBatch(values), /invalid_prepared_batch/);
  }
  const big = entry('"' + 'x'.repeat(1_100_000) + '"');
  await assert.rejects(h.repo.putPreparedBatch([big, entry('"' + 'y'.repeat(1_100_000) + '"')]), /invalid_prepared_batch/);
  assert.equal(h.calls.length, 0);
  const bounded = Array.from({ length: limits.records }, (_, i) => entry(`{"id":"${i}"}`));
  await h.repo.putPreparedBatch(bounded); assert.equal(h.calls.length, 1);
});

test('prepared batches reject incomplete, duplicate, unknown and corrupted acknowledgments', async () => {
  const original = entry(), valid = { content_sha256: original.reference.content_sha256,
    canonical_utf8_bytes: original.reference.canonical_utf8_bytes, exact_original: true };
  for (const returned of [null, {}, { rowCount: 1, rows: [] }, result([null]), result([valid, valid]),
    result([{ ...valid, content_sha256: 'f'.repeat(64) }]), result([{ ...valid, canonical_utf8_bytes: '1' }]),
    ...[false, null, undefined, 1, 'true', {}, []].map(exact_original => result([{ ...valid, exact_original }])),
    result([{ content_sha256: valid.content_sha256, canonical_utf8_bytes: valid.canonical_utf8_bytes,
      canonical_utf8: original.canonicalJson }]), result([])]) {
    const h = fixture(() => returned);
    await assert.rejects(h.repo.putPreparedBatch([original]), /storage_conflict/);
    assert.ok(h.calls.length <= 2);
  }
});

test('compact acknowledgments use stored metadata and guarded UTF8 byte equality, not a digest or JSON comparison', async () => {
  const h = fixture(), original = entry('{"number":1e+21,"raw":"1.00","unicode":"Café 🏠"}');
  await h.repo.putPreparedBatch([original]);
  await h.repo.putPreparedBatch([original]);
  const [fresh, replay, conflict] = h.calls;
  assert.match(fresh.sql, /WITH input AS MATERIALIZED/);
  assert.match(fresh.sql, /RETURNING content_sha256, canonical_utf8_bytes, canonical_utf8/);
  assert.match(fresh.sql, /FROM inserted stored LEFT JOIN input ON input.hash=stored.content_sha256/);
  assert.match(conflict.sql, /JOIN app.neighborhood_cohort_evidence_blobs stored/);
  assert.match(conflict.sql, /stored.organization_id=\$1/);
  for (const call of [fresh, replay, conflict]) {
    assert.match(call.sql, /SELECT stored.content_sha256, stored.canonical_utf8_bytes::text/);
    assert.match(call.sql, /CASE WHEN stored.canonical_utf8_bytes=input.bytes AND octet_length\(stored.canonical_utf8\)=input.bytes\s+THEN convert_to\(stored.canonical_utf8, 'UTF8'\)=convert_to\(input.text, 'UTF8'\)\s+ELSE false END AS exact_original/);
    assert.doesNotMatch(call.sql, /::jsonb|sha256\(/);
    assert.deepEqual(call.params, [ORG, [original.reference.content_sha256],
      [Number(original.reference.canonical_utf8_bytes)], [original.canonicalJson]]);
  }
});

test('mixed conflicts resend only still-unacknowledged captured originals after caller mutation', async () => {
  const h = fixture(), old = entry(), fresh = entry('{"new":"Café 🏠"}');
  await h.repo.putPreparedBatch([old]); h.calls.length = 0;
  const oldText = old.canonicalJson, oldRef = old.reference, freshRef = fresh.reference;
  const entries = [old, fresh], query = h.client.query.bind(h.client);
  h.client.query = async (sql, params) => {
    const response = await query(sql, params);
    if (sql.includes('insert-batch')) { entries[0].canonicalJson = '{}'; entries[0].reference = {}; entries.length = 0; }
    return response;
  };
  assert.deepEqual(await repository(h.client, ORG).putPreparedBatch(entries), [oldRef, freshRef]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].params, [ORG, [oldRef.content_sha256], [Number(oldRef.canonical_utf8_bytes)], [oldText]]);
});

for (const replacement of ['{"id":"00002","price":"1.00"}', '{"id":"00001","price":"1.01"}']) {
  test(`same-length substituted stored originals fail compact replay: ${replacement}`, async () => {
    const h = fixture(), original = entry();
    await h.repo.putPreparedBatch([original]);
    assert.equal(Buffer.byteLength(replacement), Number(original.reference.canonical_utf8_bytes));
    h.rows.get(`${ORG}/${original.reference.content_sha256}`).canonical_utf8 = replacement;
    await assert.rejects(h.repo.putPreparedBatch([original]), /storage_conflict/);
    assert.equal(h.calls.length, 3);
  });
}

for (const code of ['57014', '40001']) test(`compact conflict query ${code} propagates without retries`, async () => {
  const failure = Object.assign(new Error('synthetic caller rollback required'), { code });
  const h = fixture(sql => {
    if (sql.includes('insert-batch')) return result([]);
    throw failure;
  });
  await assert.rejects(h.repo.putPreparedBatch([entry()]), error => error === failure);
  assert.equal(h.calls.length, 2);
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
