import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCohortPagedGroupSelectionV1Store } from '../../src/services/neighborhoodAssessment/cohortPagedGroupSelectionV1Store.js';

/** Only the already verified disposable coordinator database calls this helper.
 * Groups are SYNTHETIC representation fixtures, not licensed neighborhood facts.
 * No current selection head, report section, acceptance or source data is changed.
 */
export async function runCohortPagedGroupSelectionDatabaseChecks({ pool, scope, contextRef }) {
  const A = `recorded-cad:${'a'.repeat(64)}`, B = `recorded-cad:${'b'.repeat(64)}`;
  const id = index => `synthetic-paged-selection-${String(index).padStart(5, '0')}`;
  const groups = [{ id: A, account_ids: Array.from({ length: 1001 }, (_, i) => id(i)) },
    { id: B, account_ids: Array.from({ length: 503 }, (_, i) => id(i + 500)) }];
  const rows = groups.flatMap(group => group.account_ids.map(account_id => ({ account_id, group_id: group.id })))
    .sort((a, b) => a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1
      : a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : 0);
  async function* pages(values = rows) { for (let i = 0; i < values.length; i += 1000) yield values.slice(i, i + 1000); }
  const originalGroups = groups.map(group => ({ id: group.id, member_count: group.account_ids.length,
    account_ids_sha256: createHash('sha256').update(json({ account_ids: group.account_ids })).digest('hex') }));
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.section_key),''))
      FROM app.custom_appraisal_workfile_sections s WHERE assignment_file_id=$1) AS sections,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),''))
      FROM app.custom_neighborhood_acceptances a WHERE assignment_file_id=$1) AS acceptances,
    (SELECT md5(to_jsonb(r)::text) FROM app.report_files r WHERE id=$2) AS report`,
  [scope.assignment_file_id, scope.report_file_id])).rows[0];
  const before = await protectedState();
  const client = await pool.connect(); let original, metadataJson;
  try {
    await client.query('BEGIN');
    const repository = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
    const catalog_ref = await repository.put(json({ synthetic_group_catalog_version: 1, groups }));
    metadataJson = json({ selection_version: 1, usage: 'retained_group_selection_only', scope,
      context_ref: contextRef, catalog_ref, revision: 1, groups: originalGroups });
    const store = createCohortPagedGroupSelectionV1Store(repository);
    original = await store.stage({ metadataJson, membershipPages: pages() });
    assert.equal(original.account_count, 1003); assert.equal(original.membership_count, 1504);
    assert.deepEqual(await store.verify({ metadataJson, manifestRef: original.manifest_ref }), original);
    await client.query('COMMIT');

    await assert.rejects(createCohortPagedGroupSelectionV1Store(
      createNeighborhoodCohortBlobRepository(client, randomUUID()))
      .verify({ metadataJson, manifestRef: original.manifest_ref }), /missing_manifest/);
    const changed = json({ ...JSON.parse(metadataJson), scope: { ...scope, assignment_file_id: '999999' } });
    await assert.rejects(store.verify({ metadataJson: changed, manifestRef: original.manifest_ref }), /invalid_manifest/);

    await client.query('BEGIN');
    const alternative = await store.stage({ metadataJson: json({ ...JSON.parse(metadataJson), revision: 2 }), membershipPages: pages() });
    assert.notDeepEqual(alternative.manifest_ref, original.manifest_ref);
    await client.query('ROLLBACK');
    await assert.rejects(store.verify({ metadataJson: json({ ...JSON.parse(metadataJson), revision: 2 }),
      manifestRef: alternative.manifest_ref }), /missing_manifest/);
    assert.deepEqual(await store.verify({ metadataJson, manifestRef: original.manifest_ref }), original);

    const count = async () => (await pool.query(`SELECT count(*)::int AS n
      FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1`, [scope.organization_id])).rows[0].n;
    const beforeCancel = await count(), signal = new AbortController();
    await client.query('BEGIN');
    const cancelled = createCohortPagedGroupSelectionV1Store({ get: repository.get, async put(text) {
      const result = await repository.put(text); signal.abort(); return result;
    } });
    const cancelGroups = [{ id: A, member_count: 1, account_ids_sha256: createHash('sha256')
      .update(json({ account_ids: ['synthetic-selection-cancel-only'] })).digest('hex') }];
    await assert.rejects(cancelled.stage({ metadataJson: json({ ...JSON.parse(metadataJson), revision: 3, groups: cancelGroups }),
      membershipPages: pages([{ account_id: 'synthetic-selection-cancel-only', group_id: A }]), signal: signal.signal }), /cancelled/);
    await client.query('ROLLBACK');
    assert.equal(await count(), beforeCancel, 'cancellation rolls back newly staged selection originals');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const reopened = await pool.connect();
  try {
    assert.deepEqual(await createCohortPagedGroupSelectionV1Store(
      createNeighborhoodCohortBlobRepository(reopened, scope.organization_id))
      .verify({ metadataJson, manifestRef: original.manifest_ref }), original);
  } finally { reopened.release(); }
  assert.deepEqual(await protectedState(), before);
  return { checks: ['real immutable paged group selection storage reopens the exact union and originals; '
    + 'foreign organization/binding refuses and caller rollback/cancellation leaves reports and accepted studies unchanged'] };
}
