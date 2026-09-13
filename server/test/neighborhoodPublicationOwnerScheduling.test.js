import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { assessmentEvidenceDigest as digest, buildNeighborhoodAssessment, canonicalAssessmentJson as json } from '../src/services/neighborhoodAssessment/contract.js';
import { createNeighborhoodAssessmentRepository, createNeighborhoodAssessmentRepositoryInTransaction,
  neighborhoodMemberContentDigest, neighborhoodMemberSetDigest, neighborhoodCallerCleanupFailure,
  prepareNeighborhoodPublication, prepareNeighborhoodPublicationBatches } from '../src/services/neighborhoodAssessment/assessmentRepository.js';
import { neighborhoodAssessmentFixture } from './fixtures/neighborhoodAssessmentFixture.js';
import { reportedObservationAssessmentFixture } from './fixtures/reportedObservationAssessmentFixture.js';
import { REPORTED_OBSERVATION_PROFILE_ID } from '../src/services/neighborhoodAssessment/reportedObservationContract.js';

const CLAIM = Object.freeze({ id: '80000000-0000-4000-8000-000000000001',
  claim_token: '90000000-0000-4000-8000-000000000001', attempts: 1 });
const PROFILE = Object.freeze({ contract_version: 2, profile_id: REPORTED_OBSERVATION_PROFILE_ID });
// Captured from the unchanged InTransaction publish path before this change.
// The trace includes the complete SQL strings, parameter arrays and JSON bytes.
const GOLDENS = {
  1: { result: '91dd616cc17e26388bde0e4f6957e966a378f6f471260a472d75ee9947dbe89d',
    trace: '92c67e77ee89c3da7885ce85734c73561315f746c0692681145a4b1a7982c0cc' },
  2: { result: 'fd1d217c06869f71b34a0e7d99c34de9e0ed9ec8e9de956ab9746a0ed2766e2d',
    trace: '3086f6a869c7424b5dc82a0b172566d1536480b416728f53307b44b6f115734d' },
};
const result = (rows = [], rowCount = rows.length) => ({ rows, rowCount });
function fixture(version = 2) {
  if (version === 2) return reportedObservationAssessmentFixture();
  const input = neighborhoodAssessmentFixture(), sources = [{ id: 'fixture-source', payload: { fixture: 'neighborhood-v1' } }];
  const row = (population_id, member_unit, member_id, account_ids) => ({ population_id, member_unit, member_id, account_ids,
    member_data: { source_refs: ['fixture-source'], synthetic: true } });
  const members = [...['P1', 'P2', 'P3', 'P4'].map(id => row('stock-a', 'property', id, [id])),
    row('sales-a', 'canonical_transaction', 'T1', ['P1']), row('sales-a', 'canonical_transaction', 'T2', ['P1']),
    row('sales-a', 'canonical_transaction', 'T3', ['P2'])];
  for (const population of input.populations) {
    const id = `population-members:${population.id}`, payload = { capture_type: 'neighborhood_population_members_v1',
      population_id: population.id, member_unit: population.member_unit,
      member_content_sha256: neighborhoodMemberContentDigest(members.filter(row => row.population_id === population.id)) };
    sources.push({ id, payload }); input.source_snapshots.push({ ...input.source_snapshots[0], id, content_sha256: digest(payload) });
    population.source_refs.push(id);
  }
  return { input, members, sources };
}
function refreshCaptures(f, profile = PROFILE) {
  for (const population of f.input.populations) {
    const source = f.sources.find(source => source.payload.population_id === population.id);
    source.payload.member_content_sha256 = neighborhoodMemberContentDigest(f.members.filter(row => row.population_id === population.id), profile);
    f.input.source_snapshots.find(snapshot => snapshot.id === source.id).content_sha256 = digest(source.payload);
  }
}
function expandedFixture(count) {
  const f = fixture(), prototype = f.members.find(row => row.member_unit === 'account');
  f.members = f.members.filter(row => row.member_unit !== 'account').concat(Array.from({ length: count }, (_, index) => {
    const id = `A-${String(index).padStart(5, '0')}`;
    return { ...structuredClone(prototype), member_id: id, account_ids: [id] };
  }));
  const population = f.input.populations.find(population => population.id === prototype.population_id);
  Object.assign(population, { member_count: count, unique_account_count: count, account_link_count: count,
    member_set_sha256: neighborhoodMemberSetDigest(f.members.filter(row => row.population_id === population.id).map(row => row.member_id)) });
  for (const statistic of f.input.statistics.filter(statistic => statistic.population_id === population.id)) {
    Object.assign(statistic, { observed_count: count, denominator_count: count, value: count });
  }
  refreshCaptures(f); return f;
}
// SQL shape/parameter/error-order doubles, not native concurrency/rollback proof.
function database(f, { beforeQuery, state = { isolation: 'read committed', read_only: 'off' }, handlers = {} } = {}) {
  const assessment = buildNeighborhoodAssessment(f.input), calls = [];
  const head = { ...assessment.scope, id: assessment.id, next_revision: 3, requested_job_id: CLAIM.id };
  const job = { id: CLAIM.id, input_signature_sha256: assessment.input_signature_sha256,
    effective_date: assessment.effective_date, data_cutoff: assessment.data_cutoff };
  const client = { release() { assert.fail('the exclusive caller owns connection release'); }, async query(sql, params = []) {
    calls.push({ sql, params: structuredClone(params) });
    await beforeQuery?.(sql, params);
    const tag = sql.match(/neighborhood:([a-z-]+)/)?.[1] ?? sql;
    if (Object.hasOwn(handlers, tag)) return handlers[tag](params, sql);
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return result();
    if (tag === 'caller-transaction') return result([state]);
    if (tag === 'scope') return result([{ case_date: assessment.effective_date,
      snapshot_date: assessment.effective_date, effective_date: assessment.effective_date }]);
    if (tag === 'job-head') return result([{ assessment_id: head.id }]);
    if (tag === 'lock-head') return result([head]);
    if (tag === 'publication-fence') return result([job]);
    if (tag === 'current') return result();
    if (['revision', 'source', 'population', 'members', 'publish', 'promote', 'finish'].includes(tag)) return result([], 1);
    throw new Error(`unexpected test SQL: ${tag}`);
  } };
  return { calls, head, job, client, repository: createNeighborhoodAssessmentRepositoryInTransaction(client) };
}
const publish = (db, f, mode, options, claim = { ...CLAIM }) => db.repository[mode](claim, f.input, f.members, f.sources, options);
const captureError = async action => { try { await action(); } catch (error) { return error; } assert.fail('expected rejection'); };
function assertSameError(actual, expected) {
  assert.equal(actual.constructor, expected.constructor); assert.equal(actual.message, expected.message); assert.equal(actual.code, expected.code);
}
function assertFrozen(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); assert.ok(Object.isFrozen(value)); Object.values(value).forEach(child => assertFrozen(child, seen));
  }
}
function checkpoints(f) {
  const iterator = prepareNeighborhoodPublicationBatches(f.input, f.members, f.sources); let count = 0;
  for (;;) { const step = iterator.next(); if (step.done) return count; assert.equal(step.value, undefined); count++; }
}

