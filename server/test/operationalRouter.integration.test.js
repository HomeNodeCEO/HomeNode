import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createOperationalRouter } from "../src/modules/operations/router.js";
import { buildDataRepairReadiness } from "../src/services/operationalReadiness.js";

function options(overrides = {}) {
  return {
    runtimeHealth: {
      liveness(_req, res) { res.json({ ok: true, status: "live" }); },
      readiness(_req, res) { res.json({ ok: true, status: "ready" }); },
    },
    pool: { totalCount: 4, idleCount: 3, waitingCount: 1 },
    requestPerformance: {
      snapshot: () => ({ requests: 7 }),
      recordClientError: () => true,
    },
    artifactRecoveryMonitor: { snapshot: () => ({ recovered: 2 }) },
    getArtifactExecutorSnapshot: () => ({ active: 1 }),
    loadDcadScraperStatus: async () => ({ payload: { status: "complete" }, stale: false }),
    inlineWorkers: { censusGeography: false, locationBackfill: false },
    documentEvidence: {
      privateObjectStorageConfigured: true,
      ocrProvider: "fixture",
      ocrConfigured: true,
    },
    processTarget: {
      uptime: () => 12.6,
      memoryUsage: () => ({
        rss: 5 * 1_048_576,
        heapUsed: 3 * 1_048_576,
        heapTotal: 4 * 1_048_576,
      }),
    },
    logger: { warn() {} },
    loadRecentMaintenance: async (_pool, { limit }) => [{ id: limit }],
    buildRepairReadiness: (input) => ({ status: "healthy", input }),
    ...overrides,
  };
}

async function startRouter(routerOptions, { authenticated = true } = {}) {
  const app = express();
  app.use(express.json());
  if (authenticated) {
    app.use((req, _res, next) => {
      req.mobileAuth = { userId: "authenticated-test-user" };
      next();
    });
  }
  app.use(createOperationalRouter(routerOptions));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

test("operational router preserves liveness, readiness, and aggregate performance contracts", async (context) => {
  const server = await startRouter(options());
  context.after(server.close);

  const health = await fetch(`${server.baseUrl}/health`);
  assert.deepEqual(await health.json(), { ok: true, status: "live" });
  const ready = await fetch(`${server.baseUrl}/ready`);
  assert.deepEqual(await ready.json(), { ok: true, status: "ready" });

  const response = await fetch(`${server.baseUrl}/api/system/performance`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    uptime_seconds: 13,
    web_process: {
      inline_workers: { census_geography: false, sales_location_backfill: false },
      scheduled_maintenance_expected: true,
    },
    document_evidence: {
      private_object_storage_configured: true,
      ocr_provider: "fixture",
      ocr_configured: true,
      ocr_runs_in_scheduled_maintenance: true,
    },
    requests: { requests: 7 },
    artifact_executor: { active: 1 },
    artifact_recovery: { recovered: 2 },
    maintenance: { status: "available", recent_runs: [{ id: 8 }] },
  });
});

