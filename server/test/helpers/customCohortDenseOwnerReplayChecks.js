import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { seedNeighborhoodDenseSource } from './neighborhoodDenseSourceSeed.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from '../fixtures/neighborhoodCachedSourceSchemaFixture.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { createCustomCohortOwnerReplayTiming } from './customCohortOwnerReplayTiming.js';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';
import { getCustomCohortRecordedHousingInterpretation } from '../../src/services/neighborhoodAssessment/customCohortRecordedHousingProfiles.js';
import { getNeighborhoodAttachment } from '../../src/services/neighborhoodAssessment/applicationRepository.js';
import { prepareNeighborhoodPublication } from '../../src/services/neighborhoodAssessment/assessmentRepository.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../../src/services/customAppraisalWorkfiles.js';
import { canonicalAssessmentJson as json, assessmentEvidenceDigest as digest } from '../../src/services/neighborhoodAssessment/contract.js';
import { createCustomNeighborhoodSourcePolicy, CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY,
  CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE, CUSTOM_NEIGHBORHOOD_SOURCE_DATASET } from '../../src/security/customNeighborhoodSourcePolicy.js';
import { authorizeCustomNeighborhoodReportObservations, CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_RIGHTS_KEY,
  CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_PURPOSE } from '../../src/security/customNeighborhoodReportObservationPolicy.js';

export const DENSE_OWNER_COUNTS = Object.freeze({ accounts: 38_106, parcels: 38_347, groups: 887,
  source_records: 1030, retained_records: 116_621, publication_members: 39_136 });
export const DENSE_OWNER_SOURCE_PROFILE = Object.freeze({ datasetRevision: 'synthetic-dense-owner-cad4-v1',
  providerRevisions: Object.freeze([Object.freeze({ provider_id: 'synthetic-local-fixture-owner', revision: 'synthetic-native-source-v1' })]) });
