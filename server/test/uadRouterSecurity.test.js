import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import express from "express";

import { createUadRouter, uadBodyParserErrorHandler } from "../src/modules/uad/router.js";

const WORKFILE_ID = "c164248f-645d-48aa-a389-dc668e6c5dc9";
const USER_ID = "711c54f2-d7a4-4418-ab65-0d9f7e0d43a1";
const ORGANIZATION_ID = "f62aa408-18eb-4ee1-bdae-167b8ff92a0c";
const OTHER_ORGANIZATION_ID = "b5250368-e8f1-4d47-9f62-a8a7cb2ea383";
const REPORT_FILE_ID = "e2f654e7-d35f-4cb5-8cc5-64e86784d0d0";

async function withServer(pool, callback, securityOverrides = {}, routerOverrides = {}) {
  const app = express();
  app.use("/api/uad", createUadRouter({
    pool,
    storage: routerOverrides.storage ?? { provider: "r2", configured: true },
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

function securityPool({
  membershipOrganizationId = ORGANIZATION_ID,
  roleCode = "appraiser",
  assignedAppraiserUserId = USER_ID,
  supervisoryAppraiserUserId = null,
} = {}) {
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
          assigned_appraiser_user_id: assignedAppraiserUserId,
          supervisory_appraiser_user_id: supervisoryAppraiserUserId,
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
  const input = {
    expected_revision: 1,
    suggestion_ids: ["suggestion-1"],
    actorUserId: "forged-actor",
    organizationId: OTHER_ORGANIZATION_ID,
    signerRole: "supervisory_appraiser",
    confirmation: {
      workfileId: "forged-workfile", organizationId: OTHER_ORGANIZATION_ID,
      actorUserId: "forged-actor", signerRole: "supervisory_appraiser",
    },
  };
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
        body: JSON.stringify(input),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { applied_suggestion_count: 1 });
  }, {}, { applyCompletionSuggestions });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], allowedPool);
  assert.equal(calls[0][1], WORKFILE_ID);
  assert.deepEqual(calls[0][2], input);
  assert.equal(calls[0][3], USER_ID);
  assert.equal(calls[0].length, 5);
  assert.deepEqual(calls[0][4], {
    workfileId: WORKFILE_ID,
    organizationId: ORGANIZATION_ID,
    actorUserId: USER_ID,
    signerRole: "appraiser",
  });
  assert.equal(Object.isFrozen(calls[0][4]), true);

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

test("UAD completion binds the assigned supervisor slot for an uppercase workfile UUID", async () => {
  const pool = securityPool({
    roleCode: "supervisory_appraiser",
    assignedAppraiserUserId: "another-assigned-appraiser",
    supervisoryAppraiserUserId: USER_ID,
  });
  const calls = [];
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID.toUpperCase()}/completion-suggestions/apply`, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true, signerRole: "appraiser", actor_user_id: "forged-actor" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { applied_suggestion_count: 1 });
  }, {}, { async applyCompletionSuggestions(...args) {
    calls.push(args);
    return { applied_suggestion_count: 1 };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], WORKFILE_ID.toUpperCase());
  assert.equal(calls[0][3], USER_ID);
  assert.deepEqual(calls[0][4], {
    workfileId: WORKFILE_ID, organizationId: ORGANIZATION_ID,
    actorUserId: USER_ID, signerRole: "supervisory_appraiser",
  });
  assert.equal(Object.isFrozen(calls[0][4]), true);
});

test("UAD completion target drift is a bounded private access-denied response", async () => {
  const pool = securityPool();
  let calls = 0;
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/completion-suggestions/apply`, {
      method: "POST",
      headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "uad_appraiser_confirmation_access_denied" });
    assert.equal(calls, 1);
  }, {}, { async applyCompletionSuggestions() {
    calls += 1;
    throw new Error("uad_appraiser_confirmation_access_denied");
  } });
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