for (const version of [1, 2]) test(`V${version} original publish and owner-only scheduling retain exact pre-edit result and SQL bytes`, async () => {
  for (const mode of ['publish', 'publishBatched']) {
    const f = fixture(version), before = json(f), db = database(f);
    let checks = 0, returned = false;
    const completed = await publish(db, f, mode, { check() { checks++; assert.equal(returned, false); } }); returned = true;
    assert.equal(digest(completed), GOLDENS[version].result); assert.equal(digest(db.calls), GOLDENS[version].trace);
    assert.equal(db.calls.length, 17); assert.equal(json(f), before);
    assertFrozen(completed.assessment);
    if (mode === 'publish') { assert.equal(checks, 0); assert.equal(Object.isFrozen(f.input), false); }
    else { assert.ok(checks > 20); assertFrozen(f.input); assertFrozen(f.members); assertFrozen(f.sources); }
    assert.ok(db.calls.every(call => !/^(BEGIN|COMMIT|ROLLBACK$|SET LOCAL)/.test(call.sql)));
  }
});

test('generic pool repository has no cooperative publication API', () => {
  const repository = createNeighborhoodAssessmentRepository({ connect() { assert.fail('no connection'); }, query() {} });
  assert.equal(Object.hasOwn(repository, 'publishBatched'), false);
});