const dependencies = ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'];
const period = Object.freeze({ start_date: '2023-07-01', end_date: '2024-06-30' });
const boundary = Object.freeze({ neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
  neighborhood_boundary_label: 'Synthetic reviewed owner boundary', neighborhood_boundary_geometry: {
    type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
  neighborhood_boundary_north: '', neighborhood_boundary_east: '', neighborhood_boundary_south: '', neighborhood_boundary_west: '' });
const completeBoundary = () => ({ ...structuredClone(boundary), ...Object.fromEntries(['north', 'east', 'south', 'west']
  .map(side => [`neighborhood_boundary_${side}`, `Synthetic ${side} outline`])) });
const rowsHash = rows => {
  const hash = createHash('sha256'); hash.update('[');
  for (let index = 0; index < rows.length; index++) { if (index) hash.update(','); hash.update(json(rows[index])); }
  return hash.update(']').digest('hex');
};

// These rows authorize ONLY the entirely synthetic local source mix. The real
// fixed policies read/hash/revalidate them; no callback supplies a decision.
// This is not a license, source-rights provisioning recipe or production grant.
export function denseOwnerSyntheticRights(organizationId, past, future) {
  const rights_basis = { owner_id: 'synthetic-local-fixture-owner',
    basis_reference: 'GENERATED TEST DATA ONLY; no real MLS data, license or provider authority',
    approved_by: 'synthetic-fixture-author', approved_at: past };
  return {
    [CUSTOM_NEIGHBORHOOD_SOURCE_RIGHTS_KEY]: { policy_version: 1, organization_id: organizationId,
      grant_id: 'synthetic-dense-owner-source', dataset: { id: CUSTOM_NEIGHBORHOOD_SOURCE_DATASET,
        revision: DENSE_OWNER_SOURCE_PROFILE.datasetRevision,
        coverage: 'entire_integrated_source_mix_including_prior_merged_values',
        provider_revisions: structuredClone(DENSE_OWNER_SOURCE_PROFILE.providerRevisions) },
      purpose_version: 1, purpose_scope: structuredClone(CUSTOM_NEIGHBORHOOD_SOURCE_PURPOSE), rights_basis,
      valid_from: past, expires_at: future, revoked_at: null, retention: 'immutable_originals_without_automated_deletion',
      exposures: { none: true, report_observation_summary: true, report_observation_members: true, report_observation_catalog: true } },
    [CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_RIGHTS_KEY]: { policy_version: 1, organization_id: organizationId,
      grant_id: 'synthetic-dense-owner-report', purpose: CUSTOM_NEIGHBORHOOD_REPORT_OBSERVATION_PURPOSE,
      rights_basis: structuredClone(rights_basis), valid_from: past, expires_at: future, revoked_at: null,
      retention: 'immutable_report_group_and_referenced_evidence', exposures: { custom_report_observations: true } },
  };
}

async function guard(pool, databaseName, fresh = false) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.match(databaseName, /^dense_memory_[a-f0-9]{32}_test$/);
  const client = await pool.connect();
  try {
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection?.stream?.remoteAddress, databaseName);
    if (fresh) assert.equal((await client.query("SELECT to_regnamespace('gis') AS gis")).rows[0].gis, null,
      'requires a new empty source namespace; no existing-fixture reset');
  } finally { client.release(); }
}
async function tx(pool, mode, execute) {
  const client = await pool.connect(); let open = false, discard;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${mode}`); open = true;
    await client.query("SET LOCAL timezone='UTC'; SET LOCAL jit=off; SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    const result = await execute(client); await client.query('COMMIT'); open = false; return result;
  } catch (error) { discard = error; throw error; }
  finally {
    if (open) try { await client.query('ROLLBACK'); } catch (error) { discard = error; }
    client.release(discard);
  }
}
const owner = timing => createCustomCohortContextCapture({ pool: timing.pool, sourceMode: 'cad4',
  authorizeMarketData: timing.wrapPolicy('authorizeMarketData', createCustomNeighborhoodSourcePolicy(DENSE_OWNER_SOURCE_PROFILE)),
  authorizeReportedObservations: timing.wrapPolicy('authorizeReportedObservations', authorizeCustomNeighborhoodReportObservations) });

async function readOriginal(pool, fixture) {
  return tx(pool, 'REPEATABLE READ READ ONLY', async client => {
    const header = await createCustomCohortContextRepository(client, json(fixture.scope)).get(json(fixture.context_ref));
    assert.ok(header);
    const refs = Object.fromEntries(dependencies.map(key => [key, header.body[key]]));
    const loaded = await loadCustomCohortCaptureInputs(client, json(fixture.scope), refs);
    return { header, loaded };
  });
}
export function assertDenseCad4Original(loaded) {
  const input = loaded.retained_inputs;
  assert.equal(input.acquisition.provenance, 'original_cached_reader_invocation');
  assert.equal(JSON.parse(input.acquisition.compact_metadata_json).mapping_version, 4);
  assert.equal(Object.hasOwn(input, 'reported_sale_interpretation'), false);
  assert.equal(input.acquisition_intent.body.intent_version, 5);
  const housingProfile = getCustomCohortRecordedHousingInterpretation(4, 2).profile_ref;
  assert.deepEqual(input.recorded_housing_interpretation, housingProfile);
  assert.deepEqual(input.acquisition_intent.body.recorded_housing_interpretation, housingProfile);
  assert.equal(input.subject.effective_date, input.acquisition.capture_result.captured_at.slice(0, 10));
  assert.equal(input.spatial.parcel_encoding, 'fixed_fields_v1');
  assert.equal(input.spatial.account_ids.length, DENSE_OWNER_COUNTS.accounts);
  for (const [index, account] of input.spatial.account_ids.entries()) assert.equal(account, `DENSE-${String(index).padStart(6, '0')}`);
  assert.equal(input.spatial.parcels.length, DENSE_OWNER_COUNTS.parcels);
  const roleCounts = {};
  for (const source of input.acquisition.capture_result.source_capture.sources) {
    const role = source.payload.projection.definition.role;
    roleCounts[role] = (roleCounts[role] ?? 0) + source.payload.records.length;
    assert.equal(source.payload.projection.definition.mapping_version, 4);
  }
  assert.deepEqual(roleCounts, { selection: 38_106, parcels: 38_347, accounts: 38_106, transactions: 1030, sale_links: 1030, gis_sync: 2 });
  assert.equal(loaded.summary.source_query_complete, true);
  assert.equal(loaded.summary.source_record_count, DENSE_OWNER_COUNTS.retained_records);
  // The original graph has been fully remapped by the real loader. Its roots
  // transitively bind all original bytes; do not allocate another giant JSON.
  return { summary: loaded.summary, original_graph_root_sha256: digest(loaded.refs), refs_sha256: digest(loaded.refs),
    accounts_sha256: digest(input.spatial.account_ids), role_counts: roleCounts };
}

// Scope/revision-checked synthetic equivalent of the assignment save's two
// persisted statements. It writes no subject snapshot or captured source bytes.
async function saveBoundary(pool, fixture, details, expectedRevision) {
  return tx(pool, 'READ COMMITTED', async client => {
    const row = (await client.query(`SELECT a.id,a.account_id,a.file_number,a.revision,w.status
      FROM app.assignment_files a JOIN app.custom_appraisal_workfiles w ON w.assignment_file_id=a.id
      WHERE a.id=$1::bigint AND a.organization_id=$2 AND a.account_id=$3
        AND a.created_by_user_id=$4 AND a.assigned_appraiser_user_id=$4 FOR UPDATE OF w,a`,
    [fixture.scope.assignment_file_id, fixture.scope.organization_id, fixture.scope.account_id, fixture.auth.userId])).rows;
    assert.equal(row.length, 1); assert.equal(row[0].status, 'draft');
    assert.equal(row[0].revision, expectedRevision);
    const revision = expectedRevision + 1;
    assert.equal((await client.query(`UPDATE app.assignment_files SET assignment_details=$1::jsonb,
      reviewer=$2,revision=$3,updated_at=now() WHERE id=$4::bigint AND revision=$5`,
    [json(details), fixture.auth.userId, revision, fixture.scope.assignment_file_id, expectedRevision])).rowCount, 1);
    await client.query(`INSERT INTO app.assignment_file_history
      (assignment_file_id,account_id,file_number,assignment_details,reviewer,revision) VALUES($1,$2,$3,$4::jsonb,$5,$6)`,
    [fixture.scope.assignment_file_id, fixture.scope.account_id, row[0].file_number, json(details), fixture.auth.userId, revision]);
    return revision;
  });
}

export async function prepareDenseCad4OwnerReplay({ pool, databaseName }) {
  await guard(pool, databaseName, true);
  await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
  const org = randomUUID(), actor = randomUUID(), caseId = randomUUID(), snapshotId = randomUUID(),
    reportId = randomUUID(), run = randomUUID(), operation = randomUUID();
  const times = (await pool.query(`WITH clock AS (SELECT clock_timestamp() AS value)
    SELECT to_char(value AT TIME ZONE 'UTC','YYYY-MM-DD') AS effective_date,
      to_char((value-interval '1 minute') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS past,
      to_char((value+interval '2 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS future FROM clock`)).rows[0];
  const ring = Array.from({ length: 10 }, (_, i) => {
    const angle = i * Math.PI / 5;
    return `${-96.71234567890123 + Math.cos(angle) * .00002} ${32.81234567890123 + Math.sin(angle) * .00002}`;
  });
  const seed = await tx(pool, 'READ COMMITTED', async client => {
    const result = await seedNeighborhoodDenseSource(client, { org, actor, caseId, snapshotId, reportId, run, operation,
      account: 'DENSE-000000', parcelCount: 38_347, accountCount: 38_106, effectiveDate: times.effective_date,
      geometry: `POLYGON((${[...ring, ring[0]].join(',')}))` });
    assert.equal((await client.query('UPDATE app_auth.organizations SET metadata=$2::jsonb WHERE id=$1',
      [org, json(denseOwnerSyntheticRights(org, times.past, times.future))])).rowCount, 1);
    return result;
  });
  const fixture = { fixture_version: 1, database: databaseName, source_mode: 'cad4', scope: seed.scope,
    auth: { userId: actor, organizations: [{ organizationId: org, roles: ['appraiser'] }] },
    source_profile: DENSE_OWNER_SOURCE_PROFILE, observation_period: period, operation_id: randomUUID() };
  const revision = (await pool.query('SELECT revision FROM app.assignment_files WHERE id=$1::bigint', [seed.scope.assignment_file_id])).rows[0].revision;
  fixture.boundary_revision = await saveBoundary(pool, fixture, boundary, revision);
  const timing = createCustomCohortOwnerReplayTiming({ pool }); timing.begin('setup');
  const service = owner(timing), base = { auth: fixture.auth, accountId: seed.scope.account_id, assignmentFileId: seed.scope.assignment_file_id };
  const captured = await service.capture({ ...base, operationId: operation, observationPeriod: period });
  assert.equal(captured.status, 'registered'); assert.equal(captured.reused, false);
  assert.equal(captured.discovery.account_count, 38_106); assert.equal(captured.discovery.parcel_count, 38_347);
  fixture.context_ref = captured.context_ref;
  const catalog = (await service.catalog({ ...base, contextRef: fixture.context_ref, selection: { revision: 1, pockets: [] } })).catalog;
  timing.end('setup');
  assert.equal(catalog.catalog_complete, true); assert.equal(catalog.pockets.length, 887);
  assert.deepEqual([...catalog.pockets.flatMap(item => item.account_ids), ...catalog.unassigned.account_ids].sort(),
    Array.from({ length: 38_106 }, (_, i) => `DENSE-${String(i).padStart(6, '0')}`));
  const ids = [...catalog.pockets.map(item => item.id), ...(catalog.unassigned.member_count ? ['discovery:unassigned'] : [])];
  fixture.group_ids_sha256 = digest(ids);
  fixture.checkpoint = { workspace_version: 5, pending_capture: null, active: { context_ref: captured.context_ref,
    observation_period: period, selection: { revision: 1, included_recorded_group_ids: ids } } };
  await tx(pool, 'READ COMMITTED', async client => {
    const saved = await saveCustomAppraisalWorkfileSectionInTransaction(client, { accountId: base.accountId,
      assignmentFileId: Number(base.assignmentFileId), sectionKey: 'neighborhood_workspace', sectionValue: fixture.checkpoint,
      expectedRevision: 0, saveReason: 'manual_save', reviewer: actor });
    assert.equal(saved.revision, 1);
  });
  const { loaded } = await readOriginal(pool, fixture);
  fixture.original = assertDenseCad4Original(loaded);
  fixture.refs = loaded.refs;
  const originalDecision = loaded.retained_inputs.acquisition.captured_query_request.market_decision;
  assert.match(originalDecision.policy_revision, /^custom-neighborhood-source-rights-v1:sha256:[a-f0-9]{64}$/);
  assert.equal(originalDecision.decision_id, `${org}:synthetic-dense-owner-source`);
  return { fixture, timings: timing.snapshot() };
}

async function protectedState(pool, fixture) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM app.neighborhood_assessments WHERE organization_id=$1) AS heads,
    (SELECT count(*)::int FROM app.neighborhood_assessment_jobs j JOIN app.neighborhood_assessments h ON h.id=j.assessment_id WHERE h.organization_id=$1) AS jobs,
    (SELECT count(*)::int FROM app.neighborhood_assessment_requests r JOIN app.neighborhood_assessments h ON h.id=r.assessment_id WHERE h.organization_id=$1) AS requests,
    (SELECT count(*)::int FROM app.neighborhood_assessment_revisions r JOIN app.neighborhood_assessments h ON h.id=r.assessment_id WHERE h.organization_id=$1) AS revisions,
    (SELECT count(*)::int FROM app.neighborhood_assessment_members m JOIN app.neighborhood_assessments h ON h.id=m.assessment_id WHERE h.organization_id=$1) AS members,
    (SELECT count(*)::int FROM app.neighborhood_assessment_attachments WHERE organization_id=$1) AS attachments,
    (SELECT count(*)::int FROM app.custom_neighborhood_acceptances WHERE organization_id=$1) AS acceptances,
    (SELECT count(*)::int FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$2::bigint AND section_key='neighborhood_assessment') AS accepted_sections,
    (SELECT count(*)::int FROM app.custom_appraisal_workfile_section_history WHERE assignment_file_id=$2::bigint AND section_key='neighborhood_assessment') AS accepted_history,
    (SELECT count(*)::int FROM app.custom_appraisal_signed_snapshots WHERE assignment_file_id=$2::bigint) AS signatures`,
  [fixture.scope.organization_id, fixture.scope.assignment_file_id])).rows[0];
}

async function checkPublished(pool, fixture, response) {
  return tx(pool, 'REPEATABLE READ READ ONLY', async client => {
    const stored = await getNeighborhoodAttachment(client, { organizationId: fixture.scope.organization_id,
      reportFileId: fixture.scope.report_file_id, workflowType: 'custom_appraisal', workflowTargetId: Number(fixture.scope.assignment_file_id),
      attachmentId: response.attachment_ref.attachment_id, attachmentRevision: response.attachment_ref.attachment_revision });
    assert.ok(stored); const assessment = stored.assessment;
    assert.equal(assessment.application_group.status, 'ready'); assert.equal(assessment.geographic_neighborhood.status, 'ready');
    assert.equal(assessment.selection.pocket_ids.length, 887);
    const sources = (await client.query(`SELECT source_id AS id,source_payload AS payload FROM app.neighborhood_assessment_sources
      WHERE assessment_id=$1 AND revision=$2 ORDER BY source_id`, [assessment.id, assessment.revision])).rows;
    const members = []; let after = ['', ''];
    for (;;) {
      const rows = (await client.query(`SELECT population_id,member_id,member_unit,account_ids,member_data FROM app.neighborhood_assessment_members
        WHERE assessment_id=$1 AND revision=$2 AND (population_id,member_id)>($3,$4)
        ORDER BY population_id,member_id LIMIT 250`, [assessment.id, assessment.revision, ...after])).rows;
      if (!rows.length) break;
      members.push(...rows); assert.ok(members.length <= 39_136);
      after = [rows.at(-1).population_id, rows.at(-1).member_id];
    }
    assert.equal(members.length, 39_136);
    // Recheck every persisted source and member, not merely the public summary.
    const publication = prepareNeighborhoodPublication(assessment, members, sources);
    assert.deepEqual(publication.assessment, assessment);
    const cad = assessment.populations.find(p => p.id === 'selected-cad-accounts');
    const sales = assessment.populations.find(p => p.id === 'selected-shared-source-records');
    assert.equal(cad.member_count, 38_106); assert.equal(sales.member_count, 1030);
    const cadIds = members.filter(item => item.population_id === cad.id).map(item => item.member_id).sort();
    assert.equal(digest(cadIds), fixture.original.accounts_sha256);
    const shared = members.filter(item => item.population_id === sales.id);
    assert.equal(shared.length, 1030);
    for (const row of shared) {
      assert.equal(row.member_data.mapping_version, 4);
      assert.equal(Object.hasOwn(row.member_data, 'interpretation_profile_ref'), false);
      assert.equal(row.member_data.association_completeness, 'not_established');
      assert.equal(row.member_data.unresolved_link_count, 1);
      assert.notEqual(row.member_data.observations.reported_close_price.state, 'observed');
      for (const key of ['reported_current_price', 'reported_living_area', 'reported_site_area'])
        assert.notEqual(row.member_data.observations[key].state, 'observed');
    }
    return { complete_publication_revalidated: true, accounts: cad.member_count, source_records: sales.member_count,
      members: members.length, sources: sources.length, populations: assessment.populations.length,
      assessment_sha256: digest(assessment), published_evidence_sha256: assessment.evidence_digest_sha256,
      member_content_sha256: rowsHash(members), source_content_sha256: rowsHash(sources),
      source_units_inferred: false, original_source_gaps_preserved: true };
  });
}

/** Actual CAD4 owner call, not the builder helper. Setup/assertions deliberately
 * sit outside each measured proposal. Caller owns pool/host/profile lifecycle.
 * No deadline override, speculative retry, Apply, source edit or grant bypass.
 */
export async function measureDenseCad4OwnerReplay({ pool, databaseName, fixture, beforeWork = async () => {}, afterWork = async () => {} }) {
  await guard(pool, databaseName);
  assert.equal(fixture.fixture_version, 1); assert.equal(fixture.database, databaseName); assert.equal(fixture.source_mode, 'cad4');
  assert.deepEqual(fixture.source_profile, DENSE_OWNER_SOURCE_PROFILE);
  assert.equal(digest(fixture.checkpoint.active.selection.included_recorded_group_ids), fixture.group_ids_sha256);
  let original = (await readOriginal(pool, fixture)).loaded;
  assert.deepEqual(assertDenseCad4Original(original), fixture.original); assert.deepEqual(original.refs, fixture.refs); original = null;
  const timing = createCustomCohortOwnerReplayTiming({ pool }), service = owner(timing);
  const request = { auth: fixture.auth, accountId: fixture.scope.account_id, assignmentFileId: fixture.scope.assignment_file_id,
    contextRef: fixture.context_ref, expectedWorkspaceRevision: 1, expectedEditorRevision: 0, operationId: fixture.operation_id };
  const initial = await protectedState(pool, fixture);
  assert.ok(Object.values(initial).every(value => value === 0));
  const outcomes = []; let ready;
  await beforeWork();
  try {
    for (const phase of ['blank_cardinals', 'complete_cardinals']) {
      if (phase === 'complete_cardinals') await saveBoundary(pool, fixture, completeBoundary(), fixture.boundary_revision);
      timing.begin(phase); let response, error;
      try { response = await service.prepareReportedObservations(request); } catch (caught) { error = caught; }
      finally { timing.end(phase); }
      if (error) {
        assert.deepEqual(await protectedState(pool, fixture), initial, 'failed owner call must roll back all publication writes');
        outcomes.push({ phase, status: 'failed', code: error.code === 'CUSTOM_COHORT_CAPTURE_FAILED' ? error.code : 'suppressed',
          reason: ['deadline_exceeded', 'cancelled', 'policy_timeout', 'connection_timeout', 'market_policy_changed', 'report_policy_changed'].includes(error.reason)
            ? error.reason : 'suppressed' });
        break; // No automatic retries, budget increases or broader fallback.
      }
      assert.equal(response.reused, false); assert.equal(response.proposal_operation_id, request.operationId);
      assert.equal(response.status, phase === 'blank_cardinals' ? 'incomplete' : 'proposed');
      outcomes.push({ phase, status: response.status, public_response_bytes: Buffer.byteLength(JSON.stringify(response)),
        public_response_sha256: digest(response), issue_codes: response.issues.map(issue => issue.code) });
      if (phase === 'blank_cardinals') {
        assert.equal(response.attachment_ref, null); assert.equal(response.assessment, null);
        assert.deepEqual(await protectedState(pool, fixture), initial);
      } else ready = response;
    }
  } finally { await afterWork(); }
  const assertionStarted = performance.now();
  const current = await protectedState(pool, fixture);
  for (const key of ['acceptances', 'accepted_sections', 'accepted_history', 'signatures']) assert.equal(current[key], initial[key]);
  let publication = null;
  if (ready) {
    for (const key of ['heads', 'jobs', 'requests', 'revisions', 'attachments']) assert.equal(current[key], 1);
    assert.equal(current.members, 39_136);
    publication = await checkPublished(pool, fixture, ready);
  }
  const reloaded = (await readOriginal(pool, fixture)).loaded;
  assert.deepEqual(assertDenseCad4Original(reloaded), fixture.original); assert.deepEqual(reloaded.refs, fixture.refs);
  return { status: ready ? 'passed' : 'owner_failed', source_mode: 'cad4', counts: DENSE_OWNER_COUNTS,
    original: fixture.original, outcomes, timings: timing.snapshot(), publication, protected_state: current,
    assertion_wall_ms: performance.now() - assertionStarted, actual_owner_capture: true, actual_owner_report_preparation: true,
    publication_sql_entered: timing.snapshot().queries.some(event => ['neighborhood:job-head', 'neighborhood:publication-fence', 'neighborhood:revision'].includes(event.label)),
    successful_publication: !!ready,
    report_apply_performed: false, accepted_report_writes: 0, production_connections: 0 };
}
