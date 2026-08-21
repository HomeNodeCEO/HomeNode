import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createUadRouter, uadBodyParserErrorHandler } from "../src/modules/uad/router.js";

const WORKFILE_ID = "c164248f-645d-48aa-a389-dc668e6c5dc9";
const USER_ID = "711c54f2-d7a4-4418-ab65-0d9f7e0d43a1";
const ORGANIZATION_ID = "f62aa408-18eb-4ee1-bdae-167b8ff92a0c";
const OTHER_ORGANIZATION_ID = "b5250368-e8f1-4d47-9f62-a8a7cb2ea383";

async function withServer(pool, callback, securityOverrides = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/uad", createUadRouter({
    pool,
    storage: { provider: "r2", configured: true },
    verifier: {
      configured: true,
      async verify() {
        return { iss: "https://identity.example", sub: "oidc-subject" };
      },
    },
    enabled: true,
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

test("UAD JSON parser failures return bounded JSON without reaching authentication or data access", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid_json_body" });

    const oversized = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`, {
      method: "PATCH",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(110_000) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_body_too_large" });
    assert.equal(pool.accessQueries.length, 0);
  });
});