test("authenticated UAD document uploads ignore a spoofed uploader and retain exact authorized scope", async () => {
  const basePool = securityPool();
  const schemaQueries = [];
  const scopeQueries = [];
  const inserts = [];
  const storedObjects = [];
  const content = Buffer.from("%PDF-1.4\nsynthetic authenticated document attribution");
  const checksum = createHash("sha256").update(content).digest("hex");
  const fileName = "uad-actor-test.pdf";
  const expectedObjectKey = `organizations/${ORGANIZATION_ID}/uad-3.6/accounts/SYNTHETIC-ACCOUNT`
    + `/workfiles/${WORKFILE_ID}/documents/${checksum}/${fileName}`;
  const storage = {
    provider: "r2",
    configured: true,
    isolated: true,
    bucket: "synthetic-private-documents",
    async putObject(input) {
      storedObjects.push({
        ...input,
        body: Buffer.from(input.body),
      });
    },
    async inspectObject({ objectKey }) {
      const stored = storedObjects.find((entry) => entry.objectKey === objectKey);
      assert.ok(stored, "document must be stored before it is inspected");
      return {
        byte_size: stored.body.length,
        etag: '"synthetic-etag"',
        content_type: stored.contentType,
      };
    },
  };
  const pool = {
    ...basePool,
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE IF NOT EXISTS app.assignment_documents")) {
        schemaQueries.push(sql);
        return { rows: [] };
      }
      if (sql.includes("SELECT workfile.id AS uad_workfile_id")) {
        scopeQueries.push([...params]);
        return { rows: [{
          uad_workfile_id: WORKFILE_ID,
          account_id: "SYNTHETIC-ACCOUNT",
          organization_id: ORGANIZATION_ID,
          report_file_id: REPORT_FILE_ID,
        }] };
      }
      if (sql.includes("INSERT INTO app.assignment_documents")) {
        inserts.push({ sql, params: [...params] });
        return { rows: [{
          id: 44,
          account_id: params[0],
          assignment_file_id: params[1],
          uad_workfile_id: params[2],
          tax_protest_file_id: params[3],
          report_file_id: params[4],
          document_type: params[5],
          title: params[6],
          file_name: params[7],
          content_type: "application/pdf",
          content: params[8],
          checksum_sha256: params[9],
          file_size_bytes: params[10],
          uploaded_by: params[11],
          storage_provider: params[12],
          storage_status: params[13],
          storage_bucket: params[14],
          object_key: params[15],
          storage_etag: params[16],
          storage_content_type: params[17],
          storage_verified_at: params[18],
          storage_last_error: params[19],
          page_count: null,
          processing_status: "reviewed",
          processing_attempts: 0,
          extraction_summary: {},
          uploaded_at: "2026-09-06T12:00:00.000Z",
          processed_at: null,
          reviewed_at: "2026-09-06T12:01:00.000Z",
        }] };
      }
      return basePool.query(sql, params);
    },
  };

  let responseBody;
  await withServer(pool, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/documents`, {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic-token",
        "content-type": "application/pdf",
        "x-document-type": "other",
        "x-document-title": encodeURIComponent("Synthetic evidence"),
        "x-document-file-name": encodeURIComponent(fileName),
        "x-document-uploaded-by": encodeURIComponent("Forged Uploader"),
      },
      body: content,
    });
    assert.equal(response.status, 201);
    responseBody = await response.json();
  }, {}, { storage });

  assert.deepEqual(basePool.accessQueries, [[WORKFILE_ID]]);
  assert.deepEqual(scopeQueries, [[WORKFILE_ID]]);
  assert.equal(schemaQueries.length, 2);
  assert.equal(inserts.length, 1);
  const [insert] = inserts;
  assert.match(insert.sql, /ON CONFLICT[\s\S]+checksum_sha256[\s\S]+DO UPDATE/);
  assert.deepEqual(insert.params.slice(0, 5), [
    "SYNTHETIC-ACCOUNT",
    null,
    WORKFILE_ID,
    null,
    REPORT_FILE_ID,
  ]);
  assert.equal(insert.params[5], "other");
  assert.equal(insert.params[6], "Synthetic evidence");
  assert.equal(insert.params[7], fileName);
  assert.equal(insert.params[8], null);
  assert.equal(insert.params[9], checksum);
  assert.equal(insert.params[10], content.length);
  assert.equal(insert.params[12], "r2");
  assert.equal(insert.params[13], "stored");
  assert.equal(insert.params[14], storage.bucket);
  assert.equal(insert.params[15], expectedObjectKey);
  assert.equal(insert.params[16], '"synthetic-etag"');
  assert.equal(insert.params[17], "application/pdf");
  assert.ok(insert.params[18] instanceof Date);
  assert.equal(insert.params[19], null);
  assert.equal(storedObjects.length, 1);
  assert.deepEqual(storedObjects[0], {
    objectKey: expectedObjectKey,
    contentType: "application/pdf",
    body: content,
  });
  assert.deepEqual({
    account_id: responseBody.document.account_id,
    assignment_file_id: responseBody.document.assignment_file_id,
    uad_workfile_id: responseBody.document.uad_workfile_id,
    tax_protest_file_id: responseBody.document.tax_protest_file_id,
    report_file_id: responseBody.document.report_file_id,
    checksum_sha256: responseBody.document.checksum_sha256,
    file_size_bytes: responseBody.document.file_size_bytes,
    storage_provider: responseBody.document.storage_provider,
    storage_status: responseBody.document.storage_status,
  }, {
    account_id: "SYNTHETIC-ACCOUNT",
    assignment_file_id: null,
    uad_workfile_id: WORKFILE_ID,
    tax_protest_file_id: null,
    report_file_id: REPORT_FILE_ID,
    checksum_sha256: checksum,
    file_size_bytes: content.length,
    storage_provider: "r2",
    storage_status: "stored",
  });

  assert.equal(insert.params[11], USER_ID);
  assert.equal(responseBody.document.uploaded_by, USER_ID);
});

test("UAD document uploads deny unauthorized callers before schema, document, or storage access", async () => {
  const content = Buffer.from("%PDF-1.4\nsynthetic denied document upload");
  const cases = [
    {
      name: "anonymous",
      poolOptions: {},
      headers: {},
      expectedStatus: 401,
      expectedBody: { error: "invalid_access_token" },
      expectedAccessQueries: [],
    },
    {
      name: "foreign organization",
      poolOptions: { membershipOrganizationId: OTHER_ORGANIZATION_ID },
      headers: { authorization: "Bearer synthetic-token" },
      expectedStatus: 403,
      expectedBody: { error: "uad_workfile_access_denied" },
      expectedAccessQueries: [[WORKFILE_ID]],
    },
    {
      name: "unassigned appraiser",
      poolOptions: { assignedAppraiserUserId: "a7253788-a018-4e96-80bd-3cc0b634b53a" },
      headers: { authorization: "Bearer synthetic-token" },
      expectedStatus: 403,
      expectedBody: { error: "uad_workfile_access_denied" },
      expectedAccessQueries: [[WORKFILE_ID]],
    },
  ];

  for (const testCase of cases) {
    const basePool = securityPool(testCase.poolOptions);
    const queries = [];
    const storageCalls = [];
    const pool = {
      ...basePool,
      async query(sql, params = []) {
        queries.push({ sql, params: [...params] });
        return basePool.query(sql, params);
      },
    };
    const storage = {
      provider: "r2",
      configured: true,
      isolated: true,
      bucket: "synthetic-private-documents",
      async putObject(input) {
        storageCalls.push(["putObject", input]);
        throw new Error("denied_upload_must_not_write_storage");
      },
      async inspectObject(input) {
        storageCalls.push(["inspectObject", input]);
        throw new Error("denied_upload_must_not_inspect_storage");
      },
    };

    await withServer(pool, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/documents`, {
        method: "POST",
        headers: {
          ...testCase.headers,
          "content-type": "application/pdf",
          "x-document-file-name": "denied-upload.pdf",
          "x-document-uploaded-by": USER_ID,
        },
        body: content,
      });
      assert.equal(response.status, testCase.expectedStatus, testCase.name);
      assert.deepEqual(await response.json(), testCase.expectedBody, testCase.name);
    }, {}, { storage });

    assert.deepEqual(basePool.accessQueries, testCase.expectedAccessQueries, testCase.name);
    assert.equal(
      queries.some(({ sql }) => (
        sql.includes("CREATE TABLE IF NOT EXISTS app.assignment_documents")
        || sql.includes("SELECT workfile.id AS uad_workfile_id")
        || sql.includes("INSERT INTO app.assignment_documents")
      )),
      false,
      `${testCase.name} must be denied before document persistence is reached`,
    );
    assert.deepEqual(storageCalls, [], testCase.name);
  }
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

