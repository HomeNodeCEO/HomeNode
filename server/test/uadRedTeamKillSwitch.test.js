import assert from "node:assert/strict";
import test from "node:test";

import { runUadRedTeamKillSwitchCheck } from "../src/modules/uad/uadRedTeamKillSwitch.js";

function json(body, status = 200, { noStore = true } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(noStore ? { "cache-control": "no-store" } : {}) },
  });
}

function disabledFetch({ leak = false } = {}) {
  return async (input) => {
    const url = new URL(input);
    if (url.pathname === "/health") return json({ ok: true }, 200, { noStore: false });
    if (url.pathname === "/api/uad/capabilities") return json({ enabled: false });
    if (url.pathname === "/api/uad/readiness") {
      return json({
        ok: false,
        blockers: ["uad_workspace_disabled"],
        checks: { workspace: { enabled: false, ready: false } },
      }, 503);
    }
    if (leak) return json({ error: "uad_workspace_disabled", diagnostic: "postgresql://secret" }, 503);
    return json({ error: "uad_workspace_disabled" }, 503);
  };
}

test("kill-switch check proves public diagnostics and blocks reads and writes", async () => {
  const result = await runUadRedTeamKillSwitchCheck({
    fetchImpl: disabledFetch(),
    checkedAt: "2026-08-24T02:45:00.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.request_count, 5);
  assert.ok(Object.values(result.checks).every((check) => check.ready));
  assert.doesNotMatch(JSON.stringify(result), /postgresql|diagnostic/i);
});

test("kill-switch check fails if a disabled route leaks diagnostics", async () => {
  const result = await runUadRedTeamKillSwitchCheck({ fetchImpl: disabledFetch({ leak: true }) });
  assert.equal(result.ok, false);
  assert.equal(result.checks.protected_read_blocked.ready, false);
  assert.equal(result.checks.protected_read_blocked.safe_response, false);
});

test("kill-switch check bounds a compromised response body", async () => {
  const result = await runUadRedTeamKillSwitchCheck({
    fetchImpl: async () => new Response("x".repeat((64 * 1024) + 1), { status: 503 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.health.error_code, "response_too_large");
  assert.equal(result.checks.health.safe_response, false);
});

test("kill-switch check cannot target staging or production", async () => {
  await assert.rejects(() => runUadRedTeamKillSwitchCheck({
    baseUrl: "https://homenode-api-staging.onrender.com",
    fetchImpl: disabledFetch(),
  }), /invalid_uad_redteam_api_url/);
});
