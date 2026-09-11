import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomCapturePhaseTiming } from '../src/services/neighborhoodAssessment/customCapturePhaseTiming.js';

test('capture phase timing returns original values and only fixed aggregate metadata', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomCapturePhaseTiming(event => events.push(event));
  const privateValue = { account: 'PRIVATE', geometry: 'PRIVATE' };
  assert.equal(await phase('subject', async () => { now += 30; return privateValue; }), privateValue);
  assert.deepEqual(events, [{ phase: 'subject', outcome: 'completed', duration_ms: 30, elapsed_ms: 30 }]);
  const original = new Error('PRIVATE SQL');
  await assert.rejects(phase('source', async () => { now += 40; throw original; }), error => error === original);
  assert.deepEqual(events[1], { phase: 'source', outcome: 'failed', duration_ms: 40, elapsed_ms: 70 });
  assert.ok(events.every(Object.isFrozen)); assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  await assert.rejects(phase('subject', () => assert.fail('duplicate phase')), /invalid_capture_phase/);
  await assert.rejects(phase('PRIVATE', () => assert.fail('unknown phase')), /invalid_capture_phase/);
  assert.equal(events.length, 2);
});

test('broken synchronous or asynchronous logging cannot change capture results', async () => {
  for (const report of [() => { throw new Error('logger failed'); }, async () => { throw new Error('logger rejected'); }]) {
    const phase = createCustomCapturePhaseTiming(report), original = new Error('original');
    assert.equal(await phase('retention', () => 42), 42);
    await assert.rejects(phase('registration', () => { throw original; }), error => error === original);
    await new Promise(resolve => setImmediate(resolve));
  }
});
