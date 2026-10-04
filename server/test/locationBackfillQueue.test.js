import assert from "node:assert/strict";
import test from "node:test";

import {
  enqueueLocationBackfillAccounts,
  ensureLocationBackfillQueueSchema,
  locationBackfillDiagnostic,
  locationBackfillRetryDelaySeconds,
  runLocationBackfillBatch,
  startLocationBackfillWorker,
} from "../src/services/locationBackfillQueue.js";

test("location backfill diagnostics retain only known source and review codes", () => {
  assert.equal(locationBackfillDiagnostic({ error: new Error("dcad_parcel_query_http_503") }), "dcad_parcel_query_http_503");
  assert.equal(locationBackfillDiagnostic({ error: new Error("dcad_parcel_query_http_503_token=secret") }), "location_backfill_failed");
  assert.equal(locationBackfillDiagnostic({ error: { code: "42P01", message: "password=secret" } }), "location_backfill_42P01");
  assert.equal(locationBackfillDiagnostic({ reviewReason: "multiple_parcel_features,site_address_mismatch" }), "multiple_parcel_features,site_address_mismatch");
  assert.equal(locationBackfillDiagnostic({ reviewReason: "password=secret" }), "location_unavailable");
  assert.equal(locationBackfillDiagnostic({ locationStatus: "not_found" }), "parcel_not_found");
});

