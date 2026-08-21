import assert from "node:assert/strict";
import test from "node:test";

import {
  REDTEAM_API_ORIGIN,
  REDTEAM_APP_ORIGIN,
  normalizeUadRedTeamApiUrl,
  normalizeUadRedTeamAppUrl,
  runUadRedTeamBaseline,
} from "../src/modules/uad/uadRedTeamBaseline.js";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function publicHeaders(extra = {}) {
  return {
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extra,
  };
}

function baselineFetch({ expose = false, complianceConfigured = false, oversized = false } = {}) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const requestHeaders = new Headers(init.headers || {});
    if (url === `${REDTEAM_API_ORIGIN}/health`) {
      return json({ ok: true, ...(oversized ? { padding: "x".repeat(70_000) } : {}) }, 200, publicHeaders());
    }
    if (url === `${REDTEAM_API_ORIGIN}/api/uad/readiness`) {
      return json({
        ok: true,
        status: "ready",
        local_delivery_ready: true,
        blockers: [],
      }, 200, publicHeaders({ "cache-control": "no-store" }));
    }
    if (url.includes("/api/uad/accounts/")) {
      const suffix = expose ? " at handler (/srv/server.js:1:2)" : "";
      return json({ error: `invalid_access_token${suffix}` }, 401, publicHeaders());
    }
    if (url === `${REDTEAM_API_ORIGIN}/api/uad/capabilities`
        && requestHeaders.get("origin") === "https://attacker.invalid") {
      return json({ error: "cors_origin_denied" }, 403, publicHeaders());
    }
    if (url === `${REDTEAM_API_ORIGIN}/api/uad/capabilities` && init.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: publicHeaders({
          "access-control-allow-origin": REDTEAM_APP_ORIGIN,
          "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key",
          vary: "Origin",
        }),
      });
    }
    if (url === `${REDTEAM_API_ORIGIN}/api/uad/capabilities`) {
      return json({
        enabled: true,
        specification_release_key: "uad-3.6-2026-08-13-h1.5",
        object_storage: { provider: "r2", configured: true },
        authentication: { required: true, configured: true },
        security: { strict: true, cors_restricted: true, rate_limit_enabled: true },
        compliance: {
          enabled: false,
          providers: {
            fannie: { enabled: false, configured: complianceConfigured },
            freddie: { enabled: false, configured: false },
          },
        },
      }, 200, publicHeaders());
    }
    if (url.startsWith(`${REDTEAM_APP_ORIGIN}/uad-3.6/`)) {
      return new Response('<main id="root"></main>', {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    throw new Error(`unexpected_request:${url}`);
  };
  return { fetchImpl, requests };
}

test("red-team URLs are fixed to the isolated Render services", () => {
  assert.equal(normalizeUadRedTeamApiUrl(`${REDTEAM_API_ORIGIN}/`), REDTEAM_API_ORIGIN);
  assert.equal(normalizeUadRedTeamAppUrl(REDTEAM_APP_ORIGIN), REDTEAM_APP_ORIGIN);
  assert.throws(
    () => normalizeUadRedTeamApiUrl("https://homenode-api-staging.onrender.com"),
    /invalid_uad_redteam_api_url/,
  );
  assert.throws(
    () => normalizeUadRedTeamApiUrl(`${REDTEAM_API_ORIGIN}.attacker.invalid`),
    /invalid_uad_redteam_api_url/,
  );
  assert.throws(
    () => normalizeUadRedTeamAppUrl(`${REDTEAM_APP_ORIGIN}?token=secret`),
    /invalid_uad_redteam_app_url/,
  );
});

test("runs a bounded unauthenticated baseline and emits sanitized evidence", async () => {
  const { fetchImpl, requests } = baselineFetch();
  const result = await runUadRedTeamBaseline({
    fetchImpl,
    checkedAt: "2026-08-21T18:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.request_count, 8);
  assert.equal(requests.length, 8);
  assert.equal(result.checks.missing_token.http_status, 401);
  assert.equal(result.checks.malformed_token.http_status, 401);
  assert.equal(result.checks.denied_origin.http_status, 403);
  assert.equal(result.checks.allowed_preflight.http_status, 204);
  assert.equal(result.checks.external_providers_disabled.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /redteam\.invalid\.token|authorization/i);
});

test("fails closed when a provider credential is configured or an error leaks internals", async () => {
  const provider = await runUadRedTeamBaseline(baselineFetch({ complianceConfigured: true }));
  assert.equal(provider.ok, false);
  assert.equal(provider.checks.external_providers_disabled.ready, false);

  const exposure = await runUadRedTeamBaseline(baselineFetch({ expose: true }));
  assert.equal(exposure.ok, false);
  assert.equal(exposure.checks.missing_token.ready, false);
  assert.equal(exposure.checks.malformed_token.ready, false);
  assert.doesNotMatch(JSON.stringify(exposure), /\/srv\/server\.js/);
});

test("rejects a fixture account outside the synthetic namespace before making requests", async () => {
  const { fetchImpl, requests } = baselineFetch();
  await assert.rejects(
    () => runUadRedTeamBaseline({ fixtureAccountId: "UAD-STAGING-SFR-0001", fetchImpl }),
    /invalid_uad_redteam_fixture_account/,
  );
  assert.equal(requests.length, 0);
});

test("bounds a compromised endpoint response without retaining its content", async () => {
  const result = await runUadRedTeamBaseline(baselineFetch({ oversized: true }));
  assert.equal(result.ok, false);
  assert.equal(result.checks.health.ready, false);
  assert.equal(result.checks.health.error_code, "response_too_large");
  assert.doesNotMatch(JSON.stringify(result), /x{100}/);
});
