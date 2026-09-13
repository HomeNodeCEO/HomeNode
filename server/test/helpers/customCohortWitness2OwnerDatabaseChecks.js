import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { createNeighborhoodCohortBlobRepository } from '../../src/services/neighborhoodAssessment/cohortEvidenceBlobRepository.js';
import { getCustomCohortReportedSaleWitnessV2Profile } from '../../src/services/neighborhoodAssessment/customCohortReportedSaleWitnessV2.js';
import { describeNeighborhoodCombinedEvidenceMarketDataPurpose } from '../../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { CACHED_CAD_EVIDENCE_FIELDS } from '../../src/services/neighborhoodAssessment/cachedRowMappingsV4.js';
import { CACHED_SALE_WITNESS_V2_VERSION, CACHED_SALE_WITNESS_V2_FIELDS, CACHED_SALE_WITNESS_V2_SQL,
  prepareCachedSaleWitnessV2 } from '../../src/services/neighborhoodAssessment/cachedSaleWitnessV2.js';
import { DENSE_CAD_CACHE_READER_LIMITS } from '../../src/services/neighborhoodAssessment/denseCadCapturePolicy.js';
import { canonicalAssessmentJson as json } from '../../src/services/neighborhoodAssessment/contract.js';

const dependencies = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const sourceRead = sql => /neighborhood-(cache|membership|closure):/.test(sql);
const sourceRows = (acquisition, role) => acquisition.capture_result.source_capture.sources
  .filter(source => source.payload.projection.definition.role === role).flatMap(source => source.payload.records);

/** Continuation of the disposable native coordinator fixture, before its later
 * subject edits. Only the real owner creates new evidence/contexts; this helper
 * never rewrites a source, relabels an old capture, or saves report state.
 * SQL-null source payloads remain SQL-null; scalar witness parity is separate.
 */
