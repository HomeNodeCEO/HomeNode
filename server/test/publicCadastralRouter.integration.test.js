import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import express from "express";

import { createPublicCadastralRouter } from "../src/modules/accounts/publicCadastralRouter.js";
import {
  authorizePublicCadastralCatalogRead,
  PUBLIC_CADASTRAL_CATALOG_SCOPE,
} from "../src/security/publicCadastralCatalog.js";
import { getPublicCadastralSubjectSummary } from "../src/services/publicCadastralCatalog.js";

const APPRAISER_AUTH = Object.freeze({
  userId: "reader-1",
  organizations: [{ organizationId: "org-1", roles: ["appraiser"] }],
});
const SUBJECT = Object.freeze({
  account_id: "PUBLIC-123",
  address: "100 MAIN ST",
  city: "DALLAS",
  postal_code: "75201",
  county: "Dallas",
  neighborhood_code: "N-1",
  subdivision: "SYNTHETIC ADDITION",
  legal_description: "LOT 1",
});

async function withServer({ auth = APPRAISER_AUTH, pool, ...options }, callback) {
  const app = express();
  app.use((req, _res, next) => {
    req.mobileAuth = auth;
    next();
  });
  app.use(createPublicCadastralRouter({ pool, ...options }));
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

function subjectPool(rows = [SUBJECT]) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("public cadastral summary exposes only safe catalog fields with no-store", async () => {
  const pool = subjectPool();
  await withServer({ pool }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/public-cadastral/accounts/PUBLIC-123/subject-summary`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      subject: SUBJECT,
      data_scope: PUBLIC_CADASTRAL_CATALOG_SCOPE,
    });
    assert.deepEqual(pool.calls[0].params, ["PUBLIC-123"]);
    assert.doesNotMatch(pool.calls[0].sql, /owner|exemption|organization|assignment|sale/i);
  });
});

test("public cadastral summary rejects anonymous and unauthorized callers before database access", async () => {
  for (const [auth, expectedStatus, expectedError] of [
    [null, 401, "authentication_required"],
    [{ userId: "reader-2", organizations: [] }, 403, "application_access_denied"],
  ]) {
    const pool = subjectPool();
    await withServer({ auth, pool }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/public-cadastral/accounts/PUBLIC-123/subject-summary`);
      assert.equal(response.status, expectedStatus);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: expectedError });
      assert.equal(pool.calls.length, 0);
    });
  }
});

test("public cadastral summary returns bounded invalid, missing, and internal errors", async () => {
  const cases = [
    ["%20", subjectPool(), 400, "invalid_account_id"],
    ["MISSING", subjectPool([]), 404, "not_found"],
    ["FAILED", { async query() { throw new Error("secret_database_detail"); } }, 500, "public_cadastral_lookup_failed"],
  ];
  for (const [accountId, pool, expectedStatus, expectedError] of cases) {
    await withServer({ pool, logger: { error() {} } }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/public-cadastral/accounts/${accountId}/subject-summary`);
      assert.equal(response.status, expectedStatus);
      assert.deepEqual(await response.json(), { error: expectedError });
    });
  }
});

test("subject loader refuses fabricated or missing public catalog capabilities before querying", async () => {
  const pool = subjectPool();
  for (const grant of [null, {
    accountId: "PUBLIC-123",
    actorUserId: "reader-1",
    scope: PUBLIC_CADASTRAL_CATALOG_SCOPE,
  }]) {
    await assert.rejects(getPublicCadastralSubjectSummary(pool, grant), /public_cadastral_scope_required/);
  }
  assert.equal(pool.calls.length, 0);

  const grant = authorizePublicCadastralCatalogRead(APPRAISER_AUTH, "PUBLIC-123");
  assert.deepEqual(await getPublicCadastralSubjectSummary(pool, grant), SUBJECT);
});

test("the UAD router no longer exposes a broad public account lookup", async () => {
  const source = await readFile(new URL("../src/modules/uad/router.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /accounts\/:accountId\/subject-summary/);
  assert.doesNotMatch(source, /getUadSubjectSummary/);
});

test("oldServer mounts the public catalog outside the tenant-owned UAD router", async () => {
  const source = await readFile(new URL("../src/oldServer.js", import.meta.url), "utf8");
  const boundary = source.indexOf("mountApplicationRouteBoundary(app, {");
  const publicCatalog = source.indexOf("app.use(publicCadastralRouter({ pool }));");
  const accountDetail = source.indexOf("app.use(createAccountDetailRouter({");
  assert.ok(boundary >= 0 && publicCatalog > boundary && accountDetail > publicCatalog);
});

test("public cadastral router fails closed when required dependencies are absent", () => {
  const pool = subjectPool();
  assert.throws(() => createPublicCadastralRouter(), /public_cadastral_query_client_required/);
  assert.throws(
    () => createPublicCadastralRouter({ pool, authorizePublicAccount: null }),
    /public_cadastral_authorizer_required/,
  );
  assert.throws(
    () => createPublicCadastralRouter({ pool, loadSubjectSummary: null }),
    /public_cadastral_subject_loader_required/,
  );
});
