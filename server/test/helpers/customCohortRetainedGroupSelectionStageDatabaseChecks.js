import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository,prepareNeighborhoodCohortBlob as blob }
  from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCatalogMembershipWitness as prepare,createCustomCohortCatalogMembershipWitnessStore as store }
  from '../../src/services/neighborhoodAssessment/customCohortCatalogMembershipWitness.js';
import { createCustomCohortRetainedGroupSelectionStage as stage }
  from '../../src/services/neighborhoodAssessment/customCohortRetainedGroupSelectionStage.js';
import { prepareCustomCohortRecordedGroupSelection as derive }
  from '../../src/services/neighborhoodAssessment/customCohortRecordedGroupSelection.js';
import { createCohortPagedGroupSelectionV1Store as selectionStore } from '../../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { customCohortCatalogPageFixture as fixture } from '../fixtures/customCohortCatalogPageFixture.js';

/** Guarded actual disposable PostgreSQL only. Real tenant-private storage and
 * caller rollback, not current assignment/source admission, head publication,
 * large-area source acquisition, live Apply or an application latency claim. */
export async function checkCustomCohortRetainedGroupSelectionStageDatabase(pool) {
  const organization = randomUUID(),other = randomUUID(),f = fixture({ count:2301,groupCount:7,organization });
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT count(*)::text FROM app.report_files) AS reports,
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.assignment_file_id,s.section_key),''))
      FROM app.custom_appraisal_workfile_sections s) AS sections,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),''))
      FROM app.custom_neighborhood_acceptances a) AS acceptances,
    (SELECT md5(coalesce(string_agg(to_jsonb(h)::text,'' ORDER BY h.organization_id,h.context_id),''))
      FROM app.neighborhood_custom_cohort_group_selection_heads h) AS heads`)).rows[0];
  const before = await protectedState(),client = await pool.connect(); let binding,selected,expected;
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1',
    [organization])).rows[0].n;
  const command = ids => json({ command_version:1,actor_user_id:randomUUID(),operation_id:randomUUID(),
    expected_selection_ref:null,included_recorded_group_ids:[...ids].sort(),selection_revision:1 });
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='8s'");
    for (const id of [organization,other]) await client.query('INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,$2,$2)',
      [id,'Synthetic retained original group selection']);
    const blobs = createNeighborhoodCohortBlobRepository(client,organization),whole = await store(blobs).stage(await prepare(f.input));
    const w = JSON.parse(whole.witness_json);
    binding = { scopeJson:f.input.scopeJson,contextJson:f.input.contextJson,manifestRef:w.display_manifest_ref,
      originalCatalogRef:w.original_catalog_ref,sourceReadModelSha256:w.source_read_model_sha256,
      rosterAccountIdsSha256:w.roster_account_ids_sha256,witnessRef:whole.witness_ref };
    const ids = [f.catalog.pockets[1].id,f.catalog.pockets[4].id,'discovery:unassigned'],commandJson = command(ids);
    expected = await derive({ ...f.input,includedGroupIds:ids,revision:1,commandJson,catalogIdentityVersion:2 });
    selected = await stage(blobs,binding).stage(commandJson);
    assert.equal(selected.catalog_original_json,expected.catalog_original_json);
    assert.equal(selected.metadata_json,expected.metadata_json);
    const expectedStage = await selectionStore(blobs).stage({ metadataJson:expected.metadata_json,membershipPages:expected.membershipPages() });
    assert.equal(selected.manifest_json,expectedStage.manifest_json);
    assert.equal(selected.selection_sha256,expectedStage.selection_sha256);
    for (const ref of selected.retention_refs) assert.deepEqual(blob(await blobs.get(ref.content_sha256,ref.canonical_utf8_bytes)),ref);
    await client.query('COMMIT'); const saved = await count();

    await client.query('BEGIN');
    const rolled = await stage(blobs,binding).stage(command([f.catalog.pockets[2].id]));
    await client.query('ROLLBACK'); assert.equal(await count(),saved);
    assert.equal(await blobs.get(rolled.catalog_ref.content_sha256,rolled.catalog_ref.canonical_utf8_bytes),null);
    for (const failure of ['ack','cancel']) {
      await client.query('BEGIN'); const controller = new AbortController();
      const port = { get:blobs.get,async put(text) {
        const ack = await blobs.put(text);
        if (failure === 'ack') throw new Error('synthetic_selected_write_ack_loss');
        controller.abort(); return ack;
      } };
      await assert.rejects(stage(port,binding,{ signal:controller.signal }).stage(command([])),/ack_loss|cancelled/);
      await client.query('ROLLBACK'); assert.equal(await count(),saved);
    }
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const observer = await pool.connect();
  try {
    await observer.query('BEGIN'); const blobs = createNeighborhoodCohortBlobRepository(observer,organization);
    const foreign = createNeighborhoodCohortBlobRepository(observer,other);
    assert.equal((await selectionStore(blobs).verify({ metadataJson:selected.metadata_json,manifestRef:selected.manifest_ref })).account_count,
      selected.account_count);
    assert.equal(await foreign.get(selected.catalog_ref.content_sha256,selected.catalog_ref.canonical_utf8_bytes),null);
    await assert.rejects(stage(foreign,binding).stage(command([])),/missing_or_changed_original/);
    await observer.query('ROLLBACK');
  } catch (error) { await observer.query('ROLLBACK'); throw error; }
  finally { observer.release(); }
  assert.deepEqual(await protectedState(),before);
}
