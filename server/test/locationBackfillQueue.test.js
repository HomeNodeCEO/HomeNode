import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueLocationBackfillAccounts,
  ensureLocationBackfillQueueSchema,
  locationBackfillRetryDelaySeconds,
} from "../src/services/locationBackfillQueue.js";

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