function entityAuditRoutePool(method) {
  const pool = securityPool();
  const authorizeQuery = pool.query.bind(pool);
  const trace = [], poolTrace = [], auditRows = [], failures = [];
  let connections = 0, releases = 0;
  let entity = {
    id: "baebad3d-633b-4ea9-97f8-5e238454d8c0",
    workfile_id: WORKFILE_ID,
    parent_entity_id: null,
    entity_type: "assignment_seller",
    entity_identifier: "assignment-seller-1",
    ordinal: 1,
    label: "Synthetic seller",
    data: { source: "synthetic-router-control" },
    created_at: "2026-09-06T00:00:00.000Z",
    updated_at: "2026-09-06T00:00:00.000Z",
  };
  const lockSql = "SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE";
  const auditSql = method === "POST"
    ? "INSERT INTO appraisal.uad_audit_events ( workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data ) VALUES ($1, $2, 'uad_entity.created', $3, $4, $5::jsonb)"
    : "INSERT INTO appraisal.uad_audit_events ( workfile_id, actor_user_id, event_type, entity_type, entity_id, before_data ) VALUES ($1, $2, 'uad_entity.deleted', $3, $4, $5::jsonb)";
  const steps = [
    ["BEGIN ISOLATION LEVEL READ COMMITTED", (params) => { assert.deepEqual(params, []); return { rows: [] }; }],
    [lockSql, (params) => {
      assert.deepEqual(params, [WORKFILE_ID]);
      return { rows: [{ id: WORKFILE_ID, status: "draft", signed_at: null }] };
    }],
    ["SELECT EXISTS ( SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1 ) AS has_signatures", (params) => {
      assert.deepEqual(params, [WORKFILE_ID]);
      return { rows: [{ has_signatures: false }] };
    }],
    ...(method === "POST" ? [
      ["SELECT count(*)::integer AS count FROM appraisal.uad_entities WHERE workfile_id = $1 AND entity_type = $2 AND parent_entity_id IS NOT DISTINCT FROM $3::uuid", (params) => {
        assert.deepEqual(params, [WORKFILE_ID, "assignment_seller", null]);
        return { rows: [{ count: 0 }] };
      }],
      ["SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM appraisal.uad_entities WHERE workfile_id = $1 AND entity_type = $2", (params) => {
        assert.deepEqual(params, [WORKFILE_ID, "assignment_seller"]);
        return { rows: [{ ordinal: 1 }] };
      }],
      ["INSERT INTO appraisal.uad_entities ( id, workfile_id, parent_entity_id, entity_type, entity_identifier, ordinal, label, data ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *", (params) => {
        assert.match(params[0], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        assert.deepEqual(params.slice(1), [WORKFILE_ID, null, "assignment_seller", "assignment-seller-1", 1,
          "Synthetic seller", JSON.stringify({ source: "synthetic-router-control" })]);
        entity = { ...entity, id: params[0] };
        return { rows: [{ ...entity, ordinal: "1" }] };
      }],
    ] : [
      ["SELECT * FROM appraisal.uad_entities WHERE id = $1 AND workfile_id = $2 FOR UPDATE", (params) => {
        assert.deepEqual(params, [entity.id, WORKFILE_ID]);
        return { rows: [{ ...entity, ordinal: "1" }] };
      }],
      ["DELETE FROM appraisal.uad_entities WHERE id = $1", (params) => {
        assert.deepEqual(params, [entity.id]);
        return { rows: [] };
      }],
    ]),
    [auditSql, (params) => {
      assert.equal(params.length, 5);
      assert.equal(params[0], WORKFILE_ID);
      assert.deepEqual(params.slice(2), ["assignment_seller", entity.id, JSON.stringify(entity)]);
      // Capture the real INSERT binding; assert actor outside the service so the
      // old source fails on null attribution, not on an unhandled mock query.
      auditRows.push({ actor_user_id: params[1], entity: JSON.parse(params[4]) });
      return { rows: [] };
    }],
    ["UPDATE appraisal.uad_workfiles SET status = 'draft', updated_at = now() WHERE id = $1", (params) => {
      assert.deepEqual(params, [WORKFILE_ID]);
      return { rows: [] };
    }],
    ["COMMIT", (params) => { assert.deepEqual(params, []); return { rows: [] }; }],
  ];
  const client = {
    async query(sql, params = []) {
      try {
        assert.equal(this, client);
        assert.equal(releases, 0);
        const statement = String(sql).replace(/\s+/g, " ").trim();
        const step = steps[trace.length];
        trace.push(statement);
        assert.ok(step, "unexpected extra transaction query");
        assert.equal(statement, step[0]);
        return step[1](params);
      } catch (error) { failures.push(error); throw error; }
    },
    release() {
      try {
        assert.equal(this, client);
        assert.equal(++releases, 1);
        assert.deepEqual(trace, steps.map(([sql]) => sql));
      } catch (error) { failures.push(error); throw error; }
    },
  };
  pool.query = async (sql, params = []) => {
    try {
      assert.equal(connections, 0, "persistence escaped the checked-out transaction client");
      const statement = String(sql).replace(/\s+/g, " ").trim();
      if (statement.includes("FROM app_auth.oidc_identities identities")) {
        assert.deepEqual(params, ["https://identity.example", "oidc-subject"]);
        poolTrace.push("identity");
      } else if (statement === "UPDATE app_auth.oidc_identities SET last_authenticated_at = now(), updated_at = now() WHERE issuer = $1 AND subject = $2") {
        assert.deepEqual(params, ["https://identity.example", "oidc-subject"]);
        poolTrace.push("authenticated");
      } else {
        assert.equal(statement, "SELECT id, organization_id, assigned_appraiser_user_id, supervisory_appraiser_user_id FROM appraisal.uad_workfiles WHERE id = $1");
        assert.deepEqual(params, [WORKFILE_ID]);
        poolTrace.push("authorized");
      }
      return await authorizeQuery(sql, params);
    } catch (error) { failures.push(error); throw error; }
  };
  pool.connect = async () => {
    assert.equal(++connections, 1);
    assert.deepEqual(poolTrace, ["identity", "authenticated", "authorized"]);
    assert.deepEqual(pool.accessQueries, [[WORKFILE_ID]]);
    return client;
  };
  return {
    pool, auditRows,
    entity: () => entity,
    assertFinished() {
      assert.deepEqual(failures, [], "SQL/client assertions must not be swallowed by the router");
      assert.equal(connections, 1);
      assert.equal(releases, 1);
      assert.deepEqual(trace, steps.map(([sql]) => sql));
      assert.equal(auditRows.length, 1);
    },
  };
}

for (const method of ["POST", "DELETE"]) {
  test(`UAD entity ${method} persists the authenticated audit actor through the real wrapper and ignores forged actors`, async () => {
    const fixture = entityAuditRoutePool(method);
    const forgedBodyActor = "87a7a94a-504a-4c0a-8061-df9eecb48cd9";
    const forgedHeaderActor = "b90b2a46-c7af-4590-ab77-e27a8f680c3e";
    await withServer(fixture.pool, async (baseUrl) => {
      const suffix = method === "DELETE" ? `/${fixture.entity().id}` : "";
      const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/entities${suffix}`, {
        method,
        headers: { authorization: "Bearer synthetic-token", "content-type": "application/json",
          "x-actor-user-id": forgedHeaderActor, "x-user-id": forgedHeaderActor },
        body: JSON.stringify({ entity_type: "assignment_seller", label: "Synthetic seller",
          data: { source: "synthetic-router-control" }, actor_user_id: forgedBodyActor, actorUserId: forgedBodyActor }),
      });
      assert.equal(response.status, method === "POST" ? 201 : 204);
      assert.equal(response.headers.get("cache-control"), "no-store");
      if (method === "POST") assert.deepEqual(await response.json(), { entity: fixture.entity() });
      else assert.equal(await response.text(), "");
    });
    fixture.assertFinished();
    assert.deepEqual(fixture.auditRows, [{ actor_user_id: USER_ID, entity: fixture.entity() }]);
    assert.notEqual(fixture.auditRows[0].actor_user_id, forgedBodyActor);
    assert.notEqual(fixture.auditRows[0].actor_user_id, forgedHeaderActor);
  });

  test(`UAD entity ${method} rejects unauthenticated, foreign-organization, and unassigned requests before mutation`, async () => {
    for (const scenario of [
      { authenticated: false, options: {}, status: 401, error: "invalid_access_token" },
      { authenticated: true, options: { membershipOrganizationId: OTHER_ORGANIZATION_ID }, status: 403, error: "uad_workfile_access_denied" },
      { authenticated: true, options: { assignedAppraiserUserId: "another-appraiser" }, status: 403, error: "uad_workfile_access_denied" },
    ]) {
      const pool = securityPool(scenario.options);
      let connections = 0;
      pool.connect = async () => { connections += 1; throw new Error("unauthorized_entity_must_not_connect"); };
      await withServer(pool, async (baseUrl) => {
        const suffix = method === "DELETE" ? "/baebad3d-633b-4ea9-97f8-5e238454d8c0" : "";
        const response = await fetch(`${baseUrl}/api/uad/workfiles/${WORKFILE_ID}/entities${suffix}`, {
          method,
          headers: { "content-type": "application/json", "x-actor-user-id": USER_ID,
            ...(scenario.authenticated ? { authorization: "Bearer synthetic-token" } : {}) },
          body: JSON.stringify({ entity_type: "assignment_seller", actor_user_id: USER_ID, actorUserId: USER_ID }),
        });
        assert.equal(response.status, scenario.status);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { error: scenario.error });
      });
      assert.equal(connections, 0);
      assert.deepEqual(pool.accessQueries, scenario.authenticated ? [[WORKFILE_ID]] : []);
    }
  });
}