export async function runCustomCohortWitness2OwnerDatabaseChecks({ pool, auth, scope, grant, legacyRequest, legacyResult }) {
  const checks = [], calls = [], purposes = [];
  const scopeJson = json(scope), profile = getCustomCohortReportedSaleWitnessV2Profile();
  const projection = { id: 'cached-combined-evidence-v1', mapping_version: 5,
    witness_version: CACHED_SALE_WITNESS_V2_VERSION, fields: [...CACHED_SALE_WITNESS_V2_FIELDS] };
  const observed = { async connect() {
    const client = await pool.connect();
    return { release: error => client.release(error), async query(statement, values) {
      calls.push(typeof statement === 'string' ? statement : statement.text);
      return client.query(statement, values);
    } };
  } };
  const checkPurpose = (principal, context, purpose, options, combined = true) => {
    assert.equal(principal.userId, auth.userId);
    assert.equal(context.scope.organization_id, scope.organization_id);
    assert.equal(context.scope.account_id, scope.account_id);
    assert.deepEqual(context.target, { report_file_id: scope.report_file_id,
      workflow_type: 'custom_appraisal', workflow_target_id: scope.assignment_file_id });
    assert.deepEqual(options, { retention: true, exposure: 'none' });
    assert.equal(purpose.event_date_scope, 'all_available_dates_for_seeded_transactions');
    if (combined) assert.deepEqual(purpose.source_projection, projection);
    else assert.equal(Object.hasOwn(purpose, 'source_projection'), false);
  };
  const policy = async (_client, principal, context, purpose, options) => {
    checkPurpose(principal, context, purpose, options);
    purposes.push(purpose); return grant;
  };
  const owner = createCustomCohortContextCapture({ pool: observed, authorizeMarketData: policy,
    sourceMode: 'combined-witness2-v1' });
  const load = async reference => {
    const client = await pool.connect();
    let opened = false, discard;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); opened = true;
      const header = await createCustomCohortContextRepository(client, scopeJson).get(json(reference));
      assert.ok(header);
      const retained = await loadCustomCohortCaptureInputs(client, scopeJson,
        Object.fromEntries(dependencies.map(key => [key, header.body[key]])));
      const blobs = createNeighborhoodCohortBlobRepository(client, scope.organization_id);
      const studyText = await blobs.get(header.body.study_input.content_sha256, header.body.study_input.canonical_utf8_bytes);
      const study = JSON.parse(studyText);
      const definition = study.reported_sale_interpretation?.definition_blob;
      const definitionText = definition ? await blobs.get(definition.content_sha256, definition.canonical_utf8_bytes) : null;
      await client.query('COMMIT'); opened = false;
      return { retained, study, studyText, definitionText };
    } finally {
      if (opened) try { await client.query('ROLLBACK'); } catch (error) { discard = error; }
      client.release(discard);
    }
  };
  const reportState = async () => (await pool.query(`SELECT
    (SELECT count(*)::int FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1) AS sections,
    (SELECT count(*)::int FROM app.custom_appraisal_workfile_section_history WHERE assignment_file_id=$1) AS history,
    (SELECT count(*)::int FROM app.custom_neighborhood_acceptances WHERE assignment_file_id=$1) AS acceptances,
    (SELECT count(*)::int FROM app.custom_appraisal_signed_snapshots WHERE assignment_file_id=$1) AS signatures`,
  [scope.assignment_file_id])).rows[0];
  const contextCount = async operationId => (await pool.query(`SELECT count(*)::int AS n
    FROM app.neighborhood_custom_cohort_contexts WHERE organization_id=$1 AND context_id=$2`,
  [scope.organization_id, operationId])).rows[0].n;
  const beforeReport = await reportState(), legacy = await load(legacyResult.context_ref);
  assert.equal(JSON.parse(legacy.retained.retained_inputs.acquisition.compact_metadata_json).mapping_version, 4);
  assert.equal(legacy.retained.acquisition_intent.body.intent_version, 1);
  assert.equal(legacy.study.study_input_version, 1);
  assert.equal(Object.hasOwn(legacy.study, 'reported_sale_interpretation'), false);

  const request = { ...legacyRequest, operationId: randomUUID() };
  const result = await owner.capture(request);
  assert.equal(result.status, 'registered'); assert.equal(result.reused, false);
  assert.equal(result.source_query_complete, true);
  assert.deepEqual(result.discovery, legacyResult.discovery);
  assert.equal(await contextCount(request.operationId), 1);
  assert.equal(purposes.length, 2, 'expanded source grant is checked before reads and before registration');
  const capturedSql = [...calls];
  assert.deepEqual(capturedSql.filter(sql => sql.startsWith('BEGIN')), [
    'BEGIN ISOLATION LEVEL READ COMMITTED', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'BEGIN ISOLATION LEVEL READ COMMITTED',
  ]);
  assert.ok(capturedSql.some(sql => sql.includes('neighborhood-cache:parcels')
    && CACHED_CAD_EVIDENCE_FIELDS.every(field => sql.includes(field))));
  assert.ok(capturedSql.some(sql => sql.includes('neighborhood-cache:transactions')
    && sql.includes(CACHED_SALE_WITNESS_V2_SQL) && sql.includes('src.mls_status AS source_mls_status')
    && sql.includes('src.source_row_number')), 'actual owner source SQL must read witness2, not relabel CAD4');
  const saved = await load(result.context_ref), input = saved.retained.retained_inputs, acquisition = input.acquisition;
  const compact = JSON.parse(acquisition.compact_metadata_json);
  assert.equal(compact.mapping_version, 5); assert.deepEqual(compact.limits, DENSE_CAD_CACHE_READER_LIMITS);
  assert.equal(acquisition.provenance, 'original_cached_reader_invocation');
  assert.equal(acquisition.authority, 'not_established');
  assert.deepEqual(purposes, Array(2).fill(describeNeighborhoodCombinedEvidenceMarketDataPurpose(acquisition.captured_query_request)));
  assert.equal(saved.retained.acquisition_intent.body.intent_version, 3);
  assert.deepEqual(saved.retained.acquisition_intent.body.reported_sale_interpretation, profile.profile_ref);
  assert.equal(saved.study.study_input_version, 2);
  assert.deepEqual(saved.study.reported_sale_interpretation,
    { profile_ref: profile.profile_ref, definition_blob: profile.definition_blob.ref });
  assert.equal(saved.definitionText, profile.definition_blob.canonical_json);
  assert.deepEqual(input.reported_sale_interpretation, profile.profile_ref);
  for (const source of acquisition.capture_result.source_capture.sources) {
    assert.equal(source.payload.projection.definition.mapping_version, 5);
    if (['parcels', 'accounts', 'transactions', 'sale_links'].includes(source.payload.projection.definition.role)) {
      for (const row of source.payload.records) assert.equal(row.data.data.cached_mapping_version, 5);
    }
  }
  const nativeParcels = (await pool.query(`SELECT object_id::text, ${CACHED_CAD_EVIDENCE_FIELDS.join(',')}
    FROM gis.dcad_parcels WHERE account_id=ANY($1::text[]) ORDER BY object_id`,
  [acquisition.captured_query_request.account_ids])).rows;
  const parcelRows = sourceRows(acquisition, 'parcels');
  assert.equal(parcelRows.length, nativeParcels.length);
  for (const row of parcelRows) {
    const original = nativeParcels.find(parcel => parcel.object_id === row.data.raw_projection.object_id);
    assert.ok(original);
    assert.deepEqual(Object.fromEntries(CACHED_CAD_EVIDENCE_FIELDS.map(key => [key, row.data.raw_projection[key]])),
      Object.fromEntries(CACHED_CAD_EVIDENCE_FIELDS.map(key => [key, original[key]])));
  }
  const sales = sourceRows(acquisition, 'transactions');
  assert.equal(sales.length, 1);
  const sale = sales[0].data, raw = sale.raw_projection;
  const native = (await pool.query(`SELECT src.mls_status, src.source_row_number,
    ${CACHED_SALE_WITNESS_V2_SQL} AS witness, src.current_price::text, s.sale_price::text
    FROM core.sales_source_records src JOIN core.sales s ON s.source_record_id=src.id
    WHERE src.id=10 AND src.primary_account_id=$1`, [scope.account_id])).rows;
  assert.equal(native.length, 1);
  assert.equal(raw.source_record_id, '10');
  assert.equal(raw.source_mls_status, native[0].mls_status);
  assert.equal(raw.source_row_number, native[0].source_row_number);
  assert.deepEqual(raw.source_raw_witness, prepareCachedSaleWitnessV2(native[0].witness));
  assert.equal(raw.source_raw_witness.root_state, 'sql_null');
  for (const cell of Object.values(raw.source_raw_witness.fields)) assert.deepEqual(cell,
    { state: 'payload_unavailable', json_type: null, value_text: null, utf8_bytes: null });
  assert.equal(raw.source_current_price, native[0].current_price); assert.equal(raw.sale_price, native[0].sale_price);
  assert.equal(sale.data.market_eligible, null); assert.equal(sale.data.historical_support, 'unknown');
  assert.ok(sale.capability_gaps.includes('canonical_source_price_conflict'));
  assert.deepEqual(sourceRows(acquisition, 'sale_links').map(row => row.data.raw_projection.account_id).sort(),
    sourceRows(legacy.retained.retained_inputs.acquisition, 'sale_links').map(row => row.data.raw_projection.account_id).sort());
  checks.push('native opt-in owner executes CAD4 plus exact witness2 SQL in RR/RO; original mapping5 dense capture registers intent3/study2 with exact retained interpretation definition and complete one-hop links');

  for (const [sourceMode, replayRequest, expected, combined] of [
    ['cad4', request, result, true], ['combined-witness2-v1', legacyRequest, legacyResult, false],
  ]) {
    const from = calls.length; let approvals = 0;
    const replayOwner = createCustomCohortContextCapture({ pool: observed, sourceMode,
      authorizeMarketData: async (_client, principal, context, purpose, options) => {
        checkPurpose(principal, context, purpose, options, combined); approvals++; return grant;
      } });
    assert.deepEqual(await replayOwner.capture(replayRequest), { ...expected, reused: true });
    assert.equal(approvals, 1);
    assert.ok(!calls.slice(from).some(sourceRead), 'cross-mode registered replay must not reread sources');
    assert.ok(!calls.slice(from).some(sql => /\b(?:INSERT\s+INTO|UPDATE\s+(?:app|app_auth|core|gis)\.|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s)/i.test(sql)),
      'replay may lock rows with SELECT FOR UPDATE but must not rewrite retained originals');
  }
  assert.deepEqual(await load(legacyResult.context_ref), legacy, 'opt-in replay never upgrades original mapping4/intent1/study1');
  assert.deepEqual(await load(result.context_ref), saved, 'default-mode replay retains original mapping5/intent3/study2');
  checks.push('registered contexts replay across either current producer mode with their original purpose/profile and bytes; no source reread or evidence rewrite');

  for (const revokeAt of [1, 2]) {
    const rejected = { ...legacyRequest, operationId: randomUUID() }, from = calls.length;
    let approvals = 0;
    const denied = createCustomCohortContextCapture({ pool: observed, sourceMode: 'combined-witness2-v1',
      authorizeMarketData: async (_client, principal, context, purpose, options) => {
        checkPurpose(principal, context, purpose, options);
        return ++approvals === revokeAt ? { allowed: false } : grant;
      } });
    await assert.rejects(denied.capture(rejected), /market_data_access_denied/);
    assert.equal(approvals, revokeAt); assert.equal(await contextCount(rejected.operationId), 0);
    const trace = calls.slice(from);
    if (revokeAt === 1) assert.ok(!trace.some(sql => /neighborhood-(cache|closure):/.test(sql)),
      'expanded-purpose denial must precede MLS closure and source reads without CAD4 fallback');
    else assert.ok(trace.some(sql => sql.includes('neighborhood-cache:transactions') && sql.includes(CACHED_SALE_WITNESS_V2_SQL)),
      'final revocation is exercised after a real original expanded source read');
    assert.ok(!trace.some(sql => /INSERT\s+INTO\s+app\.neighborhood_custom_cohort_contexts/i.test(sql)),
      'denial or final revocation must prevent context registration');
    if (revokeAt === 1) {
      const retryFrom = calls.length; let retryApprovals = 0;
      const defaultOwner = createCustomCohortContextCapture({ pool: observed,
        authorizeMarketData: async (_client, principal, context, purpose, options) => {
          checkPurpose(principal, context, purpose, options, false); retryApprovals++; return grant;
        } });
      const retried = await defaultOwner.capture(rejected);
      assert.equal(retried.status, 'registered'); assert.equal(retried.reused, false);
      assert.equal(retried.context_ref.context_id, rejected.operationId);
      assert.equal(await contextCount(rejected.operationId), 1); assert.equal(retryApprovals, 2);
      const retrySql = calls.slice(retryFrom);
      assert.ok(retrySql.some(sourceRead), 'an unregistered operation retry performs a new original acquisition');
      assert.ok(retrySql.some(sql => sql.includes('neighborhood-cache:transactions')));
      assert.ok(!retrySql.some(sql => sql.includes(CACHED_SALE_WITNESS_V2_SQL)));
      const retrySaved = await load(retried.context_ref);
      assert.equal(JSON.parse(retrySaved.retained.retained_inputs.acquisition.compact_metadata_json).mapping_version, 4);
      assert.equal(retrySaved.retained.acquisition_intent.body.intent_version, 1);
      assert.equal(retrySaved.study.study_input_version, 1);
      assert.equal(Object.hasOwn(retrySaved.retained.acquisition_intent.body, 'reported_sale_interpretation'), false);
      assert.equal(Object.hasOwn(retrySaved.study, 'reported_sale_interpretation'), false);
      checks.push('same unregistered operation retries as a new CAD4 intent1/study1 capture under the current default; orphan intent3 is not registered replay');
    }
  }
  assert.deepEqual(await reportState(), beforeReport);
  assert.ok(!calls.some(sql => /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+app\.(?:custom_appraisal_|custom_neighborhood_acceptances|neighborhood_assessment_|neighborhood_report_)/i.test(sql)),
    'capture, replay and denied attempts perform no report/publication/acceptance writes');
  checks.push('expanded-purpose denial precedes native MLS reads; final revocation prevents registration after real witness2 capture; no report/history/acceptance/signature writes');
  return { checks };
}
