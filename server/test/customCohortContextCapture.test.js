import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';
import { CUSTOM_COHORT_OPERATION_LIMITS } from '../src/services/neighborhoodAssessment/customCohortOperationLimits.js';

const input = () => ({ auth: { userId: '80000000-0000-4000-8000-000000000001', organizations: [] },
  accountId: '00026355500170360000', assignmentFileId: '9007199254740993',
  operationId: '70000000-0000-4000-8000-000000000001',
  observationPeriod: { start_date: '2023-07-01', end_date: '2024-06-30' } });
function setup(connect = () => { throw new Error('must not connect'); }) {
  return createCustomCohortContextCapture({ pool: { connect }, authorizeMarketData: () => assert.fail('must not authorize') });
}

test('checked-out connection errors fail safely and release once instead of crashing the process', async () => {
  for (const failureAt of ['BEGIN', 'SET LOCAL', '/* custom-cohort-capture:assignment */']) {
    const client = new EventEmitter(), error = new Error('synthetic connection ended'), calls = [], releases = [];
    client.query = async ({ text }) => {
      calls.push(text);
      if (text.startsWith(failureAt)) client.emit('error', error);
      return { rowCount: 0, rows: [] };
    };
    client.release = reason => releases.push(reason);
    await assert.rejects(setup(async () => client).capture(input()), error);
    assert.deepEqual(releases, [error]); assert.equal(client.listenerCount('error'), 0);
    assert.equal(calls.at(-1).startsWith(failureAt), true);
    assert.ok(!calls.includes('COMMIT'));
  }
});

test('Custom capture requires an explicit server market policy, without default grant', () => {
  assert.throws(() => createCustomCohortContextCapture({ pool: { connect() {} } }), /dependencies_required/);
});

test('recorded-group selection refreshes current roles before retained facts or head reads/writes', async () => {
  const base = input(), organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const read = { auth: { ...base.auth, organizations: [{ organizationId: organization, roles: ['appraiser'] }] },
    accountId: base.accountId, assignmentFileId: base.assignmentFileId,
    contextRef: { context_id: base.operationId, context_revision: '1', context_sha256: 'c'.repeat(64) } };
  for (const method of ['readRecordedGroupSelection', 'selectRecordedGroups']) {
    const value = method === 'readRecordedGroupSelection' ? read : { ...read,
      operationId: report, expectedSelectionRef: null, includedRecordedGroupIds: [] };
    for (const currentRoles of [null, ...(method === 'selectRecordedGroups' ? [['read_only']] : [])]) {
      const queries = [];
      const service = setup(async () => ({ release() {}, async query({ text }) {
        queries.push(text);
        if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
          assignment_file_id: base.assignmentFileId, account_id: base.accountId, organization_id: organization,
          assigned_appraiser_user_id: base.auth.userId, supervisory_appraiser_user_id: null }] };
        if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
          report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
        if (text.includes('custom-cohort-job:current-actor')) return currentRoles === null ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ user_id: base.auth.userId, organization_id: organization, roles: currentRoles }] };
        return { rowCount: 0, rows: [] };
      } }));
      await assert.rejects(service[method](value), currentRoles === null ? /job_actor_access_revoked/ : /assignment_access_denied/);
      assert.ok(queries.includes('ROLLBACK')); assert.ok(!queries.includes('COMMIT'));
      assert.ok(!queries.some(sql => sql.includes('blob:') || sql.includes('group-selection:') || sql.includes('private-workfile')));
    }
  }
});

