import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { canonicalAssessmentJson } from '../../src/services/neighborhoodAssessment/contract.js';
import { prepareNeighborhoodCohortBlob as prepare, recheckNeighborhoodCohortBlob as recheck,
  createNeighborhoodCohortBlobRepository as repository,
  NEIGHBORHOOD_COHORT_BLOB_BATCH_LIMITS as limits } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

const entry = value => {
  const canonicalJson = canonicalAssessmentJson(value);
  return { canonicalJson, reference: prepare(canonicalJson) };
};
const expectedRefs = entries => entries.map(item => item.reference);
const textBytes = values => values.reduce((sum, value) => sum + Buffer.byteLength(value, 'utf8'), 0);
const insertOrganization = (client, id) => client.query(
  'INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,$2,$2)', [id, 'Synthetic compact cohort acknowledgments']);
const settings = "SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='6s'";

function measuredClient(client, compact) {
  const metrics = { queries: 0, canonical_text_upload_utf8_bytes: 0,
    canonical_text_download_utf8_bytes: 0, returned_rows_json_utf8_bytes: 0 };
  return { metrics, client: { async query(sql, values) {
    metrics.queries++;
    if (Array.isArray(values?.[3])) metrics.canonical_text_upload_utf8_bytes += textBytes(values[3]);
    const result = await client.query(sql, values);
    for (const row of result.rows) {
      if (typeof row.canonical_utf8 === 'string') metrics.canonical_text_download_utf8_bytes += Buffer.byteLength(row.canonical_utf8, 'utf8');
      if (compact) {
        assert.deepEqual(Object.keys(row).sort(), ['canonical_utf8_bytes', 'content_sha256', 'exact_original']);
        assert.equal(typeof row.exact_original, 'boolean');
      }
    }
    // JSON rendering is a reproducible representation measurement, not the
    // PostgreSQL protocol, socket, TLS, packet or on-disk byte count.
    metrics.returned_rows_json_utf8_bytes += Buffer.byteLength(JSON.stringify(result.rows), 'utf8');
    return result;
  } } };
}

// The prior bounded SQL/ACK path, retained only as a native comparison oracle.
// Entries are prepared before timing; both implementations still recheck their
// receipt against every exact input string before any query.
async function legacyBatch(client, organization, entries) {
  assert.ok(entries.length > 0 && entries.length <= limits.records);
  assert.ok(textBytes(entries.map(item => item.canonicalJson)) <= limits.bytes);
  const expected = new Map();
  for (const item of entries) {
    recheck(item.canonicalJson, item.reference);
    assert.ok(!expected.has(item.reference.content_sha256));
    expected.set(item.reference.content_sha256, item);
  }
  const accept = result => {
    assert.equal(result.rowCount, result.rows.length);
    for (const row of result.rows) {
      const item = expected.get(row.content_sha256);
      assert.ok(item, 'legacy comparison rejects duplicate/unknown acknowledgments');
      assert.equal(row.canonical_utf8_bytes, item.reference.canonical_utf8_bytes);
      assert.equal(row.canonical_utf8, item.canonicalJson);
      expected.delete(row.content_sha256);
    }
  };
  accept(await client.query(`/* compact-ack-comparison:legacy-insert-batch */
    INSERT INTO app.neighborhood_cohort_evidence_blobs
      (organization_id,content_sha256,canonical_utf8_bytes,canonical_utf8)
    SELECT $1,input.hash,input.bytes,input.text
      FROM unnest($2::text[],$3::integer[],$4::text[]) AS input(hash,bytes,text)
    ON CONFLICT (organization_id,content_sha256) DO NOTHING
    RETURNING content_sha256,canonical_utf8_bytes::text,canonical_utf8`,
  [organization, entries.map(item => item.reference.content_sha256),
    entries.map(item => Number(item.reference.canonical_utf8_bytes)), entries.map(item => item.canonicalJson)]));
  if (expected.size) accept(await client.query(`/* compact-ack-comparison:legacy-read-batch */
    SELECT content_sha256,canonical_utf8_bytes::text,canonical_utf8
    FROM app.neighborhood_cohort_evidence_blobs
    WHERE organization_id=$1 AND content_sha256=ANY($2::text[])`, [organization, [...expected.keys()]]));
  assert.equal(expected.size, 0);
  return expectedRefs(entries);
}

