import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomCohortContextCapture } from '../src/services/neighborhoodAssessment/customCohortContextCapture.js';

const input = () => ({ auth: { userId: '80000000-0000-4000-8000-000000000001', organizations: [] },
  accountId: '00026355500170360000', assignmentFileId: '9007199254740993',
  operationId: '70000000-0000-4000-8000-000000000001',
  observationPeriod: { start_date: '2023-07-01', end_date: '2024-06-30' } });
function setup(connect = () => { throw new Error('must not connect'); }) {
  return createCustomCohortContextCapture({ pool: { connect }, authorizeMarketData: () => assert.fail('must not authorize') });
}

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
test('Custom capture honors pre-abort and expired aggregate deadline before connection', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(setup().capture(input(), { signal: controller.signal }), /cancelled/);
  await assert.rejects(setup().capture(input(), { deadline: performance.now() }), /deadline_exceeded/);
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
