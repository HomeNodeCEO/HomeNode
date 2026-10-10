import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomCohortOriginalAccountOwnerBudget as createBudget,
  CUSTOM_COHORT_ORIGINAL_ACCOUNT_OWNER_LIMITS as L } from '../src/services/neighborhoodAssessment/customCohortOriginalAccountOwnerBudget.js';

test('one actual owner executor charges authority, workspace, original and ending SQL with no reset or caller limit', async () => {
  const calls = [], result = { rowCount: 0, rows: [] }, raw = { async query(...args) { calls.push(args); return result; } },
    owner = createBudget(raw, { checkBudget() {} });
  assert.deepEqual(L, { sql_queries: 256, decoded_rows_utf8_bytes: 32000000, operation_ms: 60000 });
  assert.ok(Object.isFrozen(L)); assert.ok(Object.isFrozen(owner)); assert.deepEqual(Object.keys(owner), ['release', 'query']);
  assert.throws(() => owner.release(), /owner_transaction_owner_required/);
  for (let i = 0; i < L.sql_queries; i++) {
    const config = { text: ['authority', 'workspace', 'original', 'ending'][i % 4], values: [i], query_timeout: 7 };
    assert.equal(await owner.query(config), result); assert.equal(calls.at(-1)[0], config);
  }
  await assert.rejects(owner.query('one over'), /owner_query_limit/);
  await assert.rejects(owner.query('cannot reset after refusal'), /owner_query_limit/);
  assert.equal(calls.length, L.sql_queries);
});

test('whole decoded SQL rows share exact 32MB lifetime ceiling across otherwise small individual reads', async () => {
  const overhead = Buffer.byteLength(JSON.stringify([{ padding: '' }])), rows = [{ padding: 'x'.repeat(1000000 - overhead) }];
  let calls = 0;
  const owner = createBudget({ async query() { calls++; return { rows }; } }, { checkBudget() {} });
  for (let i = 0; i < 32; i++) await owner.query('bounded reader ' + i);
  assert.equal(calls, 32);
  await assert.rejects(owner.query('ending read exceeds whole operation'), /owner_byte_limit/);
  await assert.rejects(owner.query('fresh child cannot reset whole owner'), /owner_byte_limit/);
  assert.equal(calls, 33);
});

test('same owner deadline and outer cancellation are checked before and after actual SQL without extension', async t => {
  let now = 1000, calls = 0; t.mock.method(performance, 'now', () => now);
  const owner = createBudget({ async query() { calls++; return { rows: [] }; } }, { checkBudget() {} });
  now += L.operation_ms - 1; await owner.query('last allowed read');
  now++; await assert.rejects(owner.query('deadline'), /owner_deadline/); assert.equal(calls, 1);
  const outer = Error('synthetic earlier owner cancellation'); let cancelled = false;
  const cancelledOwner = createBudget({ async query() { calls++; cancelled = true; return { rows: [] }; } },
    { checkBudget() { if (cancelled) throw outer; } });
  await assert.rejects(cancelledOwner.query('cancel during query'), error => error === outer);
  await assert.rejects(cancelledOwner.query('poisoned'), error => error === outer); assert.equal(calls, 2);
  const slow = createBudget({ async query() { calls++; now += L.operation_ms; return { rows: [] }; } }, { checkBudget() {} });
  await assert.rejects(slow.query('deadline during query'), /owner_deadline/); assert.equal(calls, 3);
});

test('owner executor refuses malformed rows and preserves the original SQL failure for transaction cleanup', async () => {
  for (const result of [undefined, {}, { rows: null }, { rows: [1n] }]) {
    const owner = createBudget({ async query() { return result; } }, { checkBudget() {} });
    await assert.rejects(owner.query('invalid'), /owner_invalid_result/);
  }
  const cyclic = []; cyclic.push(cyclic);
  await assert.rejects(createBudget({ async query() { return { rows: cyclic }; } }, { checkBudget() {} }).query('cycle'), /owner_invalid_result/);
  let calls = 0; const original = Error('synthetic DB socket error'), owner = createBudget({ async query() { calls++; throw original; } }, { checkBudget() {} });
  await assert.rejects(owner.query('failed SQL'), error => error === original);
  await assert.rejects(owner.query('no follow-up SQL'), error => error === original); assert.equal(calls, 1);
});

test('whole-owner limits and clock cannot be supplied or reset through dependencies', () => {
  const raw = { async query() { return { rows: [] }; } };
  for (const options of [undefined, {}, { checkBudget() {}, queries: 1000 }, { checkBudget() {}, now() {} },
    new Proxy({ checkBudget() {} }, {}), { get checkBudget() { assert.fail('getter'); } },
    { checkBudget() {}, [Symbol('hidden')]: true }]) assert.throws(() => createBudget(raw, options), /owner_required/);
});
