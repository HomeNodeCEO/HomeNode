import assert from "node:assert/strict";
import test from "node:test";

import {
  recoverStaleUadArtifactGenerations,
  startUadArtifactRecoveryMonitor,
} from "../src/modules/uad/uadArtifactRecovery.js";

test("startup recovery marks only stale generating artifacts retryable", async () => {
  const calls = [];
  const warnings = [];
  const result = await recoverStaleUadArtifactGenerations({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rowCount: 2, rows: [{ id: "one" }, { id: "two" }] };
    },
  }, {
    staleAfterMinutes: 10,
    logger: { warn(message) { warnings.push(message); } },
  });
  assert.deepEqual(result, { recovered: 2, stale_after_minutes: 10 });
  assert.deepEqual(calls[0].params, [10]);
  assert.match(calls[0].sql, /generation_status = 'generating'/);
  assert.match(calls[0].sql, /generation_started_at/);
  assert.match(calls[0].sql, /uad_artifact_generation_interrupted/);
  assert.equal(warnings.length, 1);
});

test("startup recovery has a five-minute minimum to avoid taking over active work", async () => {
  let params;
  const result = await recoverStaleUadArtifactGenerations({
    async query(_sql, values) {
      params = values;
      return { rowCount: 0, rows: [] };
    },
  }, { staleAfterMinutes: 1, logger: {} });
  assert.deepEqual(params, [5]);
  assert.equal(result.recovered, 0);
});

test("recovery monitor revisits interrupted generations after startup and stops on shutdown", async () => {
  let intervalCallback = null;
  let cleared = false;
  let passes = 0;
  const monitor = startUadArtifactRecoveryMonitor({ async query() {} }, {
    intervalMs: 10_000,
    runImmediately: false,
    now: () => `pass-${passes}`,
    setIntervalImpl(callback, milliseconds) {
      assert.equal(milliseconds, 10_000);
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalImpl() { cleared = true; },
    async runRecovery() {
      passes += 1;
      return { recovered: passes === 2 ? 1 : 0, stale_after_minutes: 15 };
    },
  });
  assert.equal((await monitor.runOnce()).recovered, 0);
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(monitor.snapshot(), {
    ready: true,
    closed: false,
    running: false,
    interval_ms: 10_000,
    completed: 2,
    failed: 0,
    recovered: 1,
    last_completed_at: "pass-2",
    last_error: null,
  });
  assert.equal(monitor.dispose(), true);
  assert.equal(cleared, true);
  assert.equal(monitor.snapshot().ready, false);
  assert.deepEqual(await monitor.runOnce(), { skipped: "closed" });
});

test("recovery monitor reports a safe error and continues after a failed database pass", async () => {
  let attempts = 0;
  const warnings = [];
  const monitor = startUadArtifactRecoveryMonitor({ async query() {} }, {
    runImmediately: false,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => undefined,
    logger: { warn(message) { warnings.push(message); } },
    async runRecovery() {
      attempts += 1;
      if (attempts === 1) throw new Error("postgresql://secret@internal");
      return { recovered: 0, stale_after_minutes: 15 };
    },
  });
  assert.deepEqual(await monitor.runOnce(), { error: "uad_artifact_recovery_unavailable" });
  assert.equal(monitor.snapshot().failed, 1);
  assert.doesNotMatch(JSON.stringify({ snapshot: monitor.snapshot(), warnings }), /postgres|secret|internal/i);
  assert.equal((await monitor.runOnce()).recovered, 0);
  assert.equal(monitor.snapshot().completed, 1);
  monitor.dispose();
});

test("recovery monitor never reclaims rows while this process is generating an artifact", async () => {
  let active = 1;
  let recoveryCalls = 0;
  const monitor = startUadArtifactRecoveryMonitor({ async query() {} }, {
    runImmediately: false,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => undefined,
    shouldRun: () => active === 0,
    async runRecovery() {
      recoveryCalls += 1;
      return { recovered: 0, stale_after_minutes: 15 };
    },
  });
  assert.deepEqual(await monitor.runOnce(), { skipped: "active_generation" });
  assert.equal(recoveryCalls, 0);
  active = 0;
  assert.equal((await monitor.runOnce()).recovered, 0);
  assert.equal(recoveryCalls, 1);
  monitor.dispose();
});
