import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeApplicationAuthStagingConfiguration,
  runApplicationAuthPublicPreflight,
  runApplicationAuthStagingMatrix,
} from "../src/security/applicationAuthStagingMatrix.js";

const ORGANIZATION_A = "00000000-0000-4000-8000-000000000101";
const ORGANIZATION_B = "00000000-0000-4000-8000-000000000102";
const UAD_FILE = "00000000-0000-4000-8000-000000000103";
const PROPERTY_TAX_FILE = "00000000-0000-4000-8000-000000000104";

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": status >= 400 ? "no-store" : "private, no-store",
    },
  });
}

function successfulFetch(calls = []) {
  return async (urlValue, options = {}) => {
    const url = new URL(urlValue);
    const authorization = options.headers?.authorization || null;
    calls.push({
      path: `${url.pathname}${url.search}`,
      method: options.method || "GET",
      authorization,
      redirect: options.redirect,
      body: options.body,
    });
    if (url.pathname === "/ready") return response({ ok: true });
    if (url.pathname === "/api/auth/status") {
      return response({ configured: true, required: true });
    }
    if (url.pathname === "/api/uad/capabilities") {
      return response({ authentication: { configured: true, required: true } });
    }
    if (url.pathname === "/api/mobile/capabilities") {
      return response({
        enabled: true,
        authentication: { configured: true, client_secret_embedded: false },
      });
    }
    if (!authorization) return response({ error: "authentication_required" }, 401);
    const organizationA = authorization === "Bearer token-a";
    const organizationB = authorization === "Bearer token-b";
    if (!organizationA && !organizationB) return response({ error: "invalid_access_token" }, 401);
    if (url.pathname === "/api/auth/me") {
      const organizationId = organizationA ? ORGANIZATION_A : ORGANIZATION_B;
      return response({
        ok: true,
        session: { organizations: [{ organization_id: organizationId, roles: ["organization_admin"] }] },
      });
    }
    if (url.pathname === "/api/mobile/me") return response({ user: { userId: "bounded" } });
    if (url.pathname === "/api/auth/readiness") {
      return organizationA
        ? response({ ok: true, readiness: { activation_ready: true, blockers: [] } })
        : response({ error: "auth_readiness_access_denied" }, 403);
    }
    if (url.pathname === "/api/mobile/report-files") {
      return response({
        files: organizationA
          ? [
            { target_id: "73" },
            { target_id: UAD_FILE },
            { target_id: PROPERTY_TAX_FILE },
          ]
          : [],
      });
    }
    return organizationA
      ? response({ ok: true })
      : response({ error: "fixture_access_denied" }, 403);
  };
}

function configuration(overrides = {}) {
  return {
    baseUrl: "https://staging.example.test",
    organizationAId: ORGANIZATION_A,
    organizationBId: ORGANIZATION_B,
    organizationAToken: "token-a",
    organizationBToken: "token-b",
    accountId: "20260810-00001",
    customAssignmentFileId: "73",
    uadWorkfileId: UAD_FILE,
    propertyTaxFileId: PROPERTY_TAX_FILE,
    ...overrides,
  };
}

test("staging configuration requires HTTPS, distinct identities, and exact fixture identifiers", () => {
  const normalized = normalizeApplicationAuthStagingConfiguration(configuration());
  assert.equal(normalized.baseUrl, "https://staging.example.test");
  assert.equal(normalized.timeoutMs, 10_000);
  assert.equal(
    normalizeApplicationAuthStagingConfiguration(configuration({ timeoutMs: null })).timeoutMs,
    10_000,
  );
  assert.equal(
    normalizeApplicationAuthStagingConfiguration(configuration({ timeoutMs: "" })).timeoutMs,
    10_000,
  );
  assert.equal(
    normalizeApplicationAuthStagingConfiguration(configuration({ timeoutMs: "15000" })).timeoutMs,
    15_000,
  );
  assert.throws(
    () => normalizeApplicationAuthStagingConfiguration(configuration({ baseUrl: "http://staging.example.test" })),
    /invalid_application_auth_staging_base_url/,
  );
  assert.throws(
    () => normalizeApplicationAuthStagingConfiguration(configuration({ organizationBId: ORGANIZATION_A })),
    /application_auth_staging_organizations_must_differ/,
  );
  assert.throws(
    () => normalizeApplicationAuthStagingConfiguration(configuration({ organizationBToken: "token-a" })),
    /application_auth_staging_tokens_must_differ/,
  );
  assert.throws(
    () => normalizeApplicationAuthStagingConfiguration(configuration({ customAssignmentFileId: "file-73" })),
    /invalid_application_auth_staging_custom_assignment/,
  );
});

