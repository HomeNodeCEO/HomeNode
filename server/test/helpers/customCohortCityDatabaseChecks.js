import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { loadInstalledCustomCityDiscovery, validateRetainedCustomCityDiscovery } from '../../src/services/neighborhoodAssessment/customCityDiscovery.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../../src/services/customAppraisalWorkfiles.js';
import { readCustomNeighborhoodWorkspaceCheckpoint } from '../../src/services/neighborhoodAssessment/customWorkspaceCheckpoint.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';

const ACCOUNT = 'CAPTURE-COORD-SUBJECT';
const PERIOD = { start_date: '2023-07-01', end_date: '2024-06-30' };
const sha = value => createHash('sha256').update(value).digest('hex');
const GRANT = Object.freeze({ allowed: true, decision_id: 'synthetic_city_discovery_native', policy_revision: 'native-v1' });

/** Actual owner and immutable replay in the already migrated, guarded disposable
 * coordinator database. Create separate drafts; never reset its protected CAP
 * assignment, alter current source tables, or relabel a retained subject date.
 * New fixture rows remain for browser QA and ephemeral database teardown. */
export async function runCustomCohortCityDatabaseChecks(connectionString) {
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  const { Pool } = createRequire(import.meta.url)('pg');
  const pool = new Pool({ connectionString: target.connectionString, max: 3,
    connectionTimeoutMillis: 3000, statement_timeout: 8000, application_name: 'custom_city_discovery_test' });
  const checks = [], calls = [], exposures = [];
  async function transaction(work, readOnly = false) {
    const client = await pool.connect(); let discard;
    try {
      await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'; SET LOCAL timezone='UTC'");
      const value = await work(client); await client.query('COMMIT'); return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (cleanup) { discard = cleanup; }
      throw error;
    } finally { client.release(discard); }
  }
  async function fileState(assignment) {
    return transaction(async client => (await client.query(`SELECT jsonb_build_object(
      'assignment',(SELECT to_jsonb(a) FROM app.assignment_files a WHERE id=$1),
      'report',(SELECT to_jsonb(r) FROM app.report_files r WHERE custom_assignment_file_id=$1),
      'workfile',(SELECT to_jsonb(w) FROM app.custom_appraisal_workfiles w WHERE assignment_file_id=$1),
      'sections',(SELECT jsonb_agg(to_jsonb(s) ORDER BY section_key) FROM app.custom_appraisal_workfile_sections s WHERE assignment_file_id=$1),
      'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM app.custom_appraisal_workfile_section_history h WHERE assignment_file_id=$1),
      'acceptances',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM app.custom_neighborhood_acceptances a WHERE assignment_file_id=$1),
      'signatures',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM app.custom_appraisal_signed_snapshots s WHERE assignment_file_id=$1),
      'subject',(SELECT to_jsonb(s) FROM app.appraisal_subject_snapshots s JOIN app.report_files r ON r.subject_snapshot_id=s.id WHERE r.custom_assignment_file_id=$1),
      'case',(SELECT to_jsonb(c) FROM app.appraisal_cases c JOIN app.report_files r ON r.appraisal_case_id=c.id WHERE r.custom_assignment_file_id=$1)
      ) AS state`, [assignment])).rows[0].state, true);
  }
  try {
    const probe = await pool.connect();
    try { verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      probe.connection?.stream?.remoteAddress, target.databaseName); } finally { probe.release(); }
    const originalRows = await pool.query(`SELECT a.id::text AS assignment,a.organization_id,a.assigned_appraiser_user_id AS actor,
      r.id AS report,r.appraisal_case_id,r.subject_snapshot_id,c.effective_date::text,
      s.subject_data FROM app.assignment_files a
      JOIN app.report_files r ON r.custom_assignment_file_id=a.id AND r.account_id=a.account_id AND r.organization_id=a.organization_id
        AND r.workflow_type='custom_appraisal' AND r.uad_workfile_id IS NULL AND r.tax_protest_file_id IS NULL
      JOIN app.appraisal_cases c ON c.id=r.appraisal_case_id AND c.organization_id=a.organization_id AND c.account_id=a.account_id
      JOIN app.appraisal_subject_snapshots s ON s.id=r.subject_snapshot_id AND s.appraisal_case_id=c.id
      JOIN app_auth.organizations o ON o.id=a.organization_id
      JOIN app_auth.users u ON u.id=a.created_by_user_id AND u.id=a.assigned_appraiser_user_id
      WHERE a.account_id=$1 AND a.file_number LIKE 'CAP-%' AND o.legal_name=$2 AND u.display_name=$3`,
    [ACCOUNT, 'Synthetic Custom capture', 'Synthetic capture actor']);
    assert.equal(originalRows.rowCount, 1, 'requires exactly the preceding owned CAP coordinator assignment');
    const original = originalRows.rows[0], protectedBefore = await fileState(original.assignment);
    assert.equal(original.effective_date, '2024-06-30');
    assert.equal(original.subject_data.custom_property_snapshot.location.longitude, -96.6995);
    assert.equal(original.subject_data.custom_property_snapshot.location.latitude, 32.8005);

    // Read only the installed registry; the actual loader separately checks its
    // original bytes, exact source metadata, hash, and closed geometry grammar.
    const registry = JSON.parse(await readFile(new URL('../../data/neighborhood-city-boundaries/catalog.json', import.meta.url), 'utf8'));
    async function installed(name) {
      const matches = registry.cities.filter(row => row.name === name); assert.equal(matches.length, 1);
      const row = matches[0];
      return loadInstalledCustomCityDiscovery({ profile_id: 'custom-city-polygon-v1',
        city: { geoid: row.geoid, vintage: registry.vintage, asset_sha256: row.sha256 } });
    }
    const dallas = await installed('Dallas'), outside = await installed('Duncanville');
    const nativeGeometry = await transaction(async client => {
      const rows = await client.query(`SELECT ST_IsValid(g) AS valid,
        ST_Covers(g,ST_SetSRID(ST_MakePoint(-96.6995,32.8005),4326)) AS covers_subject
        FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::text),4326) AS g) q`, [JSON.stringify(dallas.geometry)]);
      const other = await client.query(`SELECT ST_Covers(ST_SetSRID(ST_GeomFromGeoJSON($1::text),4326),
        ST_SetSRID(ST_MakePoint(-96.6995,32.8005),4326)) AS covers_subject`, [JSON.stringify(outside.geometry)]);
      assert.deepEqual(rows.rows, [{ valid: true, covers_subject: true }]);
      assert.equal(other.rows[0].covers_subject, false);
      // Independent complete exact-polygon oracle, without radius or LIMIT.
      return (await client.query(`SELECT p.object_id::text,p.account_id FROM gis.dcad_parcels p
        WHERE ST_Intersects(p.geom,ST_SetSRID(ST_GeomFromGeoJSON($1::text),4326)) ORDER BY p.object_id`,
      [JSON.stringify(dallas.geometry)])).rows;
    }, true);
    assert.ok(nativeGeometry.some(row => row.account_id === ACCOUNT));
    checks.push('installed Dallas original is valid and covers the recorded subject; exact native polygon membership is complete, Duncanville does not cover it');

    const currentDate = (await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text AS value")).rows[0].value;
    async function newDraft(current) {
      return transaction(async client => {
        const fixture = { organization_id: original.organization_id, actor: original.actor, account: ACCOUNT, report: randomUUID(),
          appraisal_case_id: current ? randomUUID() : original.appraisal_case_id,
          subject_snapshot_id: current ? randomUUID() : original.subject_snapshot_id,
          effective_date: current ? currentDate : original.effective_date };
        if (current) {
          await client.query('INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,$4::date)',
            [fixture.appraisal_case_id, fixture.organization_id, ACCOUNT, currentDate]);
          const copied = await client.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
            SELECT $1,$2,1,$4::date,subject_data FROM app.appraisal_subject_snapshots WHERE id=$3 RETURNING subject_data`,
          [fixture.subject_snapshot_id, fixture.appraisal_case_id, original.subject_snapshot_id, currentDate]);
          assert.equal(copied.rowCount, 1); assert.deepEqual(copied.rows[0].subject_data, original.subject_data);
        }
        const file = `CITY-${current ? 'CURRENT' : 'HIST'}-${randomUUID()}`;
        fixture.assignment = (await client.query(`INSERT INTO app.assignment_files
          (organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
          VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [fixture.organization_id, ACCOUNT, file, fixture.actor])).rows[0].id;
        await client.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
          VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [fixture.report, fixture.organization_id, ACCOUNT, file,
          fixture.assignment, fixture.appraisal_case_id, fixture.subject_snapshot_id]);
        await client.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)',
          [fixture.assignment, `city-study-${randomUUID()}`]);
        return fixture;
      });
    }
    const fixture = await newDraft(true), historical = await newDraft(false);
    const owned = new Map([fixture, historical].map(item => [item.assignment, item]));
    const auth = { userId: fixture.actor, organizations: [{ organizationId: fixture.organization_id, roles: ['appraiser'] }] };
    const observed = { async connect() {
      const client = await pool.connect();
      return { release: error => client.release(error), async query(config, values) {
        const text = typeof config === 'string' ? config : config.text; calls.push(text);
        return client.query(config, values);
      } };
    } };
    const policy = async (_client, principal, context, purpose, options) => {
      const exact = owned.get(context.target.workflow_target_id); assert.ok(exact, 'synthetic policy is restricted to these two new assignments');
      assert.equal(principal.userId, exact.actor); assert.equal(context.scope.organization_id, exact.organization_id);
      assert.equal(context.target.report_file_id, exact.report); assert.equal(context.scope.account_id, ACCOUNT);
      assert.equal(context.scope.appraisal_case_id, exact.appraisal_case_id);
      assert.equal(context.scope.subject_snapshot_id, exact.subject_snapshot_id);
      assert.equal(purpose.kind, 'neighborhood_cached_market_data');
      assert.deepEqual(purpose.source_classes, ['core.sales_source_records', 'core.sales', 'core.sale_parcels']);
      assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
      assert.equal(purpose.association_metadata, 'all_transaction_parcel_links');
      assert.equal(purpose.additional_cadastral_accounts, false); assert.equal(purpose.private_assignment_overlays, false);
      assert.deepEqual(purpose.observation_period, PERIOD); assert.equal(Object.hasOwn(purpose, 'source_projection'), false);
      assert.equal(options.retention, true);
      assert.ok(['none', 'report_observation_catalog', 'report_observation_summary', 'report_observation_members'].includes(options.exposure));
      exposures.push(options.exposure); return GRANT;
    };
    const owner = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: policy });
    const request = (scope = fixture, discovery = dallas.choice) => ({ auth, accountId: ACCOUNT, assignmentFileId: scope.assignment,
      operationId: randomUUID(), observationPeriod: PERIOD, discovery });
    const currentBefore = await fileState(fixture.assignment), captureInput = request(), captured = await owner.capture(captureInput);
    assert.equal(captured.status, 'registered'); assert.equal(captured.reused, false);
    const ids = [...new Set(nativeGeometry.map(row => row.account_id))].sort();
    assert.deepEqual(captured.discovery, { ...dallas.choice, parcel_count: nativeGeometry.length, account_count: ids.length });
    assert.equal(captured.source_query_complete, true); assert.equal(captured.provider_coverage, 'not_established');
    assert.ok(calls.some(sql => sql.includes('neighborhood-membership:parcels') && sql.includes('ST_Intersects') && !sql.includes('ST_DWithin')));
    assert.deepEqual(await fileState(fixture.assignment), currentBefore, 'capture alone changes no saved workspace or report state');
    checks.push('actual current-day owner capture uses installed city intersection, exact complete counts, ordinary source policy and no report writes');

    async function load(scope, reference) {
      const scopeJson = json({ organization_id: scope.organization_id, report_file_id: scope.report,
        assignment_file_id: scope.assignment, account_id: ACCOUNT });
      return transaction(async client => {
        const header = await createCustomCohortContextRepository(client, scopeJson).get(json(reference)); assert.ok(header);
        return loadCustomCohortCaptureInputs(client, scopeJson, Object.fromEntries(
          ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [key, header.body[key]])));
      });
    }
    const retained = await load(fixture, captured.context_ref), input = retained.retained_inputs;
    assert.deepEqual(retained.study.discovery, dallas.choice); assert.deepEqual(retained.acquisition_intent.body.study.discovery, dallas.choice);
    assert.deepEqual(input.selector.account_roster.account_ids, ids); assert.deepEqual(input.spatial.account_ids, ids);
    assert.deepEqual(input.spatial.parcels.map(row => ({ object_id: row.object_id, account_id: row.account_id })), nativeGeometry);
    assert.equal(Object.hasOwn(input.spatial, 'radius_metres'), false);
    assert.deepEqual(validateRetainedCustomCityDiscovery(input.spatial.city_scope), dallas);
    assert.equal(input.spatial.city_scope.asset_utf8, dallas.asset_utf8);
    assert.equal(sha(input.spatial.city_scope.asset_utf8), dallas.choice.city.asset_sha256);
    assert.deepEqual(input.spatial.city_scope.source, dallas.source);
    assert.equal(input.subject.effective_date, currentDate);
    assert.equal(input.acquisition.capture_result.captured_at.slice(0, 10), currentDate,
      'midnight rollover requires a fresh fixture, never post-capture date relabeling');
    const closure = input.acquisition.captured_query_request.transaction_closure;
    assert.ok(closure.transactions.some(row => row.source_record_id === '10'));
    assert.ok(closure.links.some(row => row.account_id === 'CAPTURE-COORD-LINKED'), 'one-hop co-parcel source closure is not clipped to city stock');
    const roles = new Set(input.acquisition.capture_result.source_capture.sources.map(source => source.payload.projection.definition.role));
    for (const role of ['parcels', 'accounts', 'transactions', 'sale_links']) assert.ok(roles.has(role));
    assert.equal(JSON.parse(input.acquisition.compact_metadata_json).mapping_version, 4);
    checks.push('complete retained original reopens exact city asset/source metadata and all source roles, including linked transaction accounts beyond the CAD roster');

    async function immutableCounts() {
      return (await pool.query(`SELECT
        (SELECT count(*)::text FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1) AS contexts,
        (SELECT count(*)::text FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1) AS blobs`, [fixture.organization_id])).rows[0];
    }
    const replayBefore = await immutableCounts(), replayStart = calls.length;
    assert.deepEqual(await owner.capture(captureInput), { ...captured, reused: true });
    assert.equal(calls.slice(replayStart).some(sql => /neighborhood-(?:cache|membership|closure):/.test(sql)), false);
    for (const discovery of [outside.choice,
      { ...dallas.choice, city: { ...dallas.choice.city, asset_sha256: 'a'.repeat(64) } },
      { ...dallas.choice, city: { ...dallas.choice.city, vintage: '2025-01-01' } }]) {
      await assert.rejects(owner.capture({ ...captureInput, discovery }), /operation_conflict/);
    }
    assert.deepEqual(await immutableCounts(), replayBefore);
    checks.push('exact city UUID retry reuses original without fresh source acquisition; different GEOID/hash/vintage conflict before registry lookup or writes');

    const previewInput = { auth, accountId: ACCOUNT, assignmentFileId: fixture.assignment, contextRef: captured.context_ref,
      selection: { revision: 1, pockets: [{ id: 'city-all', label: 'All captured city accounts', account_ids: ids }] } };
    const catalogStart = calls.length, catalog = await owner.catalog({ ...previewInput, includeRecommendation: true });
    assert.deepEqual(catalog.discovery, dallas.choice); assert.equal(catalog.catalog.catalog_complete, true);
    assert.equal(catalog.catalog.coverage.discovery_member_count, ids.length);
    assert.equal(catalog.recommendation.policy.revision, 3); assert.equal(catalog.recommendation.evidence_mode, 'recorded_housing_only');
    assert.equal(Object.hasOwn(catalog.recommendation, 'recorded_proximity'), false);
    assert.equal(catalog.recommendation.all.factor_coverage.proximity.observed_count, 0);
    assert.equal(Object.hasOwn(catalog.discovery, 'radius_metres'), false);
    assert.equal(calls.slice(catalogStart).some(sql => sql.includes('custom-cohort-recorded-proximity:distances')), false);
    assert.equal(calls.slice(catalogStart).some(sql => /neighborhood-(?:cache|membership|closure):/.test(sql)), false);
    const preview = await owner.preview(previewInput);
    assert.equal(preview.preview.selected.stock.member_count, ids.length); assert.equal(preview.parcel_map.status, 'available');
    checks.push('current city catalog preserves city identity and observed housing-only recommendation; drawable selected stock agrees, with no radius or native proximity work');

    // Seed only this new draft's actual existing workspace section for browser
    // QA, then prove failed acquisitions do not replace its active selection.
    const included = catalog.catalog.pockets.map(pocket => pocket.id);
    if (catalog.catalog.unassigned.member_count) included.push('discovery:unassigned');
    const checkpoint = { workspace_version: 4, active: { context_ref: captured.context_ref, observation_period: PERIOD,
      selection: { revision: 1, included_recorded_group_ids: included }, discovery: dallas.choice }, pending_capture: null };
    const saved = await transaction(client => saveCustomAppraisalWorkfileSectionInTransaction(client, {
      accountId: ACCOUNT, assignmentFileId: fixture.assignment, sectionKey: 'neighborhood_workspace', sectionValue: checkpoint,
      expectedRevision: 0, saveReason: 'autosave', reviewer: 'Synthetic city native fixture' }));
    // The service returns node-postgres Date metadata; the normal HTTP JSON
    // envelope serializes it to the string required by the checkpoint reader.
    const saveAck = JSON.parse(JSON.stringify(saved));
    assert.equal(saved.revision, 1); assert.deepEqual(readCustomNeighborhoodWorkspaceCheckpoint(saveAck).checkpoint, checkpoint);
    const stable = await fileState(fixture.assignment), outsideRequest = request(fixture, outside.choice);
    await assert.rejects(owner.capture(outsideRequest), /city_subject_outside_scope/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND context_id=$2',
      [fixture.organization_id, outsideRequest.operationId])).rows[0].n, 0);
    assert.deepEqual(await fileState(fixture.assignment), stable);
    // The existing multi-phase owner may retain the failed attempt's immutable
    // phase-one intent. That is not a registered context or a saved selection.
    assert.deepEqual(await owner.capture(captureInput), { ...captured, reused: true });
    checks.push('outside-city subject is explicitly refused without appending it; existing saved city checkpoint and all report state remain exact');

    const denied = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async (...args) => {
      await policy(...args); return { allowed: false };
    } });
    const deniedBefore = await immutableCounts(), deniedStart = calls.length;
    await assert.rejects(denied.capture(captureInput), /market_data_access_denied/);
    await assert.rejects(denied.catalog({ ...previewInput, includeRecommendation: true }), /market_data_access_denied/);
    assert.equal(calls.slice(deniedStart).some(sql => /neighborhood-(?:cache|membership|closure):/.test(sql)), false);
    await assert.rejects(owner.capture({ ...request(), auth: { userId: fixture.actor,
      organizations: [{ organizationId: randomUUID(), roles: ['organization_admin'] }] } }), /assignment_access_denied/);
    let policyCalls = 0;
    const revoked = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async (...args) => {
      await policy(...args); return ++policyCalls > 2 ? { allowed: false } : GRANT;
    } });
    await assert.rejects(revoked.catalog({ ...previewInput, includeRecommendation: true }), /market_data_access_denied/);
    assert.equal(policyCalls, 3); assert.deepEqual(await immutableCounts(), deniedBefore);
    assert.deepEqual(await fileState(fixture.assignment), stable);
    checks.push('fresh current source authorization and exact assignment access remain mandatory for city replay/catalog; final revocation yields no response or durable mutation');

    const historicalBefore = await fileState(historical.assignment), historicalInput = request(historical);
    const historicalCapture = await owner.capture(historicalInput), historicalRetained = await load(historical, historicalCapture.context_ref);
    const historicalCatalog = await owner.catalog({ auth, accountId: ACCOUNT, assignmentFileId: historical.assignment,
      contextRef: historicalCapture.context_ref, selection: { revision: 1, pockets: [] }, includeRecommendation: true });
    assert.deepEqual(historicalCatalog.discovery, dallas.choice);
    assert.equal(historicalRetained.retained_inputs.subject.effective_date, '2024-06-30');
    assert.ok(historicalRetained.retained_inputs.acquisition.capture_result.captured_at.slice(0, 10) > '2024-06-30');
    assert.equal(Object.hasOwn(historicalCatalog, 'recommendation'), false, 'current CAD observations cannot become retrospective housing stock');
    assert.deepEqual(await fileState(historical.assignment), historicalBefore);
    assert.deepEqual(await fileState(original.assignment), protectedBefore);
    assert.deepEqual(await fileState(fixture.assignment), stable);
    assert.equal(stable.acceptances, null); assert.equal(stable.signatures, null);
    assert.deepEqual(stable.sections.map(row => row.section_key), ['neighborhood_workspace']);
    checks.push('genuine historical subject retains its original effective date and omits recommendation; protected original CAP and both report states stay unchanged');
    return { checks, fixture: { ...fixture, context_ref: captured.context_ref, discovery: dallas.choice,
      observation_period: PERIOD, workspace_section_revision: saved.revision, checkpoint,
      account_ids: ids, account_count: ids.length, parcel_count: nativeGeometry.length,
      protected_state_sha256: sha(JSON.stringify(stable)), source_policy: GRANT },
    historical: { ...historical, context_ref: historicalCapture.context_ref }, exposures };
  } finally { await pool.end(); }
}
