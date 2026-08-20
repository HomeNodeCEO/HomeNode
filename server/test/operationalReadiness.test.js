import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDataRepairReadiness,
  createCachedScraperStatusLoader,
  summarizeDcadScraperStatus,
  summarizeMaintenanceReadiness,
} from "../src/services/operationalReadiness.js";

const NOW = new Date("2026-08-19T20:00:00.000Z");

function maintenanceRun() {
  return {
    id: 91,
    job_name: "routine",
    status: "completed",
    started_at: "2026-08-19T07:00:00.000Z",
    finished_at: "2026-08-19T07:12:00.000Z",
    details: {
      results: {
        census: { status: { coverage: { missing_lookup_input_count: 12 }, queue: { pending: 4 } } },
        locations: { completed: 200, status: { coverage: { missing_sale_account_count: 6303, coverage_percent: 80.29 }, queue: { pending: 6295 } } },
        influences: { status: {
          coverage: { missing_sale_account_count: 3907, coverage_percent: 88.8 },
          migration: { recalculation_in_progress: true },
          unmatched_sales: { review_required_record_count: 1946 },
        } },
      },
    },
  };
}

test("maintenance summary exposes actionable queue backlogs without account identifiers", () => {
  const result = summarizeMaintenanceReadiness([maintenanceRun()], { now: NOW });
  assert.equal(result.status, "attention");
  assert.equal(result.queues.locations.coverage.missing_sale_account_count, 6303);
  assert.equal(result.queues.locations.last_run.completed, 200);
  assert.equal(result.action_items.some((item) => item.code === "sale_locations_pending"), true);
  assert.equal(result.action_items.some((item) => item.code === "sales_reconciliation_pending"), true);
  assert.equal(JSON.stringify(result).includes("26272500060150000"), false);
});

test("stale maintenance is a degraded operational state", () => {
  const run = maintenanceRun();
  run.finished_at = "2026-08-15T00:00:00.000Z";
  const result = summarizeMaintenanceReadiness([run], { now: NOW });
  assert.equal(result.status, "degraded");
  assert.equal(result.action_items[0].code, "scheduled_maintenance_stale");
});

test("scraper summary reports campaign and field-repair progress", () => {
  const result = summarizeDcadScraperStatus({
    campaign_key: "dallas_residential",
    phase: "initial_missing",
    initial_missing_count: 558534,
    initial_completed: 329741,
    initial_remaining: 228793,
    outage_circuit_state: "closed",
    data_quality: {
      field_repair_pending: 49191,
      owner_recovery_pending: 513,
      needs_review: 883,
    },
  });
  assert.equal(result.progress.initial_percent, 59.04);
  assert.equal(result.data_quality.field_repair_pending, 49191);
  assert.equal(result.action_items.some((item) => item.code === "dcad_field_repair_pending"), true);
});

test("scraper loader caches success and retains last-known data on failure", async () => {
  let calls = 0;
  let clock = Date.parse("2026-08-19T20:00:00.000Z");
  const loader = createCachedScraperStatusLoader({
    ttlMs: 1000,
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      if (calls > 1) throw new Error("source_down");
      return { ok: true, async json() { return { phase: "initial_missing" }; } };
    },
  });
  assert.equal((await loader()).payload.phase, "initial_missing");
  assert.equal((await loader()).stale, false);
  assert.equal(calls, 1);
  clock += 2000;
  const stale = await loader();
  assert.equal(stale.stale, true);
  assert.equal(stale.payload.phase, "initial_missing");
  assert.equal(stale.error, "source_down");
});

test("combined readiness includes request timing and both repair sources", () => {
  const result = buildDataRepairReadiness({
    recentMaintenance: [maintenanceRun()],
    scraper: {
      fetched_at: NOW.toISOString(),
      payload: {
        phase: "initial_missing",
        initial_missing_count: 10,
        initial_completed: 9,
        initial_remaining: 1,
        outage_circuit_state: "closed",
        data_quality: {},
      },
    },
    requestPerformance: { window: { p95_ms: 100 } },
    now: NOW,
  });
  assert.equal(result.status, "attention");
  assert.equal(result.request_performance.window.p95_ms, 100);
  assert.equal(result.dcad_scraper.progress.initial_remaining, 1);
  assert.equal(result.maintenance.queues.locations.coverage.missing_sale_account_count, 6303);
});

test("a recent one-off task does not hide a stale routine schedule", () => {
  const oldRoutine = maintenanceRun();
  oldRoutine.finished_at = "2026-08-15T00:00:00.000Z";
  const recentLocation = {
    id: 92,
    job_name: "locations",
    status: "completed",
    started_at: "2026-08-19T19:58:00.000Z",
    finished_at: "2026-08-19T19:59:00.000Z",
    details: { results: { locations: { status: { coverage: { missing_sale_account_count: 0 } } } } },
  };
  const result = summarizeMaintenanceReadiness([recentLocation, oldRoutine], { now: NOW });
  assert.equal(result.status, "degraded");
  assert.equal(result.action_items[0].code, "scheduled_maintenance_stale");
});
