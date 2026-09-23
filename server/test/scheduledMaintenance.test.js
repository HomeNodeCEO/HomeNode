import assert from "node:assert/strict";
import test from "node:test";

import {
  purgeExpiredWebSessions,
  recoverStaleScheduledMaintenanceRuns,
  resolveMaintenanceTasks,
  runScheduledMaintenance,
} from "../src/services/scheduledMaintenance.js";

test("routine maintenance refreshes cached parcel influences but excludes slower monthly source mirrors", () => {
  assert.deepEqual(resolveMaintenanceTasks("routine"), ["sessions", "documents", "sales-reconciliation", "census", "locations", "parcels", "influences"]);
});

test("maintenance tasks can be scheduled independently", () => {
  assert.deepEqual(resolveMaintenanceTasks("roads"), ["roads"]);
  assert.deepEqual(resolveMaintenanceTasks("census"), ["census"]);
  assert.deepEqual(resolveMaintenanceTasks("traffic"), ["traffic"]);
  assert.deepEqual(resolveMaintenanceTasks("sales"), ["sales-reconciliation", "locations", "influences"]);
  assert.deepEqual(resolveMaintenanceTasks("documents"), ["documents"]);
  assert.deepEqual(resolveMaintenanceTasks("sessions"), ["sessions"]);
  assert.deepEqual(resolveMaintenanceTasks("context"), ["roads", "traffic", "floods", "zoning", "influences"]);
  assert.deepEqual(resolveMaintenanceTasks("all"), [
    "sessions", "documents", "sales-reconciliation", "census", "locations", "parcels", "roads", "traffic", "floods", "zoning", "influences",
  ]);
});

test("unknown maintenance tasks fail before any database work", () => {
  assert.throws(() => resolveMaintenanceTasks("mystery"), /Unknown maintenance task/);
});

test("maintenance fails fast when its pool cannot reserve a lock connection", async () => {
  const pool = { options: { max: 1 }, async connect() { throw new Error("should_not_connect"); } };
  await assert.rejects(runScheduledMaintenance(pool, { task: "sessions" }), /maintenance_pool_requires_two_connections/);
});

test("stale maintenance history is closed without touching a live advisory lock", async () => {
  let params = null;
  const pool = {
    async query(sql, values) {
      assert.match(sql, /stale_maintenance_run_recovered/);
      params = values;
      return { rowCount: 3, rows: [] };
    },
  };
  assert.equal(
    await recoverStaleScheduledMaintenanceRuns(pool, { olderThanMinutes: 75 }),
    3,
  );
  assert.deepEqual(params, [75]);
});

test("expired and revoked web sessions are purged in a bounded skip-locked batch", async () => {
  let statement = "";
  let parameters = null;
  const pool = {
    async query(sql, values) {
      if (/DELETE FROM app_auth\.web_sessions/.test(sql)) {
        statement = sql;
        parameters = values;
        return { rowCount: 17, rows: [] };
      }
      return { rows: [] };
    },
    async connect() { return { query: (...args) => pool.query(...args), release() {} }; },
  };

  assert.deepEqual(
    await purgeExpiredWebSessions(pool, { retentionDays: 45, batchSize: 250 }),
    { purged: 17, retention_days: 45, batch_size: 250 },
  );
  assert.match(statement, /FROM app_auth\.web_sessions/);
  assert.match(
    statement,
    /WHERE LEAST\(expires_at, COALESCE\(revoked_at, expires_at\)\)\s+< now\(\)/,
  );
  assert.match(
    statement,
    /ORDER BY LEAST\(expires_at, COALESCE\(revoked_at, expires_at\)\), id/,
  );
  assert.doesNotMatch(statement, /\sOR\s/);
  assert.match(statement, /LIMIT \$2/);
  assert.match(statement, /FOR UPDATE SKIP LOCKED/);
  assert.match(statement, /DELETE FROM app_auth\.web_sessions/);
  assert.doesNotMatch(statement, /RETURNING/);
  assert.deepEqual(parameters, [45, 250]);
});

test("web session purge settings remain inside conservative bounds", async () => {
  const calls = [];
  const pool = {
    async query(_sql, values) {
      if (/DELETE FROM app_auth\.web_sessions/.test(_sql)) calls.push(values);
      return { rowCount: 0, rows: [] };
    },
    async connect() { return { query: (...args) => pool.query(...args), release() {} }; },
  };

  assert.deepEqual(
    await purgeExpiredWebSessions(pool, { retentionDays: -1, batchSize: 500_000 }),
    { purged: 0, retention_days: 1, batch_size: 10_000 },
  );
  assert.deepEqual(calls, [[1, 10_000]]);
});

