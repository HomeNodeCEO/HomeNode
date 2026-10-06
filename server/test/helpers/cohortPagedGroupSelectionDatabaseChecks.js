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

    // Compare actual fresh scoped SQL on the same complete originals. No
    // prepared summary, cache, wider limits or digest-only substitute: both
    // readers reconstruct and verify every membership/union page.
    await client.query('BEGIN');
    const wideIds = Array.from({ length: 9001 }, (_, i) => `synthetic-batch-selection-${String(i).padStart(5, '0')}`);
    const wideGroups = [{ id: A, account_ids: wideIds }];
    const wideCatalog = await repository.put(json({ synthetic_group_catalog_version: 1, groups: wideGroups }));
    const wideMetadata = json({ ...JSON.parse(metadataJson), revision: 7, catalog_ref: wideCatalog,
      groups: [{ id: A, member_count: wideIds.length,
        account_ids_sha256: createHash('sha256').update(json({ account_ids: wideIds })).digest('hex') }] });
    const wideOriginal = await store.stage({ metadataJson: wideMetadata,
      membershipPages: pages(wideIds.map(account_id => ({ account_id, group_id: A }))) });
    const pageRefs = JSON.parse(wideOriginal.manifest_json), permitted = new Set(
      [...pageRefs.membership_pages, ...pageRefs.account_pages].map(ref => ref.page.content_sha256));
    const readCalls = [], tracked = createNeighborhoodCohortBlobRepository({ async query(sql, parameters) {
      readCalls.push({ sql, parameters }); return client.query(sql, parameters);
    } }, scope.organization_id);
    const verifyInput = { metadataJson: wideMetadata, manifestRef: wideOriginal.manifest_ref };
    const single = await createCohortPagedGroupSelectionV1Store({ get: tracked.get, put: tracked.put }).verify(verifyInput);
    assert.equal(readCalls.length, 22, 'manifest + metadata + all ten membership and ten union originals');
    assert.ok(readCalls.every(call => call.sql.includes('neighborhood-cohort-blob:read */')));
    readCalls.length = 0; const visited = [];
    const batched = await createCohortPagedGroupSelectionV1Store(tracked).verify({ ...verifyInput,
      onAccountPage(value) { assert.ok(Object.isFrozen(value.account_ids)); visited.push(...value.account_ids); } });
    assert.deepEqual(batched, single); assert.deepEqual(batched, wideOriginal);
    assert.equal(batched.account_count, wideIds.length); assert.deepEqual(visited, wideIds);
    assert.equal(readCalls.length, 6, 'same complete originals: two single headers + four existing-width batches');
    const batchCalls = readCalls.filter(call => call.sql.includes('neighborhood-cohort-blob:read-batch'));
    assert.deepEqual(batchCalls.map(call => call.parameters[1].length), [8, 8, 2, 2]);
    for (const { sql, parameters } of batchCalls) {
      assert.equal(parameters[0], scope.organization_id);
      assert.ok(parameters[1].every(hash => permitted.has(hash)), 'batch opens only ORIGINAL selection pages, not source facts');
      assert.ok(parameters[2].reduce((sum, bytes) => sum + bytes, 0) <= 2_000_000);
      assert.match(sql, /octet_length\(b.canonical_utf8\)=input.bytes/);
    }
    await client.query('ROLLBACK');
    await assert.rejects(store.verify(verifyInput), /missing_manifest/);
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
    + 'foreign organization/binding refuses and caller rollback/cancellation leaves reports and accepted studies unchanged',
  'real fresh scoped original-page batching verifies the byte-identical 9,001-account selection and ordered union '
    + 'in six SQL reads instead of twenty-two, at unchanged eight-record/2MB limits; all synthetic originals roll back'] };
}
