import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveMaintenanceTasks,
  runScheduledMaintenance,
} from "../src/services/scheduledMaintenance.js";

test("routine maintenance refreshes cached parcel influences but excludes slower monthly source mirrors", () => {
  assert.deepEqual(resolveMaintenanceTasks("routine"), ["census", "locations", "parcels", "influences"]);
});

test("maintenance tasks can be scheduled independently", () => {
  assert.deepEqual(resolveMaintenanceTasks("roads"), ["roads"]);
  assert.deepEqual(resolveMaintenanceTasks("census"), ["census"]);
  assert.deepEqual(resolveMaintenanceTasks("context"), ["roads", "floods", "zoning", "influences"]);
  assert.deepEqual(resolveMaintenanceTasks("all"), [
    "census", "locations", "parcels", "roads", "floods", "zoning", "influences",
  ]);
});

test("unknown maintenance tasks fail before any database work", () => {
  assert.throws(() => resolveMaintenanceTasks("mystery"), /Unknown maintenance task/);
});

test("an overlapping scheduled run exits without starting task work", async () => {
  let taskCalls = 0;
  const pool = {
    async query(sql) {
      assert.match(sql, /pg_try_advisory_lock/);
      return { rows: [{ acquired: false }] };
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
});

test("a scheduled run records completion and always releases its lock", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(sql);
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] };
      if (/INSERT INTO app\.scheduled_maintenance_runs/.test(sql)) return { rows: [{ id: 91 }] };
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await runScheduledMaintenance(pool, {
    task: "census",
    taskRunner: async (_pool, task) => ({ task, claimed: 0 }),
    logger: { info() {}, warn() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.run_id, 91);
  assert.deepEqual(result.results.census, { task: "census", claimed: 0 });
  assert.equal(statements.some((sql) => /status = \$2/.test(sql)), true);
  assert.equal(statements.some((sql) => /pg_advisory_unlock/.test(sql)), true);
});
