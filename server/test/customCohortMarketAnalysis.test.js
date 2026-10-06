import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomCohortMarketAnalysis } from '../src/services/neighborhoodAssessment/customCohortMarketAnalysis.js';
import { normalizeMarketAnalysisRequest, parseMarketAreaKeys } from '../src/services/marketConditions.js';

const context = { context_id: '70000000-0000-4000-8000-000000000001', context_revision: '1', context_sha256: 'a'.repeat(64) };
const binding = { context_ref: context, selection_revision: 7, selection_sha256: 'b'.repeat(64) };
const identity = { auth: { userId: 'actor' }, accountId: '26355500170360000', assignmentFileId: '15' };
const body = () => ({ context_ref: context, selection: { revision: 7, pockets: [
  { id: 'one', label: 'One', account_ids: ['A', 'B'] }, { id: 'two', label: 'Two', account_ids: ['B', 'C'] },
] }, selection_sha256: binding.selection_sha256, area_keys: ['exploration'], as_of: '2026-08-31', period_months: 24, context_override: null });
const options = () => ({ signal: new AbortController().signal, deadline: performance.now() + 60_000 });
function fixture({ present } = {}) {
  const reads = [], calculations = [], gates = [];
  const cohortService = { async authorizeMarketSelection(...args) {
    reads.push(args); return present ? present(...args) : { target: identity, binding, accountIds: ['A', 'B', 'C'] };
  }, present() { assert.fail('Market analysis must not request a full neighborhood summary'); } };
  const result = { analyses: [], recommendation: {} };
  const analyze = createCustomCohortMarketAnalysis({ pool: {}, cohortService,
    buildAnalyses: async (_pool, input) => { calculations.push(input); return result; },
    run: async (key, operation, settings) => { gates.push({ key, settings }); return operation(); },
  });
  return { analyze, reads, calculations, gates, result };
}

test('exact selected account union feeds the existing market calculator without map capture or hulls', async () => {
  const f = fixture(), input = body(), before = JSON.stringify(input);
  const response = await f.analyze(identity, input, options());
  assert.deepEqual(f.calculations[0].explorationAccountIds, ['A', 'B', 'C']);
  assert.equal(f.calculations[0].subjectAccountId, identity.accountId);
  assert.equal(f.calculations[0].asOfDate, '2026-08-31');
  assert.equal(f.calculations[0].periodMonths, 24);
  assert.equal(f.calculations[0].customGeometry, null);
  assert.equal(f.reads.length, 2, 'authorize first and recheck before publishing');
  assert.ok(f.reads.every(read => read.length === 2));
  assert.equal(f.reads[0][0].auth, identity.auth);
  assert.deepEqual(f.gates[0].settings, { allowCached: false, cacheResult: false });
  assert.equal(response.exploration_binding, binding);
  assert.equal(response.analyses, f.result.analyses);
  assert.equal(JSON.stringify(input), before);
});

test('empty selection stays empty instead of falling back to a radius or city', async () => {
  const f = fixture({ present: () => ({ target: identity, binding, accountIds: [] }) }), input = body(); input.selection.pockets = [];
  await f.analyze(identity, input, options());
  assert.deepEqual(f.calculations[0].explorationAccountIds, []);
});

test('owner authorization and membership rejection prevent any market query', async () => {
  for (const reason of ['assignment_access_denied', 'market_data_access_denied', 'invalid_selection']) {
    const f = fixture({ present() { throw Object.assign(new Error(reason), { reason }); } });
    await assert.rejects(f.analyze(identity, body(), options()), error => error.reason === reason);
    assert.equal(f.calculations.length, 0); assert.equal(f.gates.length, 0);
  }
});

test('mismatched selection fingerprint cannot produce statistics', async () => {
  const f = fixture(), input = body(); input.selection_sha256 = 'c'.repeat(64);
  await assert.rejects(f.analyze(identity, input, options()), /operation_conflict/);
  assert.equal(f.calculations.length, 0);
});

test('changed access while the query runs prevents the result from being published', async () => {
  let reads = 0;
  const f = fixture({ present() {
    if (++reads === 2) throw Object.assign(new Error('market_data_access_denied'), { reason: 'market_data_access_denied' });
    return { target: identity, binding, accountIds: ['A', 'B', 'C'] };
  } });
  await assert.rejects(f.analyze(identity, body(), options()), /market_data_access_denied/);
  assert.equal(f.calculations.length, 1);
});

test('legacy polygon requests, missing exploration and malformed fingerprints are not admitted', async () => {
  for (const change of [{ area_keys: ['custom', 'exploration'] }, { area_keys: ['city'] }, { selection_sha256: '' }, { period_months: 13 }]) {
    const f = fixture();
    await assert.rejects(f.analyze(identity, { ...body(), ...change }, options()));
    assert.equal(f.reads.length, 0); assert.equal(f.calculations.length, 0);
  }
});

test('exploration is scoped to market conditions, not exposed to unrelated area parsers', () => {
  assert.throws(() => parseMarketAreaKeys(['exploration']), /invalid_market_area/);
  assert.deepEqual(normalizeMarketAnalysisRequest({ areaKeys: ['exploration'] }).areaKeys, ['exploration']);
});

test('an aborted request does not start a market calculation', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(f.analyze(identity, body(), { ...options(), signal: abort.signal }), /cancelled/);
  assert.equal(f.calculations.length, 0);
});

test('shared numeric gate saturation remains a retryable busy response', async () => {
  const analyze = createCustomCohortMarketAnalysis({ pool: {},
    cohortService: { async authorizeMarketSelection() { return { target: identity, binding, accountIds: ['A'] }; } },
    run: async () => { throw new Error('neighborhood_profile_capacity_exceeded'); },
    buildAnalyses: () => assert.fail('Saturated gate must not start another query') });
  await assert.rejects(analyze(identity, body(), options()), error => error.code === 'custom_cohort_execution_busy');
});

test('market observation dates are independent of the retained appraisal effective date', async () => {
  const f = fixture(), input = { ...body(), as_of: '2026-10-31', period_months: 12 };
  const before = JSON.stringify(input);
  await f.analyze(identity, input, options());
  assert.equal(f.calculations[0].asOfDate, '2026-10-31');
  assert.equal(f.calculations[0].periodMonths, 12);
  assert.equal(JSON.stringify(input), before);
  assert.equal(f.reads.length, 2, 'fresh access checks remain independent of the numeric window');
});
