import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { buildCustomCohortReportPreparation } from '../src/services/neighborhoodAssessment/customCohortReportPreparation.js';
import { buildCustomCohortSupportedInputs } from '../src/services/neighborhoodAssessment/customCohortSupportedInputs.js';
import { supportedInputsFixture } from './fixtures/customCohortSupportedInputsFixture.js';

const NOW = '2026-09-09T12:00:00.123456Z', HASH = 'a'.repeat(64);
const one = value => ({ rowCount: value === null ? 0 : 1, rows: value === null ? [] : [structuredClone(value)] });
const mutationSql = /\b(?:INSERT\s+INTO|UPDATE\s+app\.|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)\b/i;

/** Actual original reader/retention/review repositories and calculation modules.
 * Only bounded database response rows and transaction mechanics are faked. The
 * small assignment identity is selected BEFORE original acquisition, not by
 * relabeling a retained graph. No PostgreSQL/MVCC or production-rights claim.
 */
async function setup({ assignmentFileId = '41', reviewed = false, emptySelection = false,
  editor = { revision: 3, value_sha256: HASH }, afterFirstCommit, policy } = {}) {
  const f = await supportedInputsFixture({ assignmentFileId, saleCount: 1 });
  if (reviewed) await f.reviewAll();
  const adapter = await f.adapterInput(), target = f.input.retained_inputs.subject.target;
  const actor = f.input.retained_inputs.acquisition_intent.body.actor_user_id;
  const workspace = { revision: 19, value: { workspace_version: 1, pending_capture: null, active: {
    context_ref: f.input.expected.context_ref, observation_period: f.input.expected.observation_period,
    selection: { revision: 7, included_recorded_group_ids: emptySelection ? [] : [...f.input.selection.included_recorded_group_ids] },
  } } };
  const state = { workspace, editor, connects: 0, calls: [], policies: [], releases: [],
    assignment: { assignment_file_id: assignmentFileId, account_id: target.account_id, organization_id: target.organization_id,
      assigned_appraiser_user_id: actor, supervisory_appraiser_user_id: null },
    report: { report_file_id: target.report_file_id, appraisal_case_id: target.appraisal_case_id, subject_snapshot_id: target.subject_snapshot_id },
    editorResponse: null };
  const request = { auth: { userId: actor, organizations: [{ organizationId: target.organization_id, roles: ['appraiser'] }] },
    accountId: target.account_id, assignmentFileId, contextRef: structuredClone(f.input.expected.context_ref),
    expectedWorkspaceRevision: 19, expectedReviewGeneration: adapter.review_state.binding.generation };
  const grant = f.input.retained_inputs.acquisition.captured_query_request.market_decision;
  const owner = createCustomCohortContextCapture({ pool: { async connect() {
    const phase = ++state.connects;
    return { release(error) { state.releases.push({ phase, error }); }, async query(config) {
      const { text, values } = config; state.calls.push({ phase, ...config });
      assert.ok(Number.isFinite(config.query_timeout) && config.query_timeout > 0 && config.query_timeout <= 6000);
      assert.equal(mutationSql.test(text), false, `preparation must not write: ${text}`);
      if (text === 'COMMIT' && phase === 1 && afterFirstCommit) await afterFirstCommit({ f, state, request });
      if (/^(?:BEGIN |SET LOCAL |COMMIT$|ROLLBACK$)/.test(text)) return one(null);
      if (text.includes('custom-cohort-capture:assignment')) {
        assert.match(text, /FOR UPDATE NOWAIT/); assert.deepEqual(values, [assignmentFileId, target.account_id]);
        return one(state.assignment);
      }
      if (text.includes('custom-cohort-capture:report */')) return one(state.report);
      if (text.includes('custom-cohort-capture:workspace-parent')) {
        assert.match(text, /FOR SHARE NOWAIT/); return one({ assignment_file_id: assignmentFileId });
      }
      if (text.includes('custom-cohort-capture:workspace */')) {
        assert.deepEqual(values, [assignmentFileId, 'neighborhood_workspace', 65_536]);
        assert.match(text, /FOR SHARE NOWAIT/); return one(state.workspace);
      }
      if (text.includes('custom-cohort-capture:report-editor')) {
        assert.match(text, /octet_length\(section_value::text\) <= 4000000/);
        assert.match(text, /sha256\(convert_to\(section_value::text,'UTF8'\)\)/);
        assert.match(text, /FOR SHARE NOWAIT/); assert.deepEqual(values, [assignmentFileId, 'neighborhood_assessment']);
        return state.editorResponse ?? one(state.editor);
      }
      if (text.includes('custom-cohort-capture:report-geography */')) {
        assert.equal(values[0], assignmentFileId); assert.equal(values[1], target.account_id);
        assert.equal(values[2].length, 10); assert.equal(values[3], 262144);
        return one({ assignment_file_id: assignmentFileId, account_id: target.account_id, assignment_revision: 1,
          details_type: 'object', projected_utf8_bytes: 2, projected_json: '{}',
          projected_sha256: createHash('sha256').update('{}').digest('hex') });
      }
      if (text.includes('custom-cohort-capture:time')) return one({ value: NOW });
      return f.base.client.query(text, values);
    } };
  } }, authorizeMarketData: async (_client, _auth, context, purpose, options) => {
    assert.equal(context.target.report_file_id, target.report_file_id);
    assert.equal(Object.hasOwn(purpose, 'source_projection'), false);
    assert.deepEqual(options, { retention: true, exposure: 'none' });
    const visit = state.policies.length + 1; state.policies.push({ context, purpose, options });
    return policy ? policy({ visit, grant }) : { allowed: true, ...grant };
  } });
  const before = [...f.base.f.state.db.entries()].map(([key, value]) => [key, structuredClone(value)]);
  const unchanged = () => assert.deepEqual([...f.base.f.state.db.entries()], before, 'no evidence/assessment/acceptance storage changes');
  return { f, owner, request, state, adapter, unchanged };
}