async function compareTransfers(client) {
  const padding = '0123456789abcdefé🏠'.repeat(8192);
  // Keep the large-payload comparison below the independent 2 MB batch cap
  // even when the record-count ceiling increases.
  const entries = Array.from({ length: Math.min(limits.records, 8) }, (_, index) => entry({
    index, large: 1e21, small: 1e-7, exact_decimal: '1.00', padding,
  }));
  const evidenceBytes = textBytes(entries.map(item => item.canonicalJson));
  assert.ok(evidenceBytes > 1_000_000 && evidenceBytes <= limits.bytes);
  const trials = [];
  // Fixed, disclosed order; do not assert timing superiority from one local
  // sample. Setup, entry preparation and later verification are outside timing.
  for (const implementation of ['legacy', 'compact']) {
    const organization = randomUUID(); await insertOrganization(client, organization);
    for (const operation of ['fresh', 'replay']) {
      const measured = measuredClient(client, implementation === 'compact');
      const started = performance.now();
      const result = implementation === 'compact'
        ? await repository(measured.client, organization).putPreparedBatch(entries)
        : await legacyBatch(measured.client, organization, entries);
      const elapsed_ms = Number((performance.now() - started).toFixed(3));
      assert.deepEqual(result, expectedRefs(entries));
      assert.equal(measured.metrics.queries, operation === 'fresh' ? 1 : 2);
      assert.equal(measured.metrics.canonical_text_upload_utf8_bytes,
        evidenceBytes * (implementation === 'compact' && operation === 'replay' ? 2 : 1));
      assert.equal(measured.metrics.canonical_text_download_utf8_bytes, implementation === 'compact' ? 0 : evidenceBytes);
      trials.push({ implementation, operation, elapsed_ms, ...measured.metrics });
    }
    const found = await client.query(`SELECT content_sha256,canonical_utf8_bytes::text,canonical_utf8
      FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1`, [organization]);
    assert.equal(found.rowCount, entries.length);
    for (const row of found.rows) {
      const original = entries.find(item => item.reference.content_sha256 === row.content_sha256);
      assert.ok(original); assert.equal(row.canonical_utf8, original.canonicalJson);
      assert.equal(row.canonical_utf8_bytes, original.reference.canonical_utf8_bytes);
    }
  }
  return { measurement: 'canonical_text_and_returned_rows_json_utf8_not_protocol_or_tls_wire_bytes',
    interpretation: 'one bounded sequential local comparison; not production throughput evidence',
    records_per_batch: entries.length, evidence_utf8_bytes: evidenceBytes, trials };
}

async function waitForBlocked(observer, blocker, waiter) {
  const deadline = performance.now() + 3000;
  do {
    const result = await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS waiting', [blocker, waiter]);
    if (result.rows[0]?.waiting === true) return;
    await pause(10);
  } while (performance.now() < deadline);
  assert.fail('concurrent compact INSERT did not reach the expected uncommitted winner lock');
}

async function concurrentReplay(pool) {
  // Only the already-guarded child DB owns these committed fixture rows. They
  // remain until its normal teardown, just like the existing blob race test.
  const organization = randomUUID(); await insertOrganization(pool, organization);
  const first = await pool.connect(); let second, observer, replay;
  const winner = entry({ concurrent: 'winner', unicode: 'Café 🏠' });
  const fresh = entry({ concurrent: 'loser-only' });
  try {
    second = await pool.connect(); observer = await pool.connect();
    await first.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await first.query(settings);
    await second.query('BEGIN ISOLATION LEVEL READ COMMITTED'); await second.query(settings);
    const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await repository(first, organization).putPreparedBatch([winner]);
    const measured = measuredClient(second, true);
    replay = repository(measured.client, organization).putPreparedBatch([winner, fresh]);
    void replay.catch(() => {});
    await waitForBlocked(observer, firstPid, secondPid);
    await first.query('COMMIT');
    assert.deepEqual(await replay, expectedRefs([winner, fresh]));
    assert.equal(measured.metrics.queries, 2, 'concurrent winner needs a fresh conflict-read statement');
    assert.equal(measured.metrics.canonical_text_upload_utf8_bytes,
      2 * Buffer.byteLength(winner.canonicalJson) + Buffer.byteLength(fresh.canonicalJson), 'only the unacknowledged original is rebound');
    assert.equal(await repository(second, organization).get(fresh.reference.content_sha256, fresh.reference.canonical_utf8_bytes), fresh.canonicalJson);
    await second.query('ROLLBACK');
    assert.equal(await repository(observer, organization).get(winner.reference.content_sha256, winner.reference.canonical_utf8_bytes), winner.canonicalJson);
    assert.equal(await repository(observer, organization).get(fresh.reference.content_sha256, fresh.reference.canonical_utf8_bytes), null,
      'the second caller still owns rollback of its freshly inserted row');
  } finally {
    try { await first.query('ROLLBACK'); }
    finally {
      first.release();
      try {
        if (second) {
          try { if (replay) await replay.catch(() => {}); await second.query('ROLLBACK'); }
          finally { second.release(); }
        }
      } finally { observer?.release(); }
    }
  }
}

