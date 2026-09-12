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

test('source subphases preserve the outer duration and log only fixed aggregate metadata', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomCapturePhaseTiming(event => events.push(event));
  const grants = { auth: 'PRIVATE', account_ids: ['PRIVATE'] }, result = { payload: 'PRIVATE' };
  assert.equal(await phase('source', async () => {
    assert.equal(await phase('source_authorization', () => { now += 25; return grants; }), grants);
    return phase('source_read', () => { now += 75; return result; });
  }), result);
  assert.deepEqual(events, [
    { phase: 'source_authorization', outcome: 'completed', duration_ms: 25, elapsed_ms: 25 },
    { phase: 'source_read', outcome: 'completed', duration_ms: 75, elapsed_ms: 100 },
    { phase: 'source', outcome: 'completed', duration_ms: 100, elapsed_ms: 100 },
  ]);
  assert.ok(events.every(Object.isFrozen));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|account_ids|payload|auth":/);
  await assert.rejects(phase('source_authorization', () => assert.fail('duplicate subphase')), /invalid_capture_phase/);
  await assert.rejects(phase('source_PRIVATE', () => assert.fail('unknown subphase')), /invalid_capture_phase/);
  assert.equal(events.length, 3);
});

for (const failedPhase of ['source_authorization', 'source_read']) {
  test(`source subphase ${failedPhase} preserves the original error and outer failure`, async t => {
    let now = 100; t.mock.method(performance, 'now', () => now);
    const events = [], phase = createCustomCapturePhaseTiming(event => events.push(event));
    const original = Object.assign(new Error('PRIVATE SQL and policy data'), { private_payload: 'PRIVATE' });
    await assert.rejects(phase('source', async () => {
      for (const name of ['source_authorization', 'source_read']) {
        await phase(name, () => { now += 10; if (name === failedPhase) throw original; return 'PRIVATE'; });
      }
    }), error => error === original);
    assert.deepEqual(events, failedPhase === 'source_authorization' ? [
      { phase: 'source_authorization', outcome: 'failed', duration_ms: 10, elapsed_ms: 10 },
      { phase: 'source', outcome: 'failed', duration_ms: 10, elapsed_ms: 10 },
    ] : [
      { phase: 'source_authorization', outcome: 'completed', duration_ms: 10, elapsed_ms: 10 },
      { phase: 'source_read', outcome: 'failed', duration_ms: 10, elapsed_ms: 20 },
      { phase: 'source', outcome: 'failed', duration_ms: 20, elapsed_ms: 20 },
    ]);
    assert.ok(events.every(Object.isFrozen));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|private_payload|SQL|policy/);
  });
}
