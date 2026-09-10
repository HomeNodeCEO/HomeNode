import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { createNeighborhoodAssessmentRepository } from '../../src/services/neighborhoodAssessment/assessmentRepository.js';
import { getCustomNeighborhoodAcceptance } from '../../src/services/neighborhoodAssessment/customAcceptanceRepository.js';
import { projectCustomNeighborhoodReportSection } from '../../src/services/neighborhoodAssessment/customReportMapping.js';
import { saveCustomAppraisalWorkfileSectionInTransaction, getCustomAppraisalWorkfile } from '../../src/services/customAppraisalWorkfiles.js';
import { NEIGHBORHOOD_CACHED_SOURCE_SCHEMA } from '../fixtures/neighborhoodCachedSourceSchemaFixture.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { prepareNeighborhoodDiscoveryChoice } from '../../src/services/neighborhoodAssessment/selectorInputProfile.js';
import { canonicalAssessmentJson, assessmentEvidenceDigest } from '../../src/services/neighborhoodAssessment/contract.js';
import { createCustomCohortContextRepository } from '../../src/services/neighborhoodAssessment/customCohortContextRepository.js';
import { loadCustomCohortCaptureInputs } from '../../src/services/neighborhoodAssessment/customCohortCaptureInputs.js';

/** Real owner, retained capture, repository and atomic workfile save over a new
 * migrated synthetic database. The CAD/MLS schema is the existing native source
 * fixture, not a production schema/rights oracle. The caller creates/guards the
 * child database. No connection creation, cleanup, external data or mocked SQL.
 */
