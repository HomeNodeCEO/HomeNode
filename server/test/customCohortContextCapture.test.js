import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';

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

test('Custom capture admits only exact installed discovery choices before connection', async () => {
  const discovery = { profile_id: 'custom-suburban-radius-v2', radius_metres: '8046.72' };
  for (const value of [null, {}, { ...discovery, radius_metres: 8046.72 }, { ...discovery, radius_metres: '8046.720' },
    { ...discovery, radius_metres: '160934.4' }, { ...discovery, profile_id: 'city' },
    { ...discovery, account_ids: [] }, { ...discovery, geometry: {} }]) {
    await assert.rejects(setup().capture({ ...input(), discovery: value }), /invalid_discovery/);
  }
  for (const radius_metres of ['4828.032', '8046.72', '16093.44']) {
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
