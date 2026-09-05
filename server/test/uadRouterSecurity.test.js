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
    authenticationRequired: routerOverrides.authenticationRequired ?? true,
    security: {
      strict: true,
      corsRestricted: true,
      rateLimitEnabled: true,
      rateLimitWindowMs: 60_000,
      rateLimitMax: 300,
      ...securityOverrides,
    },
    ...(routerOverrides.applyCompletionSuggestions
      ? { applyCompletionSuggestions: routerOverrides.applyCompletionSuggestions }
      : {}),
    ...(routerOverrides.createWorkfile
      ? { createWorkfile: routerOverrides.createWorkfile }
      : {}),
    ...(routerOverrides.getCertificationReadiness
      ? { getCertificationReadiness: routerOverrides.getCertificationReadiness }
      : {}),
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

function securityPool({ membershipOrganizationId = ORGANIZATION_ID, roleCode = "appraiser" } = {}) {
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
          role_code: roleCode,
        }] };
      }
      if (sql.includes("UPDATE app_auth.oidc_identities")) return { rows: [] };
      if (sql.includes("FROM core.accounts")) {
        return { rows: [{
          account_id: "SYNTHETIC-ACCOUNT",
          address: "100 MAIN ST",
          city: "DALLAS",
          postal_code: "75201",
          county: "Dallas",
          neighborhood_code: "N-1",
          subdivision: "SYNTHETIC ADDITION",
          legal_description: "LOT 1",
        }] };
      }
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

function signerReadinessFixture(callerRole = "appraiser") {
  const caller = {
    role: callerRole,
    user_id: USER_ID,
    display_name: "Caller Appraiser",
    signature_policy: "electronic",
    profile_status: "verified",
    organization_name: "Caller Organization",
    license: {
      jurisdiction: "TX", license_number: "CALLER-123",
      license_type: "CertifiedResidential", expires_on: "2099-12-31",
    },
    ready: true,
    missing: [],
  };
  const peer = {
    role: callerRole === "appraiser" ? "supervisory_appraiser" : "appraiser",
    user_id: "peer-private-user",
    display_name: "peer-private-name",
    signature_policy: "peer-private-policy",
    profile_status: "peer-private-status",
    organization_name: "peer-private-organization",
    license: {
      jurisdiction: "peer-private-jurisdiction", license_number: "peer-private-number",
      license_type: "peer-private-type", expires_on: "peer-private-expiry",
    },
    ready: false,
    missing: ["license_expiration"],
  };
  return {
    workfile_id: WORKFILE_ID,
    revision_number: 7,
    workfile_status: "ready",
    ready: false,
    artifact_readiness: { pdf_ready: true, missing: [] },
    signers: callerRole === "appraiser" ? [caller, peer] : [peer, caller],
    internal_future_field: "internal-private-detail",
  };
}

test("certification readiness preserves caller credentials and peer diagnostics without peer identity", async () => {
  for (const callerRole of ["appraiser", "supervisory_appraiser"]) {
    const pool = securityPool();
    const readiness = signerReadinessFixture(callerRole);
    const original = structuredClone(readiness);
    let calls = 0;
    await withServer(pool, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/certification-readiness`, {
        headers: { authorization: "Bearer synthetic-token" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.deepEqual(body, { readiness: {
        workfile_id: WORKFILE_ID,
        revision_number: 7,
        workfile_status: "ready",
        ready: false,
        artifact_readiness: { pdf_ready: true, missing: [] },
        signers: readiness.signers.map(({ role, ready, missing }) => ({ role, ready, missing })),
        current_signer: readiness.signers.find(({ user_id }) => user_id === USER_ID),
      } });
      assert.doesNotMatch(JSON.stringify(body), /peer-private-|internal-private-/);
      assert.equal(calls, 1);
    }, {}, {
      getCertificationReadiness: async (receivedPool, workfileId) => {
        assert.equal(receivedPool, pool);
        assert.equal(workfileId, WORKFILE_ID);
        calls += 1;
        return readiness;
      },
    });
    assert.deepEqual(readiness, original, "HTTP projection must not mutate internal signer snapshots");
  }
});

test("certification readiness denies anonymous and cross-organization callers before loading credentials", async () => {
  for (const anonymous of [true, false]) {
    const pool = securityPool(anonymous ? {} : { membershipOrganizationId: OTHER_ORGANIZATION_ID });
    let calls = 0;
    await withServer(pool, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/certification-readiness`, {
        headers: anonymous ? {} : { authorization: "Bearer synthetic-token" },
      });
      assert.equal(response.status, anonymous ? 401 : 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        error: anonymous ? "invalid_access_token" : "uad_workfile_access_denied",
      });
      assert.equal(calls, 0);
    }, {}, { getCertificationReadiness: async () => { calls += 1; return signerReadinessFixture(); } });
  }
});