test("performance exposes only maintenance run metadata, not stored failure details", async (context) => {
  const privateDetail = "postgresql://private-user:private-password@database.example/private-db";
  const server = await startRouter(options({
    loadRecentMaintenance: async () => [{
      id: 93,
      job_name: "routine",
      status: "failed",
      started_at: "2026-09-28T04:00:00.000Z",
      finished_at: "2026-09-28T04:01:00.000Z",
      error_message: privateDetail,
      details: { failures: [{ task: "census", error: privateDetail }] },
    }],
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/system/performance`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body.maintenance.recent_runs, [{
    id: 93,
    job_name: "routine",
    status: "failed",
    started_at: "2026-09-28T04:00:00.000Z",
    finished_at: "2026-09-28T04:01:00.000Z",
  }]);
  assert.doesNotMatch(JSON.stringify(body), /private-password/);
});

test("performance failures stay stable when optional warning logging fails", async (context) => {
  const server = await startRouter(options({
    loadRecentMaintenance: async () => { throw new Error("database password"); },
    logger: { warn: () => { throw new Error("logger_offline"); } },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/system/performance`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.maintenance, { status: "unavailable", recent_runs: [] });
  assert.doesNotMatch(JSON.stringify(body), /password|logger_offline/);
});

test("client render failures accept only the bounded operational event contract", async (context) => {
  const recorded = [];
  const server = await startRouter(options({
    requestPerformance: {
      snapshot: () => ({ requests: 0 }),
      recordClientError(event) {
        if (event?.source !== "root_error_boundary") return false;
        recorded.push(event);
        return true;
      },
    },
  }));
  context.after(server.close);

  const accepted = await fetch(`${server.baseUrl}/api/system/client-errors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "root_error_boundary",
      route_code: "property_report",
      error_type: "type_error",
    }),
  });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.headers.get("cache-control"), "no-store");
  assert.deepEqual(await accepted.json(), { ok: true });
  assert.deepEqual(recorded, [{
    source: "root_error_boundary",
    route_code: "property_report",
    error_type: "type_error",
  }]);

  const rejected = await fetch(`${server.baseUrl}/api/system/client-errors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "untrusted_source", message: "database password" }),
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid_client_error_event" });
  assert.equal(recorded.length, 1);

  const anonymousServer = await startRouter(options({
    requestPerformance: {
      snapshot: () => ({ requests: 0 }),
      recordClientError(event) { recorded.push(event); return true; },
    },
  }), { authenticated: false });
  context.after(anonymousServer.close);
  const anonymous = await fetch(`${anonymousServer.baseUrl}/api/system/client-errors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "root_error_boundary",
      route_code: "property_report",
      error_type: "type_error",
    }),
  });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "authentication_required" });
  assert.equal(recorded.length, 1);
});

test("data-repair diagnostics stay bounded when maintenance and scraper status fail", async (context) => {
  const warnings = [];
  let repairInput = null;
  const server = await startRouter(options({
    inlineWorkers: { censusGeography: true, locationBackfill: false },
    loadRecentMaintenance: async () => { throw new Error("database password"); },
    loadDcadScraperStatus: async () => { throw new Error("scraper secret"); },
    buildRepairReadiness(input) {
      repairInput = input;
      return { status: "degraded", action_items: [{ code: "dependency_unavailable" }] };
    },
    logger: { warn(...args) { warnings.push(args); } },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/system/data-repair`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.status, "degraded");
  assert.deepEqual(body.runtime, {
    uptime_seconds: 13,
    memory_mb: { resident_set: 5, heap_used: 3, heap_total: 4 },
    database_pool: { total: 4, idle: 3, waiting: 1 },
    inline_bulk_workers_enabled: true,
  });
  assert.deepEqual(repairInput.recentMaintenance, []);
  assert.equal(repairInput.scraper.payload, null);
  assert.equal(repairInput.scraper.stale, false);
  assert.deepEqual(repairInput.requestPerformance, { requests: 7 });
  assert.deepEqual(warnings, [
    ["[operations] maintenance history unavailable", "unknown"],
    ["[operations] scraper status unavailable", "unknown"],
  ]);
  assert.doesNotMatch(JSON.stringify(body), /password|scraper secret/i);
});

test("data-repair response excludes stored and upstream diagnostic text", async (context) => {
  const privateDetail = "postgresql://private-user:private-password@database.example/app";
  const server = await startRouter(options({
    loadRecentMaintenance: async () => [{
      id: 1,
      job_name: "routine",
      status: "failed",
      started_at: "2026-09-28T06:00:00.000Z",
      error_message: privateDetail,
      details: { results: {
        locations: { status: {
          queue: { pending: 3, secret: privateDetail },
          coverage: { missing_sale_account_count: 2, last_error: privateDetail },
        } },
      } },
    }],
    loadDcadScraperStatus: async () => ({
      payload: {
        phase: "initial_missing",
        outage_circuit_state: privateDetail,
        data_quality: { field_repair_pending: 4, private_detail: privateDetail },
      },
      error: privateDetail,
    }),
    buildRepairReadiness: buildDataRepairReadiness,
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/system/data-repair`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.maintenance.queues.locations.queue.pending, 3);
  assert.equal(body.maintenance.queues.locations.coverage.missing_sale_account_count, 2);
  assert.equal(body.dcad_scraper.data_quality.field_repair_pending, 4);
  assert.equal(body.dcad_scraper.fetch_error, "dcad_scraper_status_unavailable");
  assert.equal(body.maintenance.recent_failures[0].error, "scheduled_maintenance_failed");
  assert.doesNotMatch(JSON.stringify(body), /private-password|private_detail|last_error|secret/);
});

test("operational router fails before mounting when a required dependency is absent", () => {
  const required = [
    ["runtimeHealth", null, /operational_liveness_handler_required/],
    ["pool", null, /operational_pool_required/],
    ["requestPerformance", null, /operational_request_performance_required/],
    ["artifactRecoveryMonitor", null, /operational_artifact_recovery_required/],
    ["getArtifactExecutorSnapshot", null, /operational_artifact_executor_required/],
    ["loadDcadScraperStatus", null, /operational_scraper_status_loader_required/],
  ];
  for (const [key, value, pattern] of required) {
    assert.throws(() => createOperationalRouter(options({ [key]: value })), pattern);
  }
});

test("entrypoint preserves the legacy boundary and extracted-router mount order", () => {
  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const boundary = source.indexOf("mountApplicationRouteBoundary(app");
  const operations = source.indexOf("app.use(createOperationalRouter(");
  const signup = source.indexOf("app.use(createSignupRouter(");
  const accounts = source.indexOf("app.use(createAccountDetailRouter(");
  assert.ok(boundary >= 0);
  assert.ok(operations > boundary, "operations must retain the existing application boundary");
  assert.ok(signup > operations, "signup must retain its position after operations");
  assert.ok(accounts > signup, "account detail must remain after operations and signup");
});
