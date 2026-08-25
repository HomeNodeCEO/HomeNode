import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createUadRouter, uadBodyParserErrorHandler } from "../src/modules/uad/router.js";

const WORKFILE_ID = "c164248f-645d-48aa-a389-dc668e6c5dc9";
const USER_ID = "711c54f2-d7a4-4418-ab65-0d9f7e0d43a1";
const ORGANIZATION_ID = "f62aa408-18eb-4ee1-bdae-167b8ff92a0c";
const OTHER_ORGANIZATION_ID = "b5250368-e8f1-4d47-9f62-a8a7cb2ea383";

async function withServer(pool, callback, securityOverrides = {}, routerOverrides = {}) {
  const app = express();
  app.use("/api/uad", createUadRouter({
    pool,
    storage: { provider: "r2", configured: true },
    verifier: {
      configured: true,
      async verify() {
        return { iss: "https://identity.example", sub: "oidc-subject" };
      },
    },
    enabled: routerOverrides.enabled ?? true,
    authenticationRequired: true,
    security: {
      strict: true,
      corsRestricted: true,
      rateLimitEnabled: true,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 300,
      ...securityOverrides,
    },
  }));
  app.use("/api/uad", uadBodyParserErrorHandler);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("disabled UAD workspace keeps diagnostics public and fails protected routes before authentication", async () => {
  let databaseCalls = 0;
  const pool = {
    async query() {
      databaseCalls += 1;
      throw new Error("disabled_workspace_must_not_query_database");
    },
  };
  await withServer(pool, async (baseUrl) => {
    const capabilities = await fetch(`${baseUrl}/api/uad/capabilities`);
    assert.equal(capabilities.status, 200);
    assert.equal((await capabilities.json()).enabled, false);

    const protectedRead = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}`);
    assert.equal(protectedRead.status, 503);
    assert.deepEqual(await protectedRead.json(), { error: "uad_workspace_disabled" });

    const protectedWrite = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 1, fields: [] }),
    });
    assert.equal(protectedWrite.status, 503);
    assert.deepEqual(await protectedWrite.json(), { error: "uad_workspace_disabled" });
    assert.equal(databaseCalls, 0);
  }, {}, { enabled: false });
});

function securityPool({ membershipOrganizationId = ORGANIZATION_ID } = {}) {
  const accessQueries = [];
  return {
    accessQueries,
    async query(sql, params = []) {
      if (sql.includes("FROM app_auth.oidc_identities")) {
        return { rows: [{
          user_id: USER_ID,
          email: "appraiser@example.test",
          display_name: "Synthetic Appraiser",
          organization_id: membershipOrganizationId,
          organization_display_name: "Synthetic Organization",
          role_code: "appraiser",
        }] };
      }
      if (sql.includes("UPDATE app_auth.oidc_identities")) return { rows: [] };
      if (sql.includes("FROM appraisal.uad_workfiles") && sql.includes("assigned_appraiser_user_id")) {
        accessQueries.push(params);
        return { rows: [{
          id: WORKFILE_ID,
          organization_id: ORGANIZATION_ID,
          assigned_appraiser_user_id: USER_ID,
          supervisory_appraiser_user_id: null,
        }] };
      }
      if (sql.includes("SELECT w.*")) {
        return { rows: [{
          id: WORKFILE_ID,
          organization_id: ORGANIZATION_ID,
          account_id: "SYNTHETIC-ACCOUNT",
          file_number: "REDTEAM-001",
          specification_release_key: "uad-3.6-2026-08-13-h1.5",
          status: "draft",
          property_type: "traditional_single_family",
          inspection_method: "traditional",
          current_revision: 1,
          assigned_appraiser_user_id: USER_ID,
          supervisory_appraiser_user_id: null,
          subject_data: {},
          source_manifest: {},
          snapshot_version: 1,
        }] };
      }
      if (sql.includes("UPDATE appraisal.delivery_attempts")) return { rows: [] };
      throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
    },
  };
}

test("strict UAD routes reject a missing bearer token before database access", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_access_token" });
    assert.equal(pool.accessQueries.length, 0);
  });
});

test("strict UAD routes reject cross-organization object access", async () => {
  const pool = securityPool({ membershipOrganizationId: OTHER_ORGANIZATION_ID });
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}`, {
      headers: { authorization: "Bearer synthetic-token" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "uad_workfile_access_denied" });
    assert.deepEqual(pool.accessQueries, [[WORKFILE_ID]]);
  });
});

