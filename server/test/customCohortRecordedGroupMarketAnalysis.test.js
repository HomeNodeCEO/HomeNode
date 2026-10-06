import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomCohortRecordedGroupMarketAnalysis as create,
  prepareCustomCohortRecordedGroupMarketRequest as prepare }
  from '../src/services/neighborhoodAssessment/customCohortRecordedGroupMarketAnalysis.js';

const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const ref = { selection_version: 1, selection_revision: 7, selection_sha256: 'b'.repeat(64),
  manifest_ref: { content_sha256: 'c'.repeat(64), canonical_utf8_bytes: '100' } };
const identity = { auth: { userId: 'actor' }, accountId: '26355500170360000', assignmentFileId: '15' };
const binding = { context_ref: context, selection_revision: 7, selection_sha256: ref.selection_sha256 };
const body = () => ({ assignment_file_id: '15', context_ref: structuredClone(context), selection_ref: structuredClone(ref),
  area_keys: ['exploration'], as_of: '2026-10-31', period_months: 12, context_override: null });
const options = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60000 });
const result = accounts => ({ target: { account_id: identity.accountId, assignment_file_id: '15' },
  selection_ref: ref, binding, accountIds: Object.freeze(accounts) });
function fixture({ authorize, calculate, run } = {}) {
  const reads = [], calculations = [], gates = [];
  const response = { subject: { account_id: identity.accountId }, analyses: [], recommendation: {} };
  const analyze = create({ pool: {}, cohortService: { async authorizeRecordedGroupMarketSelection(...args) {
    reads.push(args); return authorize ? authorize(reads.length, ...args) : result(['A', 'B', 'C']);
  } }, buildAnalyses: async (_pool, request) => { calculations.push(request); return calculate ? calculate(request) : response; },
  run: async (key, work, settings) => { gates.push({ key, settings }); return run ? run(work) : work(); } });
  return { analyze, reads, calculations, gates, response };
}

test('exact retained selection feeds the established calculator and reopens the complete original before delivery', async () => {
  const f = fixture(), input = body(), before = JSON.stringify(input);
  const out = await f.analyze(identity, input, options());
  assert.equal(f.reads.length, 2);
  assert.ok(f.reads.every(([v]) => Object.keys(v).length === 5 && !Object.hasOwn(v, 'selection') && !Object.hasOwn(v, 'account_ids')));
  assert.deepEqual(f.reads[0][0].selectionRef, ref);
  assert.deepEqual(f.calculations[0].explorationAccountIds, ['A', 'B', 'C']);
  assert.equal(f.calculations[0].asOfDate, '2026-10-31'); assert.equal(f.calculations[0].periodMonths, 12);
  assert.equal(f.calculations[0].customGeometry, null);
  assert.deepEqual(f.gates[0].settings, { allowCached: false, cacheResult: false });
  assert.equal(out.exploration_binding, binding); assert.equal(out.exploration_selection_ref, ref);
  assert.equal(Object.hasOwn(out, 'accountIds'), false); assert.equal(out.analyses, f.response.analyses);
  assert.equal(JSON.stringify(input), before);
});

test('explicit empty union never falls back to radius, city or all parcels', async () => {
  const f = fixture({ authorize: () => result([]) });
  await f.analyze(identity, body(), options()); assert.deepEqual(f.calculations[0].explorationAccountIds, []);
});

test('current rights failures and mismatched original references prevent queries or completed publication', async () => {
  for (const reason of ['assignment_access_denied', 'market_data_access_denied', 'subject_changed']) {
    const denied = fixture({ authorize() { throw Object.assign(new Error(reason), { reason }); } });
    await assert.rejects(denied.analyze(identity, body(), options()), { reason }); assert.equal(denied.calculations.length, 0);
    const revoked = fixture({ authorize: n => { if (n === 2) throw Object.assign(new Error(reason), { reason }); return result(['A']); } });
    await assert.rejects(revoked.analyze(identity, body(), options()), { reason }); assert.equal(revoked.calculations.length, 1);
  }
  for (const changed of [
    { selection_ref: { ...ref, manifest_ref: { ...ref.manifest_ref, content_sha256: 'd'.repeat(64) } } },
    { binding: { ...binding, selection_revision: 8 } },
    { target: { account_id: identity.accountId, assignment_file_id: '16' } },
  ]) {
    const f = fixture({ authorize: () => ({ ...result(['A']), ...changed }) });
    await assert.rejects(f.analyze(identity, body(), options()), /operation_conflict/); assert.equal(f.calculations.length, 0);
  }
  const changedUnion = fixture({ authorize: n => result(n === 1 ? ['A', 'B'] : ['A', 'C']) });
  await assert.rejects(changedUnion.analyze(identity, body(), options()), /operation_conflict/);
});

test('body and nested mutable window/override fields are detached before the first network await', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ authorize: async n => { if (n === 1) await pending; return result(['A']); } });
  const input = body(); input.context_override = { city: 'Garland', source: 'manual' };
  const out = f.analyze(identity, input, options());
  input.selection_ref.manifest_ref.content_sha256 = 'd'.repeat(64); input.area_keys[0] = 'city';
  input.as_of = '2020-01-01'; input.context_override.city = 'Changed'; release();
  await out;
  assert.equal(f.calculations[0].asOfDate, '2026-10-31'); assert.equal(f.calculations[0].marketContextOverride.city, 'Garland');
  assert.deepEqual(f.calculations[0].areaKeys, ['exploration']); assert.deepEqual(f.reads[1][0].selectionRef, ref);
});

test('forged memberships, legacy selections, malformed references, traps and incompatible study requests fail before authorization', async () => {
  for (const change of [{ account_ids: ['A'] }, { selection: {} }, { auth: {} }, { viewport: {} },
    { assignment_file_id: '16' }, { selection_ref: null }, { area_keys: ['city'] },
    { area_keys: ['exploration', 'custom'] }, { period_months: 13 }, { context_override: { forged: 'A' } }]) {
    const f = fixture(); await assert.rejects(f.analyze(identity, { ...body(), ...change }, options()));
    assert.equal(f.reads.length, 0); assert.equal(f.calculations.length, 0);
  }
  let calls = 0;
  const inputs = [new Proxy(body(), { get() { calls++; throw new Error('trap'); } }), body(), body(), body()];
  Object.defineProperty(inputs[1], 'area_keys', { enumerable: true, get() { calls++; throw new Error('trap'); } });
  Object.defineProperty(inputs[2].selection_ref.manifest_ref, 'content_sha256', { enumerable: true, get() { calls++; throw new Error('trap'); } });
  inputs[3].context_override = Object.defineProperty({}, 'city', { enumerable: true, get() { calls++; throw new Error('trap'); } });
  for (const input of inputs) assert.throws(() => prepare(input));
  assert.equal(calls, 0, 'data accessors are never executed');
});

test('cancellation, ending deadlines and the shared gate remain bounded and cannot return a stale completed response', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture();
  await assert.rejects(f.analyze(identity, body(), { ...options(), signal: controller.signal }), /cancelled/);
  assert.equal(f.reads.length, 0);
  const o = options(), late = fixture({ calculate: () => { o.deadline = 0; return {}; } });
  await assert.rejects(late.analyze(identity, body(), o), /deadline_exceeded/); assert.equal(late.reads.length, 1);
  const busy = fixture({ run: () => { throw new Error('neighborhood_profile_capacity_exceeded'); } });
  await assert.rejects(busy.analyze(identity, body(), options()), error => error.code === 'custom_cohort_execution_busy');
  assert.equal(busy.calculations.length, 0);
});
