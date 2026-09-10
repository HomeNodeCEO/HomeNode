import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { supportedInputsFixture } from './fixtures/customCohortSupportedInputsFixture.js';

const one = value => ({ rows: value === null ? [] : [structuredClone(value)], rowCount: value === null ? 0 : 1 });
const empty = () => one(null);
const NOW = '2026-09-10T16:00:00.123456Z';
// Actual acquisition, retained graph, assembler, publication and attachment
// validators. SQL result doubles below are NOT PostgreSQL/lock/rollback proof.
async function fixture({ incomplete = false, historical = false, policy, afterCommit, failSql } = {}) {
  const f = await supportedInputsFixture({ assignmentFileId: '41', effectiveDate: historical ? '2024-06-30' : '2026-09-10', saleCount: 1 });
  const subject = f.input.retained_inputs.subject, target = subject.target, actor = f.input.retained_inputs.acquisition_intent.body.actor_user_id;
  const workspace = { revision: 9, value: { workspace_version: 1, pending_capture: null, active: {
    context_ref: f.input.expected.context_ref, observation_period: f.input.expected.observation_period,
    selection: { revision: 3, included_recorded_group_ids: f.input.selection.included_recorded_group_ids } } } };
  const shape = incomplete ? {} : { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
    neighborhood_boundary_north: 'Recorded north', neighborhood_boundary_east: 'Recorded east',
    neighborhood_boundary_south: 'Recorded south', neighborhood_boundary_west: 'Recorded west' };
  const encoded = JSON.stringify(shape);
  const state = { calls: [], phases: 0, reportVisits: 0, commits: 0, workspace,
    workfile: { status: 'draft', signed_at: null, has_signed_snapshot: false }, editor: null,
    assignment: { assignment_file_id: '41', account_id: target.account_id, organization_id: target.organization_id,
      assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null },
    boundary: { assignment_file_id: '41', account_id: target.account_id, assignment_revision: 1, details_type: 'object',
      projected_json: encoded, projected_utf8_bytes: Buffer.byteLength(encoded), projected_sha256: createHash('sha256').update(encoded).digest('hex') },
    head: { id: randomUUID(), request_generation: 0, next_revision: 1, requested_job_id: null }, jobs: new Map(), operations: new Map(),
    assessment: null, attachment: null, suggestions: null, releases: [], retainedAcceptance: false,
    section: null, acceptance: null, historyCount: 0 };
  const input = { auth: { userId: actor, organizations: [{ organizationId: target.organization_id, roles: ['appraiser'] }] },
    accountId: target.account_id, assignmentFileId: '41', contextRef: f.input.expected.context_ref,
    expectedWorkspaceRevision: 9, expectedEditorRevision: 0, operationId: randomUUID() };
  const publishedContext = () => ({ assessment: state.assessment, stored_assessment_id: state.assessment.id,
    stored_assessment_revision: state.assessment.revision, stored_evidence_digest: state.assessment.evidence_digest_sha256,
    report_file_id: target.report_file_id, organization_id: target.organization_id, account_id: target.account_id,
    appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id,
    workflow_type: 'custom_appraisal', custom_assignment_file_id: '41', uad_workfile_id: null,
    case_organization_id: target.organization_id, case_account_id: target.account_id,
    snapshot_case_id: target.appraisal_case_id, case_effective_date: subject.effective_date,
    snapshot_effective_date: subject.effective_date, canonical_effective_date: subject.effective_date,
    target_organization_id: target.organization_id, target_account_id: target.account_id });
  const pool = { async connect() { const phase = ++state.phases; return { release(error) { state.releases.push(error); },
    async query({ text, values: v = [] }) {
      state.calls.push({ text, values: structuredClone(v), phase });
      if (failSql) await failSql(text, state);
      if (text === 'COMMIT') { state.commits++; if (afterCommit) await afterCommit(state); return empty(); }
      if (/^(BEGIN |SET LOCAL |ROLLBACK$|SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT )/.test(text)) return empty();
      if (text.includes('custom-cohort-capture:assignment')) return one(state.assignment);
      if (text.includes('custom-cohort-capture:report */')) return one({ report_file_id: target.report_file_id,
        appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id });
      if (text.includes('private-workfile')) return one(state.workfile);
      if (text.includes('workspace-parent')) return one({ assignment_file_id: '41' });
      if (text.includes('custom-cohort-capture:workspace */')) return one(state.workspace);
      if (text.includes('report-editor')) return one(state.editor);
      if (text.includes('report-geography */')) return one(state.boundary);
      if (text.includes('report-geography-topology')) return one({ is_valid: true, validation_reason: 'Synthetic oracle',
        postgis_version: 'synthetic', geometry_type: 'ST_Polygon', is_empty: false, component_count: 1,
        covers_recorded_subject_point: true, contains_recorded_subject_point: true });
      if (text.includes('custom-cohort-capture:time')) return one({ value: NOW });
      if (text.includes('reported-never-accepted')) return one({ has_acceptance: state.retainedAcceptance });
      if (text.includes('reported-operation')) {
        const op = state.operations.get(v[4]); if (!op) return empty();
        const job = state.jobs.get(op.job_id);
        return one({ ...job, payload: job.request_payload, operation_digest: op.request_digest_sha256 });
      }
      if (text.includes('neighborhood:caller-transaction')) return one({ isolation: 'read committed', read_only: 'off' });
      if (text.includes('neighborhood:scope')) return one({ effective_date: subject.effective_date, case_date: subject.effective_date, snapshot_date: subject.effective_date });
      if (text.includes('neighborhood:ensure-head')) return { rows: [], rowCount: 1 };
      if (/neighborhood:(head-for-scope|lock-head)/.test(text)) return one({ ...state.head,
        organization_id: target.organization_id, appraisal_case_id: target.appraisal_case_id,
        subject_snapshot_id: target.subject_snapshot_id, account_id: target.account_id });
      if (text.includes('neighborhood:request-operation')) return one(state.operations.get(v[1]) ?? null);
      if (text.includes('neighborhood:deduplicate')) return one([...state.jobs.values()].find(j => j.input_signature_sha256 === v[1]) ?? null);
      if (text.includes('neighborhood:enqueue')) { const job = { id: v[0], assessment_id: v[1], input_signature_sha256: v[2],
        request_digest_sha256: v[3], request_payload: JSON.parse(v[4]), effective_date: v[5], data_cutoff: v[6], request_generation: v[7],
        max_attempts: v[8], attempts: 0, status: 'queued', result_revision: null }; state.jobs.set(job.id, job); return one(job); }
      if (text.includes('neighborhood:request-pointer')) { state.head.request_generation = v[1]; state.head.requested_job_id = v[2]; return { rows: [], rowCount: 1 }; }
      if (text.includes('neighborhood:record-request')) { state.operations.set(v[1], { request_digest_sha256: v[2], job_id: v[3], request_generation: v[4] }); return { rows: [], rowCount: 1 }; }
      if (/neighborhood:(exact-job-head|job-head)/.test(text)) return one({ assessment_id: state.head.id });
      if (text.includes('neighborhood:exact-job-lock')) return one(state.jobs.get(v[1]));
      if (text.includes('neighborhood:exact-claim')) { const job = state.jobs.get(v[1]); Object.assign(job, { claim_token: v[2], status: 'running', attempts: 1 }); return one(job); }
      if (text.includes('neighborhood:publication-fence')) return one(state.jobs.get(v[0]));
      if (text.includes('neighborhood:revision')) { state.assessment = JSON.parse(v[4]); return { rows: [], rowCount: 1 }; }
      if (/neighborhood:(source|population|members|publish|promote) \*/.test(text)) return { rows: [], rowCount: 1 };
      if (text.includes('neighborhood:finish')) { Object.assign(state.jobs.get(v[0]), { status: 'succeeded', result_revision: v[3] }); return { rows: [], rowCount: 1 }; }
      if (text.includes('neighborhood-application:published-context')) return one(publishedContext());
      if (text.includes('neighborhood-application:insert-attachment')) { state.attachment = JSON.parse(v[11]); state.suggestions = JSON.parse(v[12]); return one({ attachment_id: v[0] }); }
      if (text.includes('neighborhood-application:exact-attachment')) return state.attachment ? one({ ...publishedContext(),
        attachment: state.attachment, mapped_suggestions: state.suggestions, attachment_id: state.attachment.attachment_id,
        attachment_revision: state.attachment.attachment_revision, binding_digest_sha256: state.attachment.binding_digest_sha256,
        application_identity_sha256: state.attachment.application_identity_sha256 }) : empty();
      if (text.includes('custom-neighborhood-acceptance:exact-operation')) return state.acceptance?.operation_id === v[3]
        ? one({ ...state.acceptance, history_value: state.section, history_revision: state.editor.revision,
          current_value: state.section, current_revision: state.editor.revision }) : empty();
      if (text.includes('SELECT assignment_file.id, assignment_file.file_number')) return one({ id: 41, file_number: 'Synthetic only' });
      if (text.includes('INSERT INTO app.custom_appraisal_workfiles')) return empty();
      if (text.includes('SELECT status FROM app.custom_appraisal_workfiles')) return one({ status: state.workfile.status });
      if (text.includes('SELECT revision FROM app.custom_appraisal_workfile_sections')) return one(state.editor);
      if (text.includes('INSERT INTO app.custom_appraisal_workfile_sections')) {
        state.section = JSON.parse(v[2]); state.editor = { revision: v[3], value_sha256: createHash('sha256').update(v[2]).digest('hex') };
        return one({ section_key: v[1], section_value: state.section, revision: v[3], updated_by: v[4], updated_at: NOW });
      }
      if (text.includes('INSERT INTO app.custom_appraisal_workfile_section_history')) { state.historyCount++; return empty(); }
      if (text.includes('UPDATE app.custom_appraisal_workfiles SET updated_at') || text.includes('UPDATE app.assignment_files SET updated_at')) return empty();
      if (text.includes('custom-neighborhood-save:history')) return one({ id: '1' });
      if (text.includes('custom-neighborhood-acceptance:insert')) {
        state.acceptance = Object.fromEntries(['id', 'organization_id', 'report_file_id', 'assignment_file_id', 'account_id',
          'attachment_id', 'attachment_revision', 'application_identity_sha256', 'operation_id', 'actor_user_id', 'section_key',
          'section_history_id', 'accepted_editor_revision', 'section_bytes_sha256', 'section_json_utf8', 'decision'].map((key, index) => [key, key === 'decision' ? JSON.parse(v[index]) : v[index]]));
        return one({ id: v[0] });
      }
      return f.base.client.query(text, v);
    } }; } };
  const service = createCustomCohortContextCapture({ pool,
    authorizeMarketData: async () => ({ allowed: true, ...f.input.retained_inputs.acquisition.captured_query_request.market_decision }),
    authorizeReportedObservations: async (_client, _auth, _context, purpose, requested) => {
      assert.deepEqual(requested, { retention: true, exposure: 'custom_report_observations' });
      assert.equal(purpose.kind, 'custom_reported_observations_v2'); assert.equal(purpose.private_sales_import, null);
      state.reportVisits++; return policy ? policy(state) : { allowed: true, decision_id: 'synthetic-report', policy_revision: 'v1' };
    } });
  return { f, service, input, state };
}

