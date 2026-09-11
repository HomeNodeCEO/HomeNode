import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { buildCustomCohortReportPreparation } from '../src/services/neighborhoodAssessment/customCohortReportPreparation.js';
import { buildCustomCohortSupportedInputs } from '../src/services/neighborhoodAssessment/customCohortSupportedInputs.js';
import { buildCustomCohortObservationPreview } from '../src/services/neighborhoodAssessment/customCohortObservationPreview.js';
import { canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { customCohortRepositoryFixture } from './fixtures/customCohortRepositoryFixture.js';
import { saleWitnessMeaningFixture } from './fixtures/customCohortSaleWitnessMeaningFixture.js';
import { supportedInputsFixture } from './fixtures/customCohortSupportedInputsFixture.js';

const NOW = '2026-09-09T12:00:00.123456Z', HASH = 'a'.repeat(64);
const one = value => ({ rowCount: value === null ? 0 : 1, rows: value === null ? [] : [structuredClone(value)] });
const mutationSql = /\b(?:INSERT\s+INTO|UPDATE\s+app\.|DELETE\s+FROM|CREATE\s+TABLE|DROP\s+TABLE)\b/i;

/** Actual original reader/retention/review repositories and calculation modules.
 * Only bounded database response rows and transaction mechanics are faked. The
 * small assignment identity is selected BEFORE original acquisition, not by
 * relabeling a retained graph. No PostgreSQL/MVCC or production-rights claim.
 */
async function setup({ assignmentFileId = '41', effectiveDate, reviewed = false, emptySelection = false,
  editor = { revision: 3, value_sha256: HASH }, afterFirstCommit, policy } = {}) {
  const f = await supportedInputsFixture({ assignmentFileId, effectiveDate, saleCount: 1 });
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
        assert.deepEqual(values, [assignmentFileId, 'neighborhood_workspace', 262_144]);
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

test('owner derives v2 catalog interpretation from saved v5 checkpoint, not a caller-provided request flag', async () => {
  const f = await setup({ reviewed: true });
  f.state.workspace.value.workspace_version = 5;
  const actual = await f.owner.prepareReviewedInputs(f.request);
  const input = await f.f.adapterInput();
  input.preparation_input.selection = structuredClone(f.state.workspace.value.active.selection);
  input.preparation_input.catalog_version = 2; input.derived_at = actual.supported_inputs.binding.derived_at;
  assert.deepEqual(actual.supported_inputs, buildCustomCohortSupportedInputs(input));
  await assert.rejects(f.owner.prepareReviewedInputs({ ...f.request, catalog_version: 2 }));
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

test('optional pre-capture effective date leaves all default fixture and reconstructed inspection bytes unchanged', async () => {
  const hash = value => createHash('sha256').update(json(value)).digest('hex');
  // Captured before adding effectiveDate. These pin existing evidence/profile
  // behavior, not an assertion of historical applicability or publication.
  const repo = customCohortRepositoryFixture(), sale = await saleWitnessMeaningFixture(), supported = await supportedInputsFixture();
  await supported.reviewAll();
  assert.equal(hash(repo.state.input), '66e6312ca0f23742b861ae286143720cc89c186f1299fc22241ece6dd2682a51');
  assert.equal(hash(sale.input), '04ef7f6c4cef434cde7eee982c3160e26f4ce66a77fed97d55f9030e44d60c92');
  assert.equal(hash(supported.input), 'a0642d799e8de64f8f5db2eab1fb1af15a2fdeaf267b5945ac412c7109ed58e3');
  assert.equal(hash(buildCustomCohortSupportedInputs(await supported.adapterInput())), '0a95ca7902bea4bb0bc8d8452d1ae4df87f561eb5f480245f4a144abca1e688d');
  assert.deepEqual(customCohortRepositoryFixture({ effectiveDate: '2026-09-06' }).state.input, repo.state.input);
  for (const effectiveDate of [null, '2024-02-30', '2024-6-30', '2024-06-30T00:00:00Z']) {
    assert.throws(() => customCohortRepositoryFixture({ effectiveDate }), /invalid_neighborhood_assessment/);
  }
});

function assertRetrospectiveBlock(result, fixture, effectiveDate = '2024-06-30') {
  assert.equal(result.status, 'prepared_reviewed_inputs');
  assert.equal(result.authority, 'not_established'); assert.equal(result.subject_freshness, 'matched');
  assert.equal(result.workspace_section_revision, 19); assert.equal(result.owner_clock_at, NOW);
  assert.equal(result.supported_inputs, null);
  assert.deepEqual(result.apply, { status: 'blocked', reason: 'historical_stock_evidence_required' });
  const report = result.report_preparation;
  assert.equal(report.report_preparation_version, 1); assert.equal(report.status, 'incomplete');
  assert.equal(report.authority, 'not_established'); assert.equal(report.assessment, null);
  assert.equal(report.publication_bundle, null); assert.equal(report.candidate, null);
  assert.equal(Object.hasOwn(report, 'binding'), false);
  assert.deepEqual(report.issues, [{ code: 'historical_stock_evidence_required' }]);
  assert.deepEqual(report.apply, { status: 'blocked', reasons: ['historical_stock_evidence_required'] });
  assert.deepEqual(report.temporal_support, { status: 'historical_stock_evidence_required', effective_date: effectiveDate,
    retained_capture_at: fixture.f.input.retained_inputs.acquisition.capture_result.captured_at,
    stock_basis: 'current_mirror', historical_coverage: 'not_established' });
  assert.equal(report.report_geography.status, 'absent');
  assert.deepEqual(report.report_geography.subject_point_observation.retained_subject_binding.original_snapshot_row,
    fixture.f.input.retained_inputs.subject.original_snapshot_row);
  assert.equal(report.report_geography.authority, 'not_established');
  assert.ok(Object.isFrozen(report)); assert.ok(Object.isFrozen(report.temporal_support));
}

test('reviewed retrospective context cannot compute supported stock/statistics or a report candidate from later current CAD', async () => {
  const f = await setup({ reviewed: true, effectiveDate: '2024-06-30' });
  const retained = f.f.input.retained_inputs, before = json(f.f.input), beforeReview = json(f.adapter.review_state);
  assert.equal(retained.subject.effective_date, '2024-06-30');
  assert.equal(retained.subject.case_effective_date, '2024-06-30');
  assert.equal(JSON.parse(retained.subject.original_snapshot.pg_row_json).effective_date, '2024-06-30');
  assert.equal(JSON.parse(f.f.input.context_header_json).effective_date, '2024-06-30');
  assert.equal(retained.acquisition.capture_result.captured_at, '2026-09-06T08:00:00.123Z');
  // The old pure interpreter remains available for explicitly diagnostic replay;
  // the real owner must not forward that output into report preparation.
  assert.equal(buildCustomCohortSupportedInputs(f.adapter).status, 'computed');
  const result = await f.owner.prepareReviewedInputs(f.request);
  assertRetrospectiveBlock(result, f);
  assert.equal(json(f.f.input), before); assert.equal(json(f.adapter.review_state), beforeReview);
  assert.equal(f.state.policies.length, 2); assert.equal(f.state.calls.filter(c => c.text === 'COMMIT').length, 2);
  assert.deepEqual(f.state.releases, [{ phase: 1, error: undefined }, { phase: 2, error: undefined }]);
  f.unchanged();
});

test('unreviewed and explicitly empty retrospective workspaces remain inspectable without inventing zero supported populations', async () => {
  for (const options of [{ reviewed: false }, { reviewed: true, emptySelection: true }]) {
    const f = await setup({ effectiveDate: '2024-06-30', ...options }), before = json(f.state.workspace);
    assertRetrospectiveBlock(await f.owner.prepareReviewedInputs(f.request), f);
    assert.equal(json(f.state.workspace), before); f.unchanged();
  }
});

test('an original same-capture-day context remains unchanged when reopened on a later owner day', async () => {
  const f = await setup({ reviewed: true, effectiveDate: '2026-09-06' });
  const retained = f.f.input.retained_inputs;
  assert.equal(retained.subject.effective_date, retained.acquisition.capture_result.captured_at.slice(0, 10));
  assert.ok(retained.subject.effective_date < NOW.slice(0, 10));
  const result = await f.owner.prepareReviewedInputs(f.request);
  assert.equal(result.supported_inputs.status, 'computed');
  assert.ok(result.report_preparation.candidate); assert.equal(result.report_preparation.candidate.status, 'incomplete');
  assert.equal(Object.hasOwn(result.report_preparation, 'temporal_support'), false);
  assert.ok(result.report_preparation.assessment.statistics.every(statistic => statistic.value === null));
  assert.ok(result.report_preparation.assessment.source_snapshots.every(source => source.historical_availability === 'unknown'));
  assert.equal(result.apply.reason, 'owner_adoption_and_publication_required'); f.unchanged();
});

test('later-imported actual past sales remain in the exact observational population despite the stock report block', async () => {
  const f = await setup({ reviewed: true, effectiveDate: '2024-06-30' }), retained = f.f.input.retained_inputs;
  const before = json(retained);
  const preview = () => buildCustomCohortObservationPreview({ context_ref: f.request.contextRef, retained_inputs: retained,
    selection: { revision: f.state.workspace.value.active.selection.revision, pockets: f.f.catalog.pockets.map(p => ({ id: p.id,
      label: p.label, account_ids: p.account_ids })) } });
  const observed = preview();
  assert.equal(observed.effective_date, '2024-06-30'); assert.equal(observed.captured_at.slice(0, 10), '2026-09-06');
  assert.equal(observed.all.transactions.member_count, 1); assert.equal(observed.selected.transactions.member_count, 1);
  assert.equal(observed.all.transactions.members[0].sale_date, '2024-03-01');
  assert.equal(observed.all.transactions.metrics.recorded_total_price.median, 275000);
  assert.equal(observed.all.transactions.metrics.recorded_total_price.currency, null);
  assert.equal(observed.all.source_reported.member_count, 1);
  assert.equal(observed.all.stock.temporal_basis, 'current_mirror_observation');
  assert.equal(observed.apply.status, 'blocked');
  assertRetrospectiveBlock(await f.owner.prepareReviewedInputs(f.request), f);
  assert.deepEqual(preview(), observed); assert.equal(json(retained), before); f.unchanged();
});

for (const [name, change, reason] of [
  ['assignment access', ({ state }) => { state.assignment.assigned_appraiser_user_id = '90000000-0000-4000-8000-000000000009'; }, 'assignment_access_denied'],
  ['workspace revision', ({ state }) => { state.workspace.revision++; }, 'workspace_changed'],
  ['same-revision selection', ({ state }) => { state.workspace.value.active.selection.included_recorded_group_ids = []; }, 'workspace_changed'],
  ['report snapshot identity', ({ state }) => { state.report.subject_snapshot_id = '90000000-0000-4000-8000-000000000009'; }, 'target_changed'],
  ['retained subject material', ({ f }) => { f.base.f.state.input.sections[1].row.section_value.pg_text = '{"main_improvement":{"living_area_sqft":2500}}'; }, 'subject_changed'],
  ['signed workfile', ({ f }) => { f.base.f.state.status = 'signed'; }, 'protected_workfile'],
]) test(`retrospective report block still requires the final ${name} fence`, async () => {
  const f = await setup({ reviewed: true, effectiveDate: '2024-06-30', afterFirstCommit: change });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), new RegExp(reason));
  finalRollback(f.state); f.unchanged();
});

test('a real new review head prevents returning a stale retrospective block receipt', async () => {
  const f = await setup({ reviewed: true, effectiveDate: '2024-06-30', afterFirstCommit: async ({ f }) => { await f.housing(f.accountIds[0]); } });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /generation_conflict/);
  finalRollback(f.state);
});

for (const final of [false, true]) test(`retrospective report block does not skip ${final ? 'final' : 'initial'} source authorization`, async () => {
  const f = await setup({ reviewed: true, effectiveDate: '2024-06-30',
    policy: ({ visit, grant }) => visit === (final ? 2 : 1) ? { allowed: false } : { allowed: true, ...grant } });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /market_data_access_denied/);
  if (final) finalRollback(f.state);
  else assert.equal(f.state.connects, 1);
  f.unchanged();
});

test('retrospective report block still rejects a changed final source decision', async () => {
  const f = await setup({ reviewed: true, effectiveDate: '2024-06-30', policy: ({ visit, grant }) => ({ allowed: true, ...grant,
    ...(visit === 2 ? { policy_revision: 'synthetic-changed-after-read' } : {}) }) });
  await assert.rejects(f.owner.prepareReviewedInputs(f.request), /market_policy_changed/);
  finalRollback(f.state); f.unchanged();
});