export async function checkCustomCohortReportedProposalDatabase({ pool, databaseName, discovery }) {
  const choice = discovery === undefined ? null : prepareNeighborhoodDiscoveryChoice(discovery);
  // The optional case adds a genuinely distant parcel, not a relabeled v1
  // capture. Keep this fixture bounded to its specified five-mile regression.
  if (choice) assert.equal(choice.radius_metres, '8046.72');
  assert.match(databaseName, /^[a-z][a-z0-9_]*_test$/);
  let client = await pool.connect(), effectiveDate;
  try {
    verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
      client.connection?.stream?.remoteAddress, databaseName);
    assert.equal((await client.query("SELECT to_regnamespace('gis') AS gis")).rows[0].gis, null,
      'This helper requires its own fresh synthetic source namespace; it must not replace another source fixture');
    effectiveDate = (await client.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS value")).rows[0].value;
  } finally { client.release(); }
  await pool.query(NEIGHBORHOOD_CACHED_SOURCE_SCHEMA);
  const organization = randomUUID(), actor = randomUUID(), appraisalCase = randomUUID(), snapshot = randomUUID(), report = randomUUID();
  const account = `RP-${randomUUID()}`, other = `RP-${randomUUID()}`, linked = `RP-${randomUUID()}`;
  const expandedAccount = choice ? `RP-${randomUUID()}` : null;
  const scope = { organization_id: organization, appraisal_case_id: appraisalCase, subject_snapshot_id: snapshot, account_id: account };
  const period = { start_date: '2023-07-01', end_date: '2024-06-30' };
  const geometry = { type: 'Polygon', coordinates: [[[-96.71, 32.79], [-96.68, 32.79], [-96.68, 32.82], [-96.71, 32.82], [-96.71, 32.79]]] };
  const details = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2', neighborhood_boundary_geometry: geometry,
    neighborhood_boundary_label: 'Synthetic reviewed boundary', neighborhood_boundary_north: 'Synthetic north road',
    neighborhood_boundary_east: 'Synthetic east road', neighborhood_boundary_south: 'Synthetic south road', neighborhood_boundary_west: 'Synthetic west road' };
  const location = { account_id: account, latitude: 32.8005, longitude: -96.6995, source: 'dcad_parcel_query', precision: 'parcel_centroid',
    status: 'matched', confidence: 'high', review_required: false, review_reason: null, match_method: 'parcel_id', source_parcel_id: account,
    feature_count: 1, metadata: { address_agreement: true }, geocoded_at: '2020-01-01T00:00:00.000Z', source_updated_at: null };
  client = await pool.connect(); let assignment;
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO app_auth.organizations(id,legal_name,display_name) VALUES($1,'Synthetic reported owner','Synthetic reported owner')", [organization]);
    await client.query("INSERT INTO app_auth.users(id,email,display_name) VALUES($1,$2,'Synthetic reported reviewer')", [actor, `${actor}@example.test`]);
    for (const id of [account, other, linked]) await client.query("INSERT INTO core.accounts(account_id,county,address,city,subdivision) VALUES($1,'Dallas','Synthetic only','Synthetic','Reported Native Plat')", [id]);
    if (expandedAccount) await client.query("INSERT INTO core.accounts(account_id,county,address,city,subdivision) VALUES($1,'Dallas','Synthetic four-mile parcel','Synthetic','Reported Native Plat')", [expandedAccount]);
    await client.query('INSERT INTO app.appraisal_cases(id,organization_id,account_id,effective_date) VALUES($1,$2,$3,$4)', [appraisalCase, organization, account, effectiveDate]);
    await client.query(`INSERT INTO app.appraisal_subject_snapshots(id,appraisal_case_id,snapshot_version,effective_date,subject_data)
      VALUES($1,$2,1,$3,$4::jsonb)`, [snapshot, appraisalCase, effectiveDate, JSON.stringify({ custom_property_snapshot: {
      account: { account_id: account }, improvement: { living_area_sqft: 2000 }, location } })]);
    assignment = (await client.query(`INSERT INTO app.assignment_files(organization_id,account_id,file_number,created_by_user_id,assigned_appraiser_user_id,assignment_details)
      VALUES($1,$2,$3,$4,$4,$5::jsonb) RETURNING id::text`, [organization, account, `RP-${randomUUID()}`, actor, JSON.stringify(details)])).rows[0].id;
    await client.query(`INSERT INTO app.report_files(id,organization_id,account_id,workflow_type,file_number,custom_assignment_file_id,appraisal_case_id,subject_snapshot_id)
      VALUES($1,$2,$3,'custom_appraisal',$4,$5,$6,$7)`, [report, organization, account, `RP-${randomUUID()}`, assignment, appraisalCase, snapshot]);
    await client.query('INSERT INTO app.custom_appraisal_workfiles(assignment_file_id,canonical_file_name) VALUES($1,$2)', [assignment, `reported-${randomUUID()}`]);
    const sync = randomUUID(), hash = 'a'.repeat(64);
    await client.query("INSERT INTO gis.source_sync_runs(id,source_key,mode,status,started_at,completed_at) VALUES($1,'dcad_parcels','full','complete',now()-interval '1 second',now())", [sync]);
    await client.query("INSERT INTO gis.source_sync_state(source_key,status,row_count,last_run_id,last_success_at) VALUES('dcad_parcels','current',2,$1,now())", [sync]);
    for (const [index, id] of [account, other].entries()) await client.query(`INSERT INTO gis.dcad_parcels
      (object_id,account_id,residential_year_built,residential_area_sqft,parcel_area_sqft,source_record_hash,sync_run_id,synced_at,geom)
      VALUES($1,$2,2000,2000,8000,$3,$4,now(),ST_Multi(ST_Translate(ST_GeomFromText('POLYGON((-96.7 32.8,-96.699 32.8,-96.699 32.801,-96.7 32.801,-96.7 32.8))',4326),$5,0)))`,
    [index + 1, id, hash, sync, index * 0.005]);
    if (expandedAccount) {
      await client.query(`INSERT INTO gis.dcad_parcels
        (object_id,account_id,residential_year_built,residential_area_sqft,parcel_area_sqft,source_record_hash,sync_run_id,synced_at,geom)
        VALUES(3,$1,1990,4000,16000,$2,$3,now(),ST_Multi(ST_Buffer(ST_Project(
          ST_SetSRID(ST_MakePoint(-96.6995,32.8005),4326)::geography,$4::double precision,pi()/2),10)::geometry))`,
      [expandedAccount, 'b'.repeat(64), sync, 4 * 1609.344]);
      await client.query("UPDATE gis.source_sync_state SET row_count=3 WHERE source_key='dcad_parcels' AND last_run_id=$1", [sync]);
    }
    await client.query(`INSERT INTO core.sales_source_records(id,primary_account_id,record_type,source_record_hash,close_date,current_price,living_area,year_built,days_on_market,loaded_at)
      VALUES(10,$1,'closed_sale',$2,'2024-03-01',300000,2000,2000,0,now())`, [account, hash]);
    await client.query("INSERT INTO core.sales(id,source_record_id,account_id,closing_date,sale_price,source,loaded_at) VALUES(100,10,$1,'2024-03-01',300000,'Synthetic',now())", [account]);
    await client.query(`INSERT INTO core.sale_parcels(id,source_record_id,source_position,parcel_sequence,account_id,is_resolved,match_method,loaded_at)
      VALUES(11,10,1,1,$1,true,'exact',now()),(12,10,1,2,$2,true,'exact',now())`, [account, linked]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const auth = { userId: actor, organizations: [{ organizationId: organization, roles: ['appraiser'] }] };
  const base = { auth, accountId: account, assignmentFileId: assignment };
  const calls = [], policyEvents = [];
  let afterCommit = null, loseCommit = false, denyAt = 0, changeAt = 0, policyCount = 0;
  const observed = { async connect() {
    const raw = await pool.connect();
    return { release: error => raw.release(error), async query(config) {
      const text = typeof config === 'string' ? config : config.text; calls.push(text);
      const result = await raw.query(config);
      if (text === 'COMMIT' && afterCommit) { const mutate = afterCommit; afterCommit = null; await mutate(); }
      if (text === 'COMMIT' && loseCommit) { loseCommit = false; throw new Error('synthetic_reported_commit_ack_lost'); }
      return result;
    } };
  } };
  const marketDecision = { allowed: true, decision_id: 'synthetic-retained-native', policy_revision: 'native-v1' };
  const reportDecision = { allowed: true, decision_id: 'synthetic-reported-native', policy_revision: 'native-v2' };
  const owner = createCustomCohortContextCapture({ pool: observed,
    authorizeMarketData: async (_client, actualAuth, context) => {
      assert.equal(actualAuth.userId, actor); assert.equal(context.scope.organization_id, organization); return marketDecision;
    }, authorizeReportedObservations: async (_client, actualAuth, context, purpose, options) => {
      assert.equal(actualAuth.userId, actor); assert.equal(context.scope.organization_id, organization);
      assert.equal(purpose.kind, 'custom_reported_observations_v2'); assert.equal(options.exposure, 'custom_report_observations');
      policyEvents.push({ count: ++policyCount, callIndex: calls.length });
      if (policyCount === denyAt) return { allowed: false };
      return policyCount === changeAt ? { ...reportDecision, policy_revision: 'changed' } : reportDecision;
    } });
  const captured = await owner.capture({ ...base, operationId: randomUUID(), observationPeriod: period,
    ...(choice ? { discovery: choice } : {}) });
  assert.equal(captured.status, 'registered');
  if (choice) {
    assert.equal(captured.discovery.radius_metres, choice.radius_metres);
    assert.equal(captured.discovery.account_count, 3);
    // A real ordinary capture over the same native rows must omit the parcel
    // that the five-mile study includes. Neither capture writes the report.
    const legacy = await owner.capture({ ...base, operationId: randomUUID(), observationPeriod: period });
    assert.equal(legacy.discovery.radius_metres, '4828.032'); assert.equal(legacy.discovery.account_count, 2);
  }
  const catalog = await owner.catalog({ ...base, contextRef: captured.context_ref, selection: { revision: 1, pockets: [] } });
  assert.equal(catalog.catalog.catalog_complete, true);
  const groupIds = catalog.catalog.pockets.map(value => value.id);
  if (catalog.catalog.unassigned.member_count) groupIds.push('discovery:unassigned');
  assert.ok(groupIds.length > 0);
  const checkpoint = { workspace_version: choice ? 3 : 1, pending_capture: null, active: { context_ref: captured.context_ref,
    observation_period: period, selection: { revision: 1, included_recorded_group_ids: groupIds },
    ...(choice ? { discovery: choice } : {}) } };
  client = await pool.connect();
  try {
    await client.query('BEGIN');
    const saved = await saveCustomAppraisalWorkfileSectionInTransaction(client, { accountId: account, assignmentFileId: Number(assignment),
      sectionKey: 'neighborhood_workspace', sectionValue: checkpoint, expectedRevision: 0, saveReason: 'manual_save', reviewer: actor });
    assert.equal(saved.revision, 1); await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const proposalInput = () => ({ ...base, contextRef: captured.context_ref, expectedWorkspaceRevision: 1, expectedEditorRevision: 0, operationId: randomUUID() });
  const protectedState = async () => (await pool.query(`SELECT
    (SELECT count(*)::integer FROM app.neighborhood_assessment_jobs j JOIN app.neighborhood_assessments h ON h.id=j.assessment_id WHERE h.organization_id=$1) AS jobs,
    (SELECT count(*)::integer FROM app.neighborhood_assessment_requests r JOIN app.neighborhood_assessments h ON h.id=r.assessment_id WHERE h.organization_id=$1) AS requests,
    (SELECT count(*)::integer FROM app.neighborhood_assessment_revisions r JOIN app.neighborhood_assessments h ON h.id=r.assessment_id WHERE h.organization_id=$1) AS revisions,
    (SELECT count(*)::integer FROM app.neighborhood_assessment_attachments WHERE organization_id=$1) AS attachments,
    (SELECT count(*)::integer FROM app.custom_neighborhood_acceptances WHERE organization_id=$1) AS acceptances,
    (SELECT count(*)::integer FROM app.custom_appraisal_workfile_section_history WHERE assignment_file_id=$2 AND section_key='neighborhood_assessment') AS accepted_history,
    (SELECT count(*)::integer FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$2 AND section_key='neighborhood_assessment') AS accepted_sections`,
  [organization, assignment])).rows[0];
  const resetPolicy = () => { policyCount = 0; denyAt = 0; changeAt = 0; policyEvents.length = 0; };
  const checks = ['real current-day Custom subject/capture/reopen, native manual boundary and exact saved group checkpoint; no fabricated retained graph'];
  async function rejectChangedDiscovery(action, expectedState) {
    assert.ok(choice);
    const changed = { ...checkpoint, active: { ...checkpoint.active,
      discovery: { ...choice, radius_metres: '16093.44' } } };
    const replace = async (value, expected) => {
      const result = await pool.query(`UPDATE app.custom_appraisal_workfile_sections SET section_value=$2::jsonb
        WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace' AND revision=1
          AND section_value=$3::jsonb RETURNING revision`, [assignment, JSON.stringify(value), JSON.stringify(expected)]);
      assert.equal(result.rowCount, 1, 'change only this exact owned synthetic checkpoint; preserve its editor revision');
    };
    await replace(changed, checkpoint);
    try {
      resetPolicy(); const from = calls.length;
      await assert.rejects(action(), error => error.reason === 'operation_conflict');
      assert.deepEqual(await protectedState(), expectedState);
      assert.ok(!calls.slice(from).some(sql => /neighborhood:(enqueue|exact-claim|publish)|INSERT INTO app\.custom_neighborhood_acceptances/.test(sql)));
    } finally { await replace(checkpoint, changed); resetPolicy(); }
  }
  const before = await protectedState();
  if (choice) {
    await rejectChangedDiscovery(() => owner.prepareReportedObservations(proposalInput()), before);
    checks.push('a five-mile retained context cannot be relabeled by a saved ten-mile checkpoint before proposal; no publication writes');
  }
  for (const count of [1, 3, 4]) {
    resetPolicy(); denyAt = count; const from = calls.length;
    await assert.rejects(owner.prepareReportedObservations(proposalInput()), /report_observation_access_denied/);
    assert.equal(policyCount, count); assert.deepEqual(await protectedState(), before);
    if (count === 1) assert.ok(!calls.slice(policyEvents[0].callIndex).some(sql => sql.includes('neighborhood-cohort-blob:read')),
      'denied report authorization must not continue into retained source rows');
    if (count === 4) assert.ok(calls.slice(from).some(sql => sql.includes('neighborhood:exact-claim')),
      'final denial must actually occur after repository writes and roll them back');
  }
  resetPolicy(); changeAt = 3;
  await assert.rejects(owner.prepareReportedObservations(proposalInput()), /report_policy_changed/);
  assert.deepEqual(await protectedState(), before); resetPolicy();
  checks.push('initial/report-final rights denial and changed decisions reject; post-publication denial rolls request/claim/source/attachment writes back');

  afterCommit = async () => { await pool.query(`UPDATE app.custom_appraisal_workfile_sections SET revision=2
    WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace' AND revision=1`, [assignment]); };
  await assert.rejects(owner.prepareReportedObservations(proposalInput()), /workspace_changed/);
  assert.deepEqual(await protectedState(), before);
  assert.equal((await pool.query(`UPDATE app.custom_appraisal_workfile_sections SET revision=1
    WHERE assignment_file_id=$1 AND section_key='neighborhood_workspace' AND revision=2 RETURNING revision`, [assignment])).rowCount, 1);
  resetPolicy();
  checks.push('a real committed checkpoint revision change between owner transactions prevents publication');

  const unrelated = await createNeighborhoodAssessmentRepository(pool).enqueue(scope, { operation_id: randomUUID(),
    effective_date: effectiveDate, data_cutoff: effectiveDate, input_signature_sha256: 'f'.repeat(64), payload: { synthetic_unrelated_job: true } });
  const requested = proposalInput(), from = calls.length;
  const proposal = await owner.prepareReportedObservations(requested);
  assert.equal(proposal.status, 'proposed', JSON.stringify(proposal)); assert.equal(proposal.reused, false);
  assert.equal(proposal.assessment.contract_version, 2); assert.equal(proposal.editor_revision, 0); assert.equal(proposal.workspace_section_revision, 1);
  assert.equal(proposal.assessment.status, 'ready'); assert.equal(proposal.assessment.geography_status, 'ready');
  assert.ok(calls.slice(from).some(sql => sql.includes('neighborhood:exact-claim')));
  assert.ok(!calls.slice(from).some(sql => sql.includes('neighborhood:claim */')));
  assert.ok(!calls.slice(from).some(sql => /neighborhood-(cache|membership|closure):/.test(sql)), 'proposal uses original retained rows only');
  const jobs = (await pool.query('SELECT id,status,attempts FROM app.neighborhood_assessment_jobs WHERE assessment_id=$1', [unrelated.job.assessment_id])).rows;
  assert.deepEqual(jobs.find(job => job.id === unrelated.job.id), { id: unrelated.job.id, status: 'queued', attempts: 0 });
  assert.equal(jobs.filter(job => job.status === 'succeeded').length, 1);
  assert.equal((await protectedState()).accepted_sections, 0);
  assert.equal(JSON.stringify(proposal).includes('retained_source_references'), false);
  assert.equal(JSON.stringify(proposal).includes('source_payload'), false);
  assert.ok(proposal.assessment.statistics.some(value => value.measurement === 'reported_days_on_market' && value.value === '0'));
  const frozen = await protectedState(); resetPolicy();
  assert.deepEqual(await owner.prepareReportedObservations(requested), { ...proposal, reused: true });
  assert.deepEqual(await protectedState(), frozen);
  checks.push('exact job claim leaves an older unrelated job queued; real publication/attachment is summary-only, retained, idempotent, and does not write accepted report values');

  const applying = { ...requested, operationId: randomUUID(), proposalOperationId: requested.operationId,
    attachmentId: proposal.attachment_ref.attachment_id, attachmentRevision: proposal.attachment_ref.attachment_revision,
    bindingDigest: proposal.attachment_ref.binding_digest, adopt: true };
  if (choice) {
    await rejectChangedDiscovery(() => owner.applyReportedObservations(applying), frozen);
    checks.push('Apply refuses changed saved discovery at the same workspace revision before accepting any of the five report parts');
  }
  await assert.rejects(owner.applyReportedObservations({ ...applying, adopt: false }), /invalid_reported_input/);
  await assert.rejects(owner.applyReportedObservations({ ...applying, bindingDigest: '0'.repeat(64) }), /operation_conflict/);
  assert.deepEqual(await protectedState(), frozen);
  resetPolicy(); denyAt = 3;
  await assert.rejects(owner.applyReportedObservations(applying), /report_observation_access_denied/);
  assert.equal(policyCount, 3); assert.deepEqual(await protectedState(), frozen); resetPolicy();
  checks.push('Apply requires exact explicit adoption and binding; final denial rolls the entire reserved section/history/acceptance back');

  loseCommit = true;
  await assert.rejects(owner.applyReportedObservations(applying), error => error.outcome_unknown === true);
  const committed = await protectedState(); assert.equal(committed.accepted_sections, 1); assert.equal(committed.accepted_history, 1); assert.equal(committed.acceptances, 1);
  resetPolicy(); const recovered = await owner.applyReportedObservations(applying);
  assert.equal(recovered.status, 'accepted'); assert.equal(recovered.accepted_editor_revision, 1); assert.equal(recovered.reused, true);
  assert.deepEqual(await protectedState(), committed);
  const acceptanceTarget = { organizationId: organization, reportFileId: report,
    assignmentFileId: Number(assignment), operationId: applying.operationId };
  client = await pool.connect(); let accepted;
  try { accepted = await getCustomNeighborhoodAcceptance(client, acceptanceTarget); } finally { client.release(); }
  assert.equal(accepted.acceptedEditorRevision, 1);
  const section = accepted.snapshot.section_value;
  assert.equal(Object.keys(section.mapped_values).length, 5); assert.equal(Object.keys(section.decision.applied).length, 5);
  const reopened = await getCustomAppraisalWorkfile(pool, { accountId: account, assignmentFileId: Number(assignment) });
  assert.deepEqual(reopened.sections.neighborhood_assessment.value, section);
  const projected = projectCustomNeighborhoodReportSection({ section, expected: { organization_id: organization,
    report_file_id: report, assignment_file_id: Number(assignment), account_id: account } });
  assert.equal(projected.status, 'ready', JSON.stringify(projected)); assert.equal(projected.assessment.contract_version, 2);
  assert.deepEqual(projected.assessment.geographic_neighborhood.geometry, geometry);
  assert.equal(projected.assessment.selection.revision, '1');
  assert.ok(projected.assessment.populations.some(value => value.member_unit === 'source_record'));
  assert.equal(projected.assessment.application_group.status, 'ready');
  if (choice) {
    assert.deepEqual(projected.assessment.statistics, proposal.assessment.statistics);
    assert.deepEqual(projected.assessment.geographic_neighborhood.geometry, proposal.assessment.boundary.geometry);
    assert.deepEqual(projected.assessment.geographic_neighborhood.cardinal_summaries, proposal.assessment.boundary.cardinal_summaries);
    assert.deepEqual(reopened.sections.neighborhood_workspace.value, checkpoint);
    const population = projected.assessment.populations.find(value => value.id === 'selected-cad-accounts');
    assert.equal(population.member_count, 3); assert.equal(population.unique_account_count, 3); assert.equal(population.account_link_count, 3);
    assert.equal(projected.assessment.statistics.find(value => value.population_id === population.id && value.measurement === 'account_count').value, 3);
    assert.equal(projected.assessment.statistics.find(value => value.population_id === population.id
      && value.id.endsWith(':current_cad_living_area:high')).value, '4000');
    const members = await pool.query(`SELECT member_id,account_ids FROM app.neighborhood_assessment_members
      WHERE assessment_id=$1 AND revision=$2 AND population_id=$3 ORDER BY member_id`,
    [projected.assessment.id, projected.assessment.revision, population.id]);
    assert.deepEqual(members.rows.map(row => row.member_id), [account, other, expandedAccount].sort());
    assert.ok(members.rows.every(row => row.account_ids.length === 1 && row.account_ids[0] === row.member_id));
    const sources = await pool.query(`SELECT source_id,content_sha256,source_payload FROM app.neighborhood_assessment_sources
      WHERE assessment_id=$1 AND revision=$2 ORDER BY source_id`, [projected.assessment.id, projected.assessment.revision]);
    assert.equal(sources.rowCount, projected.assessment.source_snapshots.length);
    for (const source of sources.rows) {
      assert.equal(assessmentEvidenceDigest(source.source_payload), source.content_sha256);
      assert.equal(projected.assessment.source_snapshots.find(item => item.id === source.source_id).content_sha256, source.content_sha256);
    }
    const cadSource = sources.rows.find(row => row.source_id === population.capture_source_ref);
    assert.deepEqual(cadSource.source_payload.binding.context_ref, captured.context_ref);
    assert.equal(cadSource.source_payload.binding.selection_revision, checkpoint.active.selection.revision);
    const scopeJson = canonicalAssessmentJson({ organization_id: organization, report_file_id: report,
      assignment_file_id: assignment, account_id: account });
    client = await pool.connect();
    try {
      await client.query('BEGIN');
      const header = await createCustomCohortContextRepository(client, scopeJson).get(canonicalAssessmentJson(captured.context_ref));
      const retained = await loadCustomCohortCaptureInputs(client, scopeJson, Object.fromEntries(
        ['snapshot_evidence', 'subject_dependencies', 'selection_input', 'study_input'].map(key => [key, header.body[key]])));
      assert.deepEqual(retained.study.discovery, choice);
      assert.deepEqual(retained.acquisition_intent.body.study.discovery, choice);
      assert.equal(retained.summary.radius_metres, choice.radius_metres);
      assert.deepEqual(retained.retained_inputs.selector.account_roster.account_ids, [account, other, expandedAccount].sort());
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    checks.push('fresh accepted reopen restores all five parts from the exact five-mile context, including the actual four-mile CAD account, counts, characteristics, boundary and source digests');
  }
  assert.deepEqual(await protectedState(), committed);
  checks.push('real first Apply commits all five parts/history/receipt once; lost COMMIT acknowledgment recovers exact operation without duplicate writes; normal workfile reopen restores coherent v2 boundary/statistics');
  resetPolicy();
  await assert.rejects(owner.applyReportedObservations({ ...applying, operationId: randomUUID() }), /report_editor_changed|report_group_conflict/);
  assert.deepEqual(await protectedState(), committed);
  // Retain immutable acceptance/history, but remove only this owned synthetic
  // current-section row to model a broken restore. It must not be called a new
  // empty editor or successfully recreated by replay. Restore the exact row in
  // finally; no evidence, other assignment or fixture history is removed.
  const currentSection = (await pool.query(`SELECT assignment_file_id,section_key,section_value,revision,updated_by,updated_at::text AS updated_at
    FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_assessment'`, [assignment])).rows[0];
  assert.ok(currentSection);
  assert.equal((await pool.query(`DELETE FROM app.custom_appraisal_workfile_sections
    WHERE assignment_file_id=$1 AND section_key='neighborhood_assessment' AND revision=1 RETURNING revision`, [assignment])).rowCount, 1);
  try {
    const missing = await protectedState(); assert.equal(missing.accepted_sections, 0);
    assert.equal(missing.accepted_history, 1); assert.equal(missing.acceptances, 1);
    resetPolicy();
    await assert.rejects(owner.applyReportedObservations(applying), /not_current_section|operation_conflict|group_conflict|history|duplicate key|missing/);
    assert.deepEqual(await protectedState(), missing);
  } finally {
    await pool.query(`INSERT INTO app.custom_appraisal_workfile_sections(assignment_file_id,section_key,section_value,revision,updated_by,updated_at)
      VALUES($1,$2,$3::jsonb,$4,$5,$6)`, [currentSection.assignment_file_id, currentSection.section_key,
      JSON.stringify(currentSection.section_value), currentSection.revision, currentSection.updated_by, currentSection.updated_at]);
  }
  assert.deepEqual(await protectedState(), committed);
  checks.push('retained acceptance/history with a missing current reserved section cannot report successful adoption or erase its prior evidence');
  const finalState = await pool.query("SELECT status,signed_at FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1", [assignment]);
  assert.deepEqual(finalState.rows[0], { status: 'draft', signed_at: null });
  checks.push('a new operation cannot treat an occupied accepted group as empty; signing and unrelated report sections remain untouched');
  return { checks, effective_date: effectiveDate, context_ref: captured.context_ref,
    synthetic_target: { organization_id: organization, actor_user_id: actor, report_file_id: report,
      assignment_file_id: assignment, account_id: account, appraisal_case_id: appraisalCase, subject_snapshot_id: snapshot },
    proposal_operation_id: requested.operationId, apply_operation_id: applying.operationId,
    ...(choice ? { discovery: choice, expanded_account_id: expandedAccount } : {}) };
}
