import assert from "node:assert/strict";
import test from "node:test";

import { REDTEAM_API_ORIGIN } from "../src/modules/uad/uadRedTeamBaseline.js";
import { runUadRedTeamResourcePressure } from "../src/modules/uad/uadRedTeamResourcePressure.js";

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ratelimit: '"120-in-1min"; r=100; t=60',
      "ratelimit-policy": '"120-in-1min"; q=120; w=60',
      ...headers,
    },
  });
}

function pressureFetch({ failHeader = false } = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    if (headers.has("x-redteam-bounded-header")) {
      return jsonResponse(failHeader ? 503 : 431, { error: "header_pressure_rejected" });
    }
    if (headers.has("content-encoding")) {
      assert.ok(Buffer.byteLength(init.body) < 64 * 1024);
      return jsonResponse(413, { error: "request_body_too_large" });
    }
    if (parsed.pathname === "/health") return jsonResponse(200, { ok: true });
    if (parsed.pathname === "/api/uad/readiness") return jsonResponse(200, { ok: true });
    if (parsed.pathname === "/api/uad/capabilities") {
      return jsonResponse(200, { specification_release_key: "uad-redteam-test" });
    }
    if (parsed.pathname.includes("/api/uad/accounts/")) {
      return jsonResponse(401, { error: "invalid_access_token" });
    }
    throw new Error(`unexpected_path:${parsed.pathname}`);
  };
}

test("resource pressure rejects expansion payloads, bounds concurrency, and proves recovery", async () => {
  const result = await runUadRedTeamResourcePressure({
    fetchImpl: pressureFetch(),
    concurrency: 3,
    mixedRequests: 6,
    sleep: async () => undefined,
    checkedAt: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.request_count, 13);
  assert.equal(result.checks.compressed_expansion.rejected_count, 2);
  assert.equal(result.checks.header_pressure.http_status, 431);
  assert.equal(result.checks.mixed_concurrency.attempted_requests, 6);
  assert.equal(result.checks.mixed_concurrency.server_error_responses, 0);
  assert.equal(result.checks.recovery.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /x{100}|request_body_too_large/i);
});

test("resource pressure fails closed on a server error", async () => {
  const result = await runUadRedTeamResourcePressure({
    fetchImpl: pressureFetch({ failHeader: true }),
    mixedRequests: 6,
    sleep: async () => undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.header_pressure.ready, false);
});

test("resource pressure cannot target staging, production, or another fixture namespace", async () => {
  await assert.rejects(() => runUadRedTeamResourcePressure({
    baseUrl: "https://homenode-api-staging.onrender.com",
    fetchImpl: pressureFetch(),
  }), /invalid_uad_redteam_api_url/);
  await assert.rejects(() => runUadRedTeamResourcePressure({
    baseUrl: `${REDTEAM_API_ORIGIN}.attacker.invalid`,
    fetchImpl: pressureFetch(),
  }), /invalid_uad_redteam_api_url/);
  await assert.rejects(() => runUadRedTeamResourcePressure({
    fixtureAccountId: "UAD-STAGING-SFR-0001",
    fetchImpl: pressureFetch(),
  }), /invalid_uad_redteam_fixture_account/);
});
