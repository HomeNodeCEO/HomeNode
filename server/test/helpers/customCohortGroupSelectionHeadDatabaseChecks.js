import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest as digest } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCohortPagedGroupSelectionV1Store } from '../../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';
import { createCustomCohortGroupSelectionRepository } from '../../src/services/neighborhoodAssessment/customCohortGroupSelectionRepository.js';

/** Called only by the already verified disposable database owner. Synthetic
 * groups exercise revision/head storage, not source rights or a live selection
 * service. Existing workspace/report/acceptance contents must remain unchanged.
 */
export async function runCustomCohortGroupSelectionHeadDatabaseChecks({ pool, scope, contextRef }) {
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.section_key),''))
      FROM app.custom_appraisal_workfile_sections s WHERE assignment_file_id=$1) AS sections,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),''))
      FROM app.custom_neighborhood_acceptances a WHERE assignment_file_id=$1) AS acceptances,
    (SELECT md5(to_jsonb(r)::text) FROM app.report_files r WHERE id=$2) AS report`,
  [scope.assignment_file_id, scope.report_file_id])).rows[0];
  const before = await protectedState(), A = `recorded-cad:${'e'.repeat(64)}`;
  const ids = ['synthetic-head-A', 'synthetic-head-B'];
  const create = (client, options) => createCustomCohortGroupSelectionRepository(client, json(scope), json(contextRef), options);
  const stage = async (client, revision, empty = false) => {
    const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
    const catalog_ref = await blobs.put(json({ synthetic_selection_head_catalog: true, account_ids: ids }));
    const metadataJson = json({ selection_version: 1, usage: 'retained_group_selection_only', scope,
      context_ref: contextRef, catalog_ref, revision, groups: empty ? [] : [{ id: A, member_count: ids.length,
        account_ids_sha256: digest({ account_ids: ids }) }] });
    async function* pages() { if (!empty) yield ids.map(account_id => ({ account_id, group_id: A })); }
    const original = await createCohortPagedGroupSelectionV1Store(blobs).stage({ metadataJson, membershipPages: pages() });
    return { metadataJson, manifestRef: original.manifest_ref, original };
  };
  const client = await pool.connect(); let first, firstRequest, firstStage, second, secondRequest, secondStage;
  try {
    await client.query('BEGIN');
    const repo = create(client);
    assert.equal((await repo.peekCurrent()).selection_ref, null);
    firstStage = await stage(client, 1);
    firstRequest = { operationId: randomUUID(), expectedSelectionRef: null,
      metadataJson: firstStage.metadataJson, manifestRef: firstStage.manifestRef };
    first = await repo.put(firstRequest);
    assert.equal(first.status, 'stored'); assert.equal(first.selection_ref.selection_revision, 1);
    await client.query('COMMIT'); // Treat its successful response as lost below.
    await client.query('BEGIN');
    assert.deepEqual(await repo.put(firstRequest), { ...first, status: 'reused' });
    assert.deepEqual((await repo.getCurrent({ metadataJson: firstStage.metadataJson, selectionRef: first.selection_ref })).original, firstStage.original);
    await client.query('COMMIT');

    await client.query('BEGIN');
    const controller = new AbortController();
    const cancellingClient = { release() {}, async query(...args) {
      const result = await client.query(...args);
      if (args[0].includes('custom-cohort-group-selection:head-update')) controller.abort();
      return result;
    } };
    const cancelled = await stage(client, 2, true);
    await assert.rejects(create(cancellingClient, { signal: controller.signal }).put({ operationId: randomUUID(),
      expectedSelectionRef: first.selection_ref, metadataJson: cancelled.metadataJson, manifestRef: cancelled.manifestRef }), /cancelled/);
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    assert.deepEqual((await repo.peekCurrent()).selection_ref, first.selection_ref);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_group_selections
      WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, contextRef.context_id])).rows[0].n, 1);
    await client.query('COMMIT');

    await client.query('BEGIN');
    secondStage = await stage(client, 2, true);
    secondRequest = { operationId: randomUUID(), expectedSelectionRef: first.selection_ref,
      metadataJson: secondStage.metadataJson, manifestRef: secondStage.manifestRef };
    second = await repo.put(secondRequest);
    assert.equal(secondStage.original.account_count, 0);
    const competitor = await pool.connect();
    try {
      await competitor.query('BEGIN');
      await assert.rejects(create(competitor).put({ ...secondRequest, operationId: randomUUID() }), error => error.code === '55P03');
      await competitor.query('ROLLBACK');
      await client.query('COMMIT');
      await competitor.query('BEGIN');
      await assert.rejects(create(competitor).put({ ...secondRequest, operationId: randomUUID() }), /selection_changed/);
      await competitor.query('ROLLBACK');
    } catch (error) { await competitor.query('ROLLBACK'); throw error; }
    finally { competitor.release(); }

    await client.query('BEGIN');
    await assert.rejects(repo.put(firstRequest), /selection_changed/);
    await assert.rejects(repo.getCurrent({ metadataJson: firstStage.metadataJson, selectionRef: first.selection_ref }), /selection_changed/);
    const third = await stage(client, 3);
    await repo.put({ operationId: randomUUID(), expectedSelectionRef: second.selection_ref,
      metadataJson: third.metadataJson, manifestRef: third.manifestRef });
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    assert.deepEqual((await repo.peekCurrent()).selection_ref, second.selection_ref);
    assert.deepEqual(await repo.put(secondRequest), { ...second, status: 'reused' });
    await client.query('COMMIT');
    for (const wrongScope of [{ ...scope, organization_id: randomUUID() }, { ...scope, account_id: 'wrong-head-account' }]) {
      await client.query('BEGIN');
      await assert.rejects(createCustomCohortGroupSelectionRepository(client, json(wrongScope), json(contextRef)).peekCurrent(), /storage_conflict/);
      await client.query('ROLLBACK');
    }
    await assert.rejects(client.query(`UPDATE app.neighborhood_custom_cohort_group_selections SET selection_sha256=$3
      WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, contextRef.context_id, 'f'.repeat(64)]), error => error.code === '55000');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const reopened = await pool.connect();
  try {
    await reopened.query('BEGIN');
    const result = await create(reopened).getCurrent({ metadataJson: secondStage.metadataJson, selectionRef: second.selection_ref });
    assert.equal(result.original.account_count, 0);
    assert.deepEqual(result.selection_ref, second.selection_ref);
    await reopened.query('COMMIT');
  } catch (error) { await reopened.query('ROLLBACK'); throw error; }
  finally { reopened.release(); }
  assert.deepEqual(await protectedState(), before);
  return { checks: ['real context-bound group-selection head registers/reopens a complete or explicit empty union; '
    + 'lost acknowledgment reuses, competing/stale revisions refuse, cancellation/rollback preserve the prior head '
    + 'and immutable history cannot be rewritten; genuine report/workspace/acceptances remain unchanged'] };
}