test("public preflight proves enforcement without credentials or fixture disclosure", async () => {
  const calls = [];
  const result = await runApplicationAuthPublicPreflight({
    baseUrl: "https://staging.example.test",
    fetchImpl: successfulFetch(calls),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "public_preflight");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checks.anonymous_custom_workfile.http_status, 401);
  assert.equal(result.checks.anonymous_mobile_identity.http_status, 401);
  assert.equal(result.checks.legacy_editor_key_inert.http_status, 401);
  assert.ok(calls.every((call) => call.redirect === "manual"));
  assert.ok(calls.every((call) => call.authorization === null));
});

test("public preflight fails closed when staging remains in optional authentication mode", async () => {
  const fetchImpl = async (urlValue) => {
    const url = new URL(urlValue);
    if (url.pathname === "/api/auth/status") {
      return response({ configured: true, required: false });
    }
    if (url.pathname === "/api/uad/capabilities") {
      return response({ authentication: { configured: true, required: false } });
    }
    if (url.pathname === "/api/mobile/capabilities") {
      return response({ enabled: true, authentication: { configured: true, client_secret_embedded: false } });
    }
    if (url.pathname === "/ready") return response({ ok: true });
    if (url.pathname === "/api/mobile/me") return response({ error: "invalid_access_token" }, 401);
    return response({ legacy: true });
  };
  const result = await runApplicationAuthPublicPreflight({
    baseUrl: "https://staging.example.test",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("web_auth_status"));
  assert.ok(result.blockers.includes("anonymous_custom_workfile"));
  assert.ok(result.blockers.includes("legacy_editor_key_inert"));
});

test("two-organization matrix covers positive access, write denials, and mobile isolation", async () => {
  const calls = [];
  const result = await runApplicationAuthStagingMatrix({
    ...configuration(),
    fetchImpl: successfulFetch(calls),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checks.activation_readiness.passed, true);
  assert.equal(result.checks.organization_b_custom_sign_denied.http_status, 403);
  assert.equal(result.checks.organization_b_uad_document_upload_denied.http_status, 403);
  assert.equal(result.checks.organization_b_property_tax_sketch_write_denied.http_status, 403);
  assert.equal(result.checks.organization_a_mobile_fixture_discovery.passed, true);
  assert.equal(result.checks.organization_b_mobile_fixture_isolation.passed, true);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /token-a|token-b|20260810-00001/i);
  const mutationCalls = calls.filter((call) => call.method !== "GET");
  assert.ok(mutationCalls.length > 0);
  assert.ok(mutationCalls.every((call) => (
    call.authorization === null || call.authorization === "Bearer token-b"
  )));
  assert.ok(mutationCalls.filter((call) => call.path.includes("documents"))
    .every((call) => !String(call.body).startsWith("%PDF-")));
  assert.ok(mutationCalls.filter((call) => call.path.endsWith("/workfile/sign"))
    .every((call) => String(call.body).includes("invalid negative control")));
});

test("two-organization matrix rejects a cross-tenant read that reaches data", async () => {
  const fetchImpl = successfulFetch();
  const result = await runApplicationAuthStagingMatrix({
    ...configuration(),
    async fetchImpl(url, options) {
      const parsed = new URL(url);
      if (options?.headers?.authorization === "Bearer token-b"
          && parsed.pathname.endsWith("/workfile")) return response({ ok: true });
      return fetchImpl(url, options);
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("organization_b_custom_workfile_denied"));
  assert.equal(result.checks.organization_b_custom_workfile_denied.http_status, 200);
});

test("network diagnostics remain bounded and never include request details", async () => {
  const result = await runApplicationAuthPublicPreflight({
    baseUrl: "https://staging.example.test",
    fetchImpl: async () => { throw new Error("password=secret host=internal"); },
  });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.length > 0);
  assert.match(JSON.stringify(result), /request_failed/);
  assert.doesNotMatch(JSON.stringify(result), /password|secret|internal/);
});