test("certification readiness never exposes credentials to an authorized workfile reader who is not a signer", async () => {
  for (const signers of [[], [signerReadinessFixture().signers[1]]]) {
    await withServer(securityPool(), async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/certification-readiness`, {
        headers: { authorization: "Bearer synthetic-token" },
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "uad_signature_access_denied" });
    }, {}, { getCertificationReadiness: async () => ({ ...signerReadinessFixture(), signers }) });
  }
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

test("UAD workfiles fail closed while the application rollout flag is disabled", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const capabilities = await fetch(`${baseUrl}/api/uad/capabilities`);
    assert.equal(capabilities.status, 200);
    assert.equal((await capabilities.json()).authentication.required, true);

    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_access_token" });
    assert.equal(pool.accessQueries.length, 0);
  }, {}, { authenticationRequired: false });
});

test("UAD completion confirmation is limited to the assigned appraiser and records the actor", async () => {
  const allowedPool = securityPool();
  const calls = [];
  const applyCompletionSuggestions = async (...args) => {
    calls.push(args);
    return { applied_suggestion_count: 1 };
  };
  await withServer(allowedPool, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/completion-suggestions/apply`,
      {
        method: "POST",
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: 1, suggestion_ids: ["suggestion-1"] }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { applied_suggestion_count: 1 });
  }, {}, { applyCompletionSuggestions });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], allowedPool);
  assert.equal(calls[0][1], WORKFILE_ID);
  assert.deepEqual(calls[0][2], { expected_revision: 1, suggestion_ids: ["suggestion-1"] });
  assert.equal(calls[0][3], USER_ID);

  let deniedApplyCalls = 0;
  await withServer(securityPool({ roleCode: "organization_admin" }), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/completion-suggestions/apply`,
      {
        method: "POST",
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
        body: JSON.stringify({ expected_revision: 1, suggestion_ids: ["suggestion-1"] }),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "uad_appraiser_confirmation_access_denied" });
  }, {}, {
    applyCompletionSuggestions: async () => { deniedApplyCalls += 1; },
  });
  assert.equal(deniedApplyCalls, 0);
});

test("UAD subject mismatch override rejects organization administrators", async () => {
  const pool = securityPool({ roleCode: "organization_admin" });
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/documents/44/subject-address-override`,
      {
        method: "POST",
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
        body: JSON.stringify({
          reviewer: "Forged Appraiser",
          report_subject_address: "123 Main St",
        }),
      },
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "uad_appraiser_confirmation_access_denied" });
  });
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

