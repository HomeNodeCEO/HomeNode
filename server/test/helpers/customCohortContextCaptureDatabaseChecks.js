import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import express from 'express';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomNeighborhoodCohortRouter } from '../../src/modules/accounts/customNeighborhoodCohortRouter.js';
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
    assert.equal(pool.waitingCount, 0);
    return { checks };
  } finally { await pool.end(); }
}