for (const count of [124, 125, 126, 251]) test(`${count} accounts keep complete member batches and exact SQL order across real event-loop yields`, async () => {
  const original = expandedFixture(count), scheduled = structuredClone(original), before = json(scheduled);
  const a = database(original), b = database(scheduled);
  const expected = await publish(a, original, 'publish');
  let serviced = false;
  const pending = publish(b, scheduled, 'publishBatched');
  const probe = setImmediate().then(() => { serviced = true; assert.equal(b.calls.length, 0, 'validation must finish before SAVEPOINT'); });
  assert.deepEqual(await pending, expected); await probe; assert.equal(serviced, true);
  assert.deepEqual(b.calls, a.calls); assert.equal(json(scheduled), before);
  const rows = b.calls.filter(call => call.sql.includes('neighborhood:members')).flatMap(call => JSON.parse(call.params[2]));
  assert.equal(rows.length, count + 1); assert.equal(new Set(rows.map(row => row.member_id)).size, count + 1);
});

test('existing per-row wire/storage byte splitting survives cooperative revalidation', async () => {
  for (const extra of [{ text: 'x'.repeat(750_000) }, { values: Array(4000).fill(1e308) }]) {
    const a = fixture(), b = fixture();
    for (const f of [a, b]) {
      for (const row of f.members.filter(row => row.member_unit === 'account')) Object.assign(row.member_data, extra);
      refreshCaptures(f);
    }
    const oldDb = database(a), newDb = database(b);
    assert.deepEqual(await publish(newDb, b, 'publishBatched'), await publish(oldDb, a, 'publish'));
    assert.deepEqual(newDb.calls, oldDb.calls);
    assert.ok(newDb.calls.filter(call => call.sql.includes('neighborhood:members')).length >= 2);
  }
});

test('shallow-frozen inputs and claim descendants are sealed before suspension without changing values', async () => {
  const f = expandedFixture(126), db = database(f), claim = { ...CLAIM, retained: { value: 'unchanged' } };
  const before = json({ ...f, claim }); Object.freeze(f.input); Object.freeze(claim);
  const pending = publish(db, f, 'publishBatched', undefined, claim);
  assertFrozen(f.input); assertFrozen(f.members); assertFrozen(f.sources); assertFrozen(claim);
  await setImmediate();
  for (const mutate of [() => { claim.attempts = 2; }, () => { claim.retained.value = 'changed'; },
    () => { f.members[125].member_data.injected = true; }, () => { f.sources[0].payload.injected = true; },
    () => { f.input.source_snapshots[0].content_sha256 = 'a'.repeat(64); }]) assert.throws(mutate, TypeError);
  await pending; assert.equal(json({ ...f, claim }), before);
  const fence = db.calls.find(call => call.sql.includes('neighborhood:publication-fence'));
  assert.deepEqual(fence.params, [CLAIM.id, CLAIM.claim_token, CLAIM.attempts]);
});

test('one active reservation covers seal, all yields, SQL and final check, then releases for the next operation', async () => {
  const f = fixture(), concurrent = [], db = database(f, { beforeQuery() {
    concurrent.push(assert.rejects(db.repository.getCurrent(f.input.scope), /caller_client_busy/));
  } });
  let checked = false;
  const pending = publish(db, f, 'publishBatched', { check() {
    if (!checked) { checked = true; concurrent.push(assert.rejects(db.repository.getCurrent(f.input.scope), /caller_client_busy/)); }
  } });
  assert.equal(db.calls.length, 0);
  await assert.rejects(publish(db, f, 'publishBatched'), /caller_client_busy/);
  await assert.rejects(db.repository.getCurrent(f.input.scope), /caller_client_busy/);
  await pending; await Promise.all(concurrent);
  // The same factory is usable again; its nested query hook remains refused.
  assert.equal(await db.repository.getCurrent(f.input.scope), null);
  await Promise.all(concurrent);
});

