import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNeighborhoodCohortBlobRepository, prepareNeighborhoodCohortBlob as blob }
  from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCatalogMembershipWitness as prepare, createCustomCohortCatalogMembershipWitnessStore as store }
  from '../../src/services/neighborhoodAssessment/customCohortCatalogMembershipWitness.js';
import { createCohortPagedGroupSelectionV1Store } from '../../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { customCohortCatalogPageFixture as fixture } from '../fixtures/customCohortCatalogPageFixture.js';

/** Guarded disposable migrated PostgreSQL only. This verifies actual tenant
 * storage and caller transactions, not licensed-source/current-assignment
 * admission, registry publication, live 5/10-mile capture or application SLA. */
export async function checkCustomCohortCatalogMembershipWitnessDatabase(pool) {
  const organization = randomUUID(), other = randomUUID(), make = labelSuffix =>
    fixture({ count: 1001, groupCount: 237, organization, labelSuffix });
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT count(*)::text FROM app.report_files) AS reports,
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.assignment_file_id,s.section_key),''))
      FROM app.custom_appraisal_workfile_sections s) AS sections,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),''))
      FROM app.custom_neighborhood_acceptances a) AS acceptances,
    (SELECT md5(coalesce(string_agg(to_jsonb(h)::text,'' ORDER BY h.organization_id,h.context_id),''))
      FROM app.neighborhood_custom_cohort_group_selection_heads h) AS heads`)).rows[0];
  const before = await protectedState(), client = await pool.connect(); let retained;
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',
    [organization])).rows[0].n;
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='8s'");
    for (const id of [organization, other]) await client.query('INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',
      [id, 'Synthetic complete catalog memberships']);
    const blobs = createNeighborhoodCohortBlobRepository(client, organization);
    retained = await store(blobs).stage(await prepare(make('').input));
    const rows = await client.query('SELECT content_sha256 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization]);
    assert.deepEqual(new Set(rows.rows.map(r => r.content_sha256)), new Set(retained.retention_refs.map(r => r.content_sha256)));
    await client.query('COMMIT'); const saved = await count();
    await client.query('BEGIN');
    const rolled = await store(blobs).stage(await prepare(make(' rolled back').input));
    await client.query('ROLLBACK'); assert.equal(await count(), saved);
    assert.equal(await blobs.get(rolled.witness_ref.content_sha256, rolled.witness_ref.canonical_utf8_bytes), null);
    const cancellation = new AbortController(); await client.query('BEGIN');
    const cancel = store({ get: blobs.get, async put(text) { const result = await blobs.put(text); cancellation.abort(); return result; } },
      { signal: cancellation.signal });
    await assert.rejects(cancel.stage(await prepare(make(' cancelled').input)), /cancelled/);
    await client.query('ROLLBACK'); assert.equal(await count(), saved);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const observer = await pool.connect();
  try {
    await observer.query('BEGIN'); const blobs = createNeighborhoodCohortBlobRepository(observer, organization);
    const foreign = createNeighborhoodCohortBlobRepository(observer, other);
    for (const ref of retained.retention_refs) {
      const original = await blobs.get(ref.content_sha256, ref.canonical_utf8_bytes);
      assert.deepEqual(blob(original), ref);
      assert.equal(await foreign.get(ref.content_sha256, ref.canonical_utf8_bytes), null);
    }
    const root = JSON.parse(await blobs.get(retained.witness_ref.content_sha256, retained.witness_ref.canonical_utf8_bytes));
    const metadata = await blobs.get(root.membership_metadata_ref.content_sha256, root.membership_metadata_ref.canonical_utf8_bytes);
    const verified = await createCohortPagedGroupSelectionV1Store(blobs).verify({ metadataJson: metadata,
      manifestRef: root.membership_manifest_ref });
    assert.equal(verified.account_count, 1001); assert.equal(verified.membership_count, 1001);
    assert.equal(root.group_count, 238); assert.equal(root.authority, 'not_established');
    assert.deepEqual(JSON.parse(metadata).catalog_ref, root.original_catalog_ref);
    await assert.rejects(createCohortPagedGroupSelectionV1Store(foreign).verify({ metadataJson: metadata,
      manifestRef: root.membership_manifest_ref }), /missing_manifest/);
    await observer.query('COMMIT');
  } catch (error) { await observer.query('ROLLBACK'); throw error; }
  finally { observer.release(); }
  assert.deepEqual(await protectedState(), before);
}
