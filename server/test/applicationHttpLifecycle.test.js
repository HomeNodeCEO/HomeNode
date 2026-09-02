import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveApplicationPort,
  startApplicationHttpLifecycle,
} from "../src/application/httpLifecycle.js";

function fixture(overrides = {}) {
  const calls = [];
  const errorHandler = () => undefined;
  const app = {
    use(middleware) {
      calls.push(["use", middleware]);
    },
  };
  const pool = { end() {} };
  const runtimeResilience = {
    http: { requestTimeoutMs: 30_000 },
    shutdownGraceMs: 25_000,
  };
  const server = {
    listen(port, callback) {
      calls.push(["listen", port]);
      callback();
    },
  };
  const gracefulShutdown = { isShuttingDown: () => false };
  const logs = [];
  let shutdownOptions = null;
  let recoveryDisposals = 0;
  let artifactClosures = 0;
  const options = {
    app,
    pool,
    runtimeResilience,
    finalErrorHandler: errorHandler,
    artifactRecoveryMonitor: {
      dispose() { recoveryDisposals += 1; },
    },
    closeArtifactExecution() { artifactClosures += 1; },
    environment: { PORT: "4321" },
    logger: { log(message) { logs.push(message); } },
    createHttpServer(listener, configuration) {
      calls.push(["create", listener, configuration]);
      return server;
    },
    installShutdown(value) {
      calls.push(["shutdown"]);
      shutdownOptions = value;
      return gracefulShutdown;
    },
    ...overrides,
  };
  return {
    calls,
    errorHandler,
    app,
    pool,
    runtimeResilience,
    server,
    gracefulShutdown,
    logs,
    options,
    shutdownOptions: () => shutdownOptions,
    recoveryDisposals: () => recoveryDisposals,
    artifactClosures: () => artifactClosures,
  };
}

test("application port retains the established environment and default behavior", () => {
  assert.equal(resolveApplicationPort({}), 4000);
  assert.equal(resolveApplicationPort({ PORT: "4321" }), 4321);
  assert.equal(resolveApplicationPort({ PORT: "4321suffix" }), 4321);
  assert.equal(Number.isNaN(resolveApplicationPort({ PORT: "invalid" })), true);
});

test("HTTP lifecycle preserves final middleware, listen, and shutdown composition order", () => {
  const state = fixture();
  const result = startApplicationHttpLifecycle(state.options);

  assert.deepEqual(state.calls.map(([name]) => name), ["use", "create", "listen", "shutdown"]);
  assert.equal(state.calls[0][1], state.errorHandler);
  assert.equal(state.calls[1][1], state.app);
  assert.equal(state.calls[1][2], state.runtimeResilience);
  assert.equal(result.port, 4321);
  assert.equal(result.server, state.server);
  assert.equal(result.gracefulShutdown, state.gracefulShutdown);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(state.logs, ["API listening on http://localhost:4321"]);

  const shutdown = state.shutdownOptions();
  assert.equal(shutdown.server, state.server);
  assert.equal(shutdown.pool, state.pool);
  assert.equal(shutdown.graceMs, 25_000);
  assert.equal(shutdown.logger, state.options.logger);
  assert.equal(state.recoveryDisposals(), 0);
  assert.equal(state.artifactClosures(), 0);
  shutdown.onBegin();
  assert.equal(state.recoveryDisposals(), 1);
  assert.equal(state.artifactClosures(), 1);
});

test("HTTP lifecycle rejects incomplete composition dependencies before listening", () => {
  const required = [
    ["app", null, /application_http_app_required/],
    ["pool", null, /application_http_pool_required/],
    ["runtimeResilience", null, /application_http_resilience_required/],
    ["finalErrorHandler", null, /application_http_error_handler_required/],
    ["artifactRecoveryMonitor", null, /application_artifact_recovery_monitor_required/],
    ["closeArtifactExecution", null, /application_artifact_execution_closer_required/],
  ];
  for (const [key, value, pattern] of required) {
    const state = fixture({ [key]: value });
    assert.throws(() => startApplicationHttpLifecycle(state.options), pattern);
    assert.deepEqual(state.calls, []);
  }
});
