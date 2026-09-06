import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prepareNeighborhoodCohortBlob as prepare, createNeighborhoodCohortBlobRepository as repository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';

// Called only inside the existing isolated, URL/socket-verified CI child DB
// suite. Never bootstrap a database or connect using a production environment.
export async function checkNeighborhoodCohortBlobDatabase(pool) {
  const organization = randomUUID(), other = randomUUID(), client = await pool.connect();
  const text = '{"account_id":"00026572500130160000","name":"Café 🏠","value":"1.00"}';
  let ref;
  const rejectsSql = async (sql, params, check) => {
    await client.query('SAVEPOINT invalid_cohort_blob');
    try { await assert.rejects(client.query(sql, params), check); }
    finally { await client.query('ROLLBACK TO SAVEPOINT invalid_cohort_blob'); }
  };
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='8s'");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM app.schema_migrations WHERE migration_name='20261011_neighborhood_cohort_evidence_blobs.sql'")).rows[0].count, 1);
    const migration = await readFile(new URL('../../migrations/20261011_neighborhood_cohort_evidence_blobs.sql', import.meta.url), 'utf8');
    await client.query(migration); await client.query(migration);
    for (const id of [organization, other]) await client.query('INSERT INTO app_auth.organizations (id,legal_name,display_name) VALUES ($1,$2,$2)', [id, `Synthetic cohort blobs ${id}`]);
    const own = repository(client, organization), foreign = repository(client, other);
    ref = await own.put(text);
    assert.equal(await own.get(ref.content_sha256, ref.canonical_utf8_bytes), text);
    assert.equal(await foreign.get(ref.content_sha256, ref.canonical_utf8_bytes), null);
    assert.deepEqual(await own.put(text), ref);
    assert.deepEqual(await foreign.put(text), ref);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id IN ($1,$2)', [organization, other])).rows[0].count, 2);

    for (const sql of [
      'UPDATE app.neighborhood_cohort_evidence_blobs SET canonical_utf8=canonical_utf8 WHERE organization_id=$1',
      'DELETE FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',
    ]) await rejectsSql(sql, [organization], /neighborhood_cohort_blob_immutable/);
    // Even if the guard regresses, the savepoint rollback restores this new,
    // exact synthetic table; there is no live/shared database target here.
    await rejectsSql('TRUNCATE app.neighborhood_cohort_evidence_blobs', [], /neighborhood_cohort_blob_immutable/);
    const insert = 'INSERT INTO app.neighborhood_cohort_evidence_blobs (organization_id,content_sha256,canonical_utf8_bytes,canonical_utf8) VALUES ($1,$2,$3,$4)';
    await rejectsSql(insert, [organization, 'a'.repeat(64), text.length, text], error => error.code === '23514');
    await rejectsSql(insert, [randomUUID(), 'b'.repeat(64), 2, '{}'], error => error.code === '23503');
    await rejectsSql(insert, [organization, 'c'.repeat(64), 1, '{'], error => error.code === '22P02');

    // Deliberately seed a digest/content mismatch in this private rollback-only
    // fixture. SQL does not claim to implement our canonical SHA algorithm.
    const claimed = prepare('{"actual":true}'), wrong = '{"different":true}';
    await client.query(insert, [organization, claimed.content_sha256, Buffer.byteLength(wrong), wrong]);
    await assert.rejects(own.put('{"actual":true}'), /neighborhood_cohort_blob_storage_conflict/);
    await assert.rejects(own.get(claimed.content_sha256, claimed.canonical_utf8_bytes), /neighborhood_cohort_blob_storage_conflict/);
    assert.equal(await own.get(ref.content_sha256, ref.canonical_utf8_bytes), text);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
  const observer = await pool.connect();
  try {
    assert.equal(await repository(observer, organization).get(ref.content_sha256, ref.canonical_utf8_bytes), null,
      'caller rollback must remove uncommitted blob inserts');
  } finally { observer.release(); }

  // Independent committed organization, retained until CI service teardown.
  // Two callers own separate transactions; the repository may not commit either.
  const concurrentOrganization = randomUUID();
  await pool.query('INSERT INTO app_auth.organizations (id,legal_name,display_name) VALUES ($1,$2,$2)', [concurrentOrganization, 'Synthetic concurrent cohort blobs']);
  const first = await pool.connect();
  let second, replay;
  try {
    second = await pool.connect();
    await first.query('BEGIN'); await second.query('BEGIN');
    await first.query("SET LOCAL statement_timeout='8s'"); await second.query("SET LOCAL statement_timeout='8s'");
    const initial = await repository(first, concurrentOrganization).put(text);
    replay = repository(second, concurrentOrganization).put(text);
    // Attach a rejection observer immediately; cleanup still joins this work.
    void replay.catch(() => {});
    await first.query('COMMIT');
    assert.deepEqual(await replay, initial);
    await second.query('COMMIT');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [concurrentOrganization])).rows[0].count, 1);
  } finally {
    try { await first.query('ROLLBACK'); }
    finally {
      first.release();
      if (second) {
        try { if (replay) await replay.catch(() => {}); await second.query('ROLLBACK'); }
        finally { second.release(); }
      }
    }
  }
}
