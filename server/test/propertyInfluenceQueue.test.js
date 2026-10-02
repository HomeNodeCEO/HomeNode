import assert from "node:assert/strict";
import test from "node:test";

import {
  refreshInfluenceQueueItem,
  runPropertyInfluenceBatch,
  runWithConcurrency,
} from "../src/services/propertyInfluenceQueue.js";

test("influence batch logs bounded codes and survives a throwing logger after retry settlement", async () => {
  const privateDetail = "private provider token in exception";
  const settled = [];
  const warnings = [];
  const pool = {
    async query(sql, params) {
      if (sql.includes("FROM gis.source_sync_state")) return { rows: [] };
      if (sql.includes("RETURNING queue.account_id")) {
        return { rows: [{ account_id: "26272500060150000", attempts: 1 }] };
      }
      if (sql.includes("last_error = $4")) settled.push(params);
      return { rows: [], rowCount: 1 };
    },
    async connect() { throw new Error(privateDetail); },
  };
  const result = await runPropertyInfluenceBatch(pool, {
    logger: { warn: (...args) => warnings.push(args) },
  });
  assert.equal(result.retry, 1);
  assert.equal(settled[0][3], "property_influence_failed");
  assert.deepEqual(warnings, [[
    "[property-influence] refresh failed",
    { outcome: "retry", code: "property_influence_failed" },
  ]]);
  assert.equal(JSON.stringify({ settled, warnings }).includes(privateDetail), false);

  const second = await runPropertyInfluenceBatch(pool, {
    logger: { warn() { throw new Error("logger unavailable"); } },
  });
  assert.equal(second.retry, 1);
});

test("property influence work respects its concurrency ceiling and processes every item", async () => {
  const items = Array.from({ length: 17 }, (_, index) => index + 1);
  const processed = [];
  let active = 0;
  let peak = 0;

  await runWithConcurrency(items, 4, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, item % 3));
    processed.push(item);
    active -= 1;
  });

  assert.equal(peak, 4);
  assert.deepEqual(processed.toSorted((left, right) => left - right), items);
});

test("property influence concurrency is safely bounded for empty and invalid inputs", async () => {
  let calls = 0;
  await runWithConcurrency([], 50, async () => { calls += 1; });
  await runWithConcurrency(["only"], 0, async () => { calls += 1; });
  assert.equal(calls, 1);
});

test("each influence item runs in a bounded transaction and releases its client", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rows: [] };
    },
    release() { released = true; },
  };
  const pool = { async connect() { return client; } };
  const refreshCalls = [];
  const result = await refreshInfluenceQueueItem(pool, {
    accountId: "26272500060150000",
    sourceHealth: [{ source_key: "dcad_parcels" }],
    statementTimeoutMs: 45_000,
    async refresh(queryable, options) {
      refreshCalls.push({ queryable, options });
      return { account_id: options.accountId };
    },
  });

  assert.equal(result.account_id, "26272500060150000");
  assert.equal(statements[0].sql, "BEGIN");
  assert.match(statements[1].sql, /set_config\('statement_timeout'/);
  assert.deepEqual(statements[1].params, ["45000ms"]);
  assert.equal(statements.at(-1).sql, "COMMIT");
  assert.equal(refreshCalls[0].queryable, client);
  assert.equal(refreshCalls[0].options.schemaReady, true);
  assert.equal(released, true);
});

test("a timed influence item rolls back without leaking its database client", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    },
    release() { released = true; },
  };
  const pool = { async connect() { return client; } };

  await assert.rejects(
    refreshInfluenceQueueItem(pool, {
      accountId: "26272500060150000",
      async refresh() { throw new Error("statement timeout"); },
    }),
    /statement timeout/,
  );
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.equal(released, true);
});

for (const failureStage of ["BEGIN", "timeout", "refresh", "COMMIT"]) {
  for (const rollbackFails of [false, true]) {
    test(`influence ${failureStage} failure preserves the cause and ${rollbackFails ? "retires" : "reuses"} the client after rollback`, async () => {
      const primaryError = new Error("private influence operation detail");
      const rollbackError = new Error("private rollback connection detail");
      const statements = [];
      const releases = [];
      const client = {
        async query(sql) {
          statements.push(sql);
          if (sql === "ROLLBACK" && rollbackFails) throw rollbackError;
          if (sql === failureStage || (failureStage === "timeout" && sql.includes("set_config"))) throw primaryError;
          return { rows: [] };
        },
        release(error) { releases.push(error); },
      };
      await assert.rejects(refreshInfluenceQueueItem({ async connect() { return client; } }, {
        accountId: "26272500060150000",
        async refresh(queryable) {
          assert.equal(queryable, client);
          if (failureStage === "refresh") throw primaryError;
          return { updated: true };
        },
      }), error => error === primaryError);
      assert.equal(statements.at(-1), "ROLLBACK");
      assert.equal(statements.filter(sql => sql === "ROLLBACK").length, 1);
      assert.equal(releases.length, 1);
      if (rollbackFails) {
        assert.ok(releases[0] instanceof Error);
        assert.equal(releases[0].message, "property_influence_rollback_failed");
        assert.notEqual(releases[0], primaryError);
        assert.notEqual(releases[0], rollbackError);
      } else {
        assert.equal(releases[0], undefined);
      }
    });
  }
}

test("influence refresh does not manage a borrowed queryable transaction", async () => {
  const queryable = {
    query() { assert.fail("borrowed transaction must not be changed"); },
    release() { assert.fail("borrowed client must not be released"); },
  };
  const result = { updated: true };
  assert.equal(await refreshInfluenceQueueItem(queryable, {
    async refresh(client, options) {
      assert.equal(client, queryable);
      assert.equal(options.schemaReady, true);
      return result;
    },
  }), result);
  const primaryError = new Error("borrowed refresh failed");
  await assert.rejects(refreshInfluenceQueueItem(queryable, {
    async refresh() { throw primaryError; },
  }), error => error === primaryError);
});

test("influence connection acquisition failure does not run refresh", async () => {
  const primaryError = new Error("connection unavailable");
  await assert.rejects(refreshInfluenceQueueItem({
    async connect() { throw primaryError; },
  }, {
    async refresh() { assert.fail("refresh must not run without a client"); },
  }), error => error === primaryError);
});
