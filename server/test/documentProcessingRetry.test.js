import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleDocumentProcessingRetry } from '../src/services/documentProcessingRetry.js';

test('wake queue deduplicates and bounds job IDs, releases before retry, and never holds PDF content', async () => {
  const pool = {}, callbacks = [], calls = [];
  const options = { storage: {}, ocrProvider: {} };
  const setTimer = (callback, delay) => { assert.equal(delay, 15_250); callbacks.push(callback); return { unref() {} }; };
  const process = async (...args) => { calls.push(args); throw new Error('sanitized elsewhere'); };
  for (let id = 1; id <= 32; id++) assert.equal(scheduleDocumentProcessingRetry(pool, id, options, process, { setTimer }), true);
  assert.equal(scheduleDocumentProcessingRetry(pool, 1, options, process, { setTimer }), false);
  assert.equal(scheduleDocumentProcessingRetry(pool, 33, options, process, { setTimer }), false);
  callbacks[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [[pool, 1, options]]);
  assert.equal(scheduleDocumentProcessingRetry(pool, 1, options, process, { setTimer }), true);
});
