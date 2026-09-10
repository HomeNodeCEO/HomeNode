import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkCustomCohortReportedProposalDatabase } from './customCohortReportedProposalDatabaseChecks.js';
import { NEIGHBORHOOD_CI_IDENTITY_SQL, verifyNeighborhoodCiConnection } from './neighborhoodCiDatabase.js';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { getCustomNeighborhoodAcceptance } from '../../src/services/neighborhoodAssessment/customAcceptanceRepository.js';
import { projectCustomNeighborhoodReportSection } from '../../src/services/neighborhoodAssessment/customReportMapping.js';
import { saveCustomAppraisalWorkfileSectionInTransaction } from '../../src/services/customAppraisalWorkfiles.js';

const KIND = 'accepted_custom_reported_group';
const clone = value => structuredClone(value);

/** Actual SQL successor checks; no database creation, provider access, schema
 * replacement or production fixture. A caller may reuse the previous native
 * owner's returned fixture so the genuine first adoption runs only once.
 * Every NEW destructive negative probe is confined to a rolled-back transaction.
 */
export async function checkCustomCohortReportedReplacementDatabase({ pool, databaseName, predecessorFixture = null }) {
  assert.match(databaseName, /^[a-z][a-z0-9_]*_test$/);
  let client = await pool.connect();
  try { verifyNeighborhoodCiConnection((await client.query(NEIGHBORHOOD_CI_IDENTITY_SQL)).rows[0],
    client.connection?.stream?.remoteAddress, databaseName); } finally { client.release(); }
  const fixture = predecessorFixture ?? await checkCustomCohortReportedProposalDatabase({ pool, databaseName });
  const target = fixture.synthetic_target;
  assert.ok(target && fixture.context_ref && fixture.apply_operation_id && fixture.proposal_operation_id);
  const assignment = target.assignment_file_id, assignmentNumber = Number(assignment);
  const actor = target.actor_user_id, account = target.account_id, organization = target.organization_id;
  const report = target.report_file_id;
  const auth = { userId: actor, organizations: [{ organizationId: organization, roles: ['appraiser'] }] };
  const base = { auth, accountId: account, assignmentFileId: assignment, contextRef: fixture.context_ref };
  const acceptanceTarget = operationId => ({ organizationId: organization, reportFileId: report,
    assignmentFileId: assignmentNumber, operationId });
  const accepted = async operationId => {
    const connection = await pool.connect();
    try { return await getCustomNeighborhoodAcceptance(connection, acceptanceTarget(operationId)); }
    finally { connection.release(); }
  };
  const state = async () => (await pool.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.section_key) FROM app.custom_appraisal_workfile_sections s WHERE s.assignment_file_id=$1) AS sections,
    (SELECT jsonb_agg(to_jsonb(h) ORDER BY h.id) FROM app.custom_appraisal_workfile_section_history h WHERE h.assignment_file_id=$1) AS history,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.accepted_editor_revision) FROM app.custom_neighborhood_acceptances a WHERE a.assignment_file_id=$1) AS acceptances,
    (SELECT to_jsonb(w) FROM app.custom_appraisal_workfiles w WHERE w.assignment_file_id=$1) AS workfile,
    (SELECT jsonb_build_object('assignment_details',f.assignment_details,'updated_at',f.updated_at) FROM app.assignment_files f WHERE f.id=$1) AS assignment,
    (SELECT count(*)::integer FROM app.custom_appraisal_signed_snapshots s WHERE s.assignment_file_id=$1) AS signed_snapshots,
    (SELECT count(*)::integer FROM app.neighborhood_assessment_attachments a WHERE a.report_file_id=$2) AS attachments`,
  [assignment, report])).rows[0];
  function makeOwner({ onBegin = null, rollbackOnly = false, failAfterAcceptance = false, loseCommit = false, denyAfterWrites = false } = {}) {
    const calls = []; let connects = 0, began = false, inserted = false, lost = false, denied = false;
    const observed = { async connect() {
      connects++; const raw = await pool.connect();
      return { release: error => raw.release(error), async query(config) {
        const text = typeof config === 'string' ? config : config.text; calls.push(text);
        if (text === 'COMMIT' && rollbackOnly) {
          await raw.query('ROLLBACK'); throw new Error('negative_probe_attempted_commit');
        }
        const result = await raw.query(config);
        if (text.startsWith('BEGIN ') && onBegin && !began) { began = true; await onBegin(raw); }
        if (text.includes('custom-neighborhood-acceptance:insert') && result.rowCount === 1) {
          inserted = true;
          if (failAfterAcceptance) {
            // Leave rollback ownership with the real savepoint/transaction
            // code under test. Rolling back here would erase its savepoint
            // and manufacture an unrelated rollback-failed error.
            await raw.query('SELECT 1/0');
            assert.fail('PostgreSQL division-by-zero fault did not fire');
          }
        }
        if (text === 'COMMIT' && loseCommit && !lost) { lost = true; throw new Error('synthetic_replacement_commit_ack_lost'); }
        return result;
      } };
    } };
    const owner = createCustomCohortContextCapture({ pool: observed,
      authorizeMarketData: async (_client, principal, context) => {
        assert.equal(principal.userId, actor); assert.equal(context.scope.organization_id, organization);
        return { allowed: true, decision_id: 'synthetic-retained-native', policy_revision: 'native-v1' };
      }, authorizeReportedObservations: async (_client, principal, context, purpose, options) => {
        assert.equal(principal.userId, actor); assert.equal(context.scope.organization_id, organization);
        assert.equal(purpose.kind, 'custom_reported_observations_v2'); assert.equal(options.exposure, 'custom_report_observations');
        if (denyAfterWrites && inserted) { denied = true; return { allowed: false }; }
        return { allowed: true, decision_id: 'synthetic-reported-native', policy_revision: 'native-v2' };
      } });
    return { owner, calls, get connects() { return connects; }, get inserted() { return inserted; }, get denied() { return denied; } };
  }
  const original = await accepted(fixture.apply_operation_id);
  assert.ok(original); assert.equal(original.acceptedEditorRevision, 1);
  assert.equal(original.snapshot.section_value.mapped_values['custom-neighborhood-report:evidence'].value.assessment.contract_version, 2);
  const oldSection = clone(original.snapshot.section_value), before = await state();
  assert.equal(before.acceptances.length, 1); assert.equal(before.signed_snapshots, 0);
  const originalHistory = before.history.find(row => String(row.id) === original.sectionHistoryId);
  assert.ok(originalHistory);
  const originalAcceptanceRow = clone(before.acceptances[0]);
  const currentTarget = (await pool.query(`SELECT f.organization_id,f.account_id,f.assigned_appraiser_user_id,
    r.appraisal_case_id,r.subject_snapshot_id FROM app.assignment_files f JOIN app.report_files r
    ON r.custom_assignment_file_id=f.id AND r.organization_id=f.organization_id AND r.account_id=f.account_id
    WHERE f.id=$1 AND r.id=$2 AND r.workflow_type='custom_appraisal'`, [assignment, report])).rows;
  assert.equal(currentTarget.length, 1); assert.deepEqual(currentTarget[0], { organization_id: organization, account_id: account,
    assigned_appraiser_user_id: actor, appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id });
  const savedWorkspace = before.sections.find(row => row.section_key === 'neighborhood_workspace');
  assert.equal(savedWorkspace.revision, 1); const checkpoint = clone(savedWorkspace.section_value);
  assert.ok(checkpoint.active.selection.included_recorded_group_ids.length > 0);
  checkpoint.active.selection = { revision: 2, included_recorded_group_ids: [] };
  const geometry = { type: 'Polygon', coordinates: [[[-96.712, 32.788], [-96.677, 32.788],
    [-96.677, 32.823], [-96.712, 32.823], [-96.712, 32.788]]] };
  const boundaryPatch = { neighborhood_boundary_geometry: geometry, neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_label: 'Synthetic explicit replacement outline', neighborhood_boundary_north: 'Replacement north road',
    neighborhood_boundary_east: 'Replacement east road', neighborhood_boundary_south: 'Replacement south road',
    neighborhood_boundary_west: 'Replacement west road' };
  // A genuine new saved choice and manual outline, never an empty accepted slot.
  client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1 FOR UPDATE', [assignment]);
    await client.query(`UPDATE app.assignment_files SET assignment_details=assignment_details||$2::jsonb,
      updated_at=clock_timestamp() WHERE id=$1`, [assignment, JSON.stringify(boundaryPatch)]);
    const saved = await saveCustomAppraisalWorkfileSectionInTransaction(client, { accountId: account, assignmentFileId: assignmentNumber,
      sectionKey: 'neighborhood_workspace', sectionValue: checkpoint, expectedRevision: 1, saveReason: 'manual_save', reviewer: actor });
    assert.equal(saved.revision, 2); await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  assert.deepEqual((await accepted(fixture.apply_operation_id)).snapshot.section_value, oldSection);
  const unchangedAccepted = await state();
  assert.deepEqual(unchangedAccepted.acceptances, before.acceptances);
  assert.deepEqual(unchangedAccepted.history.filter(row => row.section_key === 'neighborhood_assessment'), [originalHistory]);
  const expectedPredecessor = { acceptance_id: original.id, operation_id: original.operationId,
    accepted_editor_revision: 1, section_value_sha256: original.snapshot.section_value_sha256 };
  const request = () => ({ ...base, expectedWorkspaceRevision: 2, expectedEditorRevision: 1,
    operationId: randomUUID(), replacement: { kind: KIND } });
  const clean = makeOwner(), requested = request();
  const proposal = await clean.owner.prepareReportedObservations(requested);
  assert.equal(proposal.status, 'proposed', JSON.stringify(proposal));
  assert.deepEqual(proposal.replacement, { kind: KIND, predecessor: expectedPredecessor });
  assert.equal(proposal.editor_revision, 1); assert.equal(proposal.assessment.contract_version, 2);
  assert.deepEqual(proposal.assessment.boundary.geometry, geometry);
  assert.ok(proposal.assessment.populations.length > 0);
  assert.ok(proposal.assessment.populations.every(population => population.member_count === 0), 'existing v2 empty observation populations stay zero');
  const afterProposal = await state();
  assert.deepEqual(afterProposal.acceptances, before.acceptances);
  assert.deepEqual(afterProposal.sections.find(row => row.section_key === 'neighborhood_assessment').section_value, oldSection);
  const predecessorPayload = (await pool.query(`SELECT j.request_payload FROM app.neighborhood_assessment_requests r
    JOIN app.neighborhood_assessment_jobs j ON j.id=r.job_id AND j.assessment_id=r.assessment_id
    JOIN app.neighborhood_assessments h ON h.id=r.assessment_id WHERE r.operation_id=$1 AND h.organization_id=$2`,
  [requested.operationId, organization])).rows;
  assert.equal(predecessorPayload.length, 1); assert.equal(predecessorPayload[0].request_payload.proposal_version, 2);
  assert.deepEqual(predecessorPayload[0].request_payload.request.replacement, { kind: KIND });
  assert.deepEqual(predecessorPayload[0].request_payload.fences.replacement, { predecessor: expectedPredecessor,
    section_history_id: original.sectionHistoryId, attachment_id: original.attachmentId,
    attachment_revision: original.attachmentRevision, application_identity_sha256: oldSection.application_identity_sha256,
    receipt_digest_sha256: original.snapshot.receipt.receipt_digest_sha256 });
  assert.deepEqual(await clean.owner.prepareReportedObservations(requested), { ...proposal, reused: true });
  const applying = { ...requested, operationId: randomUUID(), proposalOperationId: requested.operationId,
    attachmentId: proposal.attachment_ref.attachment_id, attachmentRevision: proposal.attachment_ref.attachment_revision,
    bindingDigest: proposal.attachment_ref.binding_digest, adopt: true, replacement: clone(proposal.replacement) };
  const checks = ['genuine accepted v2 A remains intact while changed saved empty selection and covering manual outline produce retained replacement B with exact predecessor'];
  let baseline = await state();
  for (const replacement of [{ kind: 'unknown' }, { kind: KIND }, { kind: KIND, predecessor: null },
    { kind: KIND, predecessor: { ...expectedPredecessor, unexpected: true } }]) {
    const invalid = makeOwner();
    await assert.rejects(invalid.owner.applyReportedObservations({ ...applying, replacement }), /invalid_reported|replacement|predecessor/);
    assert.equal(invalid.connects, 0); assert.deepEqual(await state(), baseline);
  }
  for (const patch of [{ acceptance_id: randomUUID() }, { operation_id: randomUUID() },
    { section_value_sha256: '0'.repeat(64) }, { accepted_editor_revision: 2 }]) {
    await assert.rejects(clean.owner.applyReportedObservations({ ...applying,
      replacement: { kind: KIND, predecessor: { ...expectedPredecessor, ...patch } } }), /invalid_reported|conflict|changed|predecessor/);
    assert.deepEqual(await state(), baseline);
  }
  const { replacement: _replacement, ...ordinary } = applying;
  await assert.rejects(clean.owner.applyReportedObservations(ordinary), /conflict|changed|group|replacement/);
  assert.deepEqual(await state(), baseline);
  checks.push('malformed replacement commands fail before connection; foreign/stale predecessor and implicit ordinary Apply cannot overwrite accepted A');
  for (const [name, mutation, expected] of [
    ['missing current section with retained history', raw => raw.query("DELETE FROM app.custom_appraisal_workfile_sections WHERE assignment_file_id=$1 AND section_key='neighborhood_assessment'", [assignment]), /editor|current|predecessor|group/],
    ['same-revision changed current bytes', raw => raw.query("UPDATE app.custom_appraisal_workfile_sections SET section_value=jsonb_set(section_value,'{actor_user_id}',to_jsonb($2::text)) WHERE assignment_file_id=$1 AND section_key='neighborhood_assessment'", [assignment, randomUUID()]), /changed|mismatch|predecessor|current|replacement_conflict/],
    ['signed target', raw => raw.query("UPDATE app.custom_appraisal_workfiles SET status='signed',signed_at=clock_timestamp() WHERE assignment_file_id=$1", [assignment]), /read_only|signed|editable/],
  ]) {
    const negative = makeOwner({ onBegin: mutation, rollbackOnly: true });
    await assert.rejects(negative.owner.applyReportedObservations(applying), expected, name);
    assert.deepEqual(await state(), baseline, name + ' must roll back every negative mutation');
  }
  checks.push('missing current section, altered same-revision bytes and signed state reject inside rollback-only probes; no accepted/history evidence is deleted');
  const denied = makeOwner({ denyAfterWrites: true });
  await assert.rejects(denied.owner.applyReportedObservations(applying), /report_observation_access_denied/);
  assert.equal(denied.inserted, true); assert.equal(denied.denied, true); assert.deepEqual(await state(), baseline);
  const databaseFault = makeOwner({ failAfterAcceptance: true });
  await assert.rejects(databaseFault.owner.applyReportedObservations(applying), error => error.code === '22012');
  assert.equal(databaseFault.inserted, true); assert.deepEqual(await state(), baseline);
  checks.push('real post-insert PostgreSQL error and final source/report denial roll back successor section/history/acceptance and timestamps');
  // A genuinely competing proposal against the SAME populated predecessor.
  const competingRequest = request(), competing = await clean.owner.prepareReportedObservations(competingRequest);
  assert.equal(competing.status, 'proposed'); assert.deepEqual(competing.replacement, proposal.replacement);
  const competingApply = { ...competingRequest, operationId: randomUUID(), proposalOperationId: competingRequest.operationId,
    attachmentId: competing.attachment_ref.attachment_id, attachmentRevision: competing.attachment_ref.attachment_revision,
    bindingDigest: competing.attachment_ref.binding_digest, adopt: true, replacement: clone(competing.replacement) };
  baseline = await state();
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT assignment_file_id FROM app.custom_appraisal_workfiles WHERE assignment_file_id=$1 FOR UPDATE', [assignment]);
    await assert.rejects(clean.owner.applyReportedObservations(applying), error => error.code === '55P03');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  assert.deepEqual(await state(), baseline);
  const lost = makeOwner({ loseCommit: true });
  await assert.rejects(lost.owner.applyReportedObservations(applying), error => error.outcome_unknown === true);
  const committed = await state();
  assert.equal(committed.acceptances.length, 2);
  assert.equal(committed.history.filter(row => row.section_key === 'neighborhood_assessment').length, 2);
  const successor = await accepted(applying.operationId);
  assert.equal(successor.acceptedEditorRevision, 2); assert.notEqual(successor.id, original.id);
  const projection = projectCustomNeighborhoodReportSection({ section: successor.snapshot.section_value,
    expected: { organization_id: organization, report_file_id: report, assignment_file_id: assignmentNumber, account_id: account } });
  assert.equal(projection.status, 'ready'); assert.equal(projection.assessment.contract_version, 2);
  assert.equal(projection.assessment.selection.revision, '2'); assert.deepEqual(projection.assessment.selection.pocket_ids, []);
  assert.deepEqual(projection.assessment.geographic_neighborhood.geometry, geometry);
  assert.ok(projection.assessment.populations.every(population => population.member_count === 0));
  assert.equal(Object.keys(successor.snapshot.section_value.mapped_values).length, 5);
  assert.equal(Object.keys(successor.snapshot.section_value.decision.applied).length, 5);
  assert.deepEqual(committed.acceptances.find(row => row.id === original.id), originalAcceptanceRow);
  assert.deepEqual(committed.history.find(row => String(row.id) === original.sectionHistoryId), originalHistory);
  const retry = await clean.owner.applyReportedObservations(applying);
  assert.equal(retry.status, 'accepted'); assert.equal(retry.accepted_editor_revision, 2); assert.equal(retry.reused, true);
  assert.deepEqual(retry.replacement, proposal.replacement); assert.deepEqual(await state(), committed);
  checks.push('actual NOWAIT contention is finite; lost successor COMMIT ACK recovers exactly once at revision2 with two immutable groups and genuine changed zero-member statistics/outline');
  await assert.rejects(clean.owner.applyReportedObservations(competingApply), /editor|current|predecessor|changed|conflict/);
  await assert.rejects(accepted(original.operationId), /not_current_section/);
  const oldApply = { ...base, expectedWorkspaceRevision: 1, expectedEditorRevision: 0,
    operationId: fixture.apply_operation_id, proposalOperationId: fixture.proposal_operation_id,
    attachmentId: original.attachmentId, attachmentRevision: original.attachmentRevision,
    bindingDigest: original.snapshot.receipt.acceptance_manifest.binding_digest_sha256, adopt: true };
  await assert.rejects(clean.owner.applyReportedObservations(oldApply), /workspace_changed|not_current_section|conflict|changed/);
  await assert.rejects(clean.owner.applyReportedObservations({ ...applying, operationId: randomUUID() }), /editor|current|predecessor|changed|conflict/);
  assert.deepEqual(await state(), committed);
  const immutable = await pool.connect();
  try {
    for (const [sql, values] of [
      ["UPDATE app.custom_neighborhood_acceptances SET actor_user_id=$2 WHERE id=$1", [original.id, randomUUID()]],
      ["DELETE FROM app.custom_appraisal_workfile_section_history WHERE id=$1", [original.sectionHistoryId]],
      ["UPDATE app.custom_appraisal_workfile_section_history SET changed_by='tampered' WHERE id=$1", [successor.sectionHistoryId]],
    ]) {
      await immutable.query('BEGIN');
      try { await assert.rejects(immutable.query(sql, values), /immutable/); }
      finally { await immutable.query('ROLLBACK'); }
    }
  } finally { immutable.release(); }
  assert.deepEqual(await state(), committed); assert.equal(committed.signed_snapshots, 0);
  checks.push('losing replacement, old Apply replay and new-UUID replay cannot overwrite successor; both immutable histories and predecessor acceptance reject direct tampering');
  return { checks, predecessor_checks: fixture.checks, synthetic_target: target, context_ref: fixture.context_ref,
    predecessor_operation_id: original.operationId, replacement_proposal_operation_id: requested.operationId,
    replacement_apply_operation_id: applying.operationId, accepted_editor_revision: 2,
    predecessor: expectedPredecessor, successor: { acceptance_id: successor.id, section_history_id: successor.sectionHistoryId,
      section_value_sha256: successor.snapshot.section_value_sha256 }, geometry, effective_date: fixture.effective_date };
}