function finalRollback(state) {
  assert.equal(state.calls.filter(c => c.text === 'COMMIT').length, 1, 'only the first read transaction committed');
  assert.equal(state.calls.at(-1).text, 'ROLLBACK');
  assert.equal(state.calls.filter(c => mutationSql.test(c.text)).length, 0);
  assert.deepEqual(state.releases, [{ phase: 1, error: undefined }, { phase: 2, error: undefined }]);
}

test('owner assembles the actual reviewed graph and real report candidate, honestly incomplete with no persistence', async () => {
  const f = await setup({ reviewed: true }), result = await f.owner.prepareReviewedInputs(f.request), report = result.report_preparation;
  assert.equal(result.status, 'prepared_reviewed_inputs'); assert.equal(result.supported_inputs.status, 'computed');
  assert.equal(report.status, 'incomplete'); assert.equal(report.authority, 'not_established');
  assert.equal(report.identity_status, 'unpublished_preparation'); assert.equal(report.apply.status, 'blocked');
  assert.ok(report.assessment); assert.ok(report.publication_bundle); assert.ok(report.candidate);
  assert.equal(report.candidate.status, 'incomplete'); assert.deepEqual(report.candidate.suggestions, []);
  assert.deepEqual(report, buildCustomCohortReportPreparation({ supported_inputs: result.supported_inputs,
    target: report.binding.target, preparation_identity: report.binding.preparation_identity,
    report_geography: report.report_geography }));
  assert.equal(report.binding.target.custom_assignment_file_id, 41);
  assert.equal(report.binding.target.editor_revision, 3);
  assert.equal(result.workspace_section_revision, 19); assert.equal(result.supported_inputs.selection.revision, 7);
  assert.equal(result.owner_clock_at, NOW); assert.equal(result.supported_inputs.binding.derived_at, '2026-09-09T12:00:00.123Z');
  assert.equal(report.binding.derived_at, result.supported_inputs.binding.derived_at);
  assert.deepEqual(report.binding.context_ref, f.request.contextRef);
  assert.equal(report.binding.review_generation, f.request.expectedReviewGeneration);
  assert.equal(report.binding.review_state_sha256, result.supported_inputs.binding.review_state_sha256);
  assert.equal(result.apply.status, 'blocked'); assert.ok(Object.isFrozen(report));
  assert.equal(f.state.policies.length, 2); assert.equal(f.state.calls.filter(c => c.text === 'COMMIT').length, 2);
  f.unchanged();
});