test("the tenant-owned UAD router never exposes a public account summary", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/uad/accounts/SYNTHETIC-ACCOUNT/subject-summary`,
      { headers: { authorization: "Bearer synthetic-token" } },
    );
    assert.equal(response.status, 404);
  });
});

test("UAD creation binds the public URL account to authenticated organization scope", async () => {
  const pool = securityPool();
  const creationCalls = [];
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/uad/accounts/${encodeURIComponent("PUBLIC-ACCOUNT-1")}/workfiles`,
      {
        method: "POST",
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
        body: JSON.stringify({
          organization_id: ORGANIZATION_ID,
          account_id: "forged-body-account",
          account_scope: "forged_private_scope",
        }),
      },
    );
    assert.equal(response.status, 201);
    assert.equal((await response.json()).workfile.account_id, "PUBLIC-ACCOUNT-1");
  }, {}, {
    createWorkfile: async (receivedPool, input) => {
      creationCalls.push({ receivedPool, input });
      return { id: WORKFILE_ID, account_id: input.account_id };
    },
  });
  assert.equal(creationCalls.length, 1);
  assert.equal(creationCalls[0].receivedPool, pool);
  assert.deepEqual({
    account_id: creationCalls[0].input.account_id,
    account_scope: creationCalls[0].input.account_scope,
    organization_id: creationCalls[0].input.organization_id,
    actor_user_id: creationCalls[0].input.actor_user_id,
  }, {
    account_id: "PUBLIC-ACCOUNT-1",
    account_scope: "public_cadastral_catalog",
    organization_id: ORGANIZATION_ID,
    actor_user_id: USER_ID,
  });
});

test("private UAD PDF uploads pass the bounded binary parser but still require authentication", async () => {
  const pool = securityPool();
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/documents`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: Buffer.from("%PDF-synthetic-document"),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_access_token" });
    assert.equal(pool.accessQueries.length, 0);
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

test("UAD completion lifecycle refusal is a bounded private 409 response", async () => {
  const pool = securityPool();
  let calls = 0;
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/completion-suggestions/apply`, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "uad_workfile_status_locked" });
    assert.equal(calls, 1);
  }, {}, { async applyCompletionSuggestions() {
    calls += 1;
    throw new Error("uad_workfile_status_locked");
  } });
});

test("direct UAD sketch saves enforce authentication and organization access before persistence", async () => {
  for (const authenticated of [false, true]) {
    const pool = securityPool({ membershipOrganizationId: OTHER_ORGANIZATION_ID });
    let connections = 0;
    pool.connect = async () => {
      connections += 1;
      throw new Error("unauthorized_sketch_must_not_connect");
    };
    await withServer(pool, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sketches`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...(authenticated ? { authorization: "Bearer synthetic-token" } : {}) },
        body: JSON.stringify({ geometry: {} }),
      });
      assert.equal(response.status, authenticated ? 403 : 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: authenticated ? "uad_workfile_access_denied" : "invalid_access_token" });
      assert.equal(connections, 0);
      assert.deepEqual(pool.accessQueries, authenticated ? [[WORKFILE_ID]] : []);
    });
  }
});

test("direct UAD sketch lifecycle refusals use the real service and private bounded 409 responses", async () => {
  for (const fixture of [
    ...["signed", "exported", "submitted", "cancelled"].map((status) => ({ status, signed_at: null })),
    { status: "ready", signed_at: "2026-09-05T00:00:00.000Z" },
    { status: "ready", signed_at: null, has_signatures: true },
  ]) {
    const pool = securityPool();
    const trace = [];
    let releases = 0;
    pool.connect = async () => ({
      async query(sql, params) {
        const statement = String(sql).replace(/\s+/g, " ").trim();
        trace.push(statement);
        if (statement === "BEGIN ISOLATION LEVEL READ COMMITTED" || statement === "ROLLBACK") return { rows: [] };
        if (statement === "SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE") {
          assert.deepEqual(params, [WORKFILE_ID]);
          return { rows: [{ id: WORKFILE_ID, status: fixture.status, signed_at: fixture.signed_at }] };
        }
        if (statement.includes("FROM appraisal.uad_signatures")) {
          assert.deepEqual(params, [WORKFILE_ID]);
          return { rows: [{ has_signatures: fixture.has_signatures }] };
        }
        throw new Error("locked_sketch_must_not_reach_canonical_reads_or_writes");
      },
      release() { releases += 1; },
    });
    await withServer(pool, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/sketches`, {
        method: "PUT",
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
        body: JSON.stringify({ geometry: {}, expected_revision: 1 }),
      });
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "uad_workfile_status_locked" });
      assert.deepEqual(pool.accessQueries, [[WORKFILE_ID]]);
      assert.equal(trace.length, fixture.has_signatures ? 4 : 3);
      assert.equal(trace[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
      assert.equal(trace.at(-1), "ROLLBACK");
      assert.equal(releases, 1);
    });
  }
});

