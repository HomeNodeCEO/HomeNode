import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomPreviewPhaseTiming, createCustomCatalogPhaseTiming,
  createCustomPreparedCatalogPhaseTiming, createCustomPreparedCatalogProjectionTiming,
  createCustomPreparedPreviewReadTiming } from '../src/services/neighborhoodAssessment/customCapturePhaseTiming.js';

test('preview timings expose fixed phases and durations but no request evidence', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomPreviewPhaseTiming(event => events.push(event));
  const privateValue = { account: 'PRIVATE', geometry: 'PRIVATE' };
  for (const name of ['load', 'assembly', 'map', 'projection', 'authorization']) {
    assert.equal(await phase(name, () => { now += 7; return privateValue; }), privateValue);
  }
  assert.deepEqual(events, ['load', 'assembly', 'map', 'projection', 'authorization'].map((name, index) =>
    ({ phase: name, outcome: 'completed', duration_ms: 7, elapsed_ms: (index + 1) * 7 })));
  assert.ok(events.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|account|geometry/);
  await assert.rejects(phase('load', () => assert.fail('must not repeat')), /invalid_preview_phase/);
  await assert.rejects(phase('subject', () => assert.fail('capture-only')), /invalid_preview_phase/);
});

test('preview timing preserves errors and logger failures never alter work', async () => {
  const logs = [], privateError = new Error('PRIVATE SQL');
  const phase = createCustomPreviewPhaseTiming(event => logs.push(event));
  await assert.rejects(phase('load', () => { throw privateError; }), error => error === privateError);
  assert.equal(logs[0].outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|SQL/);
  const brokenLogger = createCustomPreviewPhaseTiming(() => { throw new Error('logging failed'); });
  assert.equal(await brokenLogger('assembly', () => 42), 42);
});

test('catalog subphases are fixed and omit request evidence', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomCatalogPhaseTiming(event => events.push(event));
  for (const name of ['catalog', 'proximity', 'prepared_secondary', 'recommendation', 'opening', 'fallback_opening']) {
    assert.equal(await phase(name, () => { now += 5; return 'PRIVATE'; }), 'PRIVATE');
  }
  assert.deepEqual(events, ['catalog', 'proximity', 'prepared_secondary', 'recommendation', 'opening', 'fallback_opening'].map((name, index) =>
    ({ phase: name, outcome: 'completed', duration_ms: 5, elapsed_ms: (index + 1) * 5 })));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  await assert.rejects(phase('catalog', () => null), /invalid_catalog_phase/);
  await assert.rejects(phase('load', () => null), /invalid_catalog_phase/);
});

test('optional prepared-secondary fallback retains a failed timing outcome', async () => {
  const events = [], phase = createCustomCatalogPhaseTiming(event => events.push(event));
  const value = await phase('prepared_secondary', () => Promise.reject(new Error('PRIVATE'))).catch(() => null);
  assert.equal(value, null);
  assert.equal(events[0].outcome, 'failed');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('saved catalog timings distinguish authorized reads from projection and final recheck without evidence', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomPreparedCatalogPhaseTiming(event => events.push(event));
  const names = ['target', 'authorization', 'catalog_read', 'preview_read', 'projection', 'recheck'];
  for (const name of names) assert.equal(await phase(name, () => { now += 3; return 'PRIVATE'; }), 'PRIVATE');
  assert.deepEqual(events, names.map((name, index) => ({ phase: name, outcome: 'completed',
    duration_ms: 3, elapsed_ms: (index + 1) * 3 })));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|account|geometry|source/);
  await assert.rejects(phase('load', () => null), /invalid_prepared_catalog_phase/);
  await assert.rejects(phase('target', () => null), /invalid_prepared_catalog_phase/);
});

test('saved catalog projection subphases are synchronous, bounded, and redact request evidence', t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomPreparedCatalogProjectionTiming(event => events.push(event));
  const names = ['binding', 'membership', 'opening_selection', 'observation_reselect', 'map_select',
    'summary_projection', 'transport_guard'];
  for (const name of names) assert.equal(phase(name, () => { now += 2; return 'PRIVATE'; }), 'PRIVATE');
  assert.deepEqual(events, names.map((name, index) => ({ phase: name, outcome: 'completed',
    duration_ms: 2, elapsed_ms: (index + 1) * 2 })));
  assert.ok(events.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|account|geometry|source/);
  assert.throws(() => phase('binding', () => null), /invalid_prepared_catalog_projection_phase/);
  assert.throws(() => phase('query', () => null), /invalid_prepared_catalog_projection_phase/);
  const error = new Error('PRIVATE SQL');
  const failing = createCustomPreparedCatalogProjectionTiming(event => events.push(event));
  assert.throws(() => failing('map_select', () => { throw error; }), thrown => thrown === error);
  assert.equal(events.at(-1).outcome, 'failed');
  assert.equal(createCustomPreparedCatalogProjectionTiming(() => { throw error; })('binding', () => 42), 42);
});

test('prepared preview read timings distinguish transfer, decode, and restore without evidence', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomPreparedPreviewReadTiming(event => events.push(event));
  const names = ['query', 'preview_decode', 'preview_restore', 'map_decode'];
  for (const name of names) assert.equal(await phase(name, () => { now += 4; return 'PRIVATE'; }), 'PRIVATE');
  assert.deepEqual(events, names.map((name, index) => ({ phase: name, outcome: 'completed',
    duration_ms: 4, elapsed_ms: (index + 1) * 4 })));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|account|geometry|source|sql/);
  await assert.rejects(phase('read', () => null), /invalid_prepared_preview_read_phase/);
  await assert.rejects(phase('query', () => null), /invalid_prepared_preview_read_phase/);
});
