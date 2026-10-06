import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortOriginalMetricSource as prepare, createCustomCohortOriginalMetricRunOwner as owner } from '../../src/services/neighborhoodAssessment/customCohortOriginalMetricRuns.js';
import { customCohortMetricRunFixture } from '../fixtures/customCohortMetricRunFixture.js';

/** Existing guarded migrated disposable PG suite only. Real immutable blob
 * SQL/tenant/commit/rollback proof with a SYNTHETIC issued member population.
 * Not licensed source acquisition/current assignment or >50k live acceptance. */
export async function checkCustomCohortOriginalMetricRunDatabase(pool) {
  const organization = randomUUID(), other = randomUUID(), client = await pool.connect();
  const f = customCohortMetricRunFixture({ count: 3001, organization });
  const input = (kind = 'stock', metric = 'site_area_sqft') => ({ preview: f.preview, selectionRef: f.selectionRef, kind, metric });
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
      [id, 'Synthetic original-bound metric test']);
    const blobs = createNeighborhoodCohortBlobRepository(client, organization), o = owner(blobs);
    staged = await o.stage(await prepare(input()));
    assert.deepEqual(await o.distribution(await prepare(input()), staged.manifest_ref), f.preview.selected.stock.metrics.site_area_sqft);
    const rows = await client.query('SELECT content_sha256 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization]);
    assert.deepEqual(new Set(rows.rows.map(row => row.content_sha256)), new Set(staged.retention_refs.map(ref => ref.content_sha256)),
      'every staged/intermediate original is reported to the caller for graph registration/cleanup');
    const binding = JSON.parse((await prepare(input())).binding_json);
    assert.equal(binding.member_count, 3001); assert.equal(binding.currency, null);
    await client.query('COMMIT');
    await assert.rejects(owner(createNeighborhoodCohortBlobRepository(client, other))
      .distribution(await prepare(input()), staged.manifest_ref), /missing_or_changed_original/);
    await assert.rejects(o.distribution(await prepare(input('stock', 'gla_sqft')), staged.manifest_ref), /manifest/);
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization])).rows[0].n;
    const savedCount = await count();
    const alternate = customCohortMetricRunFixture({ count: 3001, organization, selectionRevision: 3 });
    const changed = { preview: alternate.preview, selectionRef: alternate.selectionRef, kind: 'stock', metric: 'site_area_sqft' };
    await client.query('BEGIN');
    const rolled = await owner(blobs).stage(await prepare(changed));
    assert.deepEqual(await owner(blobs).distribution(await prepare(changed), rolled.manifest_ref), alternate.preview.selected.stock.metrics.site_area_sqft);
    await client.query('ROLLBACK'); assert.equal(await count(), savedCount);
    await assert.rejects(owner(blobs).distribution(await prepare(changed), rolled.manifest_ref), /missing_or_changed_original/);
    const cancellation = new AbortController(); await client.query('BEGIN');
    const cancelOwner = owner({ get: blobs.get, async put(text) { const ack = await blobs.put(text); cancellation.abort(); return ack; } },
      { signal: cancellation.signal });
    await assert.rejects(cancelOwner.stage(await prepare(input())), /cancelled/);
    await client.query('ROLLBACK'); assert.equal(await count(), savedCount);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const observer = await pool.connect();
  try {
    // Recreate the actual mapper-issued synthetic population and its receipt,
    // not the earlier receipt, then reopen all originals on a FRESH SQL client.
    const fresh = customCohortMetricRunFixture({ count: 3001, organization });
    const source = await prepare({ preview: fresh.preview, selectionRef: fresh.selectionRef, kind: 'stock', metric: 'site_area_sqft' });
    assert.deepEqual(await owner(createNeighborhoodCohortBlobRepository(observer, organization)).distribution(source, staged.manifest_ref),
      fresh.preview.selected.stock.metrics.site_area_sqft);
  } finally { observer.release(); }
  assert.deepEqual(await protectedState(), before);
}
