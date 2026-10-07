import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { prepareCustomCohortContextHeader } from '../../src/services/neighborhoodAssessment/customCohortContextContract.js';
import { createCustomCohortPreparedCatalogRepository } from '../../src/services/neighborhoodAssessment/customCohortPreparedCatalogRepository.js';
import { createCustomCohortPreparedPreviewRepository } from '../../src/services/neighborhoodAssessment/customCohortPreparedPreviewRepository.js';
import { createCustomCohortPreparedCatalogRegistry as registry } from '../../src/services/neighborhoodAssessment/customCohortPreparedCatalogRegistry.js';
import { customCohortPreparedCatalogRegistryFixture as fixture } from '../fixtures/customCohortPreparedCatalogRegistryFixture.js';
import { contextFixture } from '../fixtures/customCohortContextFixture.js';

/** Guarded disposable migrated PostgreSQL only. Actual checked compiler/index,
 * scoped SQL, transaction publication, fresh-client reads, lost ACK/rollback
 * and immutability. No live source grant, HTTP authorization or >50k SLA. */
export async function checkCustomCohortPreparedCatalogRegistryDatabase(pool, identity) {
  const scope = { organization_id: identity.scope.organization_id, report_file_id: identity.customReportId,
    assignment_file_id: String(identity.customId), account_id: identity.scope.account_id };
  const scopeJson = json(scope), calls = [], client = await pool.connect();
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT md5(coalesce(string_agg(to_jsonb(r)::text,'' ORDER BY r.id),'')) FROM app.report_files r) AS reports,
    (SELECT md5(coalesce(string_agg(to_jsonb(s)::text,'' ORDER BY s.assignment_file_id,s.section_key),'')) FROM app.custom_appraisal_workfile_sections s) AS sections,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text,'' ORDER BY a.id),'')) FROM app.custom_neighborhood_acceptances a) AS acceptances,
    (SELECT md5(coalesce(string_agg(to_jsonb(h)::text,'' ORDER BY h.organization_id,h.context_id),'')) FROM app.neighborhood_custom_cohort_group_selection_heads h) AS heads`)).rows[0];
  const before = await protectedState();
  const observing = { release() {}, async query(sql, values) { calls.push(sql); return client.query(sql, values); } };
  async function source(contextId) {
    const body = contextFixture(); body.context_id = contextId;
    Object.assign(body.target, { organization_id: scope.organization_id, report_file_id: scope.report_file_id,
      workflow_target_id: scope.assignment_file_id, account_id: scope.account_id,
      appraisal_case_id: identity.scope.appraisal_case_id, subject_snapshot_id: identity.scope.subject_snapshot_id });
    const prepared = prepareCustomCohortContextHeader(json(body));
    await createNeighborhoodCohortBlobRepository(client, scope.organization_id).put('{"synthetic":true}');
    await createCustomCohortContextRepository(client, scopeJson).put(json(body));
    // Actual original mappers and indexed builder receive this scope BEFORE
    // issuance; no row/target relabelling or mocked issuer is used.
    const scoped = fixture({ count: 31, groupCount: 7, organization: scope.organization_id,
      scope: { ...scope, appraisal_case_id: identity.scope.appraisal_case_id, subject_snapshot_id: identity.scope.subject_snapshot_id },
      context: prepared.context_ref });
    await createCustomCohortPreparedCatalogRepository(client, scopeJson, prepared.context_ref).put(scoped.payload);
    await createCustomCohortPreparedPreviewRepository(client, scopeJson, prepared.context_ref).put(scoped.preview,
      { status: 'unavailable', reason: 'synthetic_geometry_not_supplied', geojson: null });
    return prepared.context_ref;
  }
  let context, complete, staged;
  try {
    await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='8s'");
    context = await source(randomUUID());
    const owner = registry(observing, scopeJson, json(context));
    assert.equal(await owner.open(), null); staged = await owner.prepare(); complete = await owner.reopen();
    assert.equal(staged.status, 'prepared'); assert.equal(complete.metadata.account_count, 31);
    assert.equal((await registry(observing, scopeJson, json(context)).prepare()).status, 'reused');
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_prepared_catalog_roots
      WHERE organization_id=$1 AND context_id=$2`, [scope.organization_id, context.context_id])).rows[0].n, 1);
    await client.query('COMMIT');
    for (const sql of [
      'UPDATE app.neighborhood_custom_cohort_prepared_catalog_roots SET manifest_sha256=manifest_sha256 WHERE organization_id=$1 AND context_id=$2',
      'DELETE FROM app.neighborhood_custom_cohort_prepared_catalog_roots WHERE organization_id=$1 AND context_id=$2',
      'TRUNCATE app.neighborhood_custom_cohort_prepared_catalog_roots',
    ]) {
      await client.query('BEGIN'); await client.query('SAVEPOINT registry_rejection');
      await assert.rejects(client.query(sql, sql.startsWith('TRUNCATE') ? [] : [scope.organization_id, context.context_id]),
        e => e.code === '55000' && /custom_cohort_context_immutable/.test(e.message));
      await client.query('ROLLBACK');
    }
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM app.neighborhood_custom_cohort_prepared_catalog_roots) AS roots,
      (SELECT count(*)::int FROM app.neighborhood_cohort_evidence_blobs) AS blobs`)).rows[0];
    const retained = await counts(); await client.query('BEGIN');
    const alternate = await source(randomUUID());
    let failed = false;
    const lostAck = { release() {}, async query(sql, values) {
      const result = await client.query(sql, values);
      if (sql.includes('registry:insert')) { failed = true; throw new Error('synthetic_registry_lost_ack'); }
      return result;
    } };
    await assert.rejects(registry(lostAck, scopeJson, json(alternate)).prepare(), /synthetic_registry_lost_ack/);
    assert.equal(failed, true); await client.query('ROLLBACK'); assert.deepEqual(await counts(), retained);
    await client.query('BEGIN'); await assert.rejects(registry(client, scopeJson, json(context)).page(20), /page_index/);
    await client.query('ROLLBACK');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  const observer = await pool.connect();
  try {
    await observer.query('BEGIN');
    const observed = { release() {}, async query(sql, values) { calls.push(sql); return observer.query(sql, values); } };
    const first = calls.length, owner = registry(observed, scopeJson, json(context));
    assert.deepEqual(await owner.reopen(), complete);
    const directory = await owner.open(); assert.deepEqual(directory.manifest_ref, staged.manifest_ref);
    assert.deepEqual(JSON.parse((await owner.page(0)).page_json).groups, complete.groups);
    assert.ok(!calls.slice(first).some(sql => /registry:(originals|pins|insert)|prepared-(catalog|preview):read/.test(sql)));
    for (const changed of [{ ...scope, report_file_id: randomUUID() }, { ...scope, account_id: 'FOREIGN' },
      { ...scope, organization_id: randomUUID() }, { ...scope, assignment_file_id: '9223372036854775807' }])
      assert.equal(await registry(observed, json(changed), json(context)).open(), null);
    await observer.query('COMMIT');
    await assert.rejects(registry(observed, scopeJson, json(context)).open(), /caller_transaction_required/);
  } catch (error) { await observer.query('ROLLBACK'); throw error; }
  finally { observer.release(); }
  assert.deepEqual(await protectedState(), before);
}
