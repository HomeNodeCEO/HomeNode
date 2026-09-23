import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createMobileRouter } from "../src/modules/mobile/router.js";

function authenticatedFixture() {
  let verifications = 0;
  return {
    pool: {
      async query(sql) {
        if (sql.includes("SELECT identities.id AS identity_id")) {
          return { rows: [{
            identity_id: "identity-1",
            user_id: "user-1",
            email: "appraiser@example.test",
            display_name: "Appraiser",
            organization_id: "org-1",
            organization_display_name: "Organization",
            role_code: "appraiser",
          }] };
        }
        return { rows: [] };
      },
    },
    verifier: {
      configured: true,
      async verify(token) {
        assert.equal(token, "test-token");
        verifications += 1;
        return { iss: "https://identity.example", sub: "subject-1" };
      },
    },
    verifications: () => verifications,
  };
}

async function listen(app, t) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("mobile endpoints reject requests beyond the configured client limit", async (t) => {
  const app = express();
  app.use("/api/mobile", createMobileRouter({
    pool: { query: async () => ({ rows: [] }) },
    verifier: { configured: false, verify: async () => { throw new Error("unused"); } },
    enabled: false,
    security: {
      apiRateLimitEnabled: true,
      apiRateLimitWindowMs: 60_000,
      apiRateLimitMax: 1,
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/mobile/capabilities`;

  const accepted = await fetch(url);
  assert.equal(accepted.status, 200);
  const blocked = await fetch(url);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "mobile_rate_limit_exceeded" });
});

test("unexpected mobile route failures log only bounded diagnostic codes", async (t) => {
  const fixture = authenticatedFixture();
  const originalQuery = fixture.pool.query;
  const privateDetail = "postgresql://private-user:private-password@database.example/private-db";
  fixture.pool.query = async (sql, ...args) => {
    if (String(sql).includes("WITH accessible_files AS")) {
      throw Object.assign(new Error(privateDetail), { code: "secret\nforged-log-line" });
    }
    return originalQuery(sql, ...args);
  };
  const app = express();
  app.use("/api/mobile", createMobileRouter({
    pool: fixture.pool,
    verifier: fixture.verifier,
    enabled: true,
    security: { apiRateLimitEnabled: false },
  }));
  const baseUrl = await listen(app, t);
  const calls = [];
  const originalError = console.error;
  console.error = (...args) => { calls.push(args); };
  try {
    const response = await fetch(`${baseUrl}/api/mobile/properties/search?q=Main`, {
      headers: { authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "mobile_request_failed" });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(calls, [["[mobile] request failed", "unknown"]]);
  assert.doesNotMatch(JSON.stringify(calls), /private-password|forged-log-line/);
});

test("mobile rate limiting and authentication settle before JSON parsing", async (t) => {
  const fixture = authenticatedFixture();
  const app = express();
  app.use("/api/mobile", createMobileRouter({
    pool: fixture.pool,
    verifier: fixture.verifier,
    enabled: true,
    security: {
      apiRateLimitEnabled: true,
      apiRateLimitWindowMs: 60_000,
      apiRateLimitMax: 1,
    },
  }));
  const baseUrl = await listen(app, t);
  const request = () => fetch(`${baseUrl}/api/mobile/sketches/calculate`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    body: "{",
  });

  const malformed = await request();
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_json_body" });
  const blocked = await request();
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "mobile_rate_limit_exceeded" });
  assert.equal(fixture.verifications(), 1);
});

test("mobile JSON routes reject compressed request bodies", async (t) => {
  const fixture = authenticatedFixture();
  const app = express();
  app.use("/api/mobile", createMobileRouter({
    pool: fixture.pool,
    verifier: fixture.verifier,
    enabled: true,
    security: {
      apiRateLimitEnabled: true,
      apiRateLimitWindowMs: 60_000,
      apiRateLimitMax: 10,
    },
  }));
  const baseUrl = await listen(app, t);
  const response = await fetch(`${baseUrl}/api/mobile/sketches/calculate`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: "not-a-gzip-stream",
  });
  assert.equal(response.status, 415);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "unsupported_request_encoding" });
  assert.equal(fixture.verifications(), 1);
});
