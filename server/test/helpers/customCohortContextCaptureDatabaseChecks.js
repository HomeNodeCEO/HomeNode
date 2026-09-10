import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomNeighborhoodCohortRouter } from '../../src/modules/accounts/customNeighborhoodCohortRouter.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../../src/services/customAppraisalWorkfiles.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs, prepareCustomCohortCaptureInputs,
  persistCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { createCustomCohortSubjectRepository } from '../../src/services/neighborhoodAssessment/customCohortSubjectRepository.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { captureNeighborhoodSpatialMembership } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { resolveNeighborhoodCachedTransactionClosure } from '../../src/services/neighborhoodAssessment/cachedTransactionClosureReader.js';
import { createNeighborhoodCadEvidenceSourceReader, consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodCadEvidenceReadAccess, describeNeighborhoodCachedMarketDataPurpose } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { prepareNeighborhoodSelectorInputV1, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1 } from '../../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { createTestCachedReadAccess } from '../fixtures/neighborhoodCachedReadAccessFixture.js';
import { createCustomCohortDecisionEvidenceResolver } from '../../src/services/neighborhoodAssessment/customCohortDecisionEvidence.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
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
    for (const id of [account, other, linked]) await pool.query("INSERT INTO core.accounts(account_id,county,address,city,subdivision) VALUES($1,'Dallas','Synthetic only','Synthetic','Retained Oak')", [id]);
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
    let policyCalls = 0; const exposures = [];
    const capture = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async (_client, actualAuth, context, purpose, options) => {
      assert.equal(actualAuth.userId, actor); assert.equal(context.scope.organization_id, organization);
      assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions'); assert.equal(options.retention, true);
      exposures.push(options.exposure);
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

    const previewRequest = { auth, accountId: account, assignmentFileId: assignment, contextRef: result.context_ref,
      selection: { revision: 1, pockets: [{ id: 'subject-area', label: 'Subject area', account_ids: [account] }] } };
    const previewFrom = calls.length;
    const preview = await capture.preview(previewRequest);
    assert.equal(preview.status, 'preview'); assert.equal(preview.subject_freshness, 'matched');
    assert.equal(preview.selection_revision, 1); assert.deepEqual(preview.context_ref, result.context_ref);
    assert.equal(preview.preview.status, 'observations_only'); assert.equal(preview.apply.status, 'blocked');
    assert.equal(preview.preview.all.stock.member_count, 2); assert.equal(preview.preview.selected.stock.member_count, 1);
    assert.equal(preview.preview.selected.transactions.metrics.recorded_total_price.median, 300000,
      'preview must use original retained source value, not the current 400000 cache value');
    assert.equal(preview.parcel_map.status, 'available', JSON.stringify(preview.parcel_map));
    assert.equal(preview.parcel_map.geojson.features.length, 2);
    assert.deepEqual(preview.parcel_map.geojson.features.filter(feature => feature.properties.selected)
      .map(feature => feature.properties.account_id), [account]);
    const emptyPreview = await capture.preview({ ...previewRequest, selection: { revision: 2, pockets: [] } });
    assert.equal(emptyPreview.preview.selected.stock.member_count, 0);
    assert.equal(emptyPreview.preview.selected.transactions.member_count, 0);
    assert.equal(emptyPreview.parcel_map.counts.selected_accounts, 0);
    assert.equal(emptyPreview.parcel_map.geojson.features.length, 2, 'excluded areas stay visible');
    assert.ok(!calls.slice(previewFrom).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)),
      'pocket previews must not reacquire mutable property or MLS caches');
    assert.ok(!calls.slice(previewFrom).some(sql => /\b(INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|app\.)/i.test(sql)),
      'preview does not save, apply, or replace retained evidence');
    await assert.rejects(capture.preview({ ...previewRequest,
      selection: { revision: 3, pockets: [{ id: 'foreign', label: 'Not discovered', account_ids: [linked] }] } }), /pocket_membership/);
    checks.push('retained numeric and exact parcel-map preview share one selection; empty selection stays empty; no source reread or writes');

    const display = await capture.present(previewRequest, { includeMap: true });
    assert.deepEqual(display.target, { account_id: account, assignment_file_id: assignment });
    assert.equal(display.summary.all.stock.member_count, 2);
    assert.equal(display.summary.selected.stock.member_count, 1);
    assert.equal(display.summary.selected.transactions.metrics.recorded_total_price.median, 300000);
    assert.equal(display.summary.all.stock.members, undefined);
    assert.equal(display.summary.all.account_ids, undefined);
    assert.equal(display.preview, undefined, 'internal full member data must not accompany compact display');
    assert.equal(display.parcel_map.status, 'available');
    const toggled = await capture.present({ ...previewRequest, selection: { revision: 2, pockets: [] } }, { includeMap: false });
    assert.equal(toggled.summary.selected.stock.member_count, 0);
    assert.deepEqual(toggled.parcel_map, { status: 'omitted', reason: 'geometry_not_requested' });
    assert.notEqual(toggled.summary.binding.selection_sha256, display.summary.binding.selection_sha256);
    const exposureDenied = createCustomCohortContextCapture({ pool: observed,
      authorizeMarketData: async (_client, _auth, _context, _purpose, { exposure }) => exposure === 'none' ? grant : { allowed: false } });
    await assert.rejects(exposureDenied.present(previewRequest), /market_data_access_denied/);
    checks.push('compact display uses identical complete statistics without raw rows; immutable map omission and explicit exposure denial');

    // The catalog must consume the original retained account label, not a new
    // mutable-cache query. A selection never narrows its broad stock roster.
    await pool.query("UPDATE core.accounts SET subdivision='Live Changed Label' WHERE account_id=$1", [other]);
    const catalogFrom = calls.length, exposureFrom = exposures.length;
    const catalog = await capture.catalog(previewRequest);
    assert.equal(catalog.status, 'catalog'); assert.equal(catalog.subject_freshness, 'matched');
    assert.deepEqual(catalog.target, display.target);
    assert.deepEqual(catalog.catalog.binding, display.summary.binding);
    assert.equal(catalog.catalog.status, 'review_only'); assert.equal(catalog.catalog.catalog_complete, true);
    assert.equal(catalog.catalog.coverage.stock_member_count, 2);
    assert.equal(catalog.catalog.pockets.length, 1); assert.equal(catalog.catalog.pockets[0].label, 'Retained Oak');
    assert.deepEqual(catalog.catalog.pockets[0].account_ids, [account, other].sort());
    assert.equal(catalog.catalog.pockets[0].member_count, 2);
    assert.equal(catalog.catalog.subject_membership.assigned_pocket_id, catalog.catalog.pockets[0].id);
    assert.equal(catalog.catalog.unassigned.member_count, 0);
    assert.equal(catalog.catalog.pockets[0].raw_label_variants, undefined);
    assert.equal(catalog.preview, undefined); assert.equal(catalog.parcel_map, undefined);
    assert.equal(catalog.apply.status, 'blocked'); assert.equal(catalog.catalog.apply.status, 'blocked');
    assert.deepEqual(exposures.slice(exposureFrom), ['report_observation_catalog', 'report_observation_catalog']);
    const emptyCatalog = await capture.catalog({ ...previewRequest, selection: { revision: 2, pockets: [] } });
    assert.deepEqual(emptyCatalog.catalog.pockets, catalog.catalog.pockets);
    assert.deepEqual(emptyCatalog.catalog.coverage, catalog.catalog.coverage);
    assert.notEqual(emptyCatalog.catalog.binding.selection_sha256, catalog.catalog.binding.selection_sha256);
    assert.ok(!calls.slice(catalogFrom).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)));
    assert.ok(!calls.slice(catalogFrom).some(sql => /\b(INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|app\.)/i.test(sql)),
      'catalog must not write report sections, evidence, contexts or acceptance');
    const deniedFrom = calls.length;
    await assert.rejects(exposureDenied.catalog(previewRequest), /market_data_access_denied/);
    assert.ok(!calls.slice(deniedFrom).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)));
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1', [assignment])).rows[0].count, 0);
    checks.push('catalog uses retained recorded labels and full stock independent of selection; distinct two-phase exposure; no source reread or report writes');

    // Exercise the real HTTP -> exact target -> retained DB -> presentation
    // chain, not merely a router mock. This app is synthetic and loopback-only.
    const app = express();
    app.use((req, _res, next) => { req.mobileAuth = auth; next(); });
    app.use(createCustomNeighborhoodCohortRouter({ pool, resolveAccountId: async (_pool, id) => id, cohortService: capture }));
    const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/accounts/${account}/neighborhood-cohort`;
      const post = (action, body) => fetch(`${url}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const body = { assignment_file_id: assignment, context_ref: result.context_ref, selection: previewRequest.selection };
      const response = await post('preview', { ...body, include_map: false });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const http = await response.json();
      assert.deepEqual(http.summary, display.summary); assert.equal(http.preview, undefined);
      const pageResponse = await post('members', { ...body, population: { group: 'selected', kind: 'stock' }, page: { limit: 20, after_member_id: null } });
      assert.equal(pageResponse.status, 200);
      const page = await pageResponse.json(); assert.equal(page.status, 'members');
      assert.deepEqual(page.context_ref, result.context_ref); assert.equal(page.selection_revision, 1);
      const foreign = await post('preview', { ...body, context_ref: { ...result.context_ref, context_id: randomUUID() }, include_map: false });
      assert.equal(foreign.status, 404);
      assert.ok(!JSON.stringify(http).includes('raw_projection'));
      assert.ok(!JSON.stringify(page).includes('raw_values'));
      const catalogResponse = await post('catalog', body);
      assert.equal(catalogResponse.status, 200); assert.equal(catalogResponse.headers.get('cache-control'), 'no-store');
      const catalogText = await catalogResponse.text(); assert.ok(Buffer.byteLength(catalogText) <= 4_000_000);
      assert.deepEqual(JSON.parse(catalogText), catalog);
      for (const key of ['raw_projection', 'source_record_id', 'source_ref', 'raw_label_variants', 'market_decision']) {
        assert.ok(!catalogText.includes(`"${key}":`), key);
      }
      const foreignCatalog = await post('catalog', { ...body, context_ref: { ...result.context_ref, context_id: randomUUID() } });
      assert.equal(foreignCatalog.status, 404);
    } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
    checks.push('actual scoped HTTP compact-preview/member pages; foreign context refusal; no raw source exposure');
    checks.push('actual scoped HTTP retained pocket catalog is byte bounded; exact memberships and foreign-context refusal');

    for (const method of ['preview', 'catalog']) for (const deny of [true, false]) {
      let checksDone = 0;
      const revoked = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async () => {
        if (++checksDone === 1) return grant;
        return deny ? { allowed: false } : { ...grant, policy_revision: 'changed-after-load' };
      } });
      await assert.rejects(revoked[method](previewRequest), deny ? /market_data_access_denied/ : /market_policy_changed/);
      assert.equal(checksDone, 2, 'the final fresh policy must decide whether the response may leave');
    }
    for (const method of ['preview', 'catalog']) for (const kind of ['material', 'assignment']) {
      let commitCount = 0;
      const afterLoadPool = { async connect() {
        const client = await pool.connect();
        return { release: error => client.release(error), async query(config) {
          const answer = await client.query(config);
          if (config.text === 'COMMIT' && ++commitCount === 1) {
            // The real retained-read transaction ended. Change the live owner or
            // consumed material before the final response transaction begins.
            if (kind === 'material') await pool.query(`UPDATE app.appraisal_subject_snapshots
              SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2001') WHERE id=$1`, [snapshot]);
            else await pool.query('UPDATE app.assignment_files SET assigned_appraiser_user_id=NULL WHERE id=$1', [assignment]);
          }
          return answer;
        } };
      } };
      const changedAfterLoad = createCustomCohortContextCapture({ pool: afterLoadPool, authorizeMarketData: async () => grant });
      try { await assert.rejects(changedAfterLoad[method](previewRequest), kind === 'material' ? /subject_changed/ : /assignment_access_denied/); }
      finally {
        if (kind === 'material') await pool.query(`UPDATE app.appraisal_subject_snapshots
          SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2000') WHERE id=$1`, [snapshot]);
        else await pool.query('UPDATE app.assignment_files SET assigned_appraiser_user_id=$2 WHERE id=$1', [assignment, actor]);
      }
    }
    checks.push('preview rechecks policy revocation/revision and real assignment/material changes after retained loading');
    checks.push('catalog rechecks policy revocation/revision and real assignment/material changes after retained loading');

    const denied = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async () => ({ allowed: false }) });
    const denyFrom = calls.length;
    await assert.rejects(denied.capture(makeInput()), /market_data_access_denied/);
    assert.ok(!calls.slice(denyFrom).some(sql => sql.includes('neighborhood-closure:') || sql.includes('neighborhood-cache:')));
    await assert.rejects(denied.capture(request), /market_data_access_denied/,
      'a retained context must not bypass the current market-source policy');
    await assert.rejects(denied.preview(previewRequest), /market_data_access_denied/);
    await assert.rejects(denied.catalog(previewRequest), /market_data_access_denied/);
    await assert.rejects(capture.preview({ ...previewRequest,
      auth: { userId: actor, organizations: [{ organizationId: randomUUID(), roles: ['organization_admin'] }] } }), /assignment_access_denied/);
    await assert.rejects(capture.catalog({ ...previewRequest,
      auth: { userId: actor, organizations: [{ organizationId: randomUUID(), roles: ['organization_admin'] }] } }), /assignment_access_denied/);
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
    await assert.rejects(capture.preview(previewRequest), /subject_changed/,
      'original preview cannot be relabeled current after consumed subject inputs change');
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

    // The report bridge drains known same-page work before finalization. A
    // different tab/writer still needs the real database fence, not a browser
    // promise or an automatic retry. Exercise the actual section writer here.
    for (const writer of ['assignment', 'workfile_section']) {
      const contender = await pool.connect(), blocked = makeInput();
      try {
        await contender.query('BEGIN');
        if (writer === 'assignment') await contender.query(`UPDATE app.assignment_files
          SET updated_at=clock_timestamp() WHERE id=$1`, [assignment]);
        else await saveCustomAppraisalWorkfileSectionInTransaction(contender, {
          accountId: account, assignmentFileId: Number(assignment), sectionKey: 'neighborhood_characteristics',
          expectedRevision: 0, sectionValue: { synthetic_pending_report_save: true }, saveReason: 'manual_save',
          reviewer: 'Synthetic overlap reviewer',
        });
        const began = performance.now();
        await assert.rejects(capture.capture(blocked), error => error.code === '55P03');
        assert.ok(performance.now() - began < 1500, 'NOWAIT must precede the bounded statement timeout');
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.neighborhood_custom_cohort_contexts
          WHERE context_id=$1`, [blocked.operationId])).rows[0].n, 0);
        await contender.query('ROLLBACK');
        const retry = await capture.capture(blocked);
        assert.equal(retry.status, 'registered'); assert.equal(retry.reused, false);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections
          WHERE assignment_file_id=$1`, [assignment])).rows[0].n, 0, 'rolled-back report values remain absent');
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_section_history
          WHERE assignment_file_id=$1`, [assignment])).rows[0].n, 0, 'rolled-back report history remains absent');
      } finally {
        try { await contender.query('ROLLBACK'); } finally { contender.release(); }
      }
    }
    checks.push('actual assignment/section saves exclude concurrent capture; explicit retry after rollback registers without report/history writes');

    // Keep the preceding fixture untouched: the later checkpoint helper expects
    // its workspace section to be absent and locates its original actor exactly.
    // This second organization/actor/assignment uses a separate case/snapshot, but the same
    // real retained source rows. No source table or earlier report is rewritten.
    const reviewedOrganization = randomUUID(), reviewedActor = randomUUID(), reviewedCase = randomUUID(), reviewedSnapshot = randomUUID(), reviewedReport = randomUUID();
    await pool.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic reviewed inputs','Synthetic reviewed inputs')", [reviewedOrganization]);
    await pool.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic reviewed inputs actor')",
      [reviewedActor, `${reviewedActor}@example.test`]);
    await pool.query("INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,'2024-06-30')",
      [reviewedCase, reviewedOrganization, account]);
    await pool.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      SELECT $1,$2,1,effective_date,subject_data FROM app.appraisal_subject_snapshots WHERE id=$3`, [reviewedSnapshot, reviewedCase, snapshot]);
    const reviewedAssignment = (await pool.query(`INSERT INTO app.assignment_files
      (organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [reviewedOrganization, account, `PREP-${randomUUID()}`, reviewedActor])).rows[0].id;
    await pool.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
      VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [reviewedReport, reviewedOrganization, account, `PREP-${randomUUID()}`,
    reviewedAssignment, reviewedCase, reviewedSnapshot]);
    await pool.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)',
      [reviewedAssignment, `reviewed-${randomUUID()}`]);
    const reviewedAuth = { userId: reviewedActor, organizations: [{ organizationId: reviewedOrganization, roles: ['appraiser'] }] };
    const reviewedTarget = { accountId: account, assignmentFileId: reviewedAssignment };
    const reviewedExposures = [], reviewedGrant = { allowed: true, decision_id: 'synthetic_native_prepared_inputs_only', policy_revision: 'synthetic-preparation-v1' };
    const reviewedPolicy = async (_client, principal, context, _purpose, options) => {
      assert.equal(principal.userId, reviewedActor); assert.equal(context.target.workflow_target_id, reviewedAssignment);
      assert.equal(context.scope.organization_id, reviewedOrganization);
      assert.equal(options.retention, true); reviewedExposures.push(options.exposure); return reviewedGrant;
    };
    const reviewedOwner = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: reviewedPolicy });
    const reviewedCapture = await reviewedOwner.capture({ ...reviewedTarget, auth: reviewedAuth,
      operationId: randomUUID(), observationPeriod: request.observationPeriod });
    const reviewedRequest = { ...reviewedTarget, auth: reviewedAuth, contextRef: reviewedCapture.context_ref,
      expectedWorkspaceRevision: 1, expectedReviewGeneration: '0' };
    await assert.rejects(reviewedOwner.prepareReviewedInputs(reviewedRequest), /workspace_unavailable/);
    const checkpoint = { workspace_version: 1, active: { context_ref: reviewedCapture.context_ref,
      observation_period: request.observationPeriod, selection: { revision: 7, included_recorded_group_ids: [] } }, pending_capture: null };
    const saveCheckpoint = async (value, revision) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const saved = await saveCustomAppraisalWorkfileSectionInTransaction(client, { ...reviewedTarget,
          sectionKey: 'neighborhood_workspace', sectionValue: value, expectedRevision: revision,
          saveReason: 'autosave', reviewer: reviewedActor });
        await client.query('COMMIT'); return saved;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    };
    assert.equal((await saveCheckpoint(checkpoint, 0)).revision, 1);
    const protectedReviewedState = async () => {
      const sections = await pool.query(`SELECT to_jsonb(s) AS value FROM app.custom_appraisal_workfile_sections s
        WHERE assignment_file_id=$1 ORDER BY section_key`, [reviewedAssignment]);
      const history = await pool.query(`SELECT to_jsonb(h) AS value FROM app.custom_appraisal_workfile_section_history h
        WHERE assignment_file_id=$1 ORDER BY id`, [reviewedAssignment]);
      const artifacts = (await pool.query(`SELECT
        (SELECT count(*)::int FROM app.custom_neighborhood_acceptances WHERE assignment_file_id=$1) AS acceptances,
        (SELECT count(*)::int FROM app.custom_appraisal_signed_snapshots WHERE assignment_file_id=$1) AS signatures,
        (SELECT count(*)::int FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$2) AS retained_blobs,
        (SELECT count(*)::int FROM app.neighborhood_custom_cohort_contexts WHERE assignment_file_id=$1) AS retained_contexts`,
      [reviewedAssignment, reviewedOrganization])).rows[0];
      return { sections: sections.rows, history: history.rows, artifacts };
    };
    const preparedBefore = await protectedReviewedState(), preparedFrom = calls.length, preparedExposures = reviewedExposures.length;
    const prepared = await reviewedOwner.prepareReviewedInputs(reviewedRequest);
    assert.equal(prepared.status, 'prepared_reviewed_inputs'); assert.equal(prepared.workspace_section_revision, 1);
    assert.equal(prepared.authority, 'not_established'); assert.equal(prepared.subject_freshness, 'matched');
    assert.match(prepared.owner_clock_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.equal(prepared.supported_inputs.binding.derived_at, new Date(prepared.owner_clock_at).toISOString());
    assert.equal(prepared.supported_inputs.binding.review_generation, '0');
    assert.equal(prepared.supported_inputs.coverage.review_head_count, 0);
    assert.equal(prepared.supported_inputs.status, 'incomplete'); assert.equal(prepared.supported_inputs.statistics, null);
    assert.equal(prepared.supported_inputs.assessment, null); assert.equal(prepared.supported_inputs.publication, null);
    assert.deepEqual(prepared.supported_inputs.selection.account_ids, []);
    assert.deepEqual(prepared.supported_inputs.selection.included_recorded_group_ids, []);
    assert.equal(prepared.supported_inputs.selection.revision, 7);
    assert.equal(prepared.apply.status, 'blocked'); assert.equal(prepared.supported_inputs.apply.status, 'blocked');
    assert.equal(prepared.report_preparation.status, 'incomplete');
    assert.equal(prepared.report_preparation.identity_status, 'unpublished_preparation');
    assert.equal(prepared.report_preparation.binding.target.editor_revision, 0,
      'only the absent reserved report section supplies revision zero, not workspace1 or selection7');
    assert.equal(prepared.report_preparation.binding.target.custom_assignment_file_id, Number(reviewedAssignment));
    assert.deepEqual(prepared.report_preparation.binding.context_ref, reviewedCapture.context_ref);
    assert.equal(prepared.report_preparation.assessment, null);
    assert.equal(prepared.report_preparation.publication_bundle, null);
    assert.equal(prepared.report_preparation.candidate, null);
    assert.deepEqual(reviewedExposures.slice(preparedExposures), ['none', 'none']);
    assert.deepEqual(await protectedReviewedState(), preparedBefore);
    assert.ok(!calls.slice(preparedFrom).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)));
    assert.ok(!calls.slice(preparedFrom).some(sql => /\b(INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|app\.)/i.test(sql)));
    checks.push('native reviewed-input owner loads saved empty selection7, exact generation0, DB clock and absent report-editor0; genuine incomplete support without source reread or accepted/history writes');

    for (const change of [{ expectedWorkspaceRevision: 2 }, { contextRef: { ...reviewedCapture.context_ref, context_id: randomUUID() } }]) {
      await assert.rejects(reviewedOwner.prepareReviewedInputs({ ...reviewedRequest, ...change }), /workspace_changed/);
    }
    await assert.rejects(reviewedOwner.prepareReviewedInputs({ ...reviewedRequest, expectedReviewGeneration: '1' }), /generation_conflict/);
    await assert.rejects(reviewedOwner.prepareReviewedInputs({ ...reviewedRequest, expectedReviewGeneration: '01' }), /invalid_reviewed_input_revision/);
    const readonly = await reviewedOwner.prepareReviewedInputs({ ...reviewedRequest,
      auth: { userId: reviewedActor, organizations: [{ organizationId: reviewedOrganization, roles: ['read_only'] }] } });
    assert.equal(readonly.status, 'prepared_reviewed_inputs', 'the internal computation requests read, not write/sign permission');
    await assert.rejects(reviewedOwner.prepareReviewedInputs({ ...reviewedRequest,
      auth: { userId: reviewedActor, organizations: [{ organizationId: randomUUID(), roles: ['organization_admin'] }] } }), /assignment_access_denied/);
    const noSource = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: async () => ({ allowed: false }) });
    await assert.rejects(noSource.prepareReviewedInputs(reviewedRequest), /market_data_access_denied/);
    for (const last of [{ allowed: false }, { ...reviewedGrant, policy_revision: 'changed-after-prepare' }]) {
      let policyCount = 0;
      const changed = createCustomCohortContextCapture({ pool: observed,
        authorizeMarketData: async () => ++policyCount === 1 ? reviewedGrant : last });
      await assert.rejects(changed.prepareReviewedInputs(reviewedRequest), last.allowed ? /market_policy_changed/ : /market_data_access_denied/);
      assert.equal(policyCount, 2);
    }
    assert.deepEqual(await protectedReviewedState(), preparedBefore);
    checks.push('native reviewed preparation enforces exact checkpoint/context/generation, permits authorized read-only inspection, denies foreign assignment/source access and rechecks source policy');

    // Native schema forbids null whole sections; do not disable that constraint
    // just to manufacture a state that the real store cannot contain.
    await assert.rejects(pool.query(`UPDATE app.custom_appraisal_workfile_sections SET section_value='null'::jsonb
      WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [reviewedAssignment]), error => error.code === '23514');
    // Mutate only this isolated test assignment and restore exact saved bytes
    // after each malformed/pending-state probe.
    for (const value of [{}, { ...checkpoint, active: null }, { ...checkpoint, pending_capture: {
      operation_id: randomUUID(), observation_period: request.observationPeriod } }]) {
      try {
        await pool.query(`UPDATE app.custom_appraisal_workfile_sections SET section_value=$2::jsonb
          WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [reviewedAssignment, JSON.stringify(value)]);
        await assert.rejects(reviewedOwner.prepareReviewedInputs(reviewedRequest), value?.pending_capture ? /workspace_capture_pending/ : /workspace_unavailable/);
      } finally {
        await pool.query(`UPDATE app.custom_appraisal_workfile_sections SET section_value=$2::jsonb
          WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace'`, [reviewedAssignment, JSON.stringify(checkpoint)]);
      }
    }
    for (const status of ['signed', 'archived']) {
      try {
        await pool.query(`UPDATE app.custom_appraisal_workfiles SET status=$2,
          signed_at=CASE WHEN $2='signed' THEN clock_timestamp() ELSE NULL END WHERE assignment_file_id=$1`, [reviewedAssignment, status]);
        await assert.rejects(reviewedOwner.prepareReviewedInputs(reviewedRequest), /protected_workfile/);
      } finally { await pool.query("UPDATE app.custom_appraisal_workfiles SET status='draft',signed_at=NULL WHERE assignment_file_id=$1", [reviewedAssignment]); }
    }
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1 FOR UPDATE', [reviewedAssignment]);
      const began = performance.now();
      await assert.rejects(reviewedOwner.prepareReviewedInputs(reviewedRequest), error => error.code === '55P03');
      assert.ok(performance.now() - began < 1500);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    checks.push('native prepared-input read blocks missing/malformed/null-active/pending workspaces and protected files; schema refuses JSON-null sections; concurrent parent writer returns NOWAIT without retry');

    const afterFirstCommit = execute => ({ async connect() {
      const client = await pool.connect(); let done = false;
      return { release: error => client.release(error), async query(config) {
        const answer = await client.query(config);
        if (config.text === 'COMMIT' && !done) { done = true; await execute(); }
        return answer;
      } };
    } });
    // Direct SQL below is confined to an explicitly non-authoritative temporary
    // row in this second synthetic assignment. It is not an accepted section,
    // history entry or signature, and the exact original absence is restored.
    const editorBefore = await protectedReviewedState();
    const editorOwnership = await pool.query(`SELECT a.id::text FROM app.assignment_files a
      JOIN app.report_files r ON r.custom_assignment_file_id=a.id AND r.organization_id=a.organization_id
      JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=a.id
      WHERE a.id=$1::bigint AND a.organization_id=$2 AND r.id=$3 AND a.account_id=$4 AND r.account_id=$4
        AND a.created_by_user_id=$5 AND a.assigned_appraiser_user_id=$5
        AND r.appraisal_case_id=$6 AND r.subject_snapshot_id=$7 AND r.workflow_type='custom_appraisal'
        AND w.status='draft' AND w.signed_at IS NULL`,
    [reviewedAssignment, reviewedOrganization, reviewedReport, account, reviewedActor, reviewedCase, reviewedSnapshot]);
    assert.equal(editorOwnership.rowCount, 1); assert.equal(editorOwnership.rows[0].id, reviewedAssignment);
    assert.ok(editorBefore.sections.every(row => row.value.section_key !== 'neighborhood_assessment'));
    assert.equal(editorBefore.artifacts.acceptances, 0); assert.equal(editorBefore.artifacts.signatures, 0);
    const editorLabel = 'Synthetic report-editor binding fixture; not accepted';
    const editorValue = { native_fixture: 'report-editor-binding-only', fixture_id: randomUUID(), authoritative: false };
    let editorInserted = false, editorRevision = 13, editorJson = JSON.stringify(editorValue);
    const replaceEditorFixture = async (revision, value) => {
      const nextJson = JSON.stringify(value);
      const changed = await pool.query(`UPDATE app.custom_appraisal_workfile_sections SET revision=$5,section_value=$6::jsonb
        WHERE assignment_file_id=$1::bigint AND section_key='neighborhood_assessment'
          AND revision=$2 AND section_value=$3::jsonb AND updated_by=$4`,
      [reviewedAssignment, editorRevision, editorJson, editorLabel, revision, nextJson]);
      assert.equal(changed.rowCount, 1, 'only the exact owned temporary editor state may be changed');
      editorRevision = revision; editorJson = nextJson;
    };
    try {
      const inserted = await pool.query(`INSERT INTO app.custom_appraisal_workfile_sections
        (assignment_file_id,section_key,section_value,revision,updated_by)
        VALUES($1,'neighborhood_assessment',$2::jsonb,$3,$4)`, [reviewedAssignment, editorJson, editorRevision, editorLabel]);
      editorInserted = inserted.rowCount === 1; assert.ok(editorInserted);
      const editorProjection = (await pool.query(`SELECT revision,section_value::text AS stored_text,
        CASE WHEN octet_length(section_value::text)<=4000000
          THEN encode(sha256(convert_to(section_value::text,'UTF8')),'hex') ELSE NULL END AS value_sha256
        FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_assessment'`,
      [reviewedAssignment])).rows;
      assert.equal(editorProjection.length, 1); assert.equal(editorProjection[0].revision, 13);
      assert.equal(editorProjection[0].value_sha256,
        createHash('sha256').update(editorProjection[0].stored_text, 'utf8').digest('hex'),
        'native PostgreSQL hashes the actual stored JSON text, not a caller-provided digest');
      const editorStored = await protectedReviewedState(), editorReadFrom = calls.length;
      const withEditor = await reviewedOwner.prepareReviewedInputs(reviewedRequest);
      assert.equal(withEditor.report_preparation.binding.target.editor_revision, 13);
      assert.equal(withEditor.workspace_section_revision, 1); assert.equal(withEditor.supported_inputs.selection.revision, 7);
      assert.equal(withEditor.report_preparation.status, 'incomplete');
      assert.equal(withEditor.report_preparation.authority, 'not_established');
      assert.equal(withEditor.report_preparation.candidate, null); assert.equal(withEditor.report_preparation.apply.status, 'blocked');
      assert.equal(calls.slice(editorReadFrom).filter(sql => sql.includes('custom-cohort-capture:report-editor')).length, 2);
      assert.ok(!calls.slice(editorReadFrom).some(sql => /\b(INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|app\.)/i.test(sql)));
      assert.deepEqual(await protectedReviewedState(), editorStored);
      checks.push('native report preparation binds reserved editor13 independently from workspace1/selection7; real SQL SHA256 projection and read-only incomplete result');

      for (const mutation of [
        { revision: 14, value: editorValue },
        { revision: 13, value: { ...editorValue, changed_fixture_bytes: true } },
      ]) {
        let mutated = false;
        const changingEditor = createCustomCohortContextCapture({ pool: afterFirstCommit(async () => {
          if (mutated) return;
          await replaceEditorFixture(mutation.revision, mutation.value); mutated = true;
        }), authorizeMarketData: reviewedPolicy });
        try {
          await assert.rejects(changingEditor.prepareReviewedInputs(reviewedRequest), /report_editor_changed/);
          assert.ok(mutated, 'the independent committed edit must occur between the owner read transactions');
          const changedProjection = (await pool.query(`SELECT revision,
            encode(sha256(convert_to(section_value::text,'UTF8')),'hex') AS value_sha256
            FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_assessment'`,
          [reviewedAssignment])).rows[0];
          assert.equal(changedProjection.revision, mutation.revision);
          assert.equal(changedProjection.value_sha256 === editorProjection[0].value_sha256, mutation.revision === 14,
            'revision-only and fixed-revision byte changes exercise independent final fences');
        } finally { await replaceEditorFixture(13, editorValue); }
        assert.deepEqual(await protectedReviewedState(), editorStored);
      }
      checks.push('native final report-editor fence rejects committed revision-only and same-revision JSON-hash changes; exact temporary state restored without report/history artifacts');
    } finally {
      if (editorInserted) {
        const removed = await pool.query(`DELETE FROM app.custom_appraisal_workfile_sections
          WHERE assignment_file_id=$1::bigint AND section_key='neighborhood_assessment'
            AND revision=$2 AND section_value=$3::jsonb AND updated_by=$4`,
        [reviewedAssignment, editorRevision, editorJson, editorLabel]);
        assert.equal(removed.rowCount, 1, 'remove only the exact owned non-authoritative fixture row');
      }
      assert.deepEqual(await protectedReviewedState(), editorBefore);
    }
    // New manual narrative geometry is saved only on this owned synthetic
    // assignment, never on the original coordinator fixture. Its marker and
    // native validity do not represent adoption, licensure or report authority.
    const boundaryFields = ['neighborhood_boundary_geometry', 'neighborhood_boundary_source', 'neighborhood_boundary_label',
      'neighborhood_boundary_north', 'neighborhood_boundary_east', 'neighborhood_boundary_south', 'neighborhood_boundary_west',
      'neighborhood_boundary_saved_at', 'neighborhood_boundary_confirmed', 'neighborhood_boundary_confirmed_at'];
    const boundaryState = async () => {
      const rows = await pool.query(`SELECT to_jsonb(a) AS value FROM app.assignment_files a
        WHERE a.id=$1::bigint AND a.organization_id=$2 AND a.account_id=$3 AND a.created_by_user_id=$4`,
      [reviewedAssignment, reviewedOrganization, account, reviewedActor]);
      assert.equal(rows.rowCount, 1);
      const history = await pool.query('SELECT to_jsonb(h) AS value FROM app.assignment_file_history h WHERE assignment_file_id=$1 ORDER BY id',
        [reviewedAssignment]);
      return { assignment: rows.rows[0].value, history: history.rows, protected: await protectedReviewedState() };
    };
    const boundaryBefore = await boundaryState(), originalDetails = boundaryBefore.assignment.assignment_details;
    assert.ok(originalDetails && !Array.isArray(originalDetails));
    assert.ok(boundaryFields.every(key => !Object.hasOwn(originalDetails, key)), 'this exact synthetic assignment has no prior saved boundary');
    const boundaryId = randomUUID(), boundaryPolygon = { type: 'Polygon', coordinates: [
      [[-96.71, 32.79], [-96.68, 32.79], [-96.68, 32.82], [-96.71, 32.82], [-96.71, 32.79]],
      [[-96.708, 32.792], [-96.708, 32.796], [-96.704, 32.796], [-96.704, 32.792], [-96.708, 32.792]],
    ] };
    const boundaryDetails = { ...originalDetails, native_manual_boundary_fixture: boundaryId,
      synthetic_non_boundary_detail: 'Unrelated synthetic detail must not enter the projection',
      neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: boundaryPolygon,
      neighborhood_boundary_label: 'Synthetic native manual geometry; not adopted report evidence',
      neighborhood_boundary_north: 'Literal synthetic north note' };
    let currentDetails = originalDetails, currentAssignmentRevision = boundaryBefore.assignment.revision;
    const replaceBoundary = async (details, revision = currentAssignmentRevision) => {
      const result = await pool.query(`UPDATE app.assignment_files SET assignment_details=$6::jsonb,revision=$7
        WHERE id=$1::bigint AND organization_id=$2 AND account_id=$3
          AND revision=$4 AND assignment_details=$5::jsonb AND created_by_user_id=$8`,
      [reviewedAssignment, reviewedOrganization, account, currentAssignmentRevision, JSON.stringify(currentDetails),
        JSON.stringify(details), revision, reviewedActor]);
      assert.equal(result.rowCount, 1, 'only the exact owned synthetic assignment state may be replaced');
      currentDetails = details; currentAssignmentRevision = revision;
    };
    try {
      await replaceBoundary(boundaryDetails);
      const storedBoundary = await boundaryState(), boundaryCallsFrom = calls.length;
      const manual = await reviewedOwner.prepareReviewedInputs(reviewedRequest), geo = manual.report_preparation.report_geography;
      assert.equal(geo.status, 'manual_geometry_recorded'); assert.equal(geo.authority, 'not_established');
      assert.deepEqual(geo.geometry, boundaryPolygon); assert.equal(geo.binding.assignment_revision, currentAssignmentRevision);
      assert.equal(geo.binding.target.assignment_file_id, reviewedAssignment); assert.equal(geo.binding.target.account_id, account);
      assert.equal(geo.oracle_observation.is_valid, true); assert.ok(geo.oracle_observation.postgis_version.length > 0);
      assert.equal(geo.oracle_observation.geometry_type, 'ST_Polygon'); assert.equal(geo.oracle_observation.is_empty, false);
      assert.equal(geo.oracle_observation.component_count, 1);
      const recordedPoint = geo.subject_point_observation;
      assert.equal(recordedPoint.point.status, 'represented');
      assert.deepEqual(recordedPoint.point.geometry_input.coordinates, ['-96.6995', '32.8005']);
      assert.equal(recordedPoint.point.geometry_input.coordinate_encoding, 'decimal_string_v1');
      assert.equal(recordedPoint.point.geometry_input.axis_order, 'longitude_latitude');
      assert.equal(recordedPoint.retained_subject_binding.target.subject_snapshot_id, reviewedSnapshot);
      assert.equal(recordedPoint.retained_subject_binding.target.appraisal_case_id, reviewedCase);
      assert.equal(recordedPoint.retained_subject_binding.target.assignment_file_id, reviewedAssignment);
      assert.equal(recordedPoint.point.geometry_input.source_sha256, recordedPoint.retained_subject_binding.original_snapshot_row.content_sha256);
      const originalPointBlob = await pool.query(`SELECT canonical_utf8,canonical_utf8_bytes::text
        FROM app.neighborhood_cohort_evidence_blobs WHERE organization_id=$1 AND content_sha256=$2`,
      [reviewedOrganization, recordedPoint.retained_subject_binding.original_snapshot_row.content_sha256]);
      assert.equal(originalPointBlob.rowCount, 1);
      assert.equal(originalPointBlob.rows[0].canonical_utf8_bytes, recordedPoint.retained_subject_binding.original_snapshot_row.canonical_utf8_bytes);
      const originalPointRow = JSON.parse(JSON.parse(originalPointBlob.rows[0].canonical_utf8).pg_row_json);
      const originalLocation = JSON.parse(originalPointRow.subject_data.pg_text).custom_property_snapshot.location;
      assert.equal(originalPointRow.id, reviewedSnapshot); assert.equal(originalPointRow.appraisal_case_id, reviewedCase);
      assert.deepEqual(recordedPoint.point.geometry_input.coordinates, [String(originalLocation.longitude), String(originalLocation.latitude)]);
      assert.deepEqual(recordedPoint.relation, { status: 'observed', reason: null,
        covers_recorded_subject_point: true, contains_recorded_subject_point: true });
      assert.equal(geo.binding.projected_sha256, createHash('sha256').update(geo.projection.projected_json).digest('hex'));
      assert.equal(geo.binding.projected_utf8_bytes, Buffer.byteLength(geo.projection.projected_json));
      assert.deepEqual(JSON.parse(geo.projection.projected_json),
        Object.fromEntries(boundaryFields.filter(key => Object.hasOwn(boundaryDetails, key)).map(key => [key, boundaryDetails[key]])));
      assert.equal(geo.projection.projected_json.includes('synthetic_non_boundary_detail'), false);
      assert.equal(geo.projection.projected_json.includes(boundaryId), false);
      assert.equal(manual.report_preparation.assessment, null); assert.equal(manual.report_preparation.apply.status, 'blocked');
      assert.equal(manual.supported_inputs.statistics, null); assert.deepEqual(manual.supported_inputs.selection, prepared.supported_inputs.selection);
      assert.equal(calls.slice(boundaryCallsFrom).filter(sql => sql.includes('report-geography */')).length, 2);
      assert.equal(calls.slice(boundaryCallsFrom).filter(sql => sql.includes('report-geography-topology')).length, 1);
      assert.ok(!calls.slice(boundaryCallsFrom).some(sql => /\b(INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|app\.)/i.test(sql)));
      assert.deepEqual(await boundaryState(), storedBoundary);
      checks.push('native saved manual Polygon retains holes, exact scoped ten-field SQL hash and actual PostGIS validity; unrelated details omitted and no computation/report writes');

      const invalidPolygon = { type: 'Polygon', coordinates: [
        [[-96.71, 32.79], [-96.68, 32.82], [-96.71, 32.82], [-96.68, 32.79], [-96.71, 32.79]],
      ] };
      for (const [fields, status, nativeQueries] of [
        [{ ...boundaryDetails, neighborhood_boundary_geometry: invalidPolygon }, 'invalid_topology', 1],
        [{ ...boundaryDetails, neighborhood_boundary_source: 'appraiser_defined_area_manual_v1' }, 'intent_unverified', 0],
        [{ ...boundaryDetails, neighborhood_boundary_source: 'neighborhood_boundary_automatic_unverified_v1' }, 'intent_unverified', 0],
        [{ ...boundaryDetails, neighborhood_boundary_source: 'appraiser_defined_area_cleared', neighborhood_boundary_geometry: null }, 'cleared', 0],
      ]) {
        await replaceBoundary(fields);
        const from = calls.length, result = await reviewedOwner.prepareReviewedInputs(reviewedRequest);
        const resultGeo = result.report_preparation.report_geography;
        assert.equal(resultGeo.status, status); assert.equal(resultGeo.geometry, null);
        assert.equal(calls.slice(from).filter(sql => sql.includes('report-geography-topology')).length, nativeQueries);
        if (nativeQueries) {
          assert.equal(resultGeo.oracle_observation.is_valid, false);
          assert.match(resultGeo.oracle_observation.validation_reason, /[Ss]elf-intersection/);
          assert.deepEqual(JSON.parse(resultGeo.projection.projected_json).neighborhood_boundary_geometry, invalidPolygon);
          assert.equal(resultGeo.oracle_observation.covers_recorded_subject_point, null);
          assert.equal(resultGeo.oracle_observation.contains_recorded_subject_point, null);
          assert.deepEqual(resultGeo.subject_point_observation.relation, { status: 'unavailable', reason: 'native_geometry_invalid',
            covers_recorded_subject_point: null, contains_recorded_subject_point: null });
        } else assert.equal(resultGeo.oracle_observation, null);
      }
      await replaceBoundary(boundaryDetails);
      assert.deepEqual(await boundaryState(), storedBoundary);
      checks.push('native self-intersection remains invalid without repair; legacy/automatic/cleared saved geometry never invokes the topology oracle');

      const rectangle = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
      for (const [name, rings, covers, contains] of [
        ['outside', [rectangle(-96.72, 32.79, -96.71, 32.82)], false, false],
        ['exterior edge', [rectangle(-96.6995, 32.79, -96.68, 32.82)], true, false],
        ['hole interior', [boundaryPolygon.coordinates[0], rectangle(-96.7005, 32.7995, -96.6985, 32.8015)], false, false],
        ['hole edge', [boundaryPolygon.coordinates[0], rectangle(-96.6995, 32.7995, -96.6985, 32.8015)], true, false],
      ]) {
        const geometry = { type: 'Polygon', coordinates: rings };
        await replaceBoundary({ ...boundaryDetails, neighborhood_boundary_geometry: geometry });
        const from = calls.length, report = (await reviewedOwner.prepareReviewedInputs(reviewedRequest)).report_preparation;
        const currentGeo = report.report_geography;
        assert.equal(currentGeo.status, 'manual_geometry_recorded', name);
        assert.deepEqual(currentGeo.geometry, geometry, `${name}: no boundary repair or simplification`);
        assert.deepEqual(currentGeo.subject_point_observation.point, recordedPoint.point, `${name}: same retained original centroid`);
        assert.deepEqual(currentGeo.subject_point_observation.relation, { status: 'observed', reason: null,
          covers_recorded_subject_point: covers, contains_recorded_subject_point: contains }, name);
        assert.equal(currentGeo.oracle_observation.covers_recorded_subject_point, covers, name);
        assert.equal(currentGeo.oracle_observation.contains_recorded_subject_point, contains, name);
        assert.equal(calls.slice(from).filter(sql => sql.includes('report-geography-topology')).length, 1);
        assert.ok(!calls.slice(from).some(sql => /account_locations|ST_Centroid|ST_PointOnSurface|neighborhood-(cache|membership):/i.test(sql)));
        assert.equal(report.status, 'incomplete'); assert.equal(report.apply.status, 'blocked');
      }
      await replaceBoundary(boundaryDetails);
      assert.deepEqual(await boundaryState(), storedBoundary);
      checks.push('native ST_Covers/ST_Contains distinguish retained-centroid inside/outside/exterior edge/hole interior/hole edge without geocoding, repair or parcel-containment authority');

      for (const mutation of [
        { revision: currentAssignmentRevision + 1, details: boundaryDetails },
        { revision: currentAssignmentRevision, details: { ...boundaryDetails, neighborhood_boundary_north: 'Changed synthetic north note' } },
      ]) {
        let changed = false;
        const racing = createCustomCohortContextCapture({ pool: afterFirstCommit(async () => {
          if (changed) return;
          await replaceBoundary(mutation.details, mutation.revision); changed = true;
        }), authorizeMarketData: reviewedPolicy });
        try {
          await assert.rejects(racing.prepareReviewedInputs(reviewedRequest), /report_geography_changed/);
          assert.ok(changed, 'a real separately committed assignment writer must run after the initial read transaction');
        } finally { await replaceBoundary(boundaryDetails, storedBoundary.assignment.revision); }
        assert.deepEqual(await boundaryState(), storedBoundary);
      }
      checks.push('native final manual-boundary fence rejects separately committed assignment-revision and fixed-revision projection changes; exact owned state restored');

      const snapshotState = async () => {
        const row = await pool.query(`SELECT to_jsonb(s) AS value FROM app.appraisal_subject_snapshots s
          WHERE id=$1 AND appraisal_case_id=$2`, [reviewedSnapshot, reviewedCase]);
        assert.equal(row.rowCount, 1); return row.rows[0].value;
      };
      const snapshotBefore = await snapshotState(), movedSubject = structuredClone(snapshotBefore.subject_data);
      assert.equal(movedSubject.custom_property_snapshot.location.longitude, -96.6995);
      movedSubject.custom_property_snapshot.location.longitude = -96.6;
      let pointChanged = false;
      const movedPointOwner = createCustomCohortContextCapture({ pool: afterFirstCommit(async () => {
        if (pointChanged) return;
        const changed = await pool.query(`UPDATE app.appraisal_subject_snapshots SET subject_data=$3::jsonb
          WHERE id=$1 AND appraisal_case_id=$2 AND subject_data=$4::jsonb`,
        [reviewedSnapshot, reviewedCase, JSON.stringify(movedSubject), JSON.stringify(snapshotBefore.subject_data)]);
        assert.equal(changed.rowCount, 1); pointChanged = true;
      }), authorizeMarketData: reviewedPolicy });
      try {
        await assert.rejects(movedPointOwner.prepareReviewedInputs(reviewedRequest), /subject_changed/);
        assert.ok(pointChanged, 'actual current location-only edit occurs after retained-point evaluation');
      } finally {
        if (pointChanged) {
          const restored = await pool.query(`UPDATE app.appraisal_subject_snapshots SET subject_data=$3::jsonb
            WHERE id=$1 AND appraisal_case_id=$2 AND subject_data=$4::jsonb`,
          [reviewedSnapshot, reviewedCase, JSON.stringify(snapshotBefore.subject_data), JSON.stringify(movedSubject)]);
          assert.equal(restored.rowCount, 1);
        }
        assert.deepEqual(await snapshotState(), snapshotBefore);
      }
      assert.deepEqual(await boundaryState(), storedBoundary);
      checks.push('native current subject-location-only edit after point observation fails final subject fence; exact owned snapshot and boundary state restored');
    } finally {
      await replaceBoundary(originalDetails, boundaryBefore.assignment.revision);
      assert.deepEqual(await boundaryState(), boundaryBefore);
    }
    // The callback below changes actual committed state after source/read locks
    // are released and before the owner begins its final response transaction.
    let commitMutation = false;
    const changingWorkspace = createCustomCohortContextCapture({ pool: afterFirstCommit(async () => {
      if (commitMutation) return; commitMutation = true;
      const next = structuredClone(checkpoint); next.active.selection.revision = 8;
      await saveCheckpoint(next, 1);
    }), authorizeMarketData: reviewedPolicy });
    await assert.rejects(changingWorkspace.prepareReviewedInputs(reviewedRequest), /workspace_changed/);
    reviewedRequest.expectedWorkspaceRevision = 2; checkpoint.active.selection.revision = 8;
    assert.equal((await reviewedOwner.prepareReviewedInputs(reviewedRequest)).supported_inputs.selection.revision, 8);
    const originalMaterial = (await pool.query('SELECT subject_data FROM app.appraisal_subject_snapshots WHERE id=$1', [reviewedSnapshot])).rows[0].subject_data;
    let changedMaterial = false;
    const changingSubject = createCustomCohortContextCapture({ pool: afterFirstCommit(async () => {
      if (changedMaterial) return; changedMaterial = true;
      await pool.query(`UPDATE app.appraisal_subject_snapshots
        SET subject_data=jsonb_set(subject_data,'{custom_property_snapshot,improvement,living_area_sqft}','2999') WHERE id=$1`, [reviewedSnapshot]);
    }), authorizeMarketData: reviewedPolicy });
    try { await assert.rejects(changingSubject.prepareReviewedInputs(reviewedRequest), /subject_changed/); }
    finally { await pool.query('UPDATE app.appraisal_subject_snapshots SET subject_data=$2::jsonb WHERE id=$1', [reviewedSnapshot, JSON.stringify(originalMaterial)]); }
    checks.push('native final preparation rejects independently committed saved-selection and subject-material changes after its first transaction');

    const scopeJson = json({ organization_id: reviewedOrganization, report_file_id: reviewedReport, assignment_file_id: reviewedAssignment, account_id: account });
    const reviewClient = await pool.connect(); let command;
    try {
      await reviewClient.query('BEGIN');
      const header = await createCustomCohortContextRepository(reviewClient, scopeJson).get(json(reviewedCapture.context_ref));
      const retained = await loadCustomCohortCaptureInputs(reviewClient, scopeJson,
        Object.fromEntries(['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [key, header.body[key]])));
      const resolver = createCustomCohortDecisionEvidenceResolver({ context_header_json: header.header_blob.canonical_json,
        expected: { context_ref: reviewedCapture.context_ref, target: JSON.parse(scopeJson), observation_period: request.observationPeriod },
        retained_inputs: retained.retained_inputs, selection: checkpoint.active.selection });
      const source = retained.retained_inputs.acquisition.capture_result.source_capture.sources.find(source => source.payload.projection.definition.role === 'transactions');
      const record = source.payload.records[0], evidence = resolver.deriveEvidenceRef(source.id, record.record_id);
      command = { version: 1, operation_id: randomUUID(), target_ref: resolver.binding.target_ref,
        expected_context: resolver.binding.context_ref, study_ref: resolver.binding.study_ref,
        expected_generation: '0', expected_predecessor: null, subject_ref: { kind: 'capture_candidate', key: record.record_id },
        claim: { kind: 'sale_completion', qualifier: { basis: 'event' }, state: 'unknown', value: null,
          unknown_reason: 'missing_evidence', decision_refs: [] }, evidence_refs: [evidence],
        rationale: 'Synthetic native unknown review; not a supported closing assertion.' };
      await reviewClient.query('COMMIT');
    } catch (error) { await reviewClient.query('ROLLBACK'); throw error; }
    finally { reviewClient.release(); }
    let appended = false;
    const changingReview = createCustomCohortContextCapture({ pool: afterFirstCommit(async () => {
      if (appended) return; appended = true;
      const saved = await reviewedOwner.review({ ...reviewedTarget, auth: reviewedAuth, commandJson: json(command) });
      assert.equal(saved.generation, '1');
    }), authorizeMarketData: reviewedPolicy });
    await assert.rejects(changingReview.prepareReviewedInputs(reviewedRequest), /generation_conflict/);
    reviewedRequest.expectedReviewGeneration = '1';
    const reviewedState = await protectedReviewedState();
    const reopenedInputs = await reviewedOwner.prepareReviewedInputs(reviewedRequest);
    assert.equal(reopenedInputs.supported_inputs.binding.review_generation, '1');
    assert.equal(reopenedInputs.supported_inputs.coverage.review_head_count, 1);
    assert.equal(reopenedInputs.supported_inputs.status, 'incomplete'); assert.equal(reopenedInputs.supported_inputs.statistics, null);
    assert.deepEqual(reopenedInputs.supported_inputs.selection.account_ids, []);
    assert.deepEqual(await protectedReviewedState(), reviewedState);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1', [assignment])).rows[0].n, 0,
      'original capture assignment must remain untouched for the next native checkpoint helper');
    checks.push('native committed review generation change prevents stale prepared inputs; exact next generation reopens unknown review without statistics or report writes');
    await checkCadEvidenceCapture(pool, checks);
    assert.equal(pool.waitingCount, 0);
    return { checks };
  } finally { await pool.end(); }
}

// Mapping4 is an explicitly installed test reader, never the owner's default
// producer. All fixture identities are separate from CAPTURE-COORD-SUBJECT.
async function checkCadEvidenceCapture(pool, checks) {
  const org = randomUUID(), actor = randomUUID(), caseId = randomUUID(), snapshotId = randomUUID(), reportId = randomUUID();
  const operationId = randomUUID(), account = `CAPTURE-CAD4-${operationId.slice(0, 8)}`, other = `${account}-OTHER`;
  const accountIds = [account, other].sort(), parcelIds = ['910001', '910002'], sourceId = '910010', saleId = '910100', linkId = '910011';
  const hash = 'd'.repeat(64), period = { start_date: '2023-07-01', end_date: '2024-06-30' };
  const columns = ['class_code', 'class_description', 'use_description', 'structure_type', 'built_up'];
  const cadValues = [
    { class_code: '1', class_description: 'SINGLE FAMILY RESIDENCES', use_description: 'Synthetic CAD4 use only',
      structure_type: '  Literal structure label  ', built_up: true },
    { class_code: null, class_description: null, use_description: null, structure_type: null, built_up: false },
  ];
  const sqls = [];
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), query(statement, values) {
      sqls.push(typeof statement === 'string' ? statement : statement.text); return client.query(statement, values);
    } };
  } };
  const tx = async (mode, execute) => {
    const client = await observed.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
      await client.query("SET LOCAL timezone='UTC'; SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
      const value = await execute(client); await client.query('COMMIT'); return value;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  };
  const time = async client => (await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`)).rows[0].value;
  const syncBefore = await tx('READ COMMITTED', async client =>
    (await client.query("SELECT to_jsonb(s) AS value FROM gis.source_sync_state s WHERE source_key='dcad_parcels'")).rows[0].value);
  const countBefore = (await pool.query('SELECT count(*)::int AS n FROM gis.dcad_parcels')).rows[0].n;
  assert.equal(syncBefore.row_count, countBefore, 'exact synthetic source count before adding isolated CAD4 rows');
  assert.equal(syncBefore.status, 'current'); assert.ok(syncBefore.last_run_id);
  let assignment, savedContext, originalAcquisition;
  await tx('READ COMMITTED', async client => {
    assert.equal((await client.query('SELECT object_id FROM gis.dcad_parcels WHERE object_id=ANY($1::bigint[])', [parcelIds])).rowCount, 0);
    await client.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic CAD4 capture','Synthetic CAD4 capture')", [org]);
    await client.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic CAD4 actor')", [actor, `${actor}@example.test`]);
    for (const id of accountIds) await client.query("INSERT INTO core.accounts(account_id,county,address,city,subdivision) VALUES($1,'Dallas','Synthetic CAD4 only','Synthetic','CAD4 Retained Plat')", [id]);
    await client.query("INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,'2024-06-30')", [caseId, org, account]);
    const location = { account_id: account, latitude: 33.1005, longitude: -96.8995, source: 'dcad_parcel_query',
      precision: 'parcel_centroid', status: 'matched', confidence: 'high', review_required: false, review_reason: null,
      match_method: 'parcel_id', source_parcel_id: account, feature_count: 1, metadata: { address_agreement: true },
      geocoded_at: '2020-01-01T00:00:00.000Z', source_updated_at: '2019-12-31T00:00:00.000Z' };
    await client.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      VALUES($1,$2,1,'2024-06-30',$3::jsonb)`, [snapshotId, caseId, JSON.stringify({ custom_property_snapshot: {
      account: { account_id: account }, improvement: { living_area_sqft: 2100 }, location } })]);
    assignment = (await client.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
      VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [org, account, `CAD4-${operationId}`, actor])).rows[0].id;
    await client.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
      VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [reportId, org, account, `CAD4-${operationId}`, assignment, caseId, snapshotId]);
    await client.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)', [assignment, `cad4-${operationId}`]);
    for (const [index, id] of [account, other].entries()) await client.query(`INSERT INTO gis.dcad_parcels
      (object_id,account_id,residential_year_built,residential_area_sqft,parcel_area_sqft,land_use_category,
       classification_confidence,classification_review_reason,source_record_hash,sync_run_id,synced_at,geom)
      VALUES($1,$2,2001,2100.125,8100,'one_unit','high',NULL,$3,$4,now(),
        ST_Multi(ST_Translate(ST_GeomFromText('POLYGON((-96.9 33.1,-96.899 33.1,-96.899 33.101,-96.9 33.101,-96.9 33.1))',4326),$5,0)))`,
    [parcelIds[index], id, hash, syncBefore.last_run_id, index * 0.005]);
    await client.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type,source_record_hash,close_date,current_price,loaded_at)
      VALUES($1,$2,'closed_sale',$3,'2024-03-01',310000,now())`, [sourceId, account, hash]);
    await client.query(`INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price,source,loaded_at)
      VALUES($1,$2,$3,'2024-03-01',310000,'Synthetic CAD4 only',now())`, [saleId, sourceId, account]);
    await client.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved,loaded_at)
      VALUES($1,$2,1,1,$3,true,now())`, [linkId, sourceId, account]);
    assert.equal((await client.query(`UPDATE gis.source_sync_state SET row_count=$1
      WHERE source_key='dcad_parcels' AND last_run_id=$2 AND row_count=$3`,
    [countBefore + 2, syncBefore.last_run_id, countBefore])).rowCount, 1);
  });
  const auth = { userId: actor, organizations: [{ organizationId: org, roles: ['appraiser'] }] };
  const scope = { organization_id: org, report_file_id: reportId, assignment_file_id: assignment, account_id: account }, scopeJson = json(scope);
  const grant = { allowed: true, decision_id: 'synthetic_native_cad4_only', policy_revision: 'synthetic-cad4-v1' };
  const policyPurposes = [];
  const policy = async (_client, principal, context, purpose, options) => {
    assert.equal(principal.userId, actor); assert.equal(context.scope.organization_id, org);
    assert.equal(context.target.report_file_id, reportId); assert.equal(context.target.workflow_target_id, assignment);
    assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
    assert.equal(Object.hasOwn(purpose, 'source_projection'), false, 'CAD4 preserves the existing v2 MLS purpose');
    assert.deepEqual(options, { retention: true, exposure: 'none' }); policyPurposes.push(purpose); return grant;
  };
  try {
    const phaseOne = await tx('READ COMMITTED', async client => {
      const subjects = createCustomCohortSubjectRepository(client, scopeJson), subjectRef = await subjects.capture();
      const subject = await subjects.load(subjectRef), point = await subjects.loadRecordedPoint(subjectRef);
      assert.equal(point.status, 'represented');
      const study = { profile_id: NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1, observation_period: period, knowledge_cutoff: null };
      const body = { intent_version: 1, operation_id: operationId, actor_user_id: actor, subject_inputs: subjectRef,
        target: subject.target, effective_date: subject.effective_date, study, created_at: await time(client) };
      return { subject, subjectRef, point, study, intent: { body,
        reference: await createNeighborhoodCohortBlobRepository(client, org).put(json(body)) } };
    });
    const context = { target: { report_file_id: reportId, workflow_type: 'custom_appraisal', workflow_target_id: assignment },
      scope: { organization_id: org, appraisal_case_id: caseId, subject_snapshot_id: snapshotId, account_id: account }, effective_date: '2024-06-30' };
    const read = () => tx('REPEATABLE READ READ ONLY', async client => {
      const startedAt = await time(client), spatial = await captureNeighborhoodSpatialMembership(client, phaseOne.point.geometry_input);
      assert.equal(spatial.status, 'captured'); assert.deepEqual(spatial.account_ids, accountIds);
      const selector = prepareNeighborhoodSelectorInputV1({ profile_id: phaseOne.study.profile_id, ...context,
        selection: { id: operationId, revision: 1, source_sha256: spatial.membership_sha256 }, geometry_input: phaseOne.point.geometry_input,
        discovery: { radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
        roster: { complete: true, account_count: spatial.account_ids.length, account_ids: spatial.account_ids } });
      assert.equal(selector.status, 'prepared');
      const access = createTestCachedReadAccess({ ...context, selection: selector.selection, account_ids: spatial.account_ids,
        observation_period: period, knowledge_cutoff: null }, { auth, accessFactory: createNeighborhoodCadEvidenceReadAccess,
        authorizeMarketData: (principal, current, purpose) => policy(client, principal, current, purpose, { retention: true, exposure: 'none' }),
        resolveTransactionClosure: async () => {
          const closure = await resolveNeighborhoodCachedTransactionClosure(client,
            { selected_account_ids: spatial.account_ids, source_revision: `native-cad4:${operationId}` }, { deadline: performance.now() + 30_000 });
          assert.equal(closure.status, 'captured'); assert.deepEqual(closure.snapshot, spatial.snapshot); return closure.transaction_closure;
        } });
      const issued = await access.prepare();
      const reader = createNeighborhoodCadEvidenceSourceReader({ connect() { assert.fail('native CAD4 caller transaction owns connection'); } },
        { access: access.access, limits: { page_size: 1 } });
      const result = await reader.captureInSnapshot(client, { ...issued.request, auth,
        selection_grant: issued.selection_grant, market_grant: issued.market_grant }, { deadline: performance.now() + 30_000 });
      return { spatial, selector, reader, result, startedAt, completedAt: await time(client) };
    });
    const present = (await pool.query(`SELECT attname FROM pg_attribute
      WHERE attrelid='gis.dcad_parcels'::regclass AND attname=ANY($1::text[]) AND NOT attisdropped`, [columns])).rows.map(row => row.attname);
    if (present.length === 0) {
      const missing = await read();
      assert.equal(missing.result.status, 'incomplete'); assert.equal(missing.result.query_complete, false);
      assert.equal(missing.result.capabilities.parcels.state, 'unsupported_schema');
      assert.deepEqual([...missing.result.capabilities.parcels.missing_columns].sort(), [...columns].sort());
      checks.push('native CAD4 reader refuses missing CAD evidence columns; no successful reduced projection or relabeled mapping2 capture');
      // This is only the synthetic schema created at the top of this helper.
      await pool.query(`ALTER TABLE gis.dcad_parcels ADD COLUMN class_code text, ADD COLUMN class_description text,
        ADD COLUMN use_description text, ADD COLUMN structure_type text, ADD COLUMN built_up boolean`);
    } else assert.deepEqual(present.sort(), [...columns].sort(), 'synthetic CAD4 schema must contain all five columns together');
    for (const [index, value] of cadValues.entries()) assert.equal((await pool.query(`UPDATE gis.dcad_parcels
      SET class_code=$1,class_description=$2,use_description=$3,structure_type=$4,built_up=$5
      WHERE object_id=$6 AND account_id=$7 AND source_record_hash=$8`,
    [...columns.map(key => value[key]), parcelIds[index], [account, other][index], hash])).rowCount, 1);
    const from = sqls.length, captured = await read();
    assert.equal(captured.result.status, 'captured', JSON.stringify(captured.result.incomplete_reasons));
    assert.equal(captured.result.query_complete, true); assert.deepEqual(captured.result.snapshot, captured.spatial.snapshot);
    assert.ok(sqls.slice(from).some(sql => sql.includes('neighborhood-cache:parcels') && columns.every(key => sql.includes(key))),
      'actual mapping4 parcel SQL must execute with all five fields');
    assert.throws(() => consumeNeighborhoodCachedAcquisition(captured.reader, structuredClone(captured.result)), { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' });
    originalAcquisition = consumeNeighborhoodCachedAcquisition(captured.reader, captured.result);
    assert.equal(JSON.parse(originalAcquisition.compact_metadata_json).mapping_version, 4);
    assert.deepEqual(policyPurposes.at(-1), describeNeighborhoodCachedMarketDataPurpose(originalAcquisition.captured_query_request));
    assert.equal(Object.hasOwn(describeNeighborhoodCachedMarketDataPurpose(originalAcquisition.captured_query_request), 'source_projection'), false);
    const sources = captured.result.source_capture.sources;
    const parcelRows = sources.filter(source => source.payload.projection.definition.role === 'parcels').flatMap(source => source.payload.records);
    assert.equal(parcelRows.length, 2);
    for (const row of parcelRows) {
      const index = parcelIds.indexOf(row.data.raw_projection.object_id); assert.ok(index >= 0);
      assert.deepEqual(Object.fromEntries(columns.map(key => [key, row.data.raw_projection[key]])), cadValues[index]);
      assert.equal(row.data.data.housing_type, null); assert.equal(row.data.data.historical_support, 'unknown');
    }
    for (const source of sources) {
      assert.equal(source.payload.projection.definition.mapping_version, 4);
      if (['parcels', 'accounts', 'transactions', 'sale_links'].includes(source.payload.projection.definition.role)) {
        for (const row of source.payload.records) assert.equal(row.data.data.cached_mapping_version, 4);
      }
      if (source.payload.projection.definition.role === 'transactions') for (const row of source.payload.records) {
        assert.equal(row.data.raw_projection.sale_price, '310000');
        assert.equal(Object.hasOwn(row.data.raw_projection, 'source_raw_witness'), false);
        assert.equal(row.data.data.market_eligible, null);
      }
    }
    savedContext = await tx('READ COMMITTED', async client => {
      assert.equal((await createCustomCohortSubjectRepository(client, scopeJson).compareCurrent(phaseOne.subjectRef)).status, 'matched');
      const refs = await persistCustomCohortCaptureInputs(client, scopeJson, prepareCustomCohortCaptureInputs({
        acquisition: originalAcquisition, spatial: captured.spatial, subject: phaseOne.subject, subject_reference: phaseOne.subjectRef,
        selector: captured.selector, study: phaseOne.study, acquisition_intent: phaseOne.intent,
        started_at: captured.startedAt, completed_at: captured.completedAt }));
      return createCustomCohortContextRepository(client, scopeJson).put(json({ context_version: 1,
        context_id: operationId, context_revision: '1', target: { ...context.target, ...context.scope, snapshot_version: phaseOne.subject.target.snapshot_version },
        effective_date: context.effective_date, ...refs }));
    });
    checks.push('native original mapping4 RR/RO capture retains all five CAD literals and SQL NULL/false; unchanged v2 sales meaning; bounded full context retention commits');
  } finally {
    // Validate every exact synthetic target before deletion. No original account,
    // source10/sale100/link11-12/parcel1-2, organization or report is changed.
    await tx('READ COMMITTED', async client => {
      assert.deepEqual((await client.query('SELECT object_id::text,account_id,source_record_hash FROM gis.dcad_parcels WHERE object_id=ANY($1::bigint[]) ORDER BY object_id', [parcelIds])).rows,
        parcelIds.map((object_id, index) => ({ object_id, account_id: [account, other][index], source_record_hash: hash })));
      assert.deepEqual((await client.query('SELECT id::text,primary_account_id,source_record_hash FROM core.sales_source_records WHERE id=$1', [sourceId])).rows,
        [{ id: sourceId, primary_account_id: account, source_record_hash: hash }]);
      assert.deepEqual((await client.query('SELECT id::text,source_record_id::text,account_id FROM core.sales WHERE id=$1', [saleId])).rows,
        [{ id: saleId, source_record_id: sourceId, account_id: account }]);
      assert.deepEqual((await client.query('SELECT id::text,source_record_id::text,account_id FROM core.sale_parcels WHERE id=$1', [linkId])).rows,
        [{ id: linkId, source_record_id: sourceId, account_id: account }]);
      assert.deepEqual((await client.query("SELECT to_jsonb(s) AS value FROM gis.source_sync_state s WHERE source_key='dcad_parcels'")).rows[0].value,
        { ...syncBefore, row_count: countBefore + 2 });
      for (const [sql, values, count] of [
        ['DELETE FROM core.sale_parcels WHERE id=$1 AND source_record_id=$2 AND account_id=$3', [linkId, sourceId, account], 1],
        ['DELETE FROM core.sales WHERE id=$1 AND source_record_id=$2 AND account_id=$3', [saleId, sourceId, account], 1],
        ['DELETE FROM core.sales_source_records WHERE id=$1 AND primary_account_id=$2 AND source_record_hash=$3', [sourceId, account, hash], 1],
        ['DELETE FROM gis.dcad_parcels WHERE object_id=ANY($1::bigint[]) AND account_id=ANY($2::text[]) AND source_record_hash=$3', [parcelIds, accountIds, hash], 2],
      ]) assert.equal((await client.query(sql, values)).rowCount, count);
      assert.equal((await client.query("UPDATE gis.source_sync_state SET row_count=$1 WHERE source_key='dcad_parcels' AND last_run_id=$2 AND row_count=$3",
        [countBefore, syncBefore.last_run_id, countBefore + 2])).rowCount, 1);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM gis.dcad_parcels')).rows[0].n, countBefore);
      assert.deepEqual((await client.query("SELECT to_jsonb(s) AS value FROM gis.source_sync_state s WHERE source_key='dcad_parcels'")).rows[0].value, syncBefore);
    });
  }
  const reopened = await tx('READ COMMITTED', async client => {
    const header = await createCustomCohortContextRepository(client, scopeJson).get(json(savedContext.context_ref));
    return loadCustomCohortCaptureInputs(client, scopeJson,
      Object.fromEntries(['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [key, header.body[key]])));
  });
  assert.deepEqual(reopened.retained_inputs.acquisition.capture_result, originalAcquisition.capture_result);
  const owner = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: policy }), from = sqls.length;
  const replay = await owner.capture({ auth, accountId: account, assignmentFileId: assignment, operationId, observationPeriod: period });
  assert.equal(replay.reused, true); assert.deepEqual(replay.context_ref, savedContext.context_ref);
  const preview = await owner.preview({ auth, accountId: account, assignmentFileId: assignment, contextRef: savedContext.context_ref,
    selection: { revision: 1, pockets: [{ id: 'native-cad4', label: 'Synthetic CAD4 retained stock', account_ids: accountIds }] } });
  assert.equal(preview.preview.selected.stock.member_count, 2);
  assert.equal(preview.preview.selected.stock.metrics.gla_sqft.median, 2100.125);
  assert.equal(preview.preview.selected.transactions.metrics.recorded_total_price.median, 310000);
  assert.equal(preview.parcel_map.status, 'available'); assert.equal(preview.apply.status, 'blocked');
  assert.ok(!sqls.slice(from).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)), 'replay/preview must use retained originals after test source removal');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1', [assignment])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.custom_neighborhood_acceptances WHERE assignment_file_id=$1', [assignment])).rows[0].n, 0);
  checks.push('native mapping4 context reopens exact originals after owned source cleanup; default owner replays retained version4 without capture activation or report writes');
}