test("session purge times out within the remaining maintenance window and releases its connection", async () => {
  const calls = [];
  let released = false;
  const pool = {
    async connect() {
      return {
        async query(sql, values) {
          calls.push({ sql, values });
          if (/DELETE FROM app_auth\.web_sessions/.test(sql)) return { rowCount: 1 };
          return { rows: [] };
        },
        release() { released = true; },
      };
    },
  };
  const result = await purgeExpiredWebSessions(pool, { deadline: Date.now() + 5_000 });
  assert.equal(result.purged, 1);
  const timeout = calls.find(({ sql }) => /set_config\('statement_timeout'/.test(sql));
  assert.ok(Number(timeout.values[0]) > 0 && Number(timeout.values[0]) <= 5_000);
  assert.equal(calls.at(-1).sql, "COMMIT");
  assert.equal(released, true);
});

test("failed session purge rolls back without deleting a second batch", async () => {
  const calls = [];
  let released = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          if (/DELETE FROM app_auth\.web_sessions/.test(sql)) throw new Error("query_timeout");
          return { rows: [] };
        },
        release() { released = true; },
      };
    },
  };
  await assert.rejects(purgeExpiredWebSessions(pool), /query_timeout/);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(released, true);
  assert.equal(calls.filter((sql) => /DELETE FROM app_auth\.web_sessions/.test(sql)).length, 1);
});

test("session maintenance records only aggregate purge results", async () => {
  const pool = {
    async query(sql, values) {
      assert.doesNotMatch(sql, /pg_try_advisory_lock|pg_advisory_unlock/);
      if (/INSERT INTO app\.scheduled_maintenance_runs/.test(sql)) {
        return { rows: [{ id: 93 }] };
      }
      if (/DELETE FROM app_auth\.web_sessions/.test(sql)) {
        assert.deepEqual(values, [365, 1]);
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        query: (sql, values) => /pg_try_advisory_lock/.test(sql)
          ? { rows: [{ acquired: true }] }
          : /pg_advisory_unlock/.test(sql)
            ? { rows: [{ pg_advisory_unlock: true }] }
            : pool.query(sql, values),
        release() {},
      };
    },
  };

  const result = await runScheduledMaintenance(pool, {
    task: "sessions",
    sessionRetentionDays: 999,
    sessionPurgeBatchSize: -5,
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.sessions, {
    purged: 2,
    retention_days: 365,
    batch_size: 1,
  });
});

test("an overlapping scheduled run exits without starting task work", async () => {
  let taskCalls = 0;
  let released = false;
  const pool = {
    async connect() {
      return {
        async query(sql) {
          assert.match(sql, /pg_try_advisory_lock/);
          return { rows: [{ acquired: false }] };
        },
        release() { released = true; },
      };
    },
  };
  const result = await runScheduledMaintenance(pool, {
    task: "routine",
    taskRunner: async () => { taskCalls += 1; },
    logger: { info() {} },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "already_running");
  assert.equal(taskCalls, 0);
  assert.equal(released, true);
});

test("a failed advisory-lock query retires its checked-out connection", async () => {
  const failure = new Error("lock_query_failed");
  let releaseReason;
  const pool = {
    async connect() {
      return {
        async query() { throw failure; },
        release(reason) { releaseReason = reason; },
      };
    },
  };
  await assert.rejects(runScheduledMaintenance(pool, { task: "sessions" }), /lock_query_failed/);
  assert.equal(releaseReason, failure);
});

test("task failure unlocks through the original checked-out connection", async () => {
  const lockStatements = [];
  let releases = 0;
  const pool = {
    async query(sql) {
      if (/INSERT INTO app\.scheduled_maintenance_runs/.test(sql)) return { rows: [{ id: 93 }] };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql) {
          lockStatements.push(sql);
          if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
          assert.match(sql, /pg_advisory_unlock/);
          return { rows: [{ pg_advisory_unlock: true }] };
        },
        release() { releases += 1; },
      };
    },
  };
  const result = await runScheduledMaintenance(pool, {
    task: "sessions",
    taskRunner: async () => { throw new Error("maintenance_task_failed"); },
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].error, "maintenance_task_failed");
  assert.deepEqual(lockStatements.map((sql) => /pg_try_advisory_lock/.test(sql) ? "acquire" : "release"), ["acquire", "release"]);
  assert.equal(releases, 1);
});

