import assert from "node:assert/strict";
import test from "node:test";

import { runUadRedTeamEndpointFuzz } from "../src/modules/uad/uadRedTeamEndpointFuzz.js";

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

function endpointFetch({ mutateRevision = false } = {}) {
  let workfileReads = 0;
  return async (input, init = {}) => {
    const url = new URL(input);
    const decodedPath = decodeURIComponent(url.pathname);
    const headers = new Headers(init.headers);
    const method = init.method || "GET";

    if (url.pathname === "/health") return json({ ok: true }, 200, { noStore: false });
    if (url.pathname === "/api/uad/readiness") return json({ ok: true });
    if (headers.get("origin") === "https://attacker.invalid") {
      return json({ error: "cors_origin_denied" }, 403, { noStore: false });
    }
    if (url.pathname === "/api/uad/capabilities" && method === "GET") {
      return json({ specification_release_key: "uad-3.6-test" });
    }
    if (decodedPath === "/api/uad/accounts/UAD-REDTEAM-SFR-0001/workfiles") {
      return json({
        workfiles: [{ id: WORKFILE_ID, file_number: "HN-REDTEAM-ORG-A-0001", current_revision: 7 }],
      });
    }
    if (decodedPath.startsWith("/api/uad/accounts/") && decodedPath.endsWith("/workfiles")) {
      return json({ error: "invalid_account_id" }, 400);
    }
    if (url.pathname.includes("%2Feditor")) {
      return json({ error: "invalid_uad_workfile_id" }, 400);
    }
    if (decodedPath === `/api/uad/workfiles/${WORKFILE_ID}` && method === "GET") {
      workfileReads += 1;
      return json({
        workfile: {
          id: WORKFILE_ID,
          current_revision: mutateRevision && workfileReads > 1 ? 8 : 7,
        },
      });
    }
    if (decodedPath === `/api/uad/workfiles/${WORKFILE_ID}` && method === "POST") {
      return json({ error: "uad_route_not_found" }, 404);
    }
    if (decodedPath === `/api/uad/workfiles/${WORKFILE_ID}/editor/extra`
      || decodedPath === `/api/uad//workfiles/${WORKFILE_ID}`) {
      return json({ error: "uad_route_not_found" }, 404);
    }
    if (decodedPath === `/api/uad/workfiles/${WORKFILE_ID}/sections/__redteam_input_probe__`) {
      if (headers.get("content-type") === "application/x-www-form-urlencoded") {
        return json({ error: "unsupported_media_type" }, 415);
      }
      if (init.body === "true") return json({ error: "invalid_json_body" }, 400);
      return json({ error: "invalid_uad_expected_revision" }, 400);
    }
    if (decodedPath.startsWith("/api/uad/workfiles/")) {
      return json({ error: "invalid_uad_workfile_id" }, 400);
    }
    return json({ error: "unexpected_test_request" }, 500);
  };
}

async function getAccessToken() {
  return VALID_TOKEN;
}

test("bounded endpoint fuzz rejects hostile identifiers, routes, bodies, and headers", async () => {
  const result = await runUadRedTeamEndpointFuzz({
    fetchImpl: endpointFetch(),
    getAccessToken,
    checkedAt: "2026-08-23T20:30:00.000Z",
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile, "uad_redteam_endpoint_input_fuzz_v1");
  assert.equal(result.request_count, 22);
  assert.equal(Object.keys(result.identifier_attacks).length, 5);
  assert.equal(Object.keys(result.routing_attacks).length, 4);
  assert.equal(Object.keys(result.body_shape_attacks).length, 5);
  assert.equal(Object.keys(result.header_attacks).length, 3);
  assert.equal(result.recovery.fixture_unchanged.before_revision, 7);
  assert.equal(result.recovery.fixture_unchanged.after_revision, 7);
  assert.doesNotMatch(JSON.stringify(result), /valid\.valid\.valid|Bearer\s|polluted|INJECTED/i);
});

test("endpoint fuzz fails when the fixture changes during bounded probes", async () => {
  const result = await runUadRedTeamEndpointFuzz({
    fetchImpl: endpointFetch({ mutateRevision: true }),
    getAccessToken,
  });
  assert.equal(result.ok, false);
  assert.equal(result.recovery.fixture_unchanged.ready, false);
});

test("endpoint fuzz cannot target staging or production", async () => {
  await assert.rejects(() => runUadRedTeamEndpointFuzz({
    baseUrl: "https://homenode-api-staging.onrender.com",
    fetchImpl: endpointFetch(),
    getAccessToken,
  }), /invalid_uad_redteam_api_url/);
});