test('a worker claim must bind the capture operation and is detached before any database wait', async () => {
  const base = input(), claim = { operation_id: base.operationId,
    claim_token: '33333333-3333-4333-8333-333333333333', attempts: 1 };
  await assert.rejects(setup().capture(base, { captureJobClaim: { ...claim,
    operation_id: '44444444-4444-4444-8444-444444444444' } }), /operation_conflict/);
  for (const bad of [{ ...claim, auth: {} }, { ...claim, attempts: 0 },
    { ...claim, claim_token: 'bad' }, {}]) {
    await assert.rejects(setup().capture(base, { captureJobClaim: bad }), /invalid_/);
  }
  const queries = [], organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const original = structuredClone(claim);
  const service = setup(async () => {
    claim.operation_id = report; claim.claim_token = organization; claim.attempts = 5;
    return { release() {}, async query({ text, values }) {
      queries.push(text);
      if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
        assignment_file_id: base.assignmentFileId, account_id: base.accountId,
        organization_id: organization, assigned_appraiser_user_id: base.auth.userId,
        supervisory_appraiser_user_id: null }] };
      if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
        report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
      if (text.includes('custom-cohort-job:current-actor')) return { rowCount: 1, rows: [{
        user_id: base.auth.userId, organization_id: organization, roles: ['appraiser'] }] };
      if (text.includes('checkpoint-read')) {
        assert.deepEqual(values.slice(0, 3), Object.values(original));
        throw new Error('synthetic checkpoint read reached');
      }
      return { rowCount: 0, rows: [] };
    } };
  });
  await assert.rejects(service.capture({ ...base, auth: { ...base.auth,
    organizations: [{ organizationId: organization, roles: ['appraiser'] }] } },
  { captureJobClaim: claim }), /synthetic checkpoint read reached/);
  assert.ok(!queries.some(text => text.includes('subject:transaction') || text.includes('existing-context')));
});

test('worker capture refreshes current roles before subject evidence or replay lookup', async () => {
  const base = input(), organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const authorized = { ...base, auth: { ...base.auth, organizations: [{ organizationId: organization,
    roles: ['appraiser'] }] } };
  const captureJobClaim = { operation_id: base.operationId,
    claim_token: '33333333-3333-4333-8333-333333333333', attempts: 1 };
  for (const currentRoles of [null, ['read_only']]) {
    const queries = [], releases = [];
    const service = setup(async () => ({ async query({ text, values }) {
      queries.push(text);
      if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
        assignment_file_id: base.assignmentFileId, account_id: base.accountId,
        organization_id: organization, assigned_appraiser_user_id: base.auth.userId,
        supervisory_appraiser_user_id: null }] };
      if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
        report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
      if (text.includes('custom-cohort-job:current-actor')) {
        assert.deepEqual(values, [base.auth.userId, organization]);
        return currentRoles === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{
          user_id: base.auth.userId, organization_id: organization, roles: currentRoles }] };
      }
      return { rowCount: 0, rows: [] };
    }, release(error) { releases.push(error); } }));
    await assert.rejects(service.capture(authorized, { captureJobClaim }),
      currentRoles === null ? /job_actor_access_revoked/ : /assignment_access_denied/);
    assert.ok(queries.some(text => text.includes('custom-cohort-job:current-actor')));
    assert.ok(queries.includes('ROLLBACK'));
    assert.ok(!queries.includes('COMMIT'));
    assert.ok(!queries.some(text => text.includes('existing-context') || text.includes('subject:capture')));
    assert.equal(releases.length, 1);
  }
});

