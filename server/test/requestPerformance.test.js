import assert from "node:assert/strict";
import test from "node:test";

import {
  createRequestPerformanceMonitor,
  environmentFlag,
  normalizePerformancePath,
  percentile,
} from "../src/util/requestPerformance.js";

test("bulk workers require an explicit true value", () => {
  assert.equal(environmentFlag(undefined), false);
  assert.equal(environmentFlag("false"), false);
  assert.equal(environmentFlag("TRUE"), true);
  assert.equal(environmentFlag("1"), true);
  assert.equal(environmentFlag(undefined, { defaultEnabled: true }), true);
});

test("performance paths remove account and file identifiers", () => {
  assert.equal(
    normalizePerformancePath("/api/accounts/26272500060150000?include=all"),
    "/api/accounts/:accountId",
  );
  assert.equal(
    normalizePerformancePath("/api/accounts/26272500060150000/assignment-files/12345"),
    "/api/accounts/:accountId/assignment-files/:fileId",
  );
});

test("percentile uses nearest-rank semantics", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test("request monitor records bounded, aggregated samples", () => {
  let clock = 0n;
  const monitor = createRequestPerformanceMonitor({
    env: {
      PERFORMANCE_WARN_MS: "100",
      PERFORMANCE_SLOW_MS: "200",
      PERFORMANCE_WINDOW_SIZE: "25",
    },
    now: () => clock,
    logger: { info() {}, warn() {} },
    pool: { totalCount: 4, idleCount: 3, waitingCount: 0 },
  });
  const listeners = new Map();
  const response = {
    statusCode: 200,
    once(event, listener) { listeners.set(event, listener); },
    getHeader() { return "1024"; },
  };
  monitor.middleware(
    { method: "GET", path: "/api/accounts/26272500060150000" },
    response,
    () => {},
  );
  clock = 125_000_000n;
  listeners.get("finish")();

  const status = monitor.snapshot();
  assert.equal(status.window.requests, 1);
  assert.equal(status.window.above_target, 1);
  assert.equal(status.window.p95_ms, 125);
  assert.equal(status.slowest_routes[0].route, "GET /api/accounts/:accountId");
  assert.deepEqual(status.database_pool, { total: 4, idle: 3, waiting: 0 });
});
