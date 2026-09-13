import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';
import { checkedNeighborhoodDatabaseUrl, NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from '../fixtures/neighborhoodCachedSourceSchemaFixture.js';
import { createTestCachedReadAccess } from '../fixtures/neighborhoodCachedReadAccessFixture.js';
import { createNeighborhoodCadEvidenceReadAccess, createNeighborhoodCombinedEvidenceReadAccess } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createNeighborhoodDenseCadEvidenceSourceReader, createNeighborhoodDenseCombinedEvidenceSourceReader,
  consumeNeighborhoodCachedAcquisition } from '../../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { captureNeighborhoodSpatialMembershipStream, captureNeighborhoodSpatialMembershipCompact } from '../../src/services/neighborhoodAssessment/cachedSpatialMembership.js';
import { resolveNeighborhoodCachedTransactionClosure } from '../../src/services/neighborhoodAssessment/cachedTransactionClosureReader.js';
import { prepareNeighborhoodSelectorInputV1, NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1 } from '../../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { createCustomCohortSubjectRepository } from '../../src/services/neighborhoodAssessment/customCohortSubjectRepository.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { prepareCustomCohortCaptureInputsBatched, persistCustomCohortCaptureInputs, loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';
import { buildCustomCohortIndexedObservationPreviewBatched } from '../../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { buildCustomCohortParcelMapBatched } from '../../src/services/neighborhoodAssessment/customCohortParcelMap.js';
import { presentCustomCohortPreview } from '../../src/services/neighborhoodAssessment/customCohortPreviewPresentation.js';
import { buildCustomCohortSelectionCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { buildCustomCohortPocketCatalog, presentCustomCohortPocketCatalog } from '../../src/services/neighborhoodAssessment/customCohortPocketCatalog.js';
import { customCohortOpeningSelection, CUSTOM_COHORT_OPENING_RESPONSE_BYTES } from '../../src/services/neighborhoodAssessment/customCohortOpeningPreview.js';
import { buildCustomCohortPocketRecommendationBatched } from '../../src/services/neighborhoodAssessment/customCohortPocketRecommendation.js';
import { presentCustomCohortPocketRecommendation } from '../../src/services/neighborhoodAssessment/customCohortPocketRecommendationPresentation.js';
import { deriveCustomCohortRecordedProximity } from '../../src/services/neighborhoodAssessment/customCohortRecordedProximity.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';

// Test-only dispatch. These are the actual issuer/reader/encoder functions, not
// another source or persistence implementation. Defaults retain the old fixture.
export function neighborhoodDenseCaptureProfile(sourceMode = 'cad4', spatialEncoding = 'expanded') {
  assert.ok(['cad4', 'combined-witness2-v1'].includes(sourceMode), 'dense_source_mode_invalid');
  assert.ok(['expanded', 'fixed_fields_v1'].includes(spatialEncoding), 'dense_spatial_encoding_invalid');
  const combined = sourceMode === 'combined-witness2-v1';
  const interpretation = combined ? getCustomCohortReportedSaleWitnessV2Profile() : null;
  return Object.freeze({ sourceMode, spatialEncoding, mappingVersion: combined ? 5 : 4, interpretation,
    accessFactory: combined ? createNeighborhoodCombinedEvidenceReadAccess : createNeighborhoodCadEvidenceReadAccess,
    readerFactory: combined ? createNeighborhoodDenseCombinedEvidenceSourceReader : createNeighborhoodDenseCadEvidenceSourceReader,
    captureSpatial: spatialEncoding === 'fixed_fields_v1' ? captureNeighborhoodSpatialMembershipCompact : captureNeighborhoodSpatialMembershipStream,
    intentFields: Object.freeze({ intent_version: combined ? 3 : 1,
      ...(combined ? { reported_sale_interpretation: interpretation.profile_ref } : {}) }),
    captureFields: Object.freeze(combined ? { reported_sale_interpretation: interpretation.profile_ref } : {}),
  });
}

// Explicit opt-in native synthetic measurement. Create a new migrated *_test
// database before capture, then run reopen in a SEPARATE process. No live source,
// report Apply, worker activation or generalized cleanup occurs here.
export async function measureNeighborhoodDenseCapture({ connectionString, phase, retained, beforeWork = async () => {}, currentEffectiveDate = false,
  sourceMode = 'cad4', spatialEncoding = 'expanded', onReportedDiagnostic }) {
  const profile = neighborhoodDenseCaptureProfile(sourceMode, spatialEncoding);
  const target = checkedNeighborhoodDatabaseUrl(connectionString, process.env.NODE_ENV);
  assert.ok(['capture', 'reopen', 'preview', 'opening', 'recommendation', 'reported'].includes(phase));
  assert.equal(typeof currentEffectiveDate, 'boolean');
  assert.ok(onReportedDiagnostic === undefined || typeof onReportedDiagnostic === 'function');
  const pool = new pg.Pool({ connectionString: target.connectionString, max: 2, connectionTimeoutMillis: 3000,
    statement_timeout: 5000, application_name: 'synthetic_dense_capture_memory' });
  const stages = [], started = performance.now(), delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const stage = name => stages.push({ name, elapsed_ms: performance.now() - started, ...process.memoryUsage() });
  const tx = async (mode, execute) => {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${mode}`);
      await client.query("SET LOCAL timezone='UTC'; SET LOCAL jit=off; SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
      const result = await execute(client); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  };
  const time = async client => (await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value`)).rows[0].value;
  try {
    const probe = await pool.connect();
    try { verifyNeighborhoodCiConnection((await probe.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0], probe.connection.stream.remoteAddress, target.databaseName); }
    finally { probe.release(); }
    stage('connected');
    let result;
    if (phase !== 'capture') {
      assert.equal(retained.database, target.databaseName);
      await beforeWork(); stage('web_ready');
      const opened = await tx('REPEATABLE READ READ ONLY', client => loadCustomCohortCaptureInputs(client, json(retained.scope), retained.refs));
      assert.deepEqual(opened.summary, retained.summary); assert.deepEqual(opened.refs, retained.refs);
      stage('reopened'); result = { summary: opened.summary };
      if (profile.interpretation) {
        const { checkDenseWitness2Capture } = await import('./customCohortDenseReportedChecks.js');
        assert.equal(retained.source_mode, sourceMode); assert.equal(retained.spatial_encoding, spatialEncoding);
        result.combined_evidence = checkDenseWitness2Capture(opened.retained_inputs);
        assert.deepEqual(result.combined_evidence, retained.combined_evidence);
        assert.equal(opened.retained_inputs.spatial.parcel_encoding ?? 'expanded', spatialEncoding);
        // The actual scoped loader already verifies the original definition
        // text/hash before source pages. Check the retained graph shape too.
        await tx('REPEATABLE READ READ ONLY', async client => {
          const store = createNeighborhoodCohortBlobRepository(client, retained.scope.organization_id);
          const study = JSON.parse(await store.get(retained.refs.study_input.content_sha256, retained.refs.study_input.canonical_utf8_bytes));
          assert.equal(study.study_input_version, 2);
          assert.deepEqual(study.reported_sale_interpretation, { profile_ref: profile.interpretation.profile_ref,
            definition_blob: profile.interpretation.definition_blob.ref });
          const definition = profile.interpretation.definition_blob;
          assert.equal(await store.get(definition.ref.content_sha256, definition.ref.canonical_utf8_bytes), definition.canonical_json);
        });
      } else assert.equal(Object.hasOwn(opened.retained_inputs, 'reported_sale_interpretation'), false,
        'do not reopen an interpreted fixture through a legacy capacity run');
      if (phase === 'reported') {
        const { checkDenseReportedPreparation } = await import('./customCohortDenseReportedChecks.js');
        result.reported = await checkDenseReportedPreparation({ retained: opened.retained_inputs,
          query: (text, values) => pool.query(text, values), onDiagnostic: onReportedDiagnostic });
        stage('reported_preparation');
      }
      if (phase === 'preview' || phase === 'opening' || phase === 'recommendation') {
        const context_ref = { context_id: randomUUID(), context_revision: '1', context_sha256: 'a'.repeat(64) };
        const account_ids = opened.retained_inputs.spatial.account_ids;
        let selection = { revision: 1, pockets: [{ id: 'synthetic-all', label: 'Synthetic complete area', account_ids }] };
        let openingCatalog, recommendation;
        if (phase === 'opening' || phase === 'recommendation') {
          const empty = await buildCustomCohortIndexedObservationPreviewBatched({ context_ref, retained_inputs: opened.retained_inputs,
            selection: { revision: 1, pockets: [] } });
          openingCatalog = presentCustomCohortPocketCatalog({ catalog: buildCustomCohortPocketCatalog({
            retained_inputs: opened.retained_inputs, preview: empty, catalog_version: 2 }), preview: empty,
            expected: { context_ref, selection_revision: 1 } });
          const ids = [...openingCatalog.pockets.map(p => p.id), ...(openingCatalog.unassigned.member_count ? ['discovery:unassigned'] : [])];
          selection = customCohortOpeningSelection(openingCatalog, ids, 1);
          stage('opening_catalog');
          if (phase === 'recommendation') {
            // Performance-only CURRENT observation diagnostic. This intentionally
            // does not invoke the historical report/recommendation owner or claim
            // that these later synthetic CAD observations apply retrospectively.
            // Exercise the actual catalog's optional proximity path over the
            // complete dense retained graph. Its independent native geometry
            // cap must leave proximity unknown, not discard the whole catalog.
            const recorded_proximity = await tx('REPEATABLE READ READ ONLY', client =>
              deriveCustomCohortRecordedProximity(client.query.bind(client), { context_ref, retained_inputs: opened.retained_inputs }));
            assert.equal(recorded_proximity.status, 'unavailable');
            assert.equal(recorded_proximity.reason, 'capacity_exceeded');
            assert.equal(recorded_proximity.counts.accounts, account_ids.length);
            const diagnostic = await buildCustomCohortPocketRecommendationBatched({ context_ref, recorded_proximity,
              retained_inputs: opened.retained_inputs, catalog_version: 2, observation_preview: empty,
              selection: { revision: 1, included_recorded_group_ids: [] } });
            recommendation = presentCustomCohortPocketRecommendation({ recommendation: diagnostic, catalog: openingCatalog,
              expected: { context_ref, selection_revision: 1 } });
            assert.equal(recommendation.pockets.length, openingCatalog.pockets.length + (openingCatalog.unassigned.member_count ? 1 : 0));
            assert.equal(recommendation.all.member_count, account_ids.length);
            result.recommendation = { groups: recommendation.pockets.length, accounts: recommendation.all.member_count,
              bytes: Buffer.byteLength(JSON.stringify(recommendation)), apply: recommendation.apply.status };
            stage('full_roster_recommendation');
          }
        }
        const preview = await buildCustomCohortIndexedObservationPreviewBatched({ context_ref, retained_inputs: opened.retained_inputs, selection });
        stage('statistics');
        const catalog = buildCustomCohortSelectionCatalog({ retained_inputs: opened.retained_inputs, preview, catalog_version: 2 });
        assert.equal(catalog.catalog_complete, true); assert.equal(catalog.pockets.length, 887);
        assert.deepEqual([...catalog.pockets.flatMap(p => p.account_ids), ...catalog.unassigned.account_ids].sort(), [...account_ids].sort());
        stage('catalog');
        const parcel_map = await buildCustomCohortParcelMapBatched({ retained_inputs: opened.retained_inputs, selected_account_ids: account_ids });
        assert.equal(parcel_map.status, 'available', parcel_map.reason); assert.equal(parcel_map.counts.parcels, retained.summary.parcel_count);
        assert.equal(parcel_map.counts.coordinates, retained.summary.parcel_count * 11);
        assert.ok(parcel_map.counts.geojson_bytes > 16_000_000, 'exercise dense geometry above the former display cap');
        assert.equal(preview.all.stock.member_count, account_ids.length); assert.equal(preview.selected.stock.member_count, account_ids.length);
        const summary = presentCustomCohortPreview({ preview, expected: { context_ref, selection_revision: 1 } });
        const bytes = Buffer.byteLength(JSON.stringify(openingCatalog
          ? { catalog: openingCatalog, ...(recommendation ? { recommendation } : {}), initial_preview: { summary, parcel_map } } : { summary, parcel_map }));
        if (openingCatalog) assert.ok(bytes <= CUSTOM_COHORT_OPENING_RESPONSE_BYTES);
        stage('presented'); result = { ...result, preview_bytes: bytes, preview_counts: {
          all_accounts: preview.all.stock.member_count, selected_accounts: preview.selected.stock.member_count,
          all_transactions: preview.all.transactions.member_count, mapped_parcels: parcel_map.counts.parcels,
          coordinates: parcel_map.counts.coordinates, geojson_bytes: parcel_map.counts.geojson_bytes,
          recorded_groups: catalog.pockets.length, catalog_bytes: Buffer.byteLength(JSON.stringify(catalog)),
          internal_bytes_bound: preview.work.output_utf8_bytes_bound } };
      }
    } else {
      await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA); // Refuses an existing GIS schema.
      const org = randomUUID(), actor = randomUUID(), caseId = randomUUID(), snapshotId = randomUUID(), reportId = randomUUID(), run = randomUUID(), operation = randomUUID();
      const account = 'DENSE-000000', parcelCount = 38_347, accountCount = 38_106;
      // Opt-in report tests create a NEW source capture at today's database
      // date. Never relabel an older retained subject to pass the stock gate.
      const effectiveDate = currentEffectiveDate
        ? (await pool.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS value")).rows[0].value
        : '2024-06-30';
      // Ten-edge native-valid rings with realistic coordinate precision: the
      // old five-point rectangles under-tested dense retained map size.
      const ring = Array.from({ length: 10 }, (_, i) => {
        const angle = i * Math.PI / 5;
        return `${-96.71234567890123 + Math.cos(angle) * .00002} ${32.81234567890123 + Math.sin(angle) * .00002}`;
      });
      const geometry = `POLYGON((${[...ring, ring[0]].join(',')}))`;
      await tx('READ COMMITTED', async client => {
        await client.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic dense area','Synthetic dense area')", [org]);
        await client.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic actor')", [actor, `${actor}@example.test`]);
        await client.query(`INSERT INTO core.accounts(account_id,county,address,city,subdivision)
          SELECT 'DENSE-'||lpad(n::text,6,'0'),'Dallas','Synthetic address '||n,'Synthetic','Synthetic Plat '||(n%887)
          FROM generate_series(0,$1::int-1) n`, [accountCount]);
        await client.query('INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,$4)', [caseId, org, account, effectiveDate]);
        const location = { account_id: account, latitude: 32.8, longitude: -96.7, source: 'dcad_parcel_query', precision: 'parcel_centroid',
          status: 'matched', confidence: 'high', review_required: false, review_reason: null, match_method: 'parcel_id', source_parcel_id: account,
          feature_count: 1, metadata: { address_agreement: true }, geocoded_at: '2020-01-01T00:00:00.000Z', source_updated_at: null };
        await client.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
          VALUES($1,$2,1,$3,$4::jsonb)`, [snapshotId, caseId, effectiveDate, JSON.stringify({ custom_property_snapshot: {
          account: { account_id: account }, improvement: { living_area_sqft: 2000 }, location } })]);
        const assignment = (await client.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id)
          VALUES($1,$2,$3,$4,$4) RETURNING id::text`, [org, account, `DENSE-${operation}`, actor])).rows[0].id;
        await client.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
          VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [reportId, org, account, `DENSE-${operation}`, assignment, caseId, snapshotId]);
        await client.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)', [assignment, `dense-${operation}`]);
        result = { scope: { organization_id: org, report_file_id: reportId, assignment_file_id: assignment, account_id: account } };
        await client.query("INSERT INTO gis.source_sync_runs(id,source_key,mode,status,started_at,completed_at) VALUES($1,'dcad_parcels','full','complete',now()-interval '1 second',now())", [run]);
        await client.query("INSERT INTO gis.source_sync_state(source_key,status,row_count,last_run_id,last_success_at) VALUES('dcad_parcels','current',$1,$2,now())", [parcelCount, run]);
        await client.query(`INSERT INTO gis.dcad_parcels(object_id,account_id,residential_year_built,residential_area_sqft,parcel_area_sqft,current_market_value,
          land_use_category,classification_confidence,class_code,class_description,use_description,structure_type,built_up,source_record_hash,sync_run_id,synced_at,geom)
          SELECT n+1,'DENSE-'||lpad((n%$2::int)::text,6,'0'),1950+n%60,1200+n%1500,6000+n%1000,250000+n,
            'one_unit','high','1','SINGLE FAMILY RESIDENCES',repeat('Synthetic retained source. ',3),'Synthetic literal',true,repeat('a',64),$3,now(),
            ST_Multi(ST_Translate(ST_GeomFromText($4,4326),(n%200)*0.0001,(n/200)*0.0001))
          FROM generate_series(0,$1::int-1) n`, [parcelCount, accountCount, run, geometry]);
        await client.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type,source_record_hash,close_date,current_price,loaded_at)
          SELECT n+1,'DENSE-'||lpad(n::text,6,'0'),'closed_sale',repeat('b',64),'2024-03-01',250000+n,now()
          FROM generate_series(0,$1::int-1) n WHERE n%37=0`, [accountCount]);
        if (profile.interpretation) {
          const { denseWitness2FixtureCases } = await import('./customCohortDenseReportedChecks.js');
          const cases = denseWitness2FixtureCases();
          // All 1,030 sources participate (103 of each fixed case). These are
          // literal synthetic payloads, not an NTREIS dictionary or grant.
          // Surviving typed values deliberately disagree with the witnesses.
          await client.query(`UPDATE core.sales_source_records SET
            raw_payload=$1::jsonb -> (((id-1)/37)%10)::int,
            source_name='Synthetic combined witness capacity',source_filename='dense-witness2-fixture.csv',
            source_sha256=repeat('c',64),source_row_number=((id-1)/37+2)::int,
            mls_status='Active',living_area=9999,lot_size_area=8888,year_built=1980,days_on_market=99`,
          [JSON.stringify(cases.map(item => item.raw))]);
        }
        await client.query(`INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price,source,loaded_at)
          SELECT id,id,primary_account_id,close_date,current_price,'Synthetic dense',now() FROM core.sales_source_records`);
        await client.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved,loaded_at)
          SELECT id,id,1,1,primary_account_id,true,now() FROM core.sales_source_records`);
      });
      stage('seeded');
      await beforeWork(); stage('web_ready');
      const scopeJson = json(result.scope), period = { start_date: '2023-07-01', end_date: '2024-06-30' };
      const first = await tx('READ COMMITTED', async client => {
        const subjects = createCustomCohortSubjectRepository(client, scopeJson), subjectRef = await subjects.capture();
        const subject = await subjects.load(subjectRef), point = await subjects.loadRecordedPoint(subjectRef);
        assert.equal(point.status, 'represented');
        const study = { profile_id: NEIGHBORHOOD_SELECTOR_INPUT_PROFILE_V1, observation_period: period, knowledge_cutoff: null };
        const body = { ...profile.intentFields, operation_id: operation, actor_user_id: actor, subject_inputs: subjectRef,
          target: subject.target, effective_date: subject.effective_date, study, created_at: await time(client) };
        return { subject, subjectRef, point, study, intent: { body, reference: await createNeighborhoodCohortBlobRepository(client, org).put(json(body)) } };
      });
      const context = { target: { report_file_id: reportId, workflow_type: 'custom_appraisal', workflow_target_id: result.scope.assignment_file_id },
        scope: { organization_id: org, appraisal_case_id: caseId, subject_snapshot_id: snapshotId, account_id: account }, effective_date: effectiveDate };
      const read = await tx('REPEATABLE READ READ ONLY', async client => {
        const startedAt = await time(client), spatial = await profile.captureSpatial(client, first.point.geometry_input);
        assert.equal(spatial.status, 'captured', spatial.reason); assert.equal(spatial.parcels.length, parcelCount); assert.equal(spatial.account_ids.length, accountCount);
        stage('spatial');
        const selector = prepareNeighborhoodSelectorInputV1({ profile_id: first.study.profile_id, ...context,
          selection: { id: operation, revision: 1, source_sha256: spatial.membership_sha256 }, geometry_input: first.point.geometry_input,
          discovery: { radius_metres: '4828.032', distance_semantics: 'postgis_geography_spheroid_v1', parcel_predicate: 'all_intersecting_parcels' },
          roster: { complete: true, account_count: accountCount, account_ids: spatial.account_ids } });
        assert.equal(selector.status, 'prepared');
        const access = createTestCachedReadAccess({ ...context, selection: selector.selection, account_ids: spatial.account_ids,
          observation_period: period, knowledge_cutoff: null }, { accessFactory: profile.accessFactory,
          resolveTransactionClosure: async () => {
            const closure = await resolveNeighborhoodCachedTransactionClosure(client, { selected_account_ids: spatial.account_ids, source_revision: 'synthetic-native-dense-v1' });
            assert.equal(closure.status, 'captured'); assert.deepEqual(closure.snapshot, spatial.snapshot); return closure.transaction_closure;
          } });
        const issued = await access.prepare(), reader = profile.readerFactory({ connect() { assert.fail('caller owns snapshot'); } }, { access: access.access });
        const captured = await reader.captureInSnapshot(client, { ...issued.request, auth: access.auth,
          selection_grant: issued.selection_grant, market_grant: issued.market_grant });
        assert.equal(captured.status, 'captured', JSON.stringify({ reasons: captured.incomplete_reasons, counts: captured.counts })); assert.deepEqual(captured.snapshot, spatial.snapshot);
        return { acquisition: consumeNeighborhoodCachedAcquisition(reader, captured), spatial, selector, startedAt, completedAt: await time(client) };
      });
      stage('captured');
      const captureInput = { acquisition: read.acquisition, spatial: read.spatial,
        subject: first.subject, subject_reference: first.subjectRef, selector: read.selector, study: first.study,
        acquisition_intent: first.intent, started_at: read.startedAt, completed_at: read.completedAt, ...profile.captureFields };
      const prepared = await prepareCustomCohortCaptureInputsBatched(captureInput);
      stage('prepared');
      const refs = await tx('READ COMMITTED', client => persistCustomCohortCaptureInputs(client, scopeJson, prepared));
      stage('persisted'); result = { ...result, refs, summary: prepared.summary, source_counts: read.acquisition.capture_result.counts };
      if (profile.interpretation) {
        const { checkDenseWitness2Capture } = await import('./customCohortDenseReportedChecks.js');
        result.combined_evidence = checkDenseWitness2Capture(captureInput);
      }
    }
    return { database: target.databaseName, phase, ...result, stages, elapsed_ms: performance.now() - started,
      ...(profile.interpretation ? { evidence_pipeline_only: true, source_mode: sourceMode, spatial_encoding: spatialEncoding } : {}),
      max_rss_kib: process.resourceUsage().maxRSS, event_loop_p99_ms: delay.percentile(99) / 1e6,
      event_loop_max_ms: delay.max / 1e6, production_connections: 0 };
  } finally { delay.disable(); await pool.end(); }
}