for (const [name, edit] of [
  ['early assessment and invalid claim', f => { f.input.contract_version = 999; }],
  ['late member original', f => { f.members.at(-1).member_data.changed = true; }],
  ['source original', f => { f.sources[0].payload.changed = true; }],
  ['source hash', f => { f.input.source_snapshots[0].content_sha256 = 'a'.repeat(64); }],
  ['missing source', f => { f.sources.pop(); }],
  ['missing member', f => { f.members.pop(); }],
  ['unknown member population', f => { f.members[0].population_id = 'foreign'; }],
  ['invalid Unicode', f => { f.members[0].member_data.text = '\ud800'; }],
  ['invalid numeric value', f => { f.members[0].member_data.number = Infinity; }],
  ['sparse member array', f => { delete f.members[0]; }],
  ['large sparse member array', f => { f.members = new Array(100001); }],
]) test(`${name} preserves independent verification and original first error before any SQL`, async () => {
  const original = fixture(), scheduled = fixture(), oldDb = database(original), newDb = database(scheduled);
  edit(original); edit(scheduled);
  const invalidClaim = { ...CLAIM, attempts: 0 };
  const expected = await captureError(() => publish(oldDb, original, 'publish', undefined, { ...invalidClaim }));
  const actual = await captureError(() => publish(newDb, scheduled, 'publishBatched', undefined, { ...invalidClaim }));
  assertSameError(actual, expected); assert.equal(oldDb.calls.length, 0); assert.equal(newDb.calls.length, 0);
  assert.equal(await newDb.repository.getCurrent(fixture().input.scope), null, 'failure releases the active guard');
});

test('valid bundle with invalid claim is still refused after full validation and before SQL', async () => {
  const f = fixture(), db = database(f); let checks = 0;
  const error = await captureError(() => publish(db, f, 'publishBatched', { check() { checks++; } }, { ...CLAIM, attempts: 0 }));
  assert.equal(error.code, 'neighborhood_invalid_attempts'); assert.ok(checks > 20); assert.equal(db.calls.length, 0);
});

test('incomplete sparse members preserve the legacy late refusal and identical savepoint rollback SQL', async () => {
  const a = fixture(1), b = fixture(1);
  for (const f of [a, b]) {
    const population = f.input.populations.find(population => population.id === 'stock-a');
    Object.assign(population, { completeness: 'incomplete', reasons: ['synthetic_missing_member'], member_count: null,
      unique_property_count: null, property_link_count: null, member_set_sha256: null });
    delete f.members[0]; refreshCaptures(f, { contract_version: 1 });
    const prepared = prepareNeighborhoodPublication(f.input, f.members, f.sources);
    assert.equal(prepared.members.length, f.members.length);
    assert.equal(Object.hasOwn(prepared.members, prepared.members.length - 1), false, 'the old kernel retains its sparse tail');
  }
  const oldDb = database(a), newDb = database(b);
  const expected = await captureError(() => publish(oldDb, a, 'publish'));
  const actual = await captureError(() => publish(newDb, b, 'publishBatched'));
  assertSameError(actual, expected); assert.deepEqual(newDb.calls, oldDb.calls);
  assert.ok(newDb.calls.some(call => call.sql.includes('neighborhood:revision')));
  assert.equal(newDb.calls.at(-2).sql, 'ROLLBACK TO SAVEPOINT neighborhood_repository_owner');
  assert.equal(newDb.calls.at(-1).sql, 'RELEASE SAVEPOINT neighborhood_repository_owner');
});