test('job status and cancellation recheck exact current assignment access', async () => {
  const base = input(), organization = '11111111-1111-4111-8111-111111111111';
  const report = '22222222-2222-4222-8222-222222222222';
  const queries = [];
  let queued;
  const service = setup(async () => ({ async query({ text, values }) {
    queries.push({ text, values });
    if (text.includes('custom-cohort-capture:assignment')) return { rowCount: 1, rows: [{
      assignment_file_id: base.assignmentFileId, account_id: base.accountId,
      organization_id: organization, assigned_appraiser_user_id: base.auth.userId,
      supervisory_appraiser_user_id: null }] };
    if (text.includes('custom-cohort-capture:report')) return { rowCount: 1, rows: [{
      report_file_id: report, appraisal_case_id: null, subject_snapshot_id: null }] };
    if (text.includes('custom-cohort-job:enqueue */')) {
      queued = { actor_user_id: values[5], request_sha256: values[6],
        request_payload: JSON.parse(values[7]) };
      return { rowCount: 1, rows: [] };
    }
    if (text.includes('custom-cohort-job:enqueue-readback')) return { rowCount: 1, rows: [{
      operation_id: base.operationId, ...queued, status: 'queued' }] };
    if (text.includes('custom-cohort-job:status')) return { rowCount: 1, rows: [{
      status: 'queued', attempts: 0, cancellation_requested: false, context_sha256: null }] };
    if (text.includes('custom-cohort-job:cancel')) return { rowCount: 1, rows: [{ status: 'cancelled' }] };
    return { rowCount: 0, rows: [] };
  }, release() {} }));
  const authorized = { auth: { ...base.auth, organizations: [{ organizationId: organization,
    roles: ['appraiser'] }] }, accountId: base.accountId,
  assignmentFileId: base.assignmentFileId, operationId: base.operationId };
  assert.equal((await service.queueCaptureJob({ ...authorized,
    observationPeriod: base.observationPeriod })).status, 'queued');
  assert.deepEqual(queued.request_payload, { operation_id: base.operationId,
    observation_period: base.observationPeriod });
  assert.deepEqual(await service.captureJobStatus(authorized), {
    operation_id: base.operationId, status: 'queued', attempts: 0,
    cancellation_requested: false });
  assert.deepEqual(await service.cancelCaptureJob(authorized), { status: 'cancelled' });
  assert.ok(queries.some(query => query.text.includes('custom-cohort-job:status')
    && query.values[1] === organization && query.values[2] === report));
  assert.ok(queries.some(query => query.text.includes('custom-cohort-job:cancel')
    && query.values[1] === organization && query.values[2] === report));
  const before = queries.length;
  await assert.rejects(service.captureJobStatus({ ...authorized, auth: base.auth }), /assignment_access_denied/);
  assert.equal(queries.length, before + 4, 'denied lookup reads no job status or cancellation');
});

test('job status and cancellation reject injected scope before database access', async () => {
  const base = input();
  for (const action of ['captureJobStatus', 'cancelCaptureJob']) {
    await assert.rejects(setup()[action]({ auth: base.auth, accountId: base.accountId,
      assignmentFileId: base.assignmentFileId, operationId: base.operationId,
      organization_id: 'browser-chosen' }), /invalid_input/);
    await assert.rejects(setup()[action]({ auth: base.auth, accountId: base.accountId,
      assignmentFileId: base.assignmentFileId, operationId: 'not-a-uuid' }), /invalid_operation/);
  }
  await assert.rejects(setup().queueCaptureJob({ ...base,
    account_ids: ['untrusted'] }), /invalid_input/);
});

test('driver rejection at aggregate deadline reports interruption and discards once', async t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const releases = [], calls = [], driverError = new Error('PRIVATE driver timeout');
  const service = setup(async () => ({ async query(config) {
    calls.push(config.text);
    if (config.text.startsWith('SET LOCAL')) { now += CUSTOM_COHORT_OPERATION_LIMITS.capture_duration_ms; throw driverError; }
    return { rowCount: 0, rows: [] };
  }, release(error) { releases.push(error); } }));
  await assert.rejects(service.capture(input()), error => error.reason === 'deadline_exceeded'
    && error.code === 'CUSTOM_COHORT_CAPTURE_FAILED' && !error.message.includes('PRIVATE'));
  assert.deepEqual(releases, [driverError]); assert.ok(!calls.includes('COMMIT'));
});
test('Custom capture rejects browser source/target fields before any connection', async () => {
  for (const key of ['account_ids', 'geometry_input', 'organization_id', 'report_file_id', 'market_decision', 'profile_id']) {
    await assert.rejects(setup().capture({ ...input(), [key]: 'untrusted' }), /invalid_input/);
  }
});
test('Custom capture preserves exact assignment/account identity and rejects numeric rounding', async () => {
  for (const assignmentFileId of [1, 9007199254740992, '01', '-1', '9223372036854775808']) {
    await assert.rejects(setup().capture({ ...input(), assignmentFileId }), /invalid_assignment/);
  }
  for (const accountId of [123, ' trim', '', 'bad\naccount']) {
    await assert.rejects(setup().capture({ ...input(), accountId }), /invalid_account/);
  }
});
test('Custom capture rejects absent authentication, invalid UUIDs and periods before connection', async () => {
  await assert.rejects(setup().capture({ ...input(), auth: {} }), /authentication_required/);
  await assert.rejects(setup().capture({ ...input(), operationId: 'not-a-uuid' }), /invalid_operation/);
  await assert.rejects(setup().capture({ ...input(), observationPeriod: { start_date: '2024-07-01', end_date: '2024-06-30' } }), /invalid_period/);
});

