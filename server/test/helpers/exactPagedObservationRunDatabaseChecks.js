import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { exactDistribution } from '../../src/services/neighborhoodAssessment/statistics.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createExactPagedObservationRunStore } from '../../src/services/neighborhoodAssessment/exactPagedObservationRuns.js';

/** Called only by the existing guarded, fully migrated disposable PG suite.
 * Synthetic numerical storage/rollback proof, NOT a licensed source/population,
 * current assignment authorization, report-ready result or live capacity test.
 */
export async function checkExactPagedObservationRunDatabase(pool) {
  const organization = randomUUID(), other = randomUUID(), client = await pool.connect();
  const bindingJson = json({ original: 'synthetic-number-run-only', organization,
    selection: randomUUID(), population: 'synthetic-observations', metric: 'unitless', period: 'synthetic' });
  const values = Array.from({ length: 11001 }, (_, i) => i % 13 ? (i % 2 ? 1 : -1) * (11001 - i) / 3 : null);
  values[0] = -0; values[1] = 0;
  const pages = function* () { for (let i = 0; i < values.length; i += 1000) yield values.slice(i, i + 1000); };
  const expected = exactDistribution(values);
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
    for (const id of [organization, other]) await client.query('INSERT INTO app_auth.organizations (id,legal_name,display_name) VALUES ($1,$2,$2)',
      [id, 'Synthetic paged Number run test']);
    const blobs = createNeighborhoodCohortBlobRepository(client, organization), store = createExactPagedObservationRunStore(blobs);
    staged = await store.stage({ bindingJson, member_count: values.length, pages });
    assert.equal(staged.authority, 'not_established');
    assert.deepEqual(await store.distribution({ bindingJson, manifestRef: staged.manifest_ref }), expected);
    const root = JSON.parse(await blobs.get(staged.manifest_ref.content_sha256, staged.manifest_ref.canonical_utf8_bytes));
    assert.equal(root.run.count, expected.count); assert.equal(root.run.page_refs.length, Math.ceil(expected.count / 1000));
    const storedPages = [];
    for (const page of root.run.page_refs) storedPages.push(JSON.parse(await blobs.get(page.content_sha256, page.canonical_utf8_bytes)));
    assert.equal(storedPages.flat().filter(pair => pair[1] === '-0').length, 1, 'canonical SQL original preserves signed Number zero token');
    await client.query('COMMIT');
    await assert.rejects(createExactPagedObservationRunStore(createNeighborhoodCohortBlobRepository(client, other))
      .distribution({ bindingJson, manifestRef: staged.manifest_ref }), /missing_or_changed_original/);
    await assert.rejects(store.distribution({ bindingJson: json({ foreign: true }), manifestRef: staged.manifest_ref }), /manifest/);

    const count = async () => (await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization])).rows[0].n;
    const beforeRollback = await count(); await client.query('BEGIN');
    const rolledBinding = json({ ...JSON.parse(bindingJson), selection: randomUUID() });
    const rolled = await store.stage({ bindingJson: rolledBinding, member_count: values.length, pages });
    assert.deepEqual(await store.distribution({ bindingJson: rolledBinding, manifestRef: rolled.manifest_ref }), expected);
    await client.query('ROLLBACK'); assert.equal(await count(), beforeRollback);
    await assert.rejects(store.distribution({ bindingJson: rolledBinding, manifestRef: rolled.manifest_ref }), /missing_or_changed_original/);

    const signal = new AbortController(); await client.query('BEGIN');
    const cancelled = createExactPagedObservationRunStore({ get: blobs.get, async put(text) {
      const ack = await blobs.put(text); signal.abort(); return ack;
    } });
    await assert.rejects(cancelled.stage({ bindingJson, member_count: 1, pages: () => [[781.125]], signal: signal.signal }), /cancelled/);
    await client.query('ROLLBACK'); assert.equal(await count(), beforeRollback);
    assert.deepEqual(await store.distribution({ bindingJson, manifestRef: staged.manifest_ref }), expected);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const observer = await pool.connect();
  try {
    assert.deepEqual(await createExactPagedObservationRunStore(createNeighborhoodCohortBlobRepository(observer, organization))
      .distribution({ bindingJson, manifestRef: staged.manifest_ref }), expected,
    'fresh SQL client reopens every exact original; no process cache or in-memory run authority');
  } finally { observer.release(); }
  assert.deepEqual(await protectedState(), before);
}