test('actual owner publishes complete selected v2 bundle and attachment in one final transaction; bounded response only', async () => {
  const f = await fixture(), result = await f.service.prepareReportedObservations(f.input);
  assert.equal(result.status, 'proposed'); assert.equal(result.editor_revision, 0); assert.equal(result.workspace_section_revision, 9);
  assert.equal(result.assessment.contract_version, 2); assert.equal(result.assessment.assessment_id, f.state.head.id);
  assert.deepEqual(result.assessment.boundary, { geometry: f.state.assessment.geographic_neighborhood.geometry,
    cardinal_summaries: f.state.assessment.geographic_neighborhood.cardinal_summaries });
  assert.deepEqual(Object.keys(result.assessment.boundary).sort(), ['cardinal_summaries', 'geometry']);
  assert.equal(f.state.commits, 2); assert.ok(Object.isFrozen(result));
  const wire = JSON.stringify(result); assert.ok(Buffer.byteLength(wire) <= 524288);
  for (const forbidden of ['source_payload', 'member_data', 'raw_projection', 'publication_bundle', 'actor_user_id']) assert.ok(!wire.includes(forbidden));
  const writes = f.state.calls.filter(c => /\bINSERT INTO app\./.test(c.text)); assert.ok(writes.length > 0);
  assert.ok(writes.every(c => c.phase === 2));
  assert.ok(!f.state.calls.some(c => /custom_appraisal_workfile_section_history|custom_neighborhood_acceptances/.test(c.text)));
  assert.equal(f.state.calls.filter(c => c.text.startsWith('BEGIN')).length, 2, 'no nested pool transaction');
  assert.ok(f.state.calls.findIndex(c => c.text.includes('private-workfile')) < f.state.calls.findIndex(c => c.text.includes('custom-cohort-capture:assignment') && /FOR UPDATE/.test(c.text)));
});
test('exact committed proposal replay returns original published identities without enqueue/publication', async () => {
  const f = await fixture(), first = await f.service.prepareReportedObservations(f.input), count = f.state.calls.length;
  const replay = await f.service.prepareReportedObservations(f.input);
  assert.deepEqual({ ...replay, reused: false }, first); assert.equal(replay.reused, true);
  assert.ok(!f.state.calls.slice(count).some(c => /\bINSERT INTO app\./.test(c.text)));
});
for (const options of [{ incomplete: true }, { historical: true }]) test(`honest unavailable proposal never enqueues ${JSON.stringify(options)}`, async () => {
  const f = await fixture(options), result = await f.service.prepareReportedObservations(f.input);
  assert.equal(result.status, 'incomplete'); assert.equal(result.attachment_ref, null); assert.equal(result.assessment, null);
  assert.ok(result.issues.length); assert.equal(f.state.jobs.size, 0); assert.equal(f.state.commits, 2);
});
test('default/denied report rights stop before retained full graph and before any writes', async () => {
  const f = await fixture({ policy: () => ({ allowed: false }) });
  await assert.rejects(f.service.prepareReportedObservations(f.input), { reason: 'report_observation_access_denied' });
  assert.equal(f.state.jobs.size, 0); assert.equal(f.state.commits, 0);
  assert.ok(!f.state.calls.some(c => c.text.includes('report-geography')));
});
for (const [name, mutate] of [
  ['workspace', state => { state.workspace.revision++; }],
  ['editor', state => { state.editor = { revision: 1, value_sha256: 'a'.repeat(64) }; }],
  ['boundary', state => { state.boundary.assignment_revision++; }],
  ['assignment', state => { state.assignment.assigned_appraiser_user_id = randomUUID(); }],
  ['signing', state => { state.workfile.status = 'signed'; }],
]) test(`final ${name} change rejects before publication`, async () => {
  const f = await fixture({ afterCommit: state => { if (state.commits === 1) mutate(state); } });
  await assert.rejects(f.service.prepareReportedObservations(f.input)); assert.equal(f.state.jobs.size, 0);
});
test('report grant revocation after assembly rolls back rather than publishes', async () => {
  const f = await fixture({ policy: state => state.commits ? { allowed: false } : { allowed: true, decision_id: 'synthetic-report', policy_revision: 'v1' } });
  await assert.rejects(f.service.prepareReportedObservations(f.input), { reason: 'report_observation_access_denied' });
  assert.equal(f.state.jobs.size, 0); assert.equal(f.state.calls.at(-1).text, 'ROLLBACK');
});
test('ambiguous publication COMMIT is not success; exact operation retries recover committed identities', async () => {
  let lost = false;
  const f = await fixture({ failSql: (text, state) => { if (!lost && text === 'COMMIT' && state.phases === 2) { lost = true; throw new Error('synthetic lost ack'); } } });
  await assert.rejects(f.service.prepareReportedObservations(f.input), error => error.outcome_unknown === true);
  const result = await f.service.prepareReportedObservations(f.input); assert.equal(result.reused, true);
  assert.equal(f.state.jobs.size, 1); assert.equal(result.assessment.assessment_id, f.state.head.id);
});
test('Apply requires exact proposal reference and rejects occupied group without overwriting', async () => {
  const f = await fixture(), proposal = await f.service.prepareReportedObservations(f.input);
  const apply = { ...f.input, operationId: randomUUID(), proposalOperationId: f.input.operationId,
    attachmentId: proposal.attachment_ref.attachment_id, attachmentRevision: 1, bindingDigest: proposal.attachment_ref.binding_digest, adopt: true };
  await assert.rejects(f.service.applyReportedObservations({ ...apply, bindingDigest: 'a'.repeat(64) }), { reason: 'operation_conflict' });
  f.state.editor = { revision: 1, value_sha256: 'a'.repeat(64) };
  await assert.rejects(f.service.applyReportedObservations(apply), { reason: 'report_editor_changed' });
  assert.ok(!f.state.calls.some(c => c.text.includes('INSERT INTO app.custom_')));
});
test('absent section with retained acceptance history cannot be treated as an empty report', async () => {
  const f = await fixture(), proposal = await f.service.prepareReportedObservations(f.input);
  f.state.retainedAcceptance = true;
  await assert.rejects(f.service.applyReportedObservations({ ...f.input, operationId: randomUUID(),
    proposalOperationId: f.input.operationId, attachmentId: proposal.attachment_ref.attachment_id,
    attachmentRevision: 1, bindingDigest: proposal.attachment_ref.binding_digest, adopt: true }), { reason: 'report_group_conflict' });
  assert.ok(!f.state.calls.some(c => c.text.includes('INSERT INTO app.custom_')));
});
test('first Apply uses real complete acceptance/save machinery and exact replay never adds history', async () => {
  const f = await fixture(), proposal = await f.service.prepareReportedObservations(f.input);
  const input = { ...f.input, operationId: randomUUID(), proposalOperationId: f.input.operationId,
    attachmentId: proposal.attachment_ref.attachment_id, attachmentRevision: 1,
    bindingDigest: proposal.attachment_ref.binding_digest, adopt: true };
  const accepted = await f.service.applyReportedObservations(input);
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.accepted_editor_revision, 1); assert.equal(accepted.reused, false);
  assert.equal(f.state.historyCount, 1); assert.equal(Object.keys(f.state.section.mapped_values).length, 5);
  assert.equal(f.state.section.actor_user_id, f.input.auth.userId); assert.equal(f.state.section.operation_id, input.operationId);
  const count = f.state.calls.length, replay = await f.service.applyReportedObservations(input);
  assert.deepEqual({ ...replay, reused: false }, accepted); assert.equal(replay.reused, true); assert.equal(f.state.historyCount, 1);
  assert.ok(!f.state.calls.slice(count).some(c => /\bINSERT INTO|\bUPDATE app\./.test(c.text)));
  f.state.workfile = { status: 'signed', signed_at: NOW, has_signed_snapshot: true };
  const signed = await f.service.applyReportedObservations(input); assert.equal(signed.reused, true); assert.equal(f.state.historyCount, 1);
});
test('lost Apply COMMIT acknowledgement recovers exact accepted receipt without another section save', async () => {
  let lose = false, lost = false;
  const f = await fixture({ failSql: text => { if (lose && !lost && text === 'COMMIT') { lost = true; throw new Error('lost synthetic commit'); } } });
  const proposal = await f.service.prepareReportedObservations(f.input);
  const input = { ...f.input, operationId: randomUUID(), proposalOperationId: f.input.operationId,
    attachmentId: proposal.attachment_ref.attachment_id, attachmentRevision: 1,
    bindingDigest: proposal.attachment_ref.binding_digest, adopt: true };
  lose = true;
  await assert.rejects(f.service.applyReportedObservations(input), error => error.outcome_unknown === true);
  const result = await f.service.applyReportedObservations(input); assert.equal(result.reused, true); assert.equal(f.state.historyCount, 1);
});
for (const field of ['expectedEditorRevision', 'expectedWorkspaceRevision', 'operationId']) test(`malformed ${field} rejects before acquiring a client`, async () => {
  const f = await fixture(); await assert.rejects(f.service.prepareReportedObservations({ ...f.input, [field]: null }), { reason: 'invalid_reported_input' });
  assert.equal(f.state.phases, 0);
});