test("unlock failures retire the lock client and remain visible without hiding completed work", async () => {
  for (const unlockFailure of ["query_rejected", "not_owned"]) {
    const warnings = [];
    let releaseReason;
    const pool = {
      async query(sql) {
        if (/INSERT INTO app\.scheduled_maintenance_runs/.test(sql)) return { rows: [{ id: 94 }] };
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return {
          async query(sql) {
            if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
            assert.match(sql, /pg_advisory_unlock/);
            if (unlockFailure === "query_rejected") throw new Error("unlock_query_failed");
            return { rows: [{ pg_advisory_unlock: false }] };
          },
          release(reason) { releaseReason = reason; },
        };
      },
    };
    const result = await runScheduledMaintenance(pool, {
      task: "census",
      taskRunner: async () => ({ completed: true }),
      logger: { info() {}, warn(...args) { warnings.push(args); } },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.results.census, { completed: true });
    assert.equal(releaseReason instanceof Error, true);
    assert.match(releaseReason.message, unlockFailure === "query_rejected"
      ? /unlock_query_failed/
      : /maintenance_lock_release_not_owned/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /advisory lock release failed/);
  }
});

test("a scheduled run records completion and always releases its lock", async () => {
  const statements = [];
  const lockStatements = [];
  let lockReleased = false;
  const pool = {
    async query(sql) {
      statements.push(sql);
      assert.doesNotMatch(sql, /pg_try_advisory_lock|pg_advisory_unlock/);
      if (/INSERT INTO app\.scheduled_maintenance_runs/.test(sql)) return { rows: [{ id: 91 }] };
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql) {
          lockStatements.push(sql);
          if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
          assert.match(sql, /pg_advisory_unlock/);
          return { rows: [{ pg_advisory_unlock: true }] };
        },
        release() { lockReleased = true; },
      };
    },
  };
  const result = await runScheduledMaintenance(pool, {
    task: "census",
    taskRunner: async (_pool, task) => {
      assert.equal(lockReleased, false);
      return { task, claimed: 0 };
    },
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.run_id, 91);
  assert.deepEqual(result.results.census, { task: "census", claimed: 0 });
  assert.equal(statements.some((sql) => /status = \$2/.test(sql)), true);
  assert.deepEqual(lockStatements.map((sql) => /pg_try_advisory_lock/.test(sql) ? "acquire" : "release"), ["acquire", "release"]);
  assert.equal(lockReleased, true);
});

test("sales maintenance defaults can drain an import-sized backlog while staying bounded", async () => {
  const optionsByTask = new Map();
  const pool = {
    async query(sql) {
      assert.doesNotMatch(sql, /pg_try_advisory_lock|pg_advisory_unlock/);
      if (/INSERT INTO app\.scheduled_maintenance_runs/.test(sql)) {
        return { rows: [{ id: 92 }] };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return {
        async query(sql) {
          if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
          assert.match(sql, /pg_advisory_unlock/);
          return { rows: [{ pg_advisory_unlock: true }] };
        },
        release() {},
      };
    },
  };
  const result = await runScheduledMaintenance(pool, {
    task: "sales",
    taskRunner: async (_pool, task, options) => {
      optionsByTask.set(task, options);
      return { task };
    },
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(optionsByTask.get("sales-reconciliation").salesReconciliationMaximumBatches, 10);
  assert.equal(optionsByTask.get("sales-reconciliation").salesReconciliationBatchSize, 500);
  assert.equal(optionsByTask.get("sales-reconciliation").salesFuzzyReconciliationMaximumBatches, 3);
  assert.equal(optionsByTask.get("sales-reconciliation").salesFuzzyReconciliationBatchSize, 100);
  assert.equal(optionsByTask.get("sales-reconciliation").salesFuzzyCandidatesPerSale, 250);
  assert.equal(optionsByTask.get("locations").locationMaximumBatches, 100);
  assert.equal(optionsByTask.get("locations").locationBatchSize, 100);
  assert.equal(optionsByTask.get("locations").locationSeedLimit, 10_000);
  assert.equal(optionsByTask.get("influences").influenceMaximumBatches, 100);
  assert.equal(optionsByTask.get("influences").influenceBatchSize, 100);
});
