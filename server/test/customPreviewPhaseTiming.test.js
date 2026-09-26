import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomPreviewPhaseTiming, createCustomCatalogPhaseTiming } from '../src/services/neighborhoodAssessment/customCapturePhaseTiming.js';

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
