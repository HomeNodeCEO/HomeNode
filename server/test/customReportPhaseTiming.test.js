import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createCustomCapturePhaseTiming, createCustomReportPhaseTiming } from '../src/services/neighborhoodAssessment/customCapturePhaseTiming.js';

test('report phases expose only fixed durations and preserve exact values and errors', async t => {
  let now = 100; t.mock.method(performance, 'now', () => now);
  const events = [], phase = createCustomReportPhaseTiming(event => events.push(event));
  const privateValue = { account: 'PRIVATE', source: 'PRIVATE', boundary: 'PRIVATE' };
  assert.equal(await phase('load', () => { now += 25; return privateValue; }), privateValue);
  assert.equal(await phase('assembly', () => { now += 40; return privateValue; }), privateValue);
  assert.equal(await phase('publication', async () => {
    now += 5;
    assert.equal(await phase('repository', () => { now += 30; return privateValue; }), privateValue);
    now += 5; return privateValue;
  }), privateValue);
  assert.deepEqual(events, [
    { phase: 'load', outcome: 'completed', duration_ms: 25, elapsed_ms: 25 },
    { phase: 'assembly', outcome: 'completed', duration_ms: 40, elapsed_ms: 65 },
    { phase: 'repository', outcome: 'completed', duration_ms: 30, elapsed_ms: 100 },
    { phase: 'publication', outcome: 'completed', duration_ms: 40, elapsed_ms: 105 },
  ]);
  assert.ok(events.every(Object.isFrozen)); assert.doesNotMatch(JSON.stringify(events), /PRIVATE|source|boundary|account/);
});

for (const failed of ['load', 'assembly', 'repository']) {
  test(`report ${failed} failure retains its original error without disclosure`, async t => {
    let now = 0; t.mock.method(performance, 'now', () => now);
    const events = [], phase = createCustomReportPhaseTiming(event => events.push(event));
    const original = Object.assign(new Error('PRIVATE SQL'), { reason: 'PRIVATE', outcome_unknown: true });
    const work = () => { now += 10; throw original; };
    await assert.rejects(failed === 'repository'
      ? phase('publication', () => phase('repository', work)) : phase(failed, work), error => error === original);
    assert.deepEqual(events, (failed === 'repository' ? ['repository', 'publication'] : [failed]).map(name =>
      ({ phase: name, outcome: 'failed', duration_ms: 10, elapsed_ms: 10 })));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SQL|reason|outcome_unknown/);
  });
}

test('report logger failures never affect transaction results or recovery', async () => {
  for (const report of [() => { throw new Error('logger failed'); }, async () => { throw new Error('logger rejected'); }]) {
    const phase = createCustomReportPhaseTiming(report), original = new Error('work failed');
    assert.equal(await phase('load', () => 42), 42);
    await assert.rejects(phase('assembly', () => { throw original; }), error => error === original);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('capture and report vocabularies remain separate and reject arbitrary or repeated labels', async () => {
  const events = [], report = createCustomReportPhaseTiming(event => events.push(event));
  const capture = createCustomCapturePhaseTiming(() => {});
  for (const label of ['subject', 'source', 'PRIVATE', 'constructor', '__proto__'])
    await assert.rejects(report(label, () => assert.fail('must not run')), /invalid_report_phase/);
  await assert.rejects(report('load', null), /invalid_report_phase/);
  assert.equal(await report('load', () => 1), 1);
  await assert.rejects(report('load', () => assert.fail('must not repeat')), /invalid_report_phase/);
  await assert.rejects(capture('publication', () => assert.fail('must remain capture-only')), /invalid_capture_phase/);
  assert.equal(events.length, 1);
});

test('default report logger uses a fixed prefix and sanitized JSON', async t => {
  const logs = []; t.mock.method(console, 'info', value => logs.push(value));
  const result = { secret: 'PRIVATE' };
  assert.equal(await createCustomReportPhaseTiming()('load', () => result), result);
  assert.equal(logs.length, 1); assert.ok(logs[0].startsWith('[neighborhood] report-phase '));
  const event = JSON.parse(logs[0].slice('[neighborhood] report-phase '.length));
  assert.deepEqual(Object.keys(event), ['phase', 'outcome', 'duration_ms', 'elapsed_ms']);
  assert.equal(event.phase, 'load'); assert.equal(event.outcome, 'completed');
  assert.ok(Number.isInteger(event.duration_ms) && event.duration_ms >= 0);
  assert.ok(Number.isInteger(event.elapsed_ms) && event.elapsed_ms >= event.duration_ms);
  assert.doesNotMatch(logs[0], /PRIVATE|secret/);
});
