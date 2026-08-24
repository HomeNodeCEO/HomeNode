import assert from "node:assert/strict";
import test from "node:test";

import { runUadRedTeamProtocolFuzz } from "../src/modules/uad/uadRedTeamProtocolFuzz.js";

const WORKFILE_ID = "c164248f-645d-48aa-a389-dc668e6c5dc9";
const VALID_TOKEN = "valid.valid.valid";

function json(body, status = 200, { noStore = true } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(noStore ? { "cache-control": "no-store" } : {}),
    },
  });
}

function protocolFetch({ leakTokenDiagnostic = false } = {}) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization");
    const method = init.method || "GET";

    if (url.pathname === "/health") return json({ ok: true }, 200, { noStore: false });
    if (url.pathname === "/api/uad/readiness") return json({ ok: true });
    if (
      url.pathname === "/api/uad/accounts/UAD-REDTEAM-SFR-0001/workfiles"
      && authorization === `Bearer ${VALID_TOKEN}`
    ) {
      return json({
        workfiles: [{ id: WORKFILE_ID, file_number: "HN-REDTEAM-ORG-A-0001", current_revision: 7 }],
      });
    }
    if (url.pathname === `/api/uad/workfiles/${WORKFILE_ID}` && authorization === `Bearer ${VALID_TOKEN}`) {
      return json({ workfile: { id: WORKFILE_ID, current_revision: 7 } });
    }
    if (url.pathname === `/api/uad/workfiles/${WORKFILE_ID}`) {
      if (leakTokenDiagnostic) {
        return json({ error: "invalid_access_token", diagnostic: "Bearer secret.token.value" }, 401);
      }
      return json({ error: "invalid_access_token" }, 401);
    }
    if (url.pathname === `/api/uad/workfiles/${WORKFILE_ID}/sections/assignment`) {
      const contentType = headers.get("content-type") || "";
      const contentEncoding = headers.get("content-encoding") || "";
      if (contentEncoding === "gzip") return json({ error: "invalid_request_body" }, 400);
      if (/charset=iso-8859-1/i.test(contentType)) {
        return json({ error: "unsupported_request_encoding" }, 415);
      }
      if (contentType === "text/plain") return json({ error: "unsupported_media_type" }, 415);
      if (String(init.body).length > 1_000_000) return json({ error: "request_body_too_large" }, 413);
      return json({ error: "invalid_json_body" }, 400);
    }
    if (
      url.pathname === "/api/uad/__redteam_unknown_route__"
      || (url.pathname === "/api/uad/capabilities" && method === "POST")
    ) return json({ error: "uad_route_not_found" }, 404);
    return json({ error: "unexpected_test_request" }, 500);
  };
}

async function getAccessToken(_persona, options = {}) {
  if (!Object.keys(options).length) return VALID_TOKEN;
  const encoded = Buffer.from(JSON.stringify(options), "utf8").toString("base64url");
  return `signed.${encoded}.signature`;
}

test("bounded protocol fuzz rejects hostile tokens and bodies then proves recovery", async () => {
  const result = await runUadRedTeamProtocolFuzz({
    fetchImpl: protocolFetch(),
    getAccessToken,
    checkedAt: "2026-08-23T12:00:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile, "uad_redteam_protocol_fuzz_v1");
  assert.equal(result.request_count, 24);
  assert.equal(Object.keys(result.token_attacks).length, 12);
  assert.equal(Object.keys(result.body_attacks).length, 5);
  assert.equal(result.routing_attacks.method_override.http_status, 404);
  assert.equal(result.recovery.fixture_unchanged.before_revision, 7);
  assert.equal(result.recovery.fixture_unchanged.after_revision, 7);
  assert.doesNotMatch(JSON.stringify(result), /valid\.valid\.valid|Bearer\s|secret\.token/i);
});

test("protocol fuzz fails closed when an authentication response leaks diagnostics", async () => {
  const result = await runUadRedTeamProtocolFuzz({
    fetchImpl: protocolFetch({ leakTokenDiagnostic: true }),
    getAccessToken,
  });
  assert.equal(result.ok, false);
  assert.equal(result.token_attacks.basic_scheme.ready, false);
  assert.equal(result.token_attacks.basic_scheme.safe_response, false);
  assert.doesNotMatch(JSON.stringify(result), /Bearer secret\.token\.value/i);
});

test("protocol fuzz cannot be redirected outside the fixed red-team service", async () => {
  await assert.rejects(() => runUadRedTeamProtocolFuzz({
    baseUrl: "https://homenode-api-staging.onrender.com",
    fetchImpl: protocolFetch(),
    getAccessToken,
  }), /invalid_uad_redteam_api_url/);
});
