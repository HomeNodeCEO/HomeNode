import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createCustomCohortExecutionGate } from '../src/services/neighborhoodAssessment/customCohortExecutionGate.js';
const options = () => ({ signal: new AbortController().signal, deadline: performance.now() + 5000 });

test('one heavy permit, FIFO queue of four, no unbounded backlog and idempotent release', async () => {
  const gate = createCustomCohortExecutionGate(), first = await gate.acquire(options()), granted = [];
  const pending = Array.from({ length: 4 }, (_, n) => gate.acquire(options()).then(release => { granted.push(n); return release; }));
  await assert.rejects(gate.acquire(options()), { code: 'custom_cohort_execution_busy' });
  assert.deepEqual(granted, []); first(); const second = await pending[0]; first();
  assert.deepEqual(granted, [0]); second(); (await pending[1])(); (await pending[2])(); (await pending[3])();
  assert.deepEqual(granted, [0, 1, 2, 3]); (await gate.acquire(options()))();
});

test('queued abort and expiry remove only waiting work; never release an active owner', async () => {
  const gate = createCustomCohortExecutionGate(), first = await gate.acquire(options()), controller = new AbortController();
  const aborted = gate.acquire({ ...options(), signal: controller.signal }); controller.abort();
  await assert.rejects(aborted, { code: 'custom_cohort_execution_interrupted' });
  await assert.rejects(gate.acquire({ ...options(), deadline: performance.now() + 5 }), { code: 'custom_cohort_execution_interrupted' });
  let granted = false; const next = gate.acquire(options()).then(release => { granted = true; return release; });
  await pause(10); assert.equal(granted, false); first(); (await next)();
});

test('pre-aborted, expired and invalid options cannot take a slot', async () => {
  const gate = createCustomCohortExecutionGate(), controller = new AbortController(); controller.abort();
  await assert.rejects(gate.acquire({ ...options(), signal: controller.signal }));
  await assert.rejects(gate.acquire({ ...options(), deadline: 0 }));
  assert.throws(() => gate.acquire({ ...options(), deadline: Infinity }));
  (await gate.acquire(options()))();
});