test('absent review supports stay unavailable rather than becoming a report-ready population', async () => {
  const f = await setup(), result = await f.owner.prepareReviewedInputs(f.request), report = result.report_preparation;
  assert.equal(result.supported_inputs.status, 'incomplete'); assert.equal(result.supported_inputs.statistics, null);
  assert.equal(report.status, 'incomplete'); assert.equal(report.assessment, null);
  assert.equal(report.publication_bundle, null); assert.equal(report.candidate, null);
  assert.ok(report.issues.length); assert.equal(report.binding.target.editor_revision, 3);
  assert.equal(report.apply.status, 'blocked'); f.unchanged();
});

test('explicit empty saved selection stays empty through owner calculation and report preparation', async () => {
  const f = await setup({ reviewed: true, emptySelection: true }), result = await f.owner.prepareReviewedInputs(f.request);
  assert.deepEqual(result.supported_inputs.selection.account_ids, []);
  assert.deepEqual(result.supported_inputs.selection.included_recorded_group_ids, []);
  assert.equal(result.supported_inputs.selection.revision, 7);
  assert.equal(result.report_preparation.status, 'incomplete'); assert.equal(result.report_preparation.apply.status, 'blocked');
  f.unchanged();
});

for (const [name, editor, revision] of [['absent', null, 0], ['present', { revision: 3, value_sha256: HASH }, 3]]) {
  test(`${name} reserved editor state is read under parent locks twice and never borrowed from workspace`, async () => {
    const f = await setup({ editor }), result = await f.owner.prepareReviewedInputs(f.request);
    assert.equal(result.report_preparation.binding.target.editor_revision, revision);
    assert.notEqual(result.report_preparation.binding.target.editor_revision, result.workspace_section_revision);
    for (const phase of [1, 2]) {
      const calls = f.state.calls.filter(c => c.phase === phase), tag = name => calls.findIndex(c => c.text.includes(name));
      assert.equal(calls[0].text, 'BEGIN ISOLATION LEVEL READ COMMITTED');
      assert.ok(tag('workspace-parent') < tag('custom-cohort-capture:report-editor'));
      assert.ok(tag('custom-cohort-capture:workspace */') < tag('custom-cohort-capture:report-editor'));
      assert.equal(calls.filter(c => c.text.includes('custom-cohort-capture:report-editor')).length, 1);
    }
    f.unchanged();
  });
}

for (const [name, change] of [
  ['revision', ({ state }) => { state.editor.revision++; }],
  ['same-revision value hash', ({ state }) => { state.editor.value_sha256 = 'b'.repeat(64); }],
  ['deletion', ({ state }) => { state.editor = null; }],
]) test(`a concurrent accepted-section ${name} change refuses the already computed report`, async () => {
  const f = await setup({ afterFirstCommit: change });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /report_editor_changed/);
  finalRollback(f.state); f.unchanged();
});
test('a concurrent first accepted section cannot reuse absent editor revision zero', async () => {
  const f = await setup({ editor: null, afterFirstCommit: ({ state }) => { state.editor = { revision: 1, value_sha256: HASH }; } });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /report_editor_changed/);
  finalRollback(f.state); f.unchanged();
});

for (const [name, editor] of [['zero revision', { revision: 0, value_sha256: HASH }], ['string revision', { revision: '3', value_sha256: HASH }],
  ['overflow revision', { revision: 2_147_483_648, value_sha256: HASH }], ['oversize/unavailable value', { revision: 3, value_sha256: null }],
  ['malformed hash', { revision: 3, value_sha256: 'not-a-hash' }]]) {
  test(`malformed reserved section ${name} cannot masquerade as absence`, async () => {
    const f = await setup({ editor });
    await assert.rejects(f.owner.prepareReviewedInputs(f.request), /report_editor_unavailable/);
    assert.equal(f.state.connects, 1); assert.equal(f.state.calls.at(-1).text, 'ROLLBACK'); f.unchanged();
  });
}
test('contradictory/duplicate reserved row responses fail closed', async () => {
  for (const response of [{ rowCount: 0, rows: [{ revision: 1, value_sha256: HASH }] },
    { rowCount: 2, rows: [{ revision: 1, value_sha256: HASH }, { revision: 1, value_sha256: HASH }] }]) {
    const f = await setup(); f.state.editorResponse = response;
    await assert.rejects(f.owner.prepareReviewedInputs(f.request), /report_editor_unavailable/); f.unchanged();
  }
});

