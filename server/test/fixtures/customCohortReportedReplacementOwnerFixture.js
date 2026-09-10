import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createCustomCohortContextCapture } from '../../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { supportedInputsFixture } from './customCohortSupportedInputsFixture.js';

const one = value => ({ rows: value == null ? [] : [structuredClone(value)], rowCount: value == null ? 0 : 1 });
const empty = () => one(null), affected = () => ({ rows: [], rowCount: 1 });
export const REPLACEMENT_FIXTURE_NOW = '2026-09-10T16:00:00.123456Z';
const sqlHash = value => createHash('sha256').update(JSON.stringify(value, null, 1)).digest('hex');

/** Genuine retained acquisition/assembler/repositories, with explicit SQL-result
 * doubles retaining all immutable revisions. Snapshot rollback here is only a
 * deterministic failure test, NOT PostgreSQL isolation/trigger/locking proof. */
export async function reportedReplacementOwnerFixture() {
  const f = await supportedInputsFixture({ assignmentFileId: '41', effectiveDate: '2026-09-10', saleCount: 1 });
  const subject = f.input.retained_inputs.subject, target = subject.target;
  const actor = f.input.retained_inputs.acquisition_intent.body.actor_user_id;
  const shape = { neighborhood_boundary_source: 'appraiser_defined_area_manual_v2',
    neighborhood_boundary_geometry: { type: 'Polygon', coordinates: [[[-97, 32], [-96, 32], [-96, 34], [-97, 34], [-97, 32]]] },
    neighborhood_boundary_north: 'Recorded north', neighborhood_boundary_east: 'Recorded east',
    neighborhood_boundary_south: 'Recorded south', neighborhood_boundary_west: 'Recorded west' };
  const encoded = JSON.stringify(shape);
  const state = { calls: [], phases: 0, commits: 0, releases: [], afterCommit: null, beforeQuery: null, afterQuery: null,
    reportPolicy: null, marketPolicy: null, db: {
      workspace: { revision: 9, value: { workspace_version: 1, pending_capture: null, active: {
        context_ref: f.input.expected.context_ref, observation_period: f.input.expected.observation_period,
        selection: { revision: 3, included_recorded_group_ids: f.input.selection.included_recorded_group_ids } } } },
      workfile: { status: 'draft', signed_at: null, has_signed_snapshot: false },
      assignment: { assignment_file_id: '41', account_id: target.account_id, organization_id: target.organization_id,
        assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null },
      boundary: { assignment_file_id: '41', account_id: target.account_id, assignment_revision: 1, details_type: 'object',
        projected_json: encoded, projected_utf8_bytes: Buffer.byteLength(encoded), projected_sha256: createHash('sha256').update(encoded).digest('hex') },
      head: { id: randomUUID(), request_generation: 0, next_revision: 1, requested_job_id: null },
      editor: null, section: null, histories: new Map(), acceptances: new Map(), attachments: new Map(),
      assessments: new Map(), jobs: new Map(), operations: new Map(), unrelated: { sales_comparison: { unchanged: true } },
    } };
  const input = { auth: { userId: actor, organizations: [{ organizationId: target.organization_id, roles: ['appraiser'] }] },
    accountId: target.account_id, assignmentFileId: '41', contextRef: f.input.expected.context_ref,
    expectedWorkspaceRevision: 9, expectedEditorRevision: 0, operationId: randomUUID() };
  const published = assessment => ({ assessment, stored_assessment_id: assessment.id, stored_assessment_revision: assessment.revision,
    stored_evidence_digest: assessment.evidence_digest_sha256, report_file_id: target.report_file_id, organization_id: target.organization_id,
    account_id: target.account_id, appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id,
    workflow_type: 'custom_appraisal', custom_assignment_file_id: '41', uad_workfile_id: null,
    case_organization_id: target.organization_id, case_account_id: target.account_id, snapshot_case_id: target.appraisal_case_id,
    case_effective_date: subject.effective_date, snapshot_effective_date: subject.effective_date, canonical_effective_date: subject.effective_date,
    target_organization_id: target.organization_id, target_account_id: target.account_id });
  async function execute(text, v) {
    const d = state.db;
    if (text.includes('custom-cohort-capture:assignment')) return one(d.assignment);
    if (text.includes('custom-cohort-capture:report */')) return one({ report_file_id: target.report_file_id,
      appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id });
    if (text.includes('private-workfile')) return one(d.workfile);
    if (text.includes('workspace-parent')) return one({ assignment_file_id: '41' });
    if (text.includes('custom-cohort-capture:workspace */')) return one(d.workspace);
    if (text.includes('report-editor')) return one(d.editor);
    if (text.includes('report-geography */')) return one(d.boundary);
    if (text.includes('report-geography-topology')) return one({ is_valid: true, validation_reason: 'Synthetic oracle',
      postgis_version: 'synthetic', geometry_type: 'ST_Polygon', is_empty: false, component_count: 1,
      covers_recorded_subject_point: true, contains_recorded_subject_point: true });
    if (text.includes('custom-cohort-capture:time')) return one({ value: REPLACEMENT_FIXTURE_NOW });
    if (text.includes('reported-never-accepted')) return one({ has_acceptance: d.acceptances.size > 0 });
    if (text.includes('reported-predecessor')) return one(d.section ? { revision: d.editor.revision, operation_id: d.section.operation_id } : null);
    if (text.includes('reported-operation')) {
      const op = d.operations.get(v[4]); if (!op) return empty();
      const job = d.jobs.get(op.job_id); return one({ ...job, payload: job.request_payload, operation_digest: op.request_digest_sha256 });
    }
    if (text.includes('neighborhood:caller-transaction')) return one({ isolation: 'read committed', read_only: 'off' });
    if (text.includes('neighborhood:scope')) return one({ effective_date: subject.effective_date, case_date: subject.effective_date, snapshot_date: subject.effective_date });
    if (text.includes('neighborhood:ensure-head')) return affected();
    if (/neighborhood:(head-for-scope|lock-head)/.test(text)) return one({ ...d.head, organization_id: target.organization_id,
      appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id, account_id: target.account_id });
    if (text.includes('neighborhood:request-operation')) return one(d.operations.get(v[1]));
    if (text.includes('neighborhood:deduplicate')) return one([...d.jobs.values()].find(j => j.input_signature_sha256 === v[1]));
    if (text.includes('neighborhood:enqueue')) { const job = { id: v[0], assessment_id: v[1], input_signature_sha256: v[2],
      request_digest_sha256: v[3], request_payload: JSON.parse(v[4]), effective_date: v[5], data_cutoff: v[6], request_generation: v[7],
      max_attempts: v[8], attempts: 0, status: 'queued', result_revision: null }; d.jobs.set(job.id, job); return one(job); }
    if (text.includes('neighborhood:request-pointer')) { d.head.request_generation = v[1]; d.head.requested_job_id = v[2]; return affected(); }
    if (text.includes('neighborhood:record-request')) { d.operations.set(v[1], { request_digest_sha256: v[2], job_id: v[3], request_generation: v[4] }); return affected(); }
    if (/neighborhood:(exact-job-head|job-head)/.test(text)) return one({ assessment_id: d.head.id });
    if (text.includes('neighborhood:exact-job-lock')) return one(d.jobs.get(v[1]));
    if (text.includes('neighborhood:exact-claim')) { const j = d.jobs.get(v[1]); Object.assign(j, { claim_token: v[2], status: 'running', attempts: 1 }); return one(j); }
    if (text.includes('neighborhood:publication-fence')) return one(d.jobs.get(v[0]));
    if (text.includes('neighborhood:revision')) { d.assessments.set(v[1], JSON.parse(v[4])); return affected(); }
    if (/neighborhood:(source|population|members|publish) \*/.test(text)) return affected();
    if (text.includes('neighborhood:promote')) { d.head.next_revision = v[1]; d.head.current_revision = v[3]; return affected(); }
    if (text.includes('neighborhood:finish')) { Object.assign(d.jobs.get(v[0]), { status: 'succeeded', result_revision: v[3] }); return affected(); }
    if (text.includes('neighborhood-application:published-context')) return one(published(d.assessments.get(v[5])));
    if (text.includes('neighborhood-application:insert-attachment')) {
      d.attachments.set(v[0], { attachment: JSON.parse(v[11]), mapped_suggestions: JSON.parse(v[12]) }); return one({ attachment_id: v[0] });
    }
    if (text.includes('neighborhood-application:exact-attachment')) {
      const a = d.attachments.get(v[4]); if (!a || a.attachment.attachment_revision !== v[5]) return empty();
      return one({ ...published(d.assessments.get(a.attachment.assessment_revision)), ...a,
        attachment_id: a.attachment.attachment_id, attachment_revision: a.attachment.attachment_revision,
        binding_digest_sha256: a.attachment.binding_digest_sha256, application_identity_sha256: a.attachment.application_identity_sha256 });
    }
    if (text.includes('custom-neighborhood-acceptance:exact-operation')) {
      const a = d.acceptances.get(v[3]); if (!a || !d.section) return empty();
      const history = d.histories.get(a.accepted_editor_revision);
      return one({ ...a, history_value: history?.value, history_revision: history?.revision,
        current_value: d.section, current_revision: d.editor.revision });
    }
    if (text.includes('SELECT assignment_file.id, assignment_file.file_number')) return one({ id: 41, file_number: 'Synthetic only' });
    if (text.includes('INSERT INTO app.custom_appraisal_workfiles')) return empty();
    if (text.includes('SELECT status FROM app.custom_appraisal_workfiles')) return one({ status: d.workfile.status });
    if (text.includes('SELECT revision FROM app.custom_appraisal_workfile_sections')) return one(d.editor);
    if (text.includes('INSERT INTO app.custom_appraisal_workfile_sections')) {
      d.section = JSON.parse(v[2]); d.editor = { revision: v[3], value_sha256: sqlHash(d.section) };
      return one({ section_key: v[1], section_value: d.section, revision: v[3], updated_by: v[4], updated_at: REPLACEMENT_FIXTURE_NOW });
    }
    if (text.includes('INSERT INTO app.custom_appraisal_workfile_section_history')) {
      assert.equal(d.histories.has(v[3]), false); d.histories.set(v[3], { id: String(v[3]), revision: v[3], value: JSON.parse(v[2]) }); return empty();
    }
    if (text.includes('UPDATE app.custom_appraisal_workfiles SET updated_at') || text.includes('UPDATE app.assignment_files SET updated_at')) return empty();
    if (text.includes('custom-neighborhood-save:history')) return one({ id: d.histories.get(v[2])?.id });
    if (text.includes('custom-neighborhood-acceptance:insert')) {
      if (d.acceptances.has(v[8])) return empty();
      const a = Object.fromEntries(['id', 'organization_id', 'report_file_id', 'assignment_file_id', 'account_id', 'attachment_id',
        'attachment_revision', 'application_identity_sha256', 'operation_id', 'actor_user_id', 'section_key', 'section_history_id',
        'accepted_editor_revision', 'section_bytes_sha256', 'section_json_utf8', 'decision'].map((key, index) => [key, key === 'decision' ? JSON.parse(v[index]) : v[index]]));
      d.acceptances.set(a.operation_id, a); return one({ id: a.id });
    }
    return f.base.client.query(text, v);
  }
  const pool = { async connect() { const phase = ++state.phases; let snapshot = null; const savepoints = new Map();
    return { release(error) { if (snapshot) state.db = snapshot; state.releases.push(error); },
      async query(config) {
        const text = typeof config === 'string' ? config : config.text, v = config.values ?? [];
        state.calls.push({ text, values: structuredClone(v), phase }); await state.beforeQuery?.(text, v);
        if (text.startsWith('BEGIN ')) { snapshot = structuredClone(state.db); return empty(); }
        if (text === 'COMMIT') { snapshot = null; state.commits++; await state.afterCommit?.(); return empty(); }
        if (text === 'ROLLBACK') { if (snapshot) state.db = snapshot; snapshot = null; return empty(); }
        if (text.startsWith('SAVEPOINT ')) { savepoints.set(text.slice(10), structuredClone(state.db)); return empty(); }
        if (text.startsWith('ROLLBACK TO SAVEPOINT ')) { state.db = structuredClone(savepoints.get(text.slice(22))); return empty(); }
        if (text.startsWith('RELEASE SAVEPOINT ') || text.startsWith('SET LOCAL ')) return empty();
        const result = await execute(text, v); await state.afterQuery?.(text, v, result); return result;
      } };
  } };
  const service = createCustomCohortContextCapture({ pool,
    authorizeMarketData: async () => state.marketPolicy?.() ?? { allowed: true, ...f.input.retained_inputs.acquisition.captured_query_request.market_decision },
    authorizeReportedObservations: async () => state.reportPolicy?.() ?? { allowed: true, decision_id: 'synthetic-report', policy_revision: 'v1' } });
  const applyInput = (request, proposal) => ({ ...request, operationId: randomUUID(), proposalOperationId: request.operationId,
    attachmentId: proposal.attachment_ref.attachment_id, attachmentRevision: proposal.attachment_ref.attachment_revision,
    bindingDigest: proposal.attachment_ref.binding_digest, adopt: true,
    ...(proposal.replacement ? { replacement: proposal.replacement } : {}) });
  function replacementInput() {
    const d = state.db; d.workspace.revision++; d.workspace.value.active.selection.revision++;
    const labels = JSON.parse(d.boundary.projected_json); labels.neighborhood_boundary_north += ' revised';
    const json = JSON.stringify(labels); d.boundary = { ...d.boundary, assignment_revision: d.boundary.assignment_revision + 1,
      projected_json: json, projected_utf8_bytes: Buffer.byteLength(json), projected_sha256: createHash('sha256').update(json).digest('hex') };
    return { ...input, expectedWorkspaceRevision: d.workspace.revision, expectedEditorRevision: d.editor?.revision ?? 0,
      operationId: randomUUID(), replacement: { kind: 'accepted_custom_reported_group' } };
  }
  async function acceptFirst() {
    const proposal = await service.prepareReportedObservations(input), apply = applyInput(input, proposal);
    const accepted = await service.applyReportedObservations(apply); return { proposal, apply, accepted };
  }
  return { f, state, pool, service, input, target, applyInput, replacementInput, acceptFirst, sqlHash };
}
