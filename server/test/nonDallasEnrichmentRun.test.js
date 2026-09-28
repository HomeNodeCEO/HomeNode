import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  nonDallasEnrichmentFailureCode,
  runNonDallasEnrichmentBatch,
} from "../src/services/nonDallasEnrichmentWorker.js";

function runPool(handler = async () => ({ rows: [] })) {
  const queries = [];
  return {
    queries,
    pool: {
      async query(sql, values) {
        queries.push({ sql, values });
        if (sql.startsWith("INSERT INTO app.enrichment_runs")) return { rows: [{ id: 17 }] };
        return handler(sql, values);
      },
    },
  };
}

test("non-Dallas batch keeps counts while bounding item diagnostics", async () => {
  const { pool, queries } = runPool();
  const logs = [];
  const trestleClient = {};
  const result = await runNonDallasEnrichmentBatch({
    pool, trestleClient, county: "COLLIN", limit: 2,
    listCandidates: async (queryable, options) => {
      assert.equal(queryable, pool);
      assert.deepEqual(options, { county: "COLLIN", limit: 2 });
      return ["A-1", "A-2"];
    },
    enrichAccount: async (input) => {
      assert.equal(input.pool, pool);
      assert.equal(input.trestleClient, trestleClient);
      if (input.accountId === "A-2") throw new Error("token=private-value");
      return { resolved: { bedrooms: { review_required: false }, pool: { review_required: true } } };
    },
    logger: { error: (...args) => logs.push(args) },
  });
  assert.deepEqual(result, {
    run_id: 17, county: "COLLIN", processed: 1, resolved: 1, review: 1, errors: 1,
  });
  assert.deepEqual(logs, [["[non-dallas-enrichment] A-2:", "non_dallas_enrichment_failed"]]);
  assert.deepEqual(queries[1].values, [17, 1, 1, 1, 1]);
  assert.equal(JSON.stringify({ result, logs, queries }).includes("private-value"), false);
});

test("non-Dallas run stores a bounded failure code, not the original exception", async () => {
  const { pool, queries } = runPool();
  const failure = Object.assign(new Error("token=private-value"), { code: "ECONNRESET" });
  await assert.rejects(runNonDallasEnrichmentBatch({
    pool, county: "DENTON", limit: 1,
    listCandidates: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(queries[1].values[4], 1);
  assert.deepEqual(JSON.parse(queries[1].values[5]), { error: "ECONNRESET" });
  assert.equal(JSON.stringify(queries).includes("private-value"), false);
  assert.equal(nonDallasEnrichmentFailureCode(new Error("token=private-value")),
    "non_dallas_enrichment_failed");
});

test("a throwing diagnostic logger cannot interrupt non-Dallas batch settlement", async () => {
  const { pool, queries } = runPool();
  const result = await runNonDallasEnrichmentBatch({
    pool, county: "COLLIN", limit: 1,
    listCandidates: async () => ["A-1"],
    enrichAccount: async () => { throw new Error("private detail"); },
    logger: { error() { throw new Error("logger unavailable"); } },
  });
  assert.equal(result.errors, 1);
  assert.equal(queries[1].values[4], 1);
});

test("non-Dallas CLI fails with a fixed code and no exception stack", () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL("../scripts/runNonDallasEnrichment.js", import.meta.url)),
    "token-private-county",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[non-dallas-enrichment\] failed non_dallas_enrichment_failed/);
  assert.equal(result.stderr.includes("token-private-county"), false);
  assert.equal(result.stderr.includes("Error:"), false);
});