test("location-backfill worker retries without logging raw database exceptions", async () => {
  const logged = [];
  const worker = startLocationBackfillWorker({
    async query() { throw new Error("database password=do-not-expose"); },
  }, {
    initialDelayMs: 300_000,
    logger: { warn(...args) { logged.push(args); } },
  });
  try {
    await worker.runNow();
  } finally {
    worker.stop();
  }
  assert.deepEqual(logged, [[
    "[location-backfill] cycle failed; will retry",
    "location_backfill_failed",
  ]]);
  assert.doesNotMatch(JSON.stringify(logged), /do-not-expose/);
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

for (const failureStage of ["BEGIN", "lease recovery", "claim", "COMMIT"]) {
  for (const rollbackFails of [false, true]) {
    test(`location ${failureStage} failure preserves its error and ${rollbackFails ? "retires" : "reuses"} the client`, async () => {
      const primaryError = new Error("private location claim detail");
      const rollbackError = new Error("private rollback connection detail");
      const statements = [];
      const releases = [];
      const client = {
        async query(sql) {
          statements.push(sql);
          if (sql === "ROLLBACK" && rollbackFails) throw rollbackError;
          if (sql === failureStage
              || (failureStage === "lease recovery" && sql.includes("SET status = 'retry'"))
              || (failureStage === "claim" && sql.includes("UPDATE app.location_backfill_queue queue"))) {
            throw primaryError;
          }
          return { rows: [] };
        },
        release(error) { releases.push(error); },
      };
      await assert.rejects(runLocationBackfillBatch({
        async connect() { return client; },
        async query() { assert.fail("failed claims must not refresh or settle locations"); },
      }, {
        fetchImpl: async () => { assert.fail("failed claims must not contact the provider"); },
      }), error => error === primaryError);
      assert.equal(statements.at(-1), "ROLLBACK");
      assert.equal(statements.filter(sql => sql === "ROLLBACK").length, 1);
      assert.equal(releases.length, 1);
      if (rollbackFails) {
        assert.ok(releases[0] instanceof Error);
        assert.equal(releases[0].message, "location_backfill_rollback_failed");
        assert.notEqual(releases[0], primaryError);
        assert.notEqual(releases[0], rollbackError);
      } else {
        assert.equal(releases[0], undefined);
      }
    });
  }
}

test("an empty location claim commits and releases a reusable client", async () => {
  const statements = [];
  const releases = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  };
  const result = await runLocationBackfillBatch({
    async connect() { return client; },
    async query() { assert.fail("empty claims need no location refresh or settlement"); },
  }, {
    workerId: "location-claim-test-worker",
    batchSize: 7,
    fetchImpl: async () => { assert.fail("empty claims must not contact the provider"); },
  });
  assert.deepEqual(result, { claimed: 0, completed: 0, retry: 0, manualReview: 0 });
  assert.equal(statements.length, 4);
  assert.equal(statements[0].sql, "BEGIN");
  assert.match(statements[1].sql, /SET status = 'retry'/);
  assert.match(statements[2].sql, /UPDATE app\.location_backfill_queue queue/);
  assert.deepEqual(statements[2].params, [7, "location-claim-test-worker"]);
  assert.equal(statements[3].sql, "COMMIT");
  assert.deepEqual(releases, [undefined]);
});

test("location connection failure preserves its cause without provider or settlement work", async () => {
  const primaryError = new Error("location claim connection unavailable");
  await assert.rejects(runLocationBackfillBatch({
    async connect() { throw primaryError; },
    async query() { assert.fail("connection failure must not refresh or settle locations"); },
  }, {
    fetchImpl: async () => { assert.fail("connection failure must not contact the provider"); },
  }), error => error === primaryError);
});

const claimStages = ["BEGIN", "lease recovery", "claim", "COMMIT"];

function locationCleanupFixture({
  failureStage, rollbackMode = "resolve", releaseError,
  beforeRollback = () => undefined,
} = {}) {
  const events = [], releases = [];
  const primaryError = new Error("private location claim detail");
  const rollbackError = new Error("private rollback connection detail");
  let connections = 0;
  const client = {
    query(sql) {
      const stage = ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ? sql
        : sql.includes("UPDATE app.location_backfill_queue queue") ? "claim"
          : sql.includes("SET status = 'retry'") ? "lease recovery" : null;
      assert.ok(stage, "unexpected claim statement");
      events.push(stage);
      if (stage === "ROLLBACK") {
        if (rollbackMode === "throw") throw rollbackError;
        return Promise.resolve(beforeRollback()).then(() => {
          if (rollbackMode === "reject") throw rollbackError;
          return { rows: [] };
        });
      }
      if (stage === failureStage) return Promise.reject(primaryError);
      return Promise.resolve({ rows: stage === "claim" ? [{
        account_id: "26272500060150000", address: "1909 SNOWMASS LN",
        county: "Dallas", attempts: 0, worker_id: "cleanup-test-worker",
        reason: "sales_inventory", priority: 50,
      }] : [] });
    },
    release(...args) {
      events.push("release"); releases.push(args);
      if (releaseError !== undefined) throw releaseError;
    },
  };
  return {
    events, releases, primaryError, rollbackError,
    get connections() { return connections; },
    run: () => runLocationBackfillBatch({
      async connect() { connections += 1; events.push("connect"); return client; },
      async query() { events.push("post-claim query"); assert.fail("failed claim cleanup must not refresh or settle locations"); },
    }, {
      workerId: "cleanup-test-worker", batchSize: 1,
      fetchImpl: async () => { events.push("provider"); assert.fail("failed claim cleanup must not contact the provider"); },
    }),
  };
}

function assertLocationCleanupRelease(fixture, discarded) {
  assert.equal(fixture.connections, 1);
  assert.equal(fixture.releases.length, 1);
  assert.equal(fixture.releases[0].length, 1);
  const [reason] = fixture.releases[0];
  if (!discarded) return assert.equal(reason, undefined);
  assert.ok(reason instanceof Error);
  assert.equal(reason.message, "location_backfill_rollback_failed");
  assert.equal(Object.hasOwn(reason, "cause"), false);
  assert.deepEqual(Object.keys(reason), []);
  assert.equal(reason.stack.includes("private"), false);
  assert.notEqual(reason, fixture.primaryError);
  assert.notEqual(reason, fixture.rollbackError);
}

for (const failureStage of claimStages) {
  test(`location ${failureStage} failure survives a synchronous rollback throw`, async () => {
    const fixture = locationCleanupFixture({ failureStage, rollbackMode: "throw" });
    await assert.rejects(fixture.run(), error => error === fixture.primaryError);
    assert.deepEqual(fixture.events, [
      "connect", ...claimStages.slice(0, claimStages.indexOf(failureStage) + 1), "ROLLBACK", "release",
    ]);
    assertLocationCleanupRelease(fixture, true);
  });
}

for (const outcome of [
  { name: "COMMIT" },
  { name: "primary failure and successful rollback", failureStage: "claim" },
  { name: "primary failure and failed rollback", failureStage: "claim", rollbackMode: "reject" },
]) {
  for (const [kind, releaseError] of [
    ["Error", new Error("release failed")],
    ["Symbol", Symbol("release failed")],
    ["object", Object.freeze({ release: "failed" })],
  ]) {
    test(`location release-thrown ${kind} retains precedence after ${outcome.name}`, async () => {
      const fixture = locationCleanupFixture({ ...outcome, releaseError });
      await assert.rejects(fixture.run(), error => error === releaseError);
      assert.deepEqual(fixture.events, [
        "connect", "BEGIN", "lease recovery", "claim", outcome.failureStage ? "ROLLBACK" : "COMMIT", "release",
      ]);
      assertLocationCleanupRelease(fixture, outcome.rollbackMode === "reject");
    });
  }
}

for (const rollbackMode of ["resolve", "reject"]) {
  test(`location awaits rollback ${rollbackMode} before releasing or rejecting the batch`, async () => {
    let finishRollback;
    const gate = new Promise(resolve => { finishRollback = resolve; });
    const fixture = locationCleanupFixture({ failureStage: "claim", rollbackMode, beforeRollback: () => gate });
    let settled = false;
    const pending = fixture.run().then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(fixture.events, ["connect", "BEGIN", "lease recovery", "claim", "ROLLBACK"]);
      assert.deepEqual(fixture.releases, []);
      assert.equal(settled, false);
      finishRollback();
      assert.equal((await pending).error, fixture.primaryError);
      assert.deepEqual(fixture.events, ["connect", "BEGIN", "lease recovery", "claim", "ROLLBACK", "release"]);
      assertLocationCleanupRelease(fixture, rollbackMode === "reject");
    } finally {
      finishRollback();
      await pending;
    }
  });
}

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
