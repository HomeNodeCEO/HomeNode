import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';

const ORG = '10000000-0000-4000-8000-000000000001';
const ACTOR = '20000000-0000-4000-8000-000000000001';
const REPORT = '30000000-0000-4000-8000-000000000001';
const ref = () => ({ context_id: '40000000-0000-4000-8000-000000000001',
  context_revision: '1', context_sha256: 'a'.repeat(64) });
const input = () => ({ auth: { userId: ACTOR, organizations: [{ organizationId: ORG, roles: ['appraiser'] }] },
  accountId: 'EXACT-ACCOUNT', assignmentFileId: '9007199254740993', contextRef: ref(),
  expectedWorkspaceRevision: 1, expectedReviewGeneration: '0' });
function setup({ checkpoint, parent = true, assigned = ACTOR, org = ORG } = {}) {
  const calls = [], releases = [];
  const one = value => ({ rowCount: value === undefined ? 0 : 1, rows: value === undefined ? [] : [value] });
  const service = createCustomCohortContextCapture({ authorizeMarketData: () => assert.fail('must not read source policy'),
    pool: { async connect() { return {
      async query(config) {
        const sql = config.text; calls.push(config);
        if (/^(BEGIN |SET LOCAL |ROLLBACK$)/.test(sql)) return one();
        if (sql.includes('custom-cohort-capture:assignment')) {
          assert.match(sql, /FOR UPDATE NOWAIT/);
          assert.deepEqual(config.values, [input().assignmentFileId, input().accountId]);
          return one({ assignment_file_id: input().assignmentFileId, account_id: input().accountId,
            organization_id: org, assigned_appraiser_user_id: assigned, supervisory_appraiser_user_id: null });
        }
        if (sql.includes('custom-cohort-capture:report')) return one({ report_file_id: REPORT,
          appraisal_case_id: '50000000-0000-4000-8000-000000000001', subject_snapshot_id: '60000000-0000-4000-8000-000000000001' });
        if (sql.includes('custom-cohort-capture:workspace-parent')) {
          assert.deepEqual(config.values, [input().assignmentFileId]); assert.match(sql, /FOR SHARE NOWAIT/);
          return one(parent ? { assignment_file_id: input().assignmentFileId } : undefined);
        }
        if (sql.includes('custom-cohort-capture:workspace */')) {
          assert.match(sql, /CASE WHEN octet_length\(section_value::text\)/);
          assert.match(sql, /FOR SHARE NOWAIT/);
          assert.deepEqual(config.values, [input().assignmentFileId, 'neighborhood_workspace', 65_536]);
          return one(checkpoint);
        }
        assert.fail(`Unexpected source read or write: ${sql}`);
      }, release(error) { releases.push(error); },
    }; } } });
  return { service, calls, releases };
}
const saved = () => ({ revision: 1, value: { workspace_version: 1, pending_capture: null, active: {
  context_ref: ref(), observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' },
  selection: { revision: 1, included_recorded_group_ids: [] },
} } });

test('reviewed computation admits only exact owner identity, context and revision tokens', async () => {
  for (const key of ['retained_inputs', 'review_state', 'selection', 'source_grant', 'derived_at', 'organization_id', 'report_file_id']) {
    const f = setup();
    await assert.rejects(f.service.prepareReviewedInputs({ ...input(), [key]: {} }), /invalid_input/);
    assert.equal(f.calls.length, 0);
  }
  for (const expectedWorkspaceRevision of [0, -1, '1', 1.5, 2_147_483_648]) {
    const f = setup();
    await assert.rejects(f.service.prepareReviewedInputs({ ...input(), expectedWorkspaceRevision }), /invalid_reviewed_input_revision/);
    assert.equal(f.calls.length, 0);
  }
  for (const expectedReviewGeneration of [0, -1, '01', '-1', '1.2', '9223372036854775808']) {
    const f = setup();
    await assert.rejects(f.service.prepareReviewedInputs({ ...input(), expectedReviewGeneration }), /invalid_reviewed_input_revision/);
    assert.equal(f.calls.length, 0);
  }
});

test('reviewed computation refuses missing principal, invalid context and cancellation before checkout', async () => {
  const f = setup();
  await assert.rejects(f.service.prepareReviewedInputs({ ...input(), auth: null }), /authentication_required/);
  await assert.rejects(f.service.prepareReviewedInputs({ ...input(), contextRef: {} }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.prepareReviewedInputs(input(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(f.service.prepareReviewedInputs(input(), { deadline: performance.now() }), /deadline_exceeded/);
  assert.equal(f.calls.length, 0);
});

for (const [name, options] of [
  ['unassigned appraiser', { assigned: '70000000-0000-4000-8000-000000000001' }],
  ['foreign organization', { org: '80000000-0000-4000-8000-000000000001' }],
]) test(`reviewed computation denies ${name} before checkpoint/source reads`, async () => {
  const f = setup(options);
  await assert.rejects(f.service.prepareReviewedInputs(input()), /assignment_access_denied/);
  assert.ok(!f.calls.some(c => /workspace|neighborhood-cohort-blob/.test(c.text)));
  assert.equal(f.calls.at(-1).text, 'ROLLBACK'); assert.deepEqual(f.releases, [undefined]);
});

for (const [name, options] of [
  ['missing parent', { parent: false }], ['absent checkpoint', {}],
  ['null checkpoint', { checkpoint: { revision: 1, value: null } }],
  ['malformed checkpoint', { checkpoint: { revision: 1, value: {} } }],
  ['absent active context', { checkpoint: { revision: 1, value: { workspace_version: 1, active: null, pending_capture: null } } }],
]) test(`reviewed computation does not turn ${name} into a broad selection`, async () => {
  const f = setup(options);
  await assert.rejects(f.service.prepareReviewedInputs(input()), /workspace_unavailable/);
  assert.equal(f.calls.at(-1).text, 'ROLLBACK'); assert.deepEqual(f.releases, [undefined]);
  assert.ok(!f.calls.some(c => /\b(INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?app\./.test(c.text)));
});

test('reviewed computation rejects stale workspace revision or a different stored context', async () => {
  for (const change of [s => { s.revision = 2; }, s => { s.value.active.context_ref.context_sha256 = 'b'.repeat(64); }]) {
    const checkpoint = saved(); change(checkpoint); const f = setup({ checkpoint });
    await assert.rejects(f.service.prepareReviewedInputs(input()), /workspace_changed/);
    assert.equal(f.calls.at(-1).text, 'ROLLBACK');
  }
});

test('reviewed computation blocks a pending capture instead of silently using the old active context', async () => {
  const checkpoint = saved();
  checkpoint.value.pending_capture = { operation_id: ref().context_id,
    observation_period: checkpoint.value.active.observation_period };
  const f = setup({ checkpoint });
  await assert.rejects(f.service.prepareReviewedInputs(input()), /workspace_capture_pending/);
  assert.equal(f.calls.at(-1).text, 'ROLLBACK');
});