test('private capture selection is exact and reviewed, with no implicit latest or browser payload', async () => {
  const base = { batch_id: '20000000-0000-4000-8000-000000000001', expected_review_revision: 1 };
  for (const privateSalesImport of [null, {}, { ...base, expected_review_revision: 0 },
    { ...base, expected_review_revision: '1' }, { ...base, latest: true }, { ...base, rows: [] }]) {
    await assert.rejects(setup().capture({ ...input(), privateSalesImport }), /invalid_private_sales_import/);
  }
});
test('Custom capture honors pre-abort and expired aggregate deadline before connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().capture(input(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(setup().capture(input(), { deadline: performance.now() }), /deadline_exceeded/);
});

test('capture budget owns option validation after separating the internal worker claim', async () => {
  const captureJobClaim = { operation_id: input().operationId,
    claim_token: '33333333-3333-4333-8333-333333333333', attempts: 1 };
  for (const options of [null, [], Object.create({ signal: undefined }),
    { captureJobClaim, extra: true }, { captureJobClaim, signal: {} },
    { captureJobClaim, deadline: NaN }]) {
    await assert.rejects(setup().capture(input(), options), /invalid_options/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().capture(input(), { captureJobClaim, signal: controller.signal }), /cancelled/);
  await assert.rejects(setup().capture(input(), { captureJobClaim, deadline: performance.now() }), /deadline_exceeded/);
});

test('large capture has a bounded extended aggregate but respects earlier caller deadlines', async t => {
  let clock = 10_000;
  t.mock.method(performance, 'now', () => clock);
  for (const scenario of [
    { elapsed: 70_000, reason: 'target_unavailable' },
    { elapsed: CUSTOM_COHORT_OPERATION_LIMITS.capture_duration_ms + 1, reason: 'deadline_exceeded' },
    { elapsed: 70_000, deadline: 70_000, reason: 'deadline_exceeded' },
    { elapsed: CUSTOM_COHORT_OPERATION_LIMITS.capture_duration_ms + 1, deadline: 250_000, reason: 'deadline_exceeded' },
  ]) {
    clock = 10_000; const calls = [], releases = [];
    const capture = setup(async () => ({ async query(config) {
      calls.push(config);
      if (config.text.startsWith('BEGIN')) clock += scenario.elapsed;
      return { rows: [], rowCount: 0 };
    }, release(error) { releases.push(error); } }));
    await assert.rejects(capture.capture(input(), scenario.deadline ? { deadline: scenario.deadline } : {}),
      new RegExp(scenario.reason));
    assert.equal(releases.length, 1); assert.ok(!calls.some(call => call.text === 'COMMIT'));
    assert.ok(calls.every(call => call.query_timeout > 0 && call.query_timeout <= 6000));
  }
});

test('Custom capture admits only exact installed discovery choices before connection', async () => {
  const discovery = { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' };
  for (const value of [null, {}, { ...discovery, radius_metres: 8046.72 }, { ...discovery, radius_metres: '8046.720' },
    { ...discovery, radius_metres: '160934.4' }, { ...discovery, profile_id: 'city' },
    { ...discovery, account_ids: [] }, { ...discovery, geometry: {} }]) {
    await assert.rejects(setup().capture({ ...input(), discovery: value }), /invalid_discovery/);
  }
  for (const radius_metres of ['1609.344', '3218.688', '4828.032', '8046.72', '16093.44']) {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(setup().capture({ ...input(), discovery: { ...discovery, radius_metres } }, { signal: controller.signal }), /cancelled/);
  }
});
test('Custom capture releases a late checked-out client exactly once without starting a transaction', async () => {
  let finish, releases = 0, queries = 0;
  const capture = setup(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = capture.capture(input(), { signal: controller.signal });
  await Promise.resolve(); await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  finish({ release(error) { assert.ok(error); releases++; }, query() { queries++; } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(releases, 1); assert.equal(queries, 0);
});
test('Custom capture rolls back a missing target and never begins source reads', async () => {
  const calls = [], releases = [];
  const capture = setup(async () => ({
    async query({ text }) { calls.push(text); return { rowCount: 0, rows: [] }; },
    release(error) { releases.push(error); },
  }));
  await assert.rejects(capture.capture(input()), /target_unavailable/);
  assert.ok(calls.some(text => text === 'ROLLBACK'));
  assert.ok(!calls.some(text => text.includes('neighborhood-membership:')));
  assert.deepEqual(releases, [undefined]);
});
test('Custom capture discards uncertain BEGIN and failed rollback connections exactly once', async () => {
  for (const failureAt of ['BEGIN', 'ROLLBACK']) {
    const error = new Error('synthetic driver failure'), calls = [], releases = [];
    const capture = setup(async () => ({
      async query({ text }) {
        calls.push(text);
        if (text.startsWith(failureAt)) throw error;
        return { rowCount: 0, rows: [] };
      },
      release(reason) { releases.push(reason); },
    }));
    await assert.rejects(capture.capture(input()));
    assert.deepEqual(releases, [error]);
    if (failureAt === 'BEGIN') assert.equal(calls.length, 1);
  }
});

const previewInput = () => {
  const { auth, accountId, assignmentFileId } = input();
  return { auth, accountId, assignmentFileId,
    contextRef: { context_id: input().operationId, context_revision: '1', context_sha256: 'a'.repeat(64) },
    selection: { revision: 1, pockets: [] } };
};

test('Custom observation preview rejects client authority, malformed context and selection before checkout', async () => {
  for (const key of ['organization_id', 'source_rows', 'subject_freshness', 'retained_inputs']) {
    await assert.rejects(setup().preview({ ...previewInput(), [key]: {} }), /invalid_input/);
  }
  await assert.rejects(setup().preview({ ...previewInput(), contextRef: { context_id: 'unknown' } }));
  for (const revision of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(setup().preview({ ...previewInput(), selection: { revision, pockets: [] } }), /invalid_selection/);
  }
  await assert.rejects(setup().preview({ ...previewInput(), selection: { revision: 1, pockets: Array(129).fill({}) } }), /invalid_selection/);
});

test('Custom observation preview rejects missing principal and pre-cancelled work without reading evidence', async () => {
  await assert.rejects(setup().preview({ ...previewInput(), auth: null }), /authentication_required/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().preview(previewInput(), { signal: controller.signal }), /cancelled/);
});

test('Custom catalog uses the same exact principal, context, selection and aggregate budget guards', async () => {
  for (const key of ['account_ids', 'retained_inputs', 'source_grant', 'organization_id', 'catalog']) {
    await assert.rejects(setup().catalog({ ...previewInput(), [key]: {} }), /invalid_input/);
  }
  await assert.rejects(setup().catalog({ ...previewInput(), auth: null }), /authentication_required/);
  await assert.rejects(setup().catalog({ ...previewInput(), assignmentFileId: 1 }), /invalid_assignment/);
  await assert.rejects(setup().catalog({ ...previewInput(), contextRef: {} }));
  await assert.rejects(setup().catalog({ ...previewInput(), selection: { revision: 0, pockets: [] } }), /invalid_selection/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().catalog(previewInput(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(setup().catalog(previewInput(), { deadline: performance.now() }), /deadline_exceeded/);
});

test('Custom catalog rolls back missing target without reading source or writing reports', async () => {
  const calls = [], releases = [];
  const capture = setup(async () => ({
    async query({ text }) { calls.push(text); return { rowCount: 0, rows: [] }; },
    release(error) { releases.push(error); },
  }));
  await assert.rejects(capture.catalog(previewInput()), /target_unavailable/);
  assert.ok(calls.includes('ROLLBACK')); assert.deepEqual(releases, [undefined]);
  assert.ok(!calls.some(sql => /neighborhood-(cache|membership|closure):|\b(INSERT|UPDATE|DELETE)\b/i.test(sql)));
});