test("signing assurance refusals use the real service and bounded private 409 responses", async () => {
  for (const fixture of [
    { policy: "reauthentication", method: "reauthentication", code: "uad_signature_reauthentication_unavailable" },
    { policy: null, method: "session", code: "uad_signature_policy_invalid" },
    { policy: "unknown-private-policy", method: "session", code: "uad_signature_policy_invalid" },
    { policy: "session", method: "reauthentication", code: "uad_signature_authentication_method_mismatch" },
    { policy: "session", method: { method: "session" }, code: "uad_signature_authentication_method_mismatch" },
  ]) {
    const pool = securityPool();
    const trace = [];
    let releases = 0;
    pool.connect = async () => ({
      async query(sql, params) {
        const statement = String(sql).replace(/\s+/g, " ").trim();
        trace.push(statement);
        if (statement === "BEGIN" || statement === "ROLLBACK") return { rows: [] };
        assert.deepEqual(params, [WORKFILE_ID]);
        if (statement === "SELECT * FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE") {
          return { rows: [{ id: WORKFILE_ID, status: "ready", current_revision: 3,
            assigned_appraiser_user_id: USER_ID, supervisory_appraiser_user_id: null }] };
        }
        if (statement.startsWith("WITH required_signers AS")) {
          return { rows: [{ signer_role: "appraiser", user_id: USER_ID, user_active: true,
            display_name: "Synthetic Appraiser", profile_status: "active", signature_policy: fixture.policy,
            organization_id: ORGANIZATION_ID, organization_display_name: "Synthetic Organization",
            address_line_1: "1 Synthetic Street", city: "Dallas", state_code: "TX", postal_code: "75201",
            license_id: "00000000-0000-4000-8000-000000000111", jurisdiction: "TX",
            license_number: "SYNTHETIC-PRIVATE", license_type: "CertifiedResidential", expires_on: "9999-12-31" }] };
        }
        throw new Error("unsupported_assurance_must_not_reach_signature_reads_or_writes");
      },
      release() { releases += 1; },
    });
    await withServer(pool, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/signatures`, {
        method: "POST",
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
        body: JSON.stringify({ authentication_method: fixture.method, auth_time: Math.floor(Date.now() / 1000),
          amr: ["mfa"], acknowledgment_token: "caller-claims-are-not-verified-assurance" }),
      });
      assert.equal(response.status, 409);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: fixture.code });
      assert.deepEqual(pool.accessQueries, [[WORKFILE_ID]]);
      assert.equal(trace.length, 4);
      assert.equal(trace[0], "BEGIN");
      assert.equal(trace.at(-1), "ROLLBACK");
      assert.equal(releases, 1);
    });
  }
});

test("signature writes reject anonymous and cross-organization callers before the signing service", async () => {
  for (const authenticated of [false, true]) {
    const pool = securityPool({ membershipOrganizationId: OTHER_ORGANIZATION_ID });
    let connections = 0;
    pool.connect = async () => { connections += 1; throw new Error("unauthorized_signature_must_not_connect"); };
    await withServer(pool, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/signatures`, {
        method: "POST", headers: { "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer synthetic-token" } : {}) },
        body: JSON.stringify({ authentication_method: "reauthentication" }),
      });
      assert.equal(response.status, authenticated ? 403 : 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: authenticated ? "uad_workfile_access_denied" : "invalid_access_token" });
      assert.equal(connections, 0);
      assert.deepEqual(pool.accessQueries, authenticated ? [[WORKFILE_ID]] : []);
    });
  }
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