test('cancellation at every preparation check closes the real iterator and emits no partial SQL', async () => {
  const sample = fixture(), count = checkpoints(sample), totalPreSqlChecks = 2 + 2 * (count + 1) + 1;
  const prototype = prepareNeighborhoodPublicationBatches.prototype, originalReturn = prototype.return;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'return'); let returned = 0;
  Object.defineProperty(prototype, 'return', { configurable: true, value(...args) { returned++; return originalReturn.apply(this, args); } });
  try {
    for (let stop = 1; stop <= totalPreSqlChecks; stop++) {
      const f = fixture(), db = database(f), failure = new Error(`synthetic stop ${stop}`); let calls = 0;
      const previousReturns = returned;
      await assert.rejects(publish(db, f, 'publishBatched', { check() { if (++calls === stop) throw failure; } }), error => error === failure);
      assert.equal(db.calls.length, 0); assert.equal(returned - previousReturns, stop <= 2 ? 0 : 1);
      assert.equal(await db.repository.getCurrent(f.input.scope), null);
    }
  } finally {
    if (descriptor) Object.defineProperty(prototype, 'return', descriptor); else delete prototype.return;
  }
});

test('post-release budget failure is not represented as rollback of an already released savepoint', async () => {
  const f = fixture(), db = database(f), failure = new Error('late owner budget');
  await assert.rejects(publish(db, f, 'publishBatched', { check() {
    if (db.calls.at(-1)?.sql.startsWith('RELEASE SAVEPOINT')) throw failure;
  } }), error => error === failure);
  assert.ok(db.calls.some(call => call.sql.includes('neighborhood:finish')));
  assert.equal(db.calls.at(-1).sql, 'RELEASE SAVEPOINT neighborhood_repository_owner');
  assert.equal(db.calls.some(call => call.sql.startsWith('ROLLBACK')), false);
  assert.equal(await db.repository.getCurrent(f.input.scope), null);
});

test('savepoint failure and cleanup provenance retain original identities and release the reservation', async () => {
  const f = fixture(), primary = new Error('synthetic SQL failure'), cleanup = new Error('synthetic rollback failure');
  let inject = true;
  const db = database(f, { beforeQuery(sql) {
    if (inject && sql.includes('neighborhood:revision')) throw primary;
    if (inject && sql.startsWith('ROLLBACK TO SAVEPOINT')) throw cleanup;
  } });
  const error = await captureError(() => publish(db, f, 'publishBatched'));
  assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, cleanup]);
  assert.deepEqual(neighborhoodCallerCleanupFailure(error), { primary, cleanup });
  assert.equal(neighborhoodCallerCleanupFailure(new AggregateError([primary, cleanup], error.message)), null);
  inject = false; assert.equal(await db.repository.getCurrent(f.input.scope), null);
});

for (const state of [{ isolation: 'repeatable read', read_only: 'off' }, { isolation: 'read committed', read_only: 'on' }]) {
  test(`cooperative publication keeps exact transaction-state refusal ${JSON.stringify(state)}`, async () => {
    const a = fixture(), b = fixture(), oldDb = database(a, { state }), newDb = database(b, { state });
    const expected = await captureError(() => publish(oldDb, a, 'publish'));
    assertSameError(await captureError(() => publish(newDb, b, 'publishBatched')), expected);
    assert.deepEqual(newDb.calls, oldDb.calls);
    assert.equal(newDb.calls.some(call => call.sql.includes('neighborhood:scope')), false);
  });
}

test('already prepared objects do not carry reusable validation authority', async () => {
  const f = fixture(), verified = prepareNeighborhoodPublication(f.input, f.members, f.sources);
  const altered = structuredClone(verified); altered.members[0].member_data.changed = true;
  const db = database(f), sources = altered.sources.map(source => ({ id: source.snapshot.id, payload: source.payload }));
  await assert.rejects(db.repository.publishBatched({ ...CLAIM }, altered.assessment, altered.members, sources), /member_content_mismatch/);
  assert.equal(db.calls.length, 0);
});
