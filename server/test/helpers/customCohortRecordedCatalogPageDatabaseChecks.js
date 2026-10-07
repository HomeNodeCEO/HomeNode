import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortRecordedCatalogSource as prepare, createCustomCohortRecordedCatalogPageStore as store }
  from '../../src/services/neighborhoodAssessment/customCohortRecordedCatalogPages.js';
import { customCohortCatalogPageFixture as fixture } from '../fixtures/customCohortCatalogPageFixture.js';
import { createCustomCohortRetainedCatalogReader } from '../../src/services/neighborhoodAssessment/customCohortRetainedCatalogReader.js';

/** Only the existing guarded migrated disposable PostgreSQL owner invokes
 * this synthetic fixture. Actual organization scoping, exact original bytes,
 * fresh-client reads, caller commit/rollback and cancellation are exercised;
 * this is not licensed source admission, live activation or large-area SLA. */
export async function checkCustomCohortRecordedCatalogPageDatabase(pool) {
  const organization = randomUUID(), other = randomUUID(), client = await pool.connect();
  const make = labelSuffix => fixture({ count: 1001, groupCount: 237, organization, labelSuffix });
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT count(*)::text FROM app.report_files) AS reports,
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.assignment_file_id,s.section_key),''))
      FROM app.custom_appraisal_workfile_sections s) AS sections,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),''))
      FROM app.custom_neighborhood_acceptances a) AS acceptances,
    (SELECT md5(coalesce(string_agg(to_jsonb(h)::text,'' ORDER BY h.organization_id,h.context_id),''))
      FROM app.neighborhood_custom_cohort_group_selection_heads h) AS heads`)).rows[0];
  const before = await protectedState(); let staged, complete;
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='8s'");
    for (const id of [organization, other]) await client.query('INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',
      [id, 'Synthetic paged recorded catalog']);
    const blobs = createNeighborhoodCohortBlobRepository(client, organization), f = make('');
    staged = await store(blobs).stage(await prepare(f.input));
    complete = await store(blobs).reopen(await prepare(f.input), staged.manifest_ref);
    assert.equal(complete.metadata.account_count, 1001); assert.equal(complete.groups.length, 238);
    const rows = await client.query('SELECT content_sha256 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization]);
    assert.deepEqual(new Set(rows.rows.map(r => r.content_sha256)), new Set(staged.retention_refs.map(r => r.content_sha256)));
    await client.query('COMMIT');
    await assert.rejects(store(createNeighborhoodCohortBlobRepository(client, other)).reopen(await prepare(f.input), staged.manifest_ref),
      /missing_or_changed_original/);
    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',
      [organization])).rows[0].n;
    const saved = await count(), alternate = make(' renamed');
    await client.query('BEGIN');
    const rolled = await store(blobs).stage(await prepare(alternate.input));
    assert.equal((await store(blobs).readPage(await prepare(alternate.input), rolled.manifest_ref, 2)).status, 'display_page');
    await client.query('ROLLBACK'); assert.equal(await count(), saved);
    await assert.rejects(store(blobs).reopen(await prepare(alternate.input), rolled.manifest_ref), /missing_or_changed_original/);
    await assert.rejects(store(blobs).reopen(await prepare(alternate.input), staged.manifest_ref), /binding/);
    const cancellation = new AbortController(); await client.query('BEGIN');
    const cancel = store({ get: blobs.get, async put(text) { const ack = await blobs.put(text); cancellation.abort(); return ack; } },
      { signal: cancellation.signal });
    await assert.rejects(cancel.stage(await prepare(make(' cancelled').input)), /cancelled/);
    await client.query('ROLLBACK'); assert.equal(await count(), saved);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const observer = await pool.connect();
  try {
    await observer.query('BEGIN');
    const blobs = createNeighborhoodCohortBlobRepository(observer, organization), fresh = await prepare(make('').input);
    const directory = await store(blobs).open(fresh, staged.manifest_ref);
    assert.equal(directory.status, 'display_directory'); assert.equal(directory.authority, 'not_established');
    assert.deepEqual(directory.manifest_ref, staged.manifest_ref);
    assert.deepEqual(JSON.parse(directory.metadata_json), complete.metadata);
    const manifest = JSON.parse(directory.manifest_json);
    assert.equal(manifest.pages.length, 3); assert.equal(manifest.account_count, '1001');
    assert.equal(manifest.group_count, '238'); assert.ok(!Object.hasOwn(directory, 'groups'));
    await assert.rejects(store(createNeighborhoodCohortBlobRepository(observer, other)).open(fresh, staged.manifest_ref),
      /missing_or_changed_original/);
    const binding = { scopeJson: make('').input.scopeJson, contextJson: make('').input.contextJson,
      manifestRef: staged.manifest_ref, originalCatalogRef: complete.metadata.original_catalog_ref,
      sourceReadModelSha256: complete.metadata.original_read_model_sha256,
      rosterAccountIdsSha256: complete.metadata.roster_account_ids_sha256 };
    const retained = createCustomCohortRetainedCatalogReader(blobs, binding);
    assert.deepEqual(await retained.open(), directory);
    assert.deepEqual(await retained.reopen(), complete);
    await assert.rejects(createCustomCohortRetainedCatalogReader(createNeighborhoodCohortBlobRepository(observer, other), binding).open(),
      /missing_or_changed_original/);
    assert.deepEqual(await store(blobs).reopen(fresh, staged.manifest_ref), complete);
    for (let i = 0; i < fresh.page_count; i++) {
      const page = await store(blobs).readPage(await prepare(make('').input), staged.manifest_ref, i);
      assert.deepEqual(page.page.groups, complete.groups.slice(i * 100, (i + 1) * 100));
      assert.equal(page.status, 'display_page'); assert.ok(!Object.hasOwn(page, 'catalog_complete'));
      const retainedPage = await retained.page(i);
      assert.deepEqual(retainedPage.page_ref, page.page_ref);
      assert.deepEqual(JSON.parse(retainedPage.page_json), page.page);
    }
    await observer.query('COMMIT');
  } catch (error) { await observer.query('ROLLBACK'); throw error; }
  finally { observer.release(); }
  assert.deepEqual(await protectedState(), before);
}
