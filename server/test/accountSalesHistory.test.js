import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCOUNT_SALES_HISTORY_LIMITS,
  getAccountSalesHistory,
} from "../src/services/accountSalesHistory.js";

test("account sales history uses indexed source tables instead of the enriched view", async () => {
  let capturedSql = "";
  let capturedParams = [];
  const expected = [{ source_record_id: 42, listing_id: "21248276" }];
  const pool = {
    async query(sql, params) {
      capturedSql = sql;
      capturedParams = params;
      return { rows: expected };
    },
  };

  const rows = await getAccountSalesHistory(pool, " 26272500060150000 ", 20);

  assert.deepEqual(rows, expected);
  assert.deepEqual(capturedParams, ["26272500060150000", 20]);
  assert.match(capturedSql, /sales_source_records/);
  assert.match(capturedSql, /sale_parcels/);
  assert.match(capturedSql, /sale\.account_id = \$1/);
  assert.doesNotMatch(capturedSql, /v_sales_enriched/);
});

test("account sales history applies safe default and maximum limits", async () => {
  const calls = [];
  const pool = {
    async query(_sql, params) {
      calls.push(params);
      return { rows: [] };
    },
  };

  await getAccountSalesHistory(pool, "26272500060150000", 0);
  await getAccountSalesHistory(pool, "26272500060150000", 9999);

  assert.equal(calls[0][1], ACCOUNT_SALES_HISTORY_LIMITS.default);
  assert.equal(calls[1][1], ACCOUNT_SALES_HISTORY_LIMITS.maximum);
});

test("account sales history skips an empty account identifier", async () => {
  let called = false;
  const pool = {
    async query() {
      called = true;
      return { rows: [] };
    },
  };

  assert.deepEqual(await getAccountSalesHistory(pool, " "), []);
  assert.equal(called, false);
});