for (const [name, change, reason] of [
  ['workspace revision', ({ state }) => { state.workspace.revision++; }, 'workspace_changed'],
  ['same-revision saved selection', ({ state }) => { state.workspace.value.active.selection.included_recorded_group_ids = []; }, 'workspace_changed'],
  ['pending capture', ({ state }) => { state.workspace.value.pending_capture = { operation_id: state.workspace.value.active.context_ref.context_id,
    observation_period: state.workspace.value.active.observation_period }; }, 'workspace_capture_pending'],
  ['subject material', ({ f }) => { f.base.f.state.input.sections[1].row.section_value.pg_text = '{"main_improvement":{"living_area_sqft":2500}}'; }, 'subject_changed'],
  ['signed workfile', ({ f }) => { f.base.f.state.status = 'signed'; }, 'protected_workfile'],
  ['assignment access', ({ state }) => { state.assignment.assigned_appraiser_user_id = '90000000-0000-4000-8000-000000000009'; }, 'assignment_access_denied'],
  ['report subject identity', ({ state }) => { state.report.subject_snapshot_id = '90000000-0000-4000-8000-000000000009'; }, 'target_changed'],
]) test(`report preparation preserves final ${name} fence`, async () => {
  const f = await setup({ afterFirstCommit: change });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), new RegExp(reason));
  finalRollback(f.state); f.unchanged();
});

test('a real new review head between owner read transactions refuses stale-generation assembly', async () => {
  const f = await setup({ afterFirstCommit: async ({ f }) => { await f.housing(f.accountIds[0]); } });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /generation_conflict/);
  finalRollback(f.state);
});

for (const final of [false, true]) test(`${final ? 'final' : 'initial'} source denial never returns a report candidate`, async () => {
  const f = await setup({ policy: ({ visit, grant }) => visit === (final ? 2 : 1) ? { allowed: false } : { allowed: true, ...grant } });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /market_data_access_denied/);
  if (final) finalRollback(f.state);
  else assert.equal(f.state.calls.some(c => c.text.includes('custom-cohort-capture:report-editor')), false);
  f.unchanged();
});
test('changed final source grant refuses report preparation despite successful calculation', async () => {
  const f = await setup({ policy: ({ visit, grant }) => ({ allowed: true, ...grant,
    ...(visit === 2 ? { policy_revision: 'synthetic-changed-after-calculation' } : {}) }) });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /market_policy_changed/); finalRollback(f.state); f.unchanged();
});

test('full int64 identity preserves existing supported computation but never rounds into an attachment target', async () => {
  const f = await setup({ assignmentFileId: '9223372036854775807', reviewed: true });
  const result = await f.owner.prepareReviewedInputs(f.request);
  assert.equal(result.supported_inputs.status, 'computed');
  assert.deepEqual(result.supported_inputs, buildCustomCohortSupportedInputs({ ...f.adapter,
    preparation_input: { ...f.adapter.preparation_input, selection: f.state.workspace.value.active.selection },
    derived_at: '2026-09-09T12:00:00.123Z' }));
  assert.equal(result.report_preparation.status, 'incomplete'); assert.equal(result.report_preparation.candidate, null);
  assert.deepEqual(result.report_preparation.issues, [{ code: 'unsupported_assignment_identity' }]);
  assert.equal(f.state.calls.some(c => c.text.includes('custom-cohort-capture:report-editor')), false);
  f.unchanged();
});

test('caller-supplied report identities/editor state are refused before any connection', async () => {
  const f = await setup();
  for (const key of ['report_preparation', 'preparation_identity', 'target', 'editor_revision', 'assessment_id', 'candidate']) {
    await assert.rejects(f.owner.prepareReviewedInputs({ ...f.request, [key]: {} }), /invalid_input/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.owner.prepareReviewedInputs(f.request, { signal: controller.signal }), /cancelled/);
  await assert.rejects(f.owner.prepareReviewedInputs(f.request, { deadline: performance.now() }), /deadline_exceeded/);
  assert.equal(f.state.connects, 0); f.unchanged();
});

test('cancellation after the initial read COMMIT cannot deliver a partial candidate or start final work', async () => {
  const controller = new AbortController();
  const f = await setup({ afterFirstCommit: () => { controller.abort(); } });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request, { signal: controller.signal }), /cancelled/);
  assert.equal(f.state.connects, 1); assert.equal(f.state.calls.at(-1).text, 'COMMIT');
  assert.equal(f.state.releases.length, 1); f.unchanged();
});
