import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeHealthHandlers } from "../src/security/runtimeHealth.js";

function response() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
  };
}

test("liveness remains cheap and fails before shutdown drains traffic", () => {
  let shuttingDown = false;
  const handlers = createRuntimeHealthHandlers({
    pool: { async query() { return { rows: [{ ready: 1 }] }; } },
    isShuttingDown: () => shuttingDown,
  });
  const live = response();
  handlers.liveness({}, live);
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.body, { ok: true, status: "live" });
  shuttingDown = true;
  const stopping = response();
  handlers.liveness({}, stopping);
  assert.equal(stopping.statusCode, 503);
  assert.deepEqual(stopping.body, { ok: false, status: "shutting_down" });
});

test("readiness proves database, pool, artifact executor, and configured memory headroom", async () => {
  const pool = {
    totalCount: 4,
    idleCount: 3,
    waitingCount: 0,
    async query(config) {
      assert.deepEqual(config, { text: "SELECT 1 AS ready", query_timeout: 2_000 });
      return { rows: [{ ready: 1 }] };
    },
  };
  const handlers = createRuntimeHealthHandlers({
    pool,
    artifactExecutorSnapshot: () => ({ ready: true, active: 1, queued: 0 }),
    memoryUsage: () => ({ rss: 128 * 1024 * 1024, heapUsed: 40 * 1024 * 1024, external: 5 * 1024 * 1024 }),
    environment: { READINESS_MAX_RSS_MB: "512", READINESS_MAX_DATABASE_WAITERS: "2" },
  });
  const ready = response();
  await handlers.readiness({}, ready);
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.ok, true);
  assert.equal(ready.body.checks.database.pool.total, 4);
  assert.equal(ready.body.checks.database.pool.probe_timeout_ms, 2_000);
  assert.equal(ready.body.checks.memory.rss_mb, 128);
});

test("readiness bounds a stalled database probe instead of hanging the health endpoint", async () => {
  const handlers = createRuntimeHealthHandlers({
    pool: {
      async query() { return new Promise(() => {}); },
    },
    environment: { READINESS_DATABASE_TIMEOUT_MS: "100" },
  });
  const startedAt = Date.now();
  const degraded = response();
  await handlers.readiness({}, degraded);
  assert.equal(degraded.statusCode, 503);
  assert.deepEqual(degraded.body.blockers, ["database_unavailable"]);
  assert.equal(degraded.body.checks.database.pool.probe_timeout_ms, 100);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("readiness returns bounded blocker codes without leaking dependency errors", async () => {
  const handlers = createRuntimeHealthHandlers({
    pool: {
      waitingCount: 8,
      async query() { throw new Error("postgresql://secret@sensitive/internal"); },
    },
    artifactExecutorSnapshot: () => ({ ready: false, active: 0, queued: 0 }),
    memoryUsage: () => ({ rss: 600 * 1024 * 1024, heapUsed: 1, external: 1 }),
    environment: { READINESS_MAX_RSS_MB: "512", READINESS_MAX_DATABASE_WAITERS: "2" },
  });
  const degraded = response();
  await handlers.readiness({}, degraded);
  assert.equal(degraded.statusCode, 503);
  assert.deepEqual(degraded.body.blockers, [
    "database_unavailable",
    "database_pool_saturated",
    "artifact_executor_unavailable",
    "memory_pressure",
  ]);
  assert.doesNotMatch(JSON.stringify(degraded.body), /postgres|secret|sensitive/i);
});

test("readiness reports rollout posture with stable warnings without taking traffic offline", async () => {
  const handlers = createRuntimeHealthHandlers({
    pool: { async query() { return { rows: [{ ready: 1 }] }; } },
    securityPostureSnapshot: () => ({
      status: "degraded",
      mode: "production_rollout",
      warnings: [
        "legacy_auth_rollout_active",
        "legacy_auth_rollout_expiring",
        "not safe to expose: 2026-09-30",
      ],
      configured_secret: "must-not-leak",
    }),
  });
  const ready = response();
  await handlers.readiness({}, ready);
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.ok, true);
  assert.deepEqual(ready.body.warnings, [
    "legacy_auth_rollout_active",
    "legacy_auth_rollout_expiring",
  ]);
  assert.deepEqual(ready.body.checks.security, {
    status: "degraded",
    mode: "production_rollout",
    warnings: ["legacy_auth_rollout_active", "legacy_auth_rollout_expiring"],
  });
  assert.doesNotMatch(JSON.stringify(ready.body), /2026|secret|must-not-leak/i);
});

test("readiness fails closed with a stable code when security posture is unavailable", async () => {
  const handlers = createRuntimeHealthHandlers({
    pool: { async query() { return { rows: [{ ready: 1 }] }; } },
    securityPostureSnapshot: () => { throw new Error("secret diagnostic"); },
  });
  const degraded = response();
  await handlers.readiness({}, degraded);
  assert.equal(degraded.statusCode, 503);
  assert.deepEqual(degraded.body.blockers, ["security_posture_unavailable"]);
  assert.deepEqual(degraded.body.warnings, ["security_posture_unavailable"]);
  assert.doesNotMatch(JSON.stringify(degraded.body), /secret diagnostic/);
});
