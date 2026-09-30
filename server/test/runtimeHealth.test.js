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

test("concurrent readiness requests share one database probe and retry after it settles", async () => {
  let resolveProbe;
  let queries = 0;
  const handlers = createRuntimeHealthHandlers({
    pool: {
      query() {
        queries += 1;
        if (queries === 1) return new Promise(resolve => { resolveProbe = resolve; });
        return Promise.resolve({ rows: [{ ready: 1 }] });
      },
    },
  });
  const first = response();
  const second = response();
  const firstCall = handlers.readiness({}, first);
  const secondCall = handlers.readiness({}, second);
  await Promise.resolve();
  assert.equal(queries, 1);

  resolveProbe({ rows: [{ ready: 1 }] });
  await Promise.all([firstCall, secondCall]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);

  const next = response();
  await handlers.readiness({}, next);
  assert.equal(queries, 2);
  assert.equal(next.statusCode, 200);
});

test("timed-out readiness requests do not queue new probes while the old query is pending", async () => {
  let resolveProbe;
  let queries = 0;
  const handlers = createRuntimeHealthHandlers({
    pool: {
      query() {
        queries += 1;
        if (queries === 1) return new Promise(resolve => { resolveProbe = resolve; });
        return Promise.resolve({ rows: [{ ready: 1 }] });
      },
    },
    environment: { READINESS_DATABASE_TIMEOUT_MS: "100" },
  });
  const first = response();
  const second = response();
  await Promise.all([handlers.readiness({}, first), handlers.readiness({}, second)]);
  assert.equal(queries, 1);
  assert.equal(first.statusCode, 503);
  assert.equal(second.statusCode, 503);

  const third = response();
  await handlers.readiness({}, third);
  assert.equal(queries, 1);
  assert.equal(third.statusCode, 503);

  resolveProbe({ rows: [{ ready: 1 }] });
  await new Promise(resolve => setImmediate(resolve));
  const recovered = response();
  await handlers.readiness({}, recovered);
  assert.equal(queries, 2);
  assert.equal(recovered.statusCode, 200);
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

test("readiness blocks while required startup initialization is pending", async () => {
  const handlers = createRuntimeHealthHandlers({
    pool: { async query() { return { rows: [{ ready: 1 }] }; } },
    startupInitializationSnapshot: () => ({
      required: {
        ready: ["account_locations_schema"],
        pending: ["assignment_files_schema"],
        failed: [],
      },
      optional: { ready: [], pending: ["census_geography_schema"], failed: [] },
    }),
  });
  const degraded = response();
  await handlers.readiness({}, degraded);
  assert.equal(degraded.statusCode, 503);
  assert.deepEqual(degraded.body.blockers, ["required_initialization_pending"]);
  assert.deepEqual(degraded.body.warnings, ["optional_initialization_pending"]);
  assert.deepEqual(degraded.body.checks.initialization.required.pending, [
    "assignment_files_schema",
  ]);
});

test("readiness blocks required initialization failures without leaking errors", async () => {
  const handlers = createRuntimeHealthHandlers({
    pool: { async query() { return { rows: [{ ready: 1 }] }; } },
    startupInitializationSnapshot: () => ({
      status: "failed",
      required: { ready: [], pending: [], failed: ["property_context_schema", "unsafe code"] },
      optional: { ready: [], pending: [], failed: ["location_backfill_schema"] },
      error: "postgresql://secret@sensitive/internal",
    }),
  });
  const degraded = response();
  await handlers.readiness({}, degraded);
  assert.equal(degraded.statusCode, 503);
  assert.deepEqual(degraded.body.blockers, ["required_initialization_failed"]);
  assert.deepEqual(degraded.body.warnings, ["optional_initialization_failed"]);
  assert.deepEqual(degraded.body.checks.initialization.required.failed, [
    "property_context_schema",
  ]);
  assert.doesNotMatch(JSON.stringify(degraded.body), /postgres|secret|sensitive|unsafe/i);
});

test("optional initialization failures warn without rejecting traffic", async () => {
  const handlers = createRuntimeHealthHandlers({
    pool: { async query() { return { rows: [{ ready: 1 }] }; } },
    startupInitializationSnapshot: () => ({
      required: { ready: ["assignment_files_schema"], pending: [], failed: [] },
      optional: { ready: [], pending: [], failed: ["census_geography_schema"] },
    }),
  });
  const ready = response();
  await handlers.readiness({}, ready);
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.ok, true);
  assert.deepEqual(ready.body.warnings, ["optional_initialization_failed"]);
  assert.equal(ready.body.checks.initialization.status, "degraded");
});