/** Invoke only from the existing URL/socket-verified, migrated native child-DB
 * entrypoint. No pool creation, connection-string selection, bootstrap, DDL,
 * shared resets or deletion here.
 * Functional/measurement fixtures roll back; the explicit two-client winner
 * test leaves its committed rows only for that owned child's normal teardown.
 */
export async function checkNeighborhoodCohortCompactAckDatabase(pool) {
  const organization = randomUUID(), other = randomUUID(), client = await pool.connect();
  let measurements;
  try {
    await client.query('BEGIN'); await client.query(settings);
    await insertOrganization(client, organization); await insertOrganization(client, other);
    const originals = [entry({ name: 'Café 🏠', exact_decimal: '1.00', large: 1e21, small: 1e-7 }),
      entry({ absent: null, flag: false, nested: ['𝛼', 0, true] }), entry({ id: '0000123456789' })];
    assert.match(originals[0].canonicalJson, /1e\+21/); assert.match(originals[0].canonicalJson, /1e-7/);
    const fresh = measuredClient(client, true), own = repository(fresh.client, organization);
    assert.deepEqual(await own.putPreparedBatch(originals), expectedRefs(originals));
    assert.equal(fresh.metrics.queries, 1);
    assert.deepEqual(await own.putPreparedBatch(originals), expectedRefs(originals));
    assert.equal(fresh.metrics.queries, 3);
    const mixed = [originals[1], entry({ mixed: 'new' })];
    assert.deepEqual(await own.putPreparedBatch(mixed), expectedRefs(mixed));
    assert.equal(fresh.metrics.queries, 5);
    const reader = repository(client, organization);
    const batchReader = repository({ async query(sql, values) {
      assert.equal(values.length, 3, 'ordinary prepared reads do not bind original text');
      const result = await client.query(sql, values);
      for (const row of result.rows) {
        assert.deepEqual(Object.keys(row).sort(), ['canonical_utf8', 'canonical_utf8_bytes', 'content_sha256']);
      }
      return result;
    } }, organization);
    const prepared = await batchReader.getPreparedBatch(expectedRefs(originals));
    assert.deepEqual(prepared.map(item => item.canonicalJson), originals.map(item => item.canonicalJson));
    assert.deepEqual(prepared.map(item => item.reference), expectedRefs(originals));
    for (const original of [...originals, mixed[1]]) {
      assert.equal(await reader.get(original.reference.content_sha256, original.reference.canonical_utf8_bytes), original.canonicalJson);
    }
    const foreign = repository(client, other);
    assert.equal(await foreign.get(originals[0].reference.content_sha256, originals[0].reference.canonical_utf8_bytes), null);
    assert.deepEqual(await foreign.putPreparedBatch([originals[0]]), expectedRefs([originals[0]]));
    // SQL admits canonical text plus claimed digest columns, so seed a real
    // same-length mismatch without disabling guards or changing immutable rows.
    const claimed = entry({ case: 'AAAA' }), wrong = canonicalAssessmentJson({ case: 'BBBB' });
    assert.equal(Buffer.byteLength(wrong), Number(claimed.reference.canonical_utf8_bytes));
    await client.query(`INSERT INTO app.neighborhood_cohort_evidence_blobs
      (organization_id,content_sha256,canonical_utf8_bytes,canonical_utf8) VALUES($1,$2,$3,$4)`,
    [organization, claimed.reference.content_sha256, Number(claimed.reference.canonical_utf8_bytes), wrong]);
    await assert.rejects(own.putPreparedBatch([claimed]), /neighborhood_cohort_blob_storage_conflict/);
    measurements = await compareTransfers(client);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM app_auth.organizations WHERE id=ANY($1::uuid[])',
    [[organization, other]])).rows[0].count, 0, 'functional fixture and evidence remain caller-rollback owned');
  await concurrentReplay(pool);
  return { checks: ['fresh_all-conflict_mixed', 'exact_utf8_and_numeric_literals', 'organization_isolation',
    'same_hash_same_length_different_text_refused', 'read_committed_concurrent_winner', 'caller_rollback'], measurements };
}
