import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

/** Append-only fixtures in the already verified disposable coordinator DB.
 * No current production accounts, credentials or source grants are accepted. */
export async function runCustomCohortDiscoveryDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 3,
    connectionTimeoutMillis: 3000, statement_timeout: 8000, application_name: 'custom_discovery_expansion_test' });
  const checks = [];
  try {
    const probe = await pool.connect();
    try { verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      probe.connection?.stream?.remoteAddress, target.databaseName); } finally { probe.release(); }
    const candidates = await pool.query(`SELECT a.id::text AS assignment, a.organization_id, a.assigned_appraiser_user_id AS actor,
      r.id AS report, r.appraisal_case_id, r.subject_snapshot_id FROM app.assignment_files a JOIN app.report_files r ON r.custom_assignment_file_id=a.id
      WHERE a.account_id='CAPTURE-COORD-SUBJECT' AND a.file_number LIKE 'CAP-%'`);
    assert.equal(candidates.rowCount, 1, 'requires exactly the owned synthetic coordinator assignment');
    const original = candidates.rows[0], account = 'CAPTURE-COORD-SUBJECT';
    // Earlier acceptance/checkpoint checks deliberately protect their file.
    // Give this expansion check its own draft; never un-sign/reset that file.
    const assignment = (await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [original.organization_id, account, `EXP-${randomUUID()}`, original.actor])).rows[0].id;
    const fixture = { organization_id: original.organization_id, actor: original.actor, assignment, report: randomUUID() };
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
      VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [fixture.report, fixture.organization_id, account, `EXP-${randomUUID()}`,
      assignment, original.appraisal_case_id, original.subject_snapshot_id]);
    await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)', [assignment, `expansion-${randomUUID()}`]);
    const auth = { userId: fixture.actor, organizations: [{ organizationId: fixture.organization_id, roles: ['appraiser'] }] };
    const policy = async () => ({ allowed: true, decision_id: 'synthetic_discovery_expansion', policy_revision: 'test-v1' });
    const owner = createCustomCohortContextCapture({ pool, authorizeMarketData: policy });
    const request = discovery => ({ auth, accountId: account, assignmentFileId: fixture.assignment, operationId: randomUUID(),
      observationPeriod: { start_date: '2023-07-01', end_date: '2024-06-30' }, ...(discovery ? { discovery } : {}) });
    const choice = radius_metres => ({ profile_id: 'custom-suburban-radius-v2', radius_metres });
    const baselineRequest = request(), baseline = await owner.capture(baselineRequest);
    const state = (await pool.query("SELECT * FROM gis.source_sync_state WHERE source_key='dcad_parcels'")).rows[0];
    assert.ok(state.last_run_id);
    const far = [`EXPANSION-4-${randomUUID()}`, `EXPANSION-8-${randomUUID()}`];
    const baseId = BigInt((await pool.query('SELECT COALESCE(max(object_id),0)::text AS value FROM gis.dcad_parcels')).rows[0].value) + 1n;
    for (const [index, id] of far.entries()) {
      await pool.query("INSERT INTO core.accounts(account_id,county,address,city,subdivision) VALUES($1,'Dallas','Synthetic expansion only','Synthetic','Expansion Plat')", [id]);
      // Actual geography projection places one small parcel four miles east,
      // the other eight miles east. No bounding-box or degree approximation.
      await pool.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,parcel_area_sqft,source_record_hash,sync_run_id,synced_at,geom)
        VALUES($1,$2,8000,$3,$4,now(),ST_Multi(ST_Buffer(ST_Project(
          ST_SetSRID(ST_MakePoint(-96.6995,32.8005),4326)::geography,$5::double precision,pi()/2),10)::geometry))`,
      [(baseId + BigInt(index)).toString(), id, 'e'.repeat(64), state.last_run_id, (index ? 8 : 4) * 1609.344]);
    }
    await pool.query("UPDATE gis.source_sync_state SET row_count=row_count+2 WHERE source_key='dcad_parcels' AND last_run_id=$1", [state.last_run_id]);
    const scopeJson = json({ organization_id: fixture.organization_id, report_file_id: fixture.report,
      assignment_file_id: fixture.assignment, account_id: account });
    async function load(reference) {
      const client = await pool.connect();
      try { await client.query('BEGIN');
        const header = await createCustomCohortContextRepository(client, scopeJson).get(json(reference));
        const result = await loadCustomCohortCaptureInputs(client, scopeJson, Object.fromEntries(
          ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [key, header.body[key]])));
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    const contexts = [];
    for (const [radius, extra] of [['4828.032', 0], ['8046.72', 1], ['16093.44', 2]]) {
      const input = request(choice(radius)), captured = await owner.capture(input);
      assert.equal(captured.discovery.radius_metres, radius);
      assert.equal(captured.discovery.account_count, baseline.discovery.account_count + extra);
      const retained = await load(captured.context_ref);
      assert.deepEqual(retained.study.discovery, input.discovery);
      assert.deepEqual(retained.acquisition_intent.body.study.discovery, input.discovery);
      const ids = retained.retained_inputs.selector.account_roster.account_ids;
      assert.equal(ids.includes(far[0]), extra >= 1); assert.equal(ids.includes(far[1]), extra >= 2);
      assert.deepEqual(await owner.capture(input), { ...captured, reused: true });
      await assert.rejects(owner.capture({ ...input, discovery: choice(radius === '8046.72' ? '16093.44' : '8046.72') }), /operation_conflict/);
      const preview = await owner.preview({ auth, accountId: account, assignmentFileId: fixture.assignment, contextRef: captured.context_ref,
        selection: { revision: 1, pockets: [{ id: 'all-discovered', label: 'All discovered synthetic accounts', account_ids: ids }] } });
      assert.equal(preview.preview.selected.stock.member_count, ids.length);
      assert.equal(preview.parcel_map.status, 'available');
      contexts.push({ radius, context_ref: captured.context_ref, account_count: ids.length });
    }
    assert.deepEqual(await owner.capture(baselineRequest), { ...baseline, reused: true }, 'old v1 reopens without adding new source rows');
    const freshLegacy = await owner.capture(request());
    assert.equal(freshLegacy.discovery.account_count, baseline.discovery.account_count);
    assert.equal((await pool.query('SELECT count(*)::int AS value FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1', [fixture.assignment])).rows[0].value, 0);
    const denied = createCustomCohortContextCapture({ pool, authorizeMarketData: async () => ({ allowed: false }) });
    await assert.rejects(denied.capture(request(choice('16093.44'))), /market_data_access_denied/);
    checks.push('actual spheroid membership: four-mile parcel only in5/10; eight-mile parcel only in10; no record target or truncation');
    checks.push('v2 study/intent/retained selector radius bindings survive authorized replay; changed-radius UUID conflicts');
    checks.push('retained selected-stock counts and drawable map agree; original v1 replay unchanged after new parcel insertion');
    checks.push('larger area does not bypass source authorization or write report sections');
    return { checks, fixture: { ...fixture, account }, contexts };
  } finally { await pool.end(); }
}
