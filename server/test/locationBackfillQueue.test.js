import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueLocationBackfillAccounts,
  ensureLocationBackfillQueueSchema,
  locationBackfillDiagnostic,
  locationBackfillRetryDelaySeconds,
  runLocationBackfillBatch,
} from "../src/services/locationBackfillQueue.js";

test("location backfill diagnostics retain only known source and review codes", () => {
  assert.equal(locationBackfillDiagnostic({ error: new Error("dcad_parcel_query_http_503") }), "dcad_parcel_query_http_503");
  assert.equal(locationBackfillDiagnostic({ error: new Error("dcad_parcel_query_http_503_token=secret") }), "location_backfill_failed");
  assert.equal(locationBackfillDiagnostic({ error: { code: "42P01", message: "password=secret" } }), "location_backfill_42P01");
  assert.equal(locationBackfillDiagnostic({ reviewReason: "multiple_parcel_features,site_address_mismatch" }), "multiple_parcel_features,site_address_mismatch");
  assert.equal(locationBackfillDiagnostic({ reviewReason: "password=secret" }), "location_unavailable");
  assert.equal(locationBackfillDiagnostic({ locationStatus: "not_found" }), "parcel_not_found");
});

test("location refresh failures never enter queue state or batch results as raw text", async () => {
  const statements = [];
  const workerId = "location-worker-1";
  const pool = {
    async query(sql, params) {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes("CREATE TABLE IF NOT EXISTS core.account_locations")) {
        throw new Error("database password=do-not-expose");
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql) {
          if (String(sql).includes("UPDATE app.location_backfill_queue queue")) {
            return { rows: [{ account_id: "26272500060150000", attempts: 0, worker_id: workerId }] };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const result = await runLocationBackfillBatch(pool, { workerId });

  assert.equal(result.retry, 1);
  assert.equal(result.manualReview, 0);
  assert.equal(result.error, "location_backfill_failed");
  const outcome = statements.find(({ sql }) => sql.includes("last_error = $5"));
  assert.equal(outcome.params[1], "retry");
  assert.equal(outcome.params[4], "location_backfill_failed");
  assert.equal(JSON.stringify({ statements, result }).includes("do-not-expose"), false);
});

test("location-backfill schema ensure shares one per-pool attempt and caches success", async () => {
  let finishQueue;
  const queuePending = new Promise((resolve) => { finishQueue = resolve; });
  let markQueueStarted;
  const queueStarted = new Promise((resolve) => { markQueueStarted = resolve; });
  const calls = [];
  const pool = { query: (sql) => {
    calls.push(sql);
    if (calls.length === 2) {
      markQueueStarted();
      return queuePending;
    }
    return Promise.resolve({ rows: [] });
  } };
  const first = ensureLocationBackfillQueueSchema(pool);
  const second = ensureLocationBackfillQueueSchema(pool);
  await queueStarted;
  assert.equal(calls.length, 2);
  finishQueue({ rows: [] });
  await Promise.all([first, second]);
  await ensureLocationBackfillQueueSchema(pool);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /core\.account_locations/);
  assert.match(calls[1], /app\.location_backfill_queue/);
});

test("location-backfill schema ensure retries only its failed phase", async () => {
  const calls = [];
  const pool = { query: async (sql) => {
    calls.push(sql);
    if (calls.length === 2) throw new Error("queue schema unavailable");
  } };
  await assert.rejects(ensureLocationBackfillQueueSchema(pool), /queue schema unavailable/);
  await ensureLocationBackfillQueueSchema(pool);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /app\.location_backfill_queue/);
});

test("location-backfill schema ensure retries both phases after its prerequisite fails", async () => {
  const calls = [];
  const pool = { query: async (sql) => {
    calls.push(sql);
    if (calls.length === 1) throw new Error("account locations unavailable");
  } };
  await assert.rejects(ensureLocationBackfillQueueSchema(pool), /account locations unavailable/);
  await ensureLocationBackfillQueueSchema(pool);
  assert.equal(calls.length, 3);
  assert.match(calls[1], /core\.account_locations/);
  assert.match(calls[2], /app\.location_backfill_queue/);
});

test("location backfill retries use bounded exponential delays", () => {
  assert.equal(locationBackfillRetryDelaySeconds(1), 30);
  assert.equal(locationBackfillRetryDelaySeconds(2), 60);
  assert.equal(locationBackfillRetryDelaySeconds(5), 480);
  assert.equal(locationBackfillRetryDelaySeconds(20), 3600);
  assert.equal(
    locationBackfillRetryDelaySeconds(3, {
      baseSeconds: 10,
      maximumSeconds: 25,
    }),
    25,
  );
});

test("queueing deduplicates Dallas accounts and rejects unsupported counties", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      const requested = JSON.parse(params[0]);
      return {
        rows: requested.map((item) => ({ account_id: item.account_id })),
      };
    },
  };
  const result = await enqueueLocationBackfillAccounts(
    pool,
    [
      {
        account_id: "26272500060150000",
        address: "1909 SNOWMASS LN",
        county: "Dallas County",
      },
      {
        account_id: "26272500060150000",
        address: "1909 SNOWMASS LN",
        county: "Dallas",
      },
      {
        account_id: "12345678901234567",
        address: "COLLIN TEST",
        county: "Collin",
      },
      { account_id: "invalid", county: "Dallas" },
    ],
    { reason: "sales_reconciliation", priority: 200 },
  );

  assert.equal(calls.length, 1);
  assert.equal(result.requested, 1);
  assert.equal(result.queued, 1);
  assert.deepEqual(result.accountIds, ["26272500060150000"]);
  assert.equal(calls[0].params[1], 200);
  assert.equal(calls[0].params[2], "sales_reconciliation");
  assert.match(calls[0].sql, /location_backfill_queue/);
});
