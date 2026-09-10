import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeighborhoodAssessmentRepositoryInTransaction } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { ASSESSMENT_SCOPE as scope } from './fixtures/neighborhoodAssessmentFixture.js';

const ID = '80000000-0000-4000-8000-000000000001';
const result = rows => ({ rows, rowCount: rows.length });
function fixture({ state = { isolation: 'read committed', read_only: 'off' }, generation = 3, foreign = false } = {}) {
  const calls = [], head = { ...scope, id: ID, request_generation: generation, requested_job_id: ID };
  const client = { release() { assert.fail('caller release'); }, async query(sql, params) {
    calls.push({ sql, params });
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return result([]);
    if (sql.includes('caller-transaction')) return result([state]);
    if (sql.includes('neighborhood:scope')) return result([{ effective_date: '2024-06-30', case_date: '2024-06-30', snapshot_date: '2024-06-30' }]);
    if (sql.includes('exact-job-head')) return result(foreign ? [] : [{ assessment_id: ID }]);
    if (sql.includes('lock-head')) return result([head]);
    if (sql.includes('exact-job-lock')) return result([{ id: ID, request_generation: 1 }]);
    if (sql.includes('exact-claim')) return result([{ id: ID, claim_token: params[2], attempts: 1 }]);
    if (sql.includes('neighborhood:current')) return result([]);
    throw new Error('unexpected SQL');
  } };
  return { client, calls, repository: createNeighborhoodAssessmentRepositoryInTransaction(client) };
}
test('caller repository pins explicit writable RC and never owns transaction or connection', async () => {
  const f = fixture(); assert.equal(await f.repository.getCurrent(scope), null);
  assert.equal(f.calls[0].sql, 'SAVEPOINT neighborhood_repository_owner');
  assert.equal(f.calls.at(-1).sql, 'RELEASE SAVEPOINT neighborhood_repository_owner');
  assert.ok(f.calls.every(c => !/^(BEGIN|COMMIT|ROLLBACK$|SET LOCAL)/.test(c.sql)));
});
for (const state of [{ isolation: 'repeatable read', read_only: 'off' }, { isolation: 'read committed', read_only: 'on' }, {}]) {
  test(`rejects wrong caller transaction ${JSON.stringify(state)} before scope read`, async () => {
    const f = fixture({ state }); await assert.rejects(f.repository.getCurrent(scope), /caller_transaction_required/);
    assert.equal(f.calls.length, 4); assert.match(f.calls[2].sql, /^ROLLBACK TO SAVEPOINT/);
  });
}
test('autocommit savepoint refusal performs no data reads or cleanup transaction', async () => {
  const calls = []; const repository = createNeighborhoodAssessmentRepositoryInTransaction({ release() {}, async query(sql) {
    calls.push(sql); throw new Error('savepoint requires transaction');
  } });
  await assert.rejects(repository.getCurrent(scope), /savepoint requires/); assert.equal(calls.length, 1);
});
test('exact claim locks and changes only the explicitly scoped requested job/generation', async () => {
  const f = fixture(), claim = await f.repository.claimExact(scope, { job_id: ID, expected_request_generation: 3 });
  assert.equal(claim.id, ID); assert.equal(claim.attempts, 1);
  const find = text => f.calls.find(c => c.sql.includes(text));
  assert.deepEqual(find('exact-job-head').params, [...Object.values(scope), ID]);
  assert.match(find('exact-job-lock').sql, /FOR UPDATE NOWAIT/);
  assert.match(find('exact-claim').sql, /WHERE assessment_id=\$1 AND id=\$2/);
  assert.ok(!f.calls.some(c => /SKIP LOCKED|neighborhood:claim |neighborhood:exhausted/.test(c.sql)));
});
for (const options of [{ generation: 4 }, { foreign: true }]) test(`exact claim rejects stale/foreign target ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); await assert.rejects(f.repository.claimExact(scope, { job_id: ID, expected_request_generation: 3 }));
  assert.ok(!f.calls.some(c => c.sql.includes('exact-claim')));
  assert.match(f.calls.at(-2).sql, /^ROLLBACK TO SAVEPOINT/);
});
test('overlapping calls on one caller factory are rejected, not interleaved savepoints', async () => {
  let resume; const pending = new Promise(resolve => { resume = resolve; }); const f = fixture(), original = f.client.query;
  f.client.query = async (sql, values) => { if (sql.startsWith('SAVEPOINT')) await pending; return original(sql, values); };
  const first = f.repository.getCurrent(scope);
  await assert.rejects(f.repository.getCurrent(scope), /caller_client_busy/); resume(); await first;
});
