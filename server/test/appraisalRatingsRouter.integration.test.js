import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import express from "express";

import { createAppraisalRatingsRouter } from "../src/modules/appraisalRatings/router.js";

function baseOptions(overrides = {}) {
  return {
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => { throw new Error("unexpected_connect"); },
    },
    ratingsReady: Promise.resolve(),
    accountIdAllowed: (value) => /^\d+$/.test(value),
    requireEditor: () => true,
    logger: { error() {} },
    ...overrides,
  };
}

async function startRouter(options) {
  const app = express();
  app.use(express.json());
  app.use(createAppraisalRatingsRouter(options));
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

test("rating reads and history preserve validation, SQL scope, and response shapes", async (context) => {
  const calls = [];
  const rating = { account_id: "123", effective_date: "2026-09-02", revision: 2 };
  const history = [{ ...rating, changed_at: "2026-09-02T12:00:00Z" }];
  const server = await startRouter(baseOptions({
    pool: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: /_history/.test(sql) ? history : [rating] };
      },
      connect: async () => { throw new Error("unexpected_connect"); },
    },
  }));
  context.after(server.close);

  const invalidAccount = await fetch(`${server.baseUrl}/api/accounts/not-valid/appraisal-rating?effective_date=2026-09-02`);
  assert.equal(invalidAccount.status, 400);
  assert.deepEqual(await invalidAccount.json(), { error: "invalid_account_id" });
  const invalidDate = await fetch(`${server.baseUrl}/api/accounts/123/appraisal-rating?effective_date=2026-02-30`);
  assert.equal(invalidDate.status, 400);

  const response = await fetch(`${server.baseUrl}/api/accounts/123/appraisal-rating?effective_date=2026-09-02`);
  assert.deepEqual(await response.json(), { rating });
  const historyResponse = await fetch(`${server.baseUrl}/api/accounts/123/appraisal-rating-history`);
  assert.deepEqual(await historyResponse.json(), { history });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, ["123", "2026-09-02"]);
  assert.match(calls[0].sql, /WHERE account_id = \$1 AND effective_date = \$2::date/);
  assert.deepEqual(calls[1].params, ["123"]);
  assert.match(calls[1].sql, /LIMIT 100/);
});

test("rating writes preserve transaction, revision, history, and release behavior", async (context) => {
  const calls = [];
  let released = 0;
  const rating = {
    account_id: "123",
    effective_date: "2026-09-02",
    condition_rating: "C3",
    quality_rating: "Q4",
    notes: "Reviewed",
    reviewer: "Appraiser",
    revision: 3,
  };
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (/SELECT \* FROM app\.subject_appraisal_ratings/.test(sql)) {
        return { rows: [{ revision: 2 }], rowCount: 1 };
      }
      if (/INSERT INTO app\.subject_appraisal_ratings \(/.test(sql)) {
        return { rows: [rating], rowCount: 1 };
      }
      if (/INSERT INTO app\.subject_appraisal_rating_history/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
    release() { released += 1; },
  };
  const server = await startRouter(baseOptions({
    pool: { query: async () => ({ rows: [] }), connect: async () => client },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123/appraisal-rating`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      effective_date: "2026-09-02",
      condition_rating: "C3",
      quality_rating: "Q4",
      notes: "Reviewed",
      reviewer: "Appraiser",
      expected_revision: 2,
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, rating });
  assert.equal(released, 1);
  assert.deepEqual(calls.map(({ sql }) => sql === "BEGIN" || sql === "COMMIT" ? sql : sql.match(/^(?:\s*)([^\n]+)/)?.[1].trim()), [
    "BEGIN",
    "SELECT 1 FROM core.accounts WHERE account_id = $1 FOR SHARE",
    "SELECT * FROM app.subject_appraisal_ratings",
    "INSERT INTO app.subject_appraisal_ratings (",
    "INSERT INTO app.subject_appraisal_rating_history (",
    "COMMIT",
  ]);
  assert.deepEqual(calls[3].params, ["123", "2026-09-02", "C3", "Q4", "Reviewed", "Appraiser", 3]);
});

test("rating revision conflicts roll back and release without writing", async (context) => {
  const calls = [];
  let released = 0;
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (/SELECT 1 FROM core\.accounts/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/SELECT \* FROM app\.subject_appraisal_ratings/.test(sql)) {
        return { rows: [{ revision: 4 }], rowCount: 1 };
      }
      throw new Error("unexpected_write");
    },
    release() { released += 1; },
  };
  const server = await startRouter(baseOptions({
    pool: { query: async () => ({ rows: [] }), connect: async () => client },
  }));
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/accounts/123/appraisal-rating`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      effective_date: "2026-09-02",
      condition_rating: "C3",
      expected_revision: 2,
    }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "rating_revision_conflict",
    current_revision: 4,
  });
  assert.equal(released, 1);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.some((sql) => /INSERT/.test(sql)), false);
});

test("rating writes retain editor denial and bounded transaction failures", async (context) => {
  let connectCalls = 0;
  const denied = await startRouter(baseOptions({
    requireEditor(_req, res) {
      res.status(403).json({ error: "editor_required" });
      return false;
    },
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => { connectCalls += 1; throw new Error("unexpected_connect"); },
    },
  }));
  let released = 0;
  const failedCalls = [];
  const failed = await startRouter(baseOptions({
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        async query(sql) {
          failedCalls.push(sql);
          if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
          throw Object.assign(new Error("database password"), { code: "XX000" });
        },
        release() { released += 1; },
      }),
    },
  }));
  context.after(async () => Promise.all([denied.close(), failed.close()]));
  const body = JSON.stringify({ effective_date: "2026-09-02", condition_rating: "C3" });

  const deniedResponse = await fetch(`${denied.baseUrl}/api/accounts/123/appraisal-rating`, {
    method: "PUT", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(deniedResponse.status, 403);
  assert.equal(connectCalls, 0);

  const failedResponse = await fetch(`${failed.baseUrl}/api/accounts/123/appraisal-rating`, {
    method: "PUT", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(failedResponse.status, 500);
  const failureBody = await failedResponse.json();
  assert.deepEqual(failureBody, { error: "subject_rating_update_failed" });
  assert.doesNotMatch(JSON.stringify(failureBody), /password|XX000/);
  assert.deepEqual(failedCalls, ["BEGIN", "SELECT 1 FROM core.accounts WHERE account_id = $1 FOR SHARE", "ROLLBACK"]);
  assert.equal(released, 1);
});

test("entrypoint mounts appraisal ratings at the original account-domain position", () => {
  const source = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const saleHistory = source.indexOf('app.get("/api/sales/:sourceRecordId/review-history"');
  const ratings = source.indexOf("app.use(createAppraisalRatingsRouter(");
  const enrichment = source.indexOf('app.get("/api/enrichment/status"');
  assert.ok(ratings > saleHistory);
  assert.ok(enrichment > ratings);
});
