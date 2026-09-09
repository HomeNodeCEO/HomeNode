import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from '../fixtures/neighborhoodCachedSourceSchemaFixture.js';

/** New disposable migrated test database only; no cleanup of shared tables,
 * fake CI, external provider, live organization, or production credentials. */
export async function runCustomCohortContextCaptureDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const require = createRequire(import.meta.url), pg = require('pg');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 4, connectionTimeoutMillis: 3000,
    statement_timeout: 8000, application_name: 'custom_cohort_context_capture_test' });
  const checks = [];
  try {
    const probe = await pool.connect();
    try { verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      probe.connection?.stream?.remoteAddress, target.databaseName); } finally { probe.release(); }
    await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
    const organization = randomUUID(), actor = randomUUID(), appraisalCase = randomUUID(), snapshot = randomUUID(), report = randomUUID();
    const account = 'CAPTURE-COORD-SUBJECT', other = 'CAPTURE-COORD-OTHER', linked = 'CAPTURE-COORD-LINKED';
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic Custom capture','Synthetic Custom capture')", [organization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic capture actor')", [actor, `${actor}@example.test`]);
    for (const id of [account, other, linked]) await pool.query("INSERT INTO core.accounts(account_id,county,address,city) VALUES($1,'Dallas','Synthetic only','Synthetic')", [id]);
    await pool.query("INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,'2024-06-30')", [appraisalCase, organization, account]);
    const location = { account_id: account, latitude: 32.8005, longitude: -96.6995, source: 'dcad_parcel_query', precision: 'parcel_centroid',
      status: 'matched', confidence: 'high', review_required: false, review_reason: null, match_method: 'parcel_id', source_parcel_id: account,
      feature_count: 1, metadata: { address_agreement: true }, geocoded_at: '2020-01-01T00:00:00.000Z', source_updated_at: '2019-12-31T00:00:00.000Z' };
    await pool.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      VALUES($1,$2,1,'2024-06-30',$3::jsonb)`, [snapshot, appraisalCase, JSON.stringify({ custom_property_snapshot: {
      account: { account_id: account }, improvement: { living_area_sqft: 2000 }, location } })]);
    const assignment = (await pool.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [organization, account, `CAP-${randomUUID()}`, actor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
      VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [report, organization, account, `CAP-${randomUUID()}`, assignment, appraisalCase, snapshot]);
    await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)', [assignment, `capture-${randomUUID()}`]);
    const run = randomUUID(), hash = 'a'.repeat(64);
    await pool.query("INSERT INTO gis.source_sync_runs(id,source_key,mode,status,started_at,completed_at) VALUES($1,'dcad_parcels','full','complete',now()-interval '1 second',now())", [run]);
    await pool.query("INSERT INTO gis.source_sync_state(source_key,status,row_count,last_run_id,last_success_at) VALUES('dcad_parcels','current',2,$1,now())", [run]);
    for (const [index, id] of [account, other].entries()) await pool.query(`INSERT INTO gis.dcad_parcels
      (object_id,account_id,parcel_area_sqft,source_record_hash,sync_run_id,synced_at,geom)
      VALUES($1,$2,8000,$3,$4,now(),ST_Multi(ST_Translate(ST_GeomFromText('POLYGON((-96.7 32.8,-96.699 32.8,-96.699 32.801,-96.7 32.801,-96.7 32.8))',4326),$5,0)))`,
    [index + 1, id, hash, run, index * 0.005]);
    await pool.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type,source_record_hash,close_date,current_price,loaded_at)
      VALUES(10,$1,'closed_sale',$2,'2024-03-01',300000,now())`, [account, hash]);
    await pool.query("INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price,source,loaded_at) VALUES(100,10,$1,'2024-03-01',300000,'Synthetic',now())", [account]);
    await pool.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved,loaded_at)
      VALUES(11,10,1,1,$1,true,now()),(12,10,1,2,$2,true,now())`, [account, linked]);
    const auth = { userId: actor, organizations: [{ organizationId: organization, roles: ['appraiser'] }] };
    const makeInput = () => ({ auth, accountId: account, assignmentFileId: assignment, operationId: randomUUID(),
      observationPeriod: { start_date: '2023-07-01', end_date: '2024-06-30' } });
    const calls = [];
    let loseCommit = false, commits = 0;
    const observed = { async connect() {
      const client = await pool.connect();
      return { release: error => client.release(error), async query(config) {
        calls.push(config.text);
        const result = await client.query(config);
        if (config.text === 'COMMIT' && ++commits === 3 && loseCommit) throw new Error('synthetic_lost_commit_ack');
        return result;
      } };
    } };
    const grant = { allowed: true, decision_id: 'synthetic_all_cached_rows_and_retention', policy_revision: 'synthetic-test-v1' };
    let policyCalls = 0;
    const capture = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async (_client, actualAuth, context, purpose, options) => {
      assert.equal(actualAuth.userId, actor); assert.equal(context.scope.organization_id, organization);
      assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions'); assert.equal(options.retention, true);
      if (++policyCalls === 1) await pool.query('UPDATE core.sales SET sale_price=400000 WHERE id=100');
      return grant;
    } });
    const request = makeInput();
    const result = await capture.capture(request);
    assert.equal(result.status, 'registered'); assert.equal(result.reused, false); assert.equal(policyCalls, 2);
    assert.equal(result.discovery.radius_metres, '4828.032'); assert.equal(result.discovery.account_count, 2);
    assert.equal(result.provider_coverage, 'not_established');
    assert.ok(result.unsupported_capabilities.includes('historical_characteristics'));
    const saved = await pool.query('SELECT canonical_utf8 FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization]);
    assert.ok(saved.rows.some(row => row.canonical_utf8.includes('300000') && row.canonical_utf8.includes('sale_price')),
      'source evidence must retain the original snapshot price despite a concurrent committed change');
    assert.equal((await pool.query('SELECT sale_price::text AS price FROM core.sales WHERE id=100')).rows[0].price, '400000');
    assert.ok(saved.rows.some(row => row.canonical_utf8.includes(linked)), 'full one-hop identity evidence must survive retention');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1', [assignment])).rows[0].count, 0,
      'capture does not apply or rewrite report sections');
    checks.push('real three-phase capture; same-snapshot source price; complete original retention; no report writes');

    const before = calls.length, blobsBefore = saved.rowCount;
    const replay = await capture.capture(request);
    assert.equal(replay.reused, true); assert.deepEqual(replay.context_ref, result.context_ref);
    assert.deepEqual(replay, { ...result, reused: true });
    assert.ok(!calls.slice(before).some(sql => sql.includes('neighborhood-cache:') || sql.includes('neighborhood-membership:')));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1', [organization])).rows[0].count, blobsBefore);
    await assert.rejects(capture.capture({ ...request, observationPeriod: { start_date: '2022-01-01', end_date: '2024-06-30' } }), /operation_conflict/);
    checks.push('exact authorized replay without source reread or extra evidence; changed operation input refused');

    const denied = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async () => ({ allowed: false }) });
    const denyFrom = calls.length;
    await assert.rejects(denied.capture(makeInput()), /market_data_access_denied/);
    assert.ok(!calls.slice(denyFrom).some(sql => sql.includes('neighborhood-closure:') || sql.includes('neighborhood-cache:')));
    await assert.rejects(denied.capture(request), /market_data_access_denied/,
      'a retained context must not bypass the current market-source policy');
    await assert.rejects(capture.capture({ ...makeInput(), auth: { userId: actor, organizations: [{ organizationId: randomUUID(), roles: ['organization_admin'] }] } }), /assignment_access_denied/);
    checks.push('market denial before MLS reads and exact-organization denial');

    const cancelled = makeInput(), controller = new AbortController();
    const cancelling = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async () => {
      controller.abort(); return new Promise(() => {});
    } });
    await assert.rejects(cancelling.capture(cancelled, { signal: controller.signal }), /cancelled/);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_custom_cohort_contexts WHERE context_id=$1', [cancelled.operationId])).rows[0].count, 0);
    let version = 0;
    const changingPolicy = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async () => ({
      ...grant, policy_revision: `synthetic-${++version}`,
    }) });
    await assert.rejects(changingPolicy.capture(makeInput()), /market_policy_changed/);
    checks.push('cancelled policy work and changed retention policy cannot register a context');

    const changed = makeInput(); let mutate = true;
    const concurrent = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async () => {
      if (mutate) { mutate = false; await pool.query(`UPDATE app.appraisal_subject_snapshots
        SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2100') WHERE id=$1`, [snapshot]); }
      return grant;
    } });
    await assert.rejects(concurrent.capture(changed), /subject_changed/);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_custom_cohort_contexts WHERE context_id=$1', [changed.operationId])).rows[0].count, 0);
    checks.push('concurrent consumed-subject change refuses registration');

    loseCommit = true; commits = 0;
    const uncertain = makeInput();
    await assert.rejects(capture.capture(uncertain), error => error.message === 'synthetic_lost_commit_ack' && error.outcome_unknown === true);
    loseCommit = false;
    const recovered = await capture.capture(uncertain);
    assert.equal(recovered.status, 'registered'); assert.equal(recovered.reused, true);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.neighborhood_custom_cohort_contexts WHERE context_id=$1', [uncertain.operationId])).rows[0].count, 1);
    checks.push('actual durable COMMIT with simulated lost acknowledgment reopens once');
    assert.equal(pool.waitingCount, 0);
    return { checks };
  } finally { await pool.end(); }
}
