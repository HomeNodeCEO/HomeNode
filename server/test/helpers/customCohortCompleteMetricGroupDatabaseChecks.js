import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCustomCohortCompleteMetricGroup as group } from '../../src/services/neighborhoodAssessment/customCohortCompleteMetricGroup.js';
import { customCohortMetricRunFixture as fixture } from '../fixtures/customCohortMetricRunFixture.js';

/** Guarded migrated disposable PostgreSQL only. The original members are
 * mapper-issued SYNTHETIC observations, not licensed/current/historical data.
 * This exercises actual supplemental root SQL/tenancy/commit/rollback, not a
 * live selection registry, complete source capture or >50k production capacity. */
export async function checkCustomCohortCompleteMetricGroupDatabase(pool) {
  const organization = randomUUID(), other = randomUUID(), client = await pool.connect();
  const make = revision => fixture({ count: 1001, organization, selectionRevision: revision });
  const input = f => ({ preview: f.preview, selectionRef: f.selectionRef });
  const expected = f => Object.fromEntries(['stock', 'transactions', 'source_reported'].map(kind => [kind, f.preview.selected[kind].metrics]));
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT count(*)::text FROM app.report_files) AS reports,
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.assignment_file_id,s.section_key),''))
      FROM app.custom_appraisal_workfile_sections s) AS sections,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),''))
      FROM app.custom_neighborhood_acceptances a) AS acceptances,
    (SELECT md5(coalesce(string_agg(to_jsonb(h)::text,'' ORDER BY h.organization_id,h.context_id),''))
      FROM app.neighborhood_custom_cohort_group_selection_heads h) AS heads`)).rows[0];
  const before = await protectedState(); let staged;
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='8s'");
    for (const id of [organization, other]) await client.query('INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',
      [id, 'Synthetic complete metric group']);
    const blobs = createNeighborhoodCohortBlobRepository(client, organization), f = make(2);
    staged = await group(blobs).stage(input(f));
    assert.deepEqual((await group(blobs).reopen(input(f), staged.manifest_ref)).metrics, expected(f));
    const rows = await client.query('SELECT content_sha256 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization]);
    assert.deepEqual(new Set(rows.rows.map(row => row.content_sha256)), new Set(staged.retention_refs.map(ref => ref.content_sha256)),
      'the retained group root reports EVERY final/intermediate original');
    await client.query('COMMIT');
    await assert.rejects(group(createNeighborhoodCohortBlobRepository(client, other)).reopen(input(f), staged.manifest_ref), /missing_or_changed_original/);
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization])).rows[0].n;
    const saved = await count(), alternate = make(3);
    await client.query('BEGIN');
    const rolled = await group(blobs).stage(input(alternate));
    assert.deepEqual((await group(blobs).reopen(input(alternate), rolled.manifest_ref)).metrics, expected(alternate));
    await client.query('ROLLBACK'); assert.equal(await count(), saved);
    await assert.rejects(group(blobs).reopen(input(alternate), rolled.manifest_ref), /missing_or_changed_original/);
    await assert.rejects(group(blobs).reopen(input(alternate), staged.manifest_ref), /binding/);
    const cancellation = new AbortController(); await client.query('BEGIN');
    const cancel = group({ get: blobs.get, async put(text) {
      const ack = await blobs.put(text); cancellation.abort(); return ack;
    } }, { signal: cancellation.signal });
    await assert.rejects(cancel.stage(input(make(4))), /cancelled/);
    await client.query('ROLLBACK'); assert.equal(await count(), saved);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const observer = await pool.connect();
  try {
    const fresh = make(2), result = await group(createNeighborhoodCohortBlobRepository(observer, organization)).reopen(input(fresh), staged.manifest_ref);
    assert.deepEqual(result.metrics, expected(fresh)); assert.deepEqual(result.retention_refs, staged.retention_refs);
    assert.equal(result.authority, 'not_established');
  } finally { observer.release(); }
  assert.deepEqual(await protectedState(), before);
}
