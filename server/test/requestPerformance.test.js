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
  assert.equal(
    normalizePerformancePath(
      "/api/uad/workfiles/5cf2dacc-5c55-4ed5-bdc1-b445e70f570b/assets/c0a8133d-06b4-48fa-bdb3-a25d996ab3e0/verify",
    ),
    "/api/uad/workfiles/:workfileId/assets/:assetId/verify",
  );
  assert.equal(
    normalizePerformancePath("/api/uad/accounts/UAD-REDTEAM-SFR-0001/workfiles?limit=5"),
    "/api/uad/accounts/:accountId/workfiles",
  );
  assert.equal(
    normalizePerformancePath("/api/unknown/5cf2dacc-5c55-4ed5-bdc1-b445e70f570b"),
    "/api/unknown/:id",
  );
});

test("percentile uses nearest-rank semantics", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
});

test("request monitor records bounded, aggregated samples", () => {
  let clock = 0n;
  let monitorDisabled = 0;
  const eventLoopDelay = {
    count: 5,
    mean: 12_400_000,
    max: 48_900_000,
    enable() {},
    disable() { monitorDisabled += 1; },
    percentile(value) {
      return { 50: 10_100_000, 95: 32_200_000, 99: 47_700_000 }[value];
    },
  };
  const monitor = createRequestPerformanceMonitor({
    env: {
      PERFORMANCE_WARN_MS: "100",
      PERFORMANCE_SLOW_MS: "200",
      PERFORMANCE_WINDOW_SIZE: "25",
    },
    now: () => clock,
    logger: { info() {}, warn() {} },
    pool: { totalCount: 4, idleCount: 3, waitingCount: 0 },
    createEventLoopDelayMonitor(options) {
      assert.deepEqual(options, { resolution: 20 });
      return eventLoopDelay;
    },
    eventLoopUtilization: () => ({ utilization: 0.276 }),
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
  assert.equal(status.window.completed, 1);
  assert.equal(status.window.interrupted, 0);
  assert.equal(status.window.client_errors, 0);
  assert.equal(status.window.p95_ms, 125);
  assert.equal(status.window.sample_state, "warming");
  assert.equal(status.window.minimum_ready_samples, 25);
  assert.equal(status.slowest_routes[0].route, "GET /api/accounts/:accountId");
  assert.equal(status.slowest_routes[0].average_ms, 125);
  assert.equal(status.slowest_routes[0].above_target, 1);
  assert.equal(status.slowest_routes[0].completed, 1);
  assert.equal(status.slowest_routes[0].interrupted, 0);
  assert.deepEqual(status.database_pool, { total: 4, idle: 3, waiting: 0 });
  assert.deepEqual(status.event_loop, {
    delay: {
      resolution_ms: 20,
      samples: 5,
      sample_state: "ready",
      mean_ms: 12.4,
      p50_ms: 10.1,
      p95_ms: 32.2,
      p99_ms: 47.7,
      maximum_ms: 48.9,
    },
    utilization_percent: 27.6,
  });
  assert.deepEqual(status.browser_recovery, {
    window: { capacity: 25, events: 0, last_recorded_at: null },
    by_route: [],
    by_error_type: [],
  });
  monitor.dispose();
  assert.equal(monitorDisabled, 1);
});

test("client error telemetry retains only allowlisted aggregate codes", () => {
  const errors = [];
  const monitor = createRequestPerformanceMonitor({
    env: { PERFORMANCE_WINDOW_SIZE: "25" },
    logger: { error(message, payload) { errors.push({ message, payload }); } },
    createEventLoopDelayMonitor: () => ({ count: 0, enable() {}, disable() {} }),
    eventLoopUtilization: () => ({ utilization: 0 }),
  });
  assert.equal(monitor.recordClientError(null), false);
  assert.equal(monitor.recordClientError({ source: "unknown" }), false);
  assert.equal(monitor.recordClientError({
    source: "root_error_boundary",
    route_code: "report/secret-account-id",
    error_type: "database password",
    message: "token=must-not-leak",
    stack: "postgresql://secret@sensitive/internal",
  }), false);
  assert.equal(monitor.recordClientError({
    source: "root_error_boundary",
    route_code: "unknown",
    error_type: "generic_error",
  }), true);
  assert.equal(monitor.recordClientError({
    source: "root_error_boundary",
    route_code: "uad_workspace",
    error_type: "chunk_load_error",
  }), true);

  const snapshot = monitor.snapshot().browser_recovery;
  assert.equal(snapshot.window.events, 2);
  assert.equal(typeof snapshot.window.last_recorded_at, "string");
  assert.deepEqual(snapshot.by_route, [
    { route_code: "uad_workspace", events: 1 },
    { route_code: "unknown", events: 1 },
  ]);
  assert.deepEqual(snapshot.by_error_type, [
    { error_type: "chunk_load_error", events: 1 },
    { error_type: "generic_error", events: 1 },
  ]);
  assert.deepEqual(errors.map(({ message, payload }) => ({ message, payload })), [
    {
      message: "[frontend] application render failure",
      payload: {
        code: "application_render_failure",
        error_type: "generic_error",
        route_code: "unknown",
      },
    },
    {
      message: "[frontend] application render failure",
      payload: {
        code: "application_render_failure",
        error_type: "chunk_load_error",
        route_code: "uad_workspace",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify({ snapshot, errors }), /password|token|postgres|secret|sensitive/i);
});

test("request monitor records a response close before finish exactly once", () => {
  let clock = 0n;
  const warnings = [];
  const monitor = createRequestPerformanceMonitor({
    now: () => clock,
    logger: { warn(message, payload) { warnings.push({ message, payload }); } },
    createEventLoopDelayMonitor: () => ({
      count: 0,
      enable() {},
      disable() {},
    }),
    eventLoopUtilization: () => ({ utilization: Number.NaN }),
  });
  const listeners = new Map();
  monitor.middleware({
    method: "POST",
    path: "/api/accounts/26272500060150000/assignment-files/12345",
  }, {
    statusCode: 200,
    once(event, listener) { listeners.set(event, listener); },
  }, () => {});
  clock = 75_000_000n;
  listeners.get("close")();
  listeners.get("finish")();

  const status = monitor.snapshot();
  assert.equal(status.window.requests, 1);
  assert.equal(status.window.completed, 0);
  assert.equal(status.window.interrupted, 1);
  assert.equal(status.window.server_errors, 0);
  assert.equal(status.slowest_routes[0].route, "POST /api/accounts/:accountId/assignment-files/:fileId");
  assert.equal(status.slowest_routes[0].interrupted, 1);
  assert.deepEqual(status.event_loop, {
    delay: {
      resolution_ms: 20,
      samples: 0,
      sample_state: "warming",
      mean_ms: 0,
      p50_ms: 0,
      p95_ms: 0,
      p99_ms: 0,
      maximum_ms: 0,
    },
    utilization_percent: 0,
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, "[performance] request closed before completion");
  assert.equal(warnings[0].payload.path, "/api/accounts/:accountId/assignment-files/:fileId");
  assert.equal(warnings[0].payload.outcome, "closed_before_finish");
});