test("strict UAD routes allow the assigned appraiser and keep capabilities public", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const capabilities = await fetch(`${baseUrl}/api/uad/capabilities`);
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.headers.get("cache-control"), "no-store");
    assert.equal((await capabilities.json()).authentication.required, true);

    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}`, {
      headers: { authorization: "Bearer synthetic-token" },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).workfile.id, WORKFILE_ID);
  });
});

test("strict UAD routes return a bounded generic response after the configured request limit", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/api/uad/capabilities`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/uad/capabilities`)).status, 200);
    const blocked = await fetch(`${baseUrl}/api/uad/capabilities`);
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: "rate_limit_exceeded" });
    assert.ok(blocked.headers.get("retry-after"));
  }, { rateLimitMax: 2 });
});

test("completed or unknown delivery attempts return a conflict without exposing persistence details", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const attemptId = "6a1f59f2-0ab1-47ce-8754-0277864c51d1";
    const response = await fetch(
      `${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/delivery-attempts/${attemptId}`,
      {
        method: "PATCH",
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "delivery_attempt_not_found_or_completed" });
  });
});

test("rate limiting keeps one client bucket across rotating proxy addresses", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const request = (forwardedFor, clientIp = "203.0.113.20") => fetch(`${baseUrl}/api/uad/capabilities`, {
      headers: {
        "cf-connecting-ip": clientIp,
        "x-forwarded-for": forwardedFor,
      },
    });

    assert.equal((await request("192.0.2.10")).status, 200);
    assert.equal((await request("192.0.2.11")).status, 200);
    assert.equal((await request("192.0.2.12")).status, 429);
    assert.equal((await request("192.0.2.12", "203.0.113.21")).status, 200);
  }, { rateLimitMax: 2, rateLimitClientIpHeader: "cf-connecting-ip" });
});

test("UAD rate limiting runs before JSON parsing and bounds repeated malformed bodies", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const request = () => fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: "{",
    });

    const first = await request();
    assert.equal(first.status, 400);
    assert.deepEqual(await first.json(), { error: "invalid_json_body" });

    const blocked = await request();
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: "rate_limit_exceeded" });
    assert.equal(blocked.headers.get("cache-control"), "no-store");
    assert.ok(blocked.headers.get("retry-after"));
    assert.equal(pool.accessQueries.length, 0);
  }, { rateLimitMax: 1 });
});

test("UAD router bounds hostile identifiers, path variants, and JSON root shapes", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    for (const path of [
      "/api/uad/workfiles/not-a-uuid",
      `/api/uad/workfiles/${encodeURIComponent("uad'quoted;identifier")}`,
      `/api/uad/workfiles/${encodeURIComponent("\uFF10\uFF11\uFF12\uFF13-\uD83D\uDD12")}`,
      `/api/uad/workfiles/${WORKFILE_ID}%2Feditor`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: "Bearer synthetic-token" },
      });
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), { error: "invalid_uad_workfile_id" }, path);
    }

    for (const accountId of ["A".repeat(65), "UAD-REDTEAM\nINJECTED"]) {
      const response = await fetch(
        `${baseUrl}/api/uad/accounts/${encodeURIComponent(accountId)}/workfiles`,
        { headers: { authorization: "Bearer synthetic-token" } },
      );
      assert.equal(response.status, 400, accountId);
      assert.deepEqual(await response.json(), { error: "invalid_account_id" }, accountId);
    }

    for (const path of [
      `/api/uad/workfiles/${WORKFILE_ID}/editor/extra`,
      `/api/uad//workfiles/${WORKFILE_ID}`,
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { authorization: "Bearer synthetic-token" },
      });
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { error: "uad_route_not_found" }, path);
    }

    const unsupportedMethod = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}`, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unsupportedMethod.status, 404);
    assert.deepEqual(await unsupportedMethod.json(), { error: "uad_route_not_found" });

    const bodies = [
      { body: "{\"__proto__\":{\"polluted\":true}}", error: "invalid_uad_expected_revision" },
      { body: "[]", error: "invalid_uad_expected_revision" },
      { body: "true", error: "invalid_json_body" },
      {
        body: `${"{\"nested\":".repeat(32)}null${"}".repeat(32)}`,
        error: "invalid_uad_expected_revision",
      },
    ];
    for (const { body, error } of bodies) {
      const response = await fetch(
        `${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/__redteam_input_probe__`,
        {
          method: "PATCH",
          headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
          body,
        },
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error });
    }
    assert.equal(pool.accessQueries.length, 5);
  });
});

test("UAD JSON parser failures return bounded JSON without reaching authentication or data access", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get("cache-control"), "no-store");
    assert.deepEqual(await malformed.json(), { error: "invalid_json_body" });

    const oversized = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_050_000) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get("cache-control"), "no-store");
    assert.deepEqual(await oversized.json(), { error: "request_body_too_large" });
    assert.equal(pool.accessQueries.length, 0);
  });
});

test("UAD mutation routes reject non-JSON bodies and unknown routes stay bounded", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const unsupported = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: { authorization: "Bearer synthetic-token", "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(unsupported.status, 415);
    assert.equal(unsupported.headers.get("cache-control"), "no-store");
    assert.deepEqual(await unsupported.json(), { error: "unsupported_media_type" });

    const missing = await fetch(`${baseUrl}/api/uad/__unknown_route__`, {
      headers: { authorization: "Bearer synthetic-token" },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("cache-control"), "no-store");
    assert.deepEqual(await missing.json(), { error: "uad_route_not_found" });
  });
});

test("UAD body parser hides compression and charset parser diagnostics", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const invalidGzip = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer synthetic-token",
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: "not-a-gzip-stream",
    });
    assert.equal(invalidGzip.status, 400);
    assert.equal(invalidGzip.headers.get("cache-control"), "no-store");
    assert.deepEqual(await invalidGzip.json(), { error: "invalid_request_body" });

    const unsupportedCharset = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: {
        authorization: "Bearer synthetic-token",
        "content-type": "application/json; charset=iso-8859-1",
      },
      body: "{}",
    });
    assert.equal(unsupportedCharset.status, 415);
    assert.equal(unsupportedCharset.headers.get("cache-control"), "no-store");
    assert.deepEqual(await unsupportedCharset.json(), { error: "unsupported_request_encoding" });
    assert.equal(pool.accessQueries.length, 0);
  });
});
