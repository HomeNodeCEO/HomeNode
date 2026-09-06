import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareNeighborhoodCohortBlob as prepare, createNeighborhoodCohortBlobRepository as repository } from '../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const text = '{"account_id":"00026572500130160000","name":"Café 🏠","value":"1.00"}';
const result = rows => ({ rows, rowCount: rows.length });
function fake() {
  const rows = new Map(), calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    const key = params.slice(0, 2).join('/');
    if (sql.includes('blob:read')) return result(rows.has(key) ? [rows.get(key)] : []);
    if (sql.includes('blob:insert')) {
      if (rows.has(key)) return result([]);
      const row = { content_sha256: params[1], canonical_utf8_bytes: params[2], canonical_utf8: params[3] };
      rows.set(key, row); return result([row]);
    }
    throw new Error('Unexpected SQL');
  } };
  return { rows, calls, client };
}

test('canonical bytes, original string IDs/decimals, and Unicode round trip unchanged', async () => {
  const h = fake(), repo = repository(h.client, ORG), ref = await repo.put(text);
  assert.deepEqual(ref, { content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'), canonical_utf8_bytes: String(Buffer.byteLength(text)) });
  assert.equal(await repo.get(ref.content_sha256, ref.canonical_utf8_bytes), text);
  assert.ok(Object.isFrozen(ref));
});

test('same-organization replay checks exact content and other organizations cannot read it', async () => {
  const h = fake(), a = repository(h.client, ORG), b = repository(h.client, OTHER);
  const ref = await a.put(text);
  assert.equal(await b.get(ref.content_sha256, ref.canonical_utf8_bytes), null);
  assert.deepEqual(await a.put(text), ref);
  assert.equal(h.rows.size, 1);
  assert.deepEqual(await b.put(text), ref);
  assert.equal(h.rows.size, 2);
  assert.ok(h.calls.every(call => call.sql.includes('organization_id')));
  assert.ok(h.calls.every(call => !/BEGIN|COMMIT|ROLLBACK|CREATE |UPDATE |DELETE |TRUNCATE/.test(call.sql)));
});

test('invalid or noncanonical primitive input fails before any database call', async () => {
  const h = fake(), repo = repository(h.client, ORG);
  for (const invalid of [null, {}, new String('{}'), '', ' {"a":1}', '{"b":1,"a":2}', '{"a":1,"a":2}',
    '{"a":9007199254740993}', '1.00', '-0', 'NaN', '1e999', '1e-999', '"\\u0000"', '"\\ud800"', '\u0000', '\ud800']) {
    await assert.rejects(repo.put(invalid), /neighborhood_cohort_blob_(invalid_payload|noncanonical)/);
  }
  assert.equal(h.calls.length, 0);
});

test('byte, node, depth and PostgreSQL numeric expansion budgets fail before SQL', async () => {
  const h = fake(), repo = repository(h.client, ORG);
  const depth = n => '['.repeat(n) + '0' + ']'.repeat(n);
  for (const invalid of ['"' + 'x'.repeat(1499999) + '"', JSON.stringify(Array(100000).fill(0)), depth(36),
    '[' + Array(7000).fill('1e+308').join(',') + ']']) {
    await assert.rejects(repo.put(invalid), /neighborhood_cohort_blob_limit_exceeded/);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(prepare(depth(35)).canonical_utf8_bytes, '71');
  assert.equal(prepare('"' + 'x'.repeat(1499998) + '"').canonical_utf8_bytes, '1500000');
});

test('bad scope and reference values are rejected before SQL without leaking input', async () => {
  const h = fake();
  for (const org of [null, {}, 'untrusted organization', `${ORG}; DROP TABLE example;`, `${ORG}\n`]) assert.throws(() => repository(h.client, org), /^Error: neighborhood_cohort_blob_invalid_scope$/);
  const repo = repository(h.client, ORG), ref = prepare(text);
  for (const [hash, bytes] of [['x', '1'], [ref.content_sha256, 5], [ref.content_sha256, '01'], [ref.content_sha256, '0'],
    [ref.content_sha256, '1500001'], [ref.content_sha256.toUpperCase(), ref.canonical_utf8_bytes],
    [`${ref.content_sha256}\n`, ref.canonical_utf8_bytes], [ref.content_sha256, '1\n'],
    [ref.content_sha256, '1\r'], [ref.content_sha256, '1\u2028']]) {
    await assert.rejects(repo.get(hash, bytes), /^Error: neighborhood_cohort_blob_invalid_reference$/);
  }
  assert.equal(h.calls.length, 0);
});

test('same digest with different content, counts, or canonical validity is a conflict, never an overwrite', async () => {
  for (const changed of [{ canonical_utf8: '{"wrong":1}' }, { canonical_utf8_bytes: '1' },
    { canonical_utf8: '{"a":1,"a":1}' }, { content_sha256: 'f'.repeat(64) }]) {
    const h = fake(), repo = repository(h.client, ORG), ref = await repo.put(text);
    const key = `${ORG}/${ref.content_sha256}`;
    const original = h.rows.get(key); h.rows.set(key, { ...original, ...changed });
    await assert.rejects(repo.put(text), /neighborhood_cohort_blob_storage_conflict/);
    await assert.rejects(repo.get(ref.content_sha256, ref.canonical_utf8_bytes), /neighborhood_cohort_blob_storage_conflict/);
    assert.deepEqual(h.rows.get(key), { ...original, ...changed });
  }
});

test('malformed driver row sets do not look like missing data or successful insertion', async () => {
  for (const returned of [null, {}, { rows: null, rowCount: 0 }, { rows: [], rowCount: 1 },
    { rows: [null], rowCount: 1 }, { rows: [{}, {}], rowCount: 2 }]) {
    const repo = repository({ query: async () => returned }, ORG), ref = prepare(text);
    await assert.rejects(repo.put(text), /neighborhood_cohort_blob_storage_conflict/);
    await assert.rejects(repo.get(ref.content_sha256, ref.canonical_utf8_bytes), /neighborhood_cohort_blob_storage_conflict/);
  }
});

test('caller still owns database errors and rollback; repository does not retry a failed query', async () => {
  const failure = Object.assign(new Error('synthetic transaction abort'), { code: '40001' });
  let calls = 0;
  const repo = repository({ query: async () => { calls++; throw failure; } }, ORG);
  await assert.rejects(repo.put(text), error => error === failure);
  assert.equal(calls, 1);
});

test('additive migration has tenant key, byte constraints and statement-level immutability guards', () => {
  const sql = readFileSync(new URL('../migrations/20261011_neighborhood_cohort_evidence_blobs.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../src/database/mobileMigrations.js', import.meta.url), 'utf8');
  assert.match(runner, /20261011_neighborhood_cohort_evidence_blobs\.sql/);
  assert.match(sql, /PRIMARY KEY \(organization_id, content_sha256\)/);
  assert.match(sql, /REFERENCES app_auth.organizations\(id\) ON DELETE RESTRICT/);
  assert.match(sql, /octet_length\(canonical_utf8\) = canonical_utf8_bytes/);
  assert.match(sql, /BEFORE UPDATE OR DELETE OR TRUNCATE/);
  assert.match(sql, /FOR EACH STATEMENT/);
  assert.doesNotMatch(sql, /(?:ALTER|DROP) TABLE|^\s*(?:BEGIN|COMMIT|ROLLBACK);/m);
});
