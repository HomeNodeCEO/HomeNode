import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomSourceReadTiming } from '../src/services/neighborhoodAssessment/customSourceReadTiming.js';
import { createNeighborhoodDenseCadEvidenceSourceReader, consumeNeighborhoodCachedAcquisition } from '../src/services/neighborhoodAssessment/cachedSourceReader.js';
import { createNeighborhoodCadEvidenceReadAccess } from '../src/services/neighborhoodAssessment/cachedReadAccess.js';
import { createTestCachedReadAccess } from './fixtures/neighborhoodCachedReadAccessFixture.js';
import { ASSESSMENT_SCOPE } from './fixtures/neighborhoodAssessmentFixture.js';

const TAGS = ['begin', 'settings', 'commit', 'caller-snapshot', 'scope', 'capabilities', 'parcels', 'accounts',
  'sync-state', 'sync-runs', 'source-ids', 'transaction-identities', 'link-identities', 'legacy-identities',
  'transactions', 'sale-links', 'legacy', 'other'];
const expectedQueries = populated => Object.fromEntries(TAGS.map(tag => [tag,
  populated[tag] ?? { count: 0, duration_ms: 0 }]));

test('source timer emits one fixed frozen aggregate and preserves its original return value', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], timer = createCustomSourceReadTiming(event => events.push(event));
  const original = { account_id: 'PRIVATE', raw_payload: 'PRIVATE', status: 'incomplete' };
  const result = await timer.run(async () => {
    now += 5;
    const first = timer.startQuery('parcels'); now += 20; first(); first();
    const second = timer.startQuery('parcels'); now += 10; second();
    now += 15; timer.beginFinalization(); now += 50;
    return original;
  });
  assert.equal(result, original);
  assert.deepEqual(events, [{ phase: 'source_read', outcome: 'completed', duration_ms: 100,
    query_count: 2, query_ms: 30, non_query_wall_ms: 70, finalization_ms: 50,
    queries: expectedQueries({ parcels: { count: 2, duration_ms: 30 } }) }]);
  assert.ok(Object.isFrozen(events[0])); assert.ok(Object.isFrozen(events[0].queries));
  assert.ok(Object.values(events[0].queries).every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|account_id|raw_payload|incomplete/);
});

test('unknown query tags are aggregated without inspecting or echoing their value', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const events = [], timer = createCustomSourceReadTiming(event => events.push(event));
  const hostile = { toString() { assert.fail('tag coercion'); } };
  await timer.run(() => {
    for (const tag of ['PRIVATE SQL', '__proto__', hostile]) { const stop = timer.startQuery(tag); now += 2; stop(); }
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].queries, expectedQueries({ other: { count: 3, duration_ms: 6 } }));
  assert.equal(events[0].finalization_ms, 0);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|__proto__|toString/);
});

test('query failure timing preserves the exact error and includes owner cleanup before reporting', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], timer = createCustomSourceReadTiming(event => events.push(event));
  const original = Object.assign(new Error('PRIVATE driver SQL'), { code: 'PRIVATE', rows: ['PRIVATE'] });
  let cleaned = false;
  await assert.rejects(timer.run(async () => {
    try { const stop = timer.startQuery('transactions'); try { now += 12; throw original; } finally { stop(); } }
    finally { now += 7; cleaned = true; assert.equal(events.length, 0); }
  }), error => error === original);
  assert.equal(cleaned, true);
  assert.deepEqual(events, [{ phase: 'source_read', outcome: 'failed', duration_ms: 19,
    query_count: 1, query_ms: 12, non_query_wall_ms: 7, finalization_ms: 0,
    queries: expectedQueries({ transactions: { count: 1, duration_ms: 12 } }) }]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|rows|code/);
});

test('finalization failures report elapsed work without replacing the error', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const events = [], timer = createCustomSourceReadTiming(event => events.push(event)), original = new Error('PRIVATE');
  await assert.rejects(timer.run(() => {
    now += 5; timer.beginFinalization(); now += 7; timer.beginFinalization(); now += 3; throw original;
  }), error => error === original);
  assert.equal(events[0].duration_ms, 15); assert.equal(events[0].finalization_ms, 10);
  assert.equal(events[0].outcome, 'failed');
});

test('synchronous and asynchronous logger failure cannot change results or errors', async () => {
  for (const report of [() => { throw Error('logger failed'); }, async () => { throw Error('logger rejected'); }]) {
    const original = {}, error = new Error('original');
    assert.equal(await createCustomSourceReadTiming(report).run(() => original), original);
    await assert.rejects(createCustomSourceReadTiming(report).run(() => { throw error; }), actual => actual === error);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('actual dense reader failure logs aggregates without changing refusal or taking transaction ownership', async t => {
  const logs = []; t.mock.method(console, 'info', value => logs.push(value));
  const request = { scope: ASSESSMENT_SCOPE, account_ids: [ASSESSMENT_SCOPE.account_id], effective_date: '2024-06-30',
    observation_period: { start_date: '2023-07-01', end_date: '2024-06-30' } };
  const access = createTestCachedReadAccess(request, { accessFactory: createNeighborhoodCadEvidenceReadAccess });
  const issued = await access.prepare();
  const reader = createNeighborhoodDenseCadEvidenceSourceReader({ connect() { assert.fail('caller owns connection'); } }, { access: access.access });
  let queries = 0;
  const client = { release() { assert.fail('caller owns release'); }, async query(config) {
    queries++; assert.match(config.text, /neighborhood-cache:caller-snapshot/); throw Error('PRIVATE SQL failure');
  } };
  const result = await reader.captureInSnapshot(client, { ...issued.request, auth: access.auth,
    selection_grant: issued.selection_grant, market_grant: issued.market_grant });
  assert.equal(result.status, 'incomplete'); assert.equal(result.source_capture, null);
  assert.deepEqual(result.incomplete_reasons, ['source_query_unavailable']); assert.equal(queries, 1);
  assert.equal(Object.hasOwn(result, 'timing'), false);
  assert.throws(() => consumeNeighborhoodCachedAcquisition(reader, result), { code: 'NEIGHBORHOOD_ORIGINAL_CAPTURE_REQUIRED' });
  assert.equal(logs.length, 1);
  const event = JSON.parse(logs[0].replace('[neighborhood] source-read-timing ', ''));
  assert.equal(event.query_count, result.counts.queries); assert.equal(event.queries['caller-snapshot'].count, 1);
  assert.equal(event.finalization_ms, 0); assert.equal(event.phase, 'source_read');
  assert.deepEqual(Object.keys(event), ['phase', 'outcome', 'duration_ms', 'query_count', 'query_ms',
    'non_query_wall_ms', 'finalization_ms', 'queries']);
  assert.doesNotMatch(logs[0], /PRIVATE|source_query_unavailable|account_id|source_capture/);
});
