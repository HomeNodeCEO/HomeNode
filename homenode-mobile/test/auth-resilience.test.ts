import assert from "node:assert/strict";
import test from "node:test";

import { MobileApi, ApiError } from "../src/api/client";
import {
  canReplayAfterAuthenticationFailure,
  classifyRefreshFailure,
  type AccessTokenRequest,
} from "../src/auth/refreshPolicy";
import { createMobileConfig } from "../src/config";

const config = createMobileConfig({
  EXPO_PUBLIC_API_BASE_URL: "https://api.homenode.test",
  EXPO_PUBLIC_OIDC_ISSUER: "https://homenode.authkit.app",
  EXPO_PUBLIC_OIDC_CLIENT_ID: "client_mobile123",
});

test("only a confirmed invalid_grant terminally expires the mobile session", () => {
  assert.equal(classifyRefreshFailure({ code: "invalid_grant" }), "temporary");
  assert.equal(classifyRefreshFailure(
    { code: "invalid_grant" },
    { confirmedTokenError: true },
  ), "terminal");
  assert.equal(classifyRefreshFailure(
    { code: "temporarily_unavailable" },
    { confirmedTokenError: true },
  ), "temporary");
  assert.equal(classifyRefreshFailure(new TypeError("Network request failed")), "temporary");
});

test("authentication replay is restricted to read-only methods", () => {
  assert.equal(canReplayAfterAuthenticationFailure(undefined), true);
  assert.equal(canReplayAfterAuthenticationFailure("GET"), true);
  assert.equal(canReplayAfterAuthenticationFailure("HEAD"), true);
  assert.equal(canReplayAfterAuthenticationFailure("POST"), false);
  assert.equal(canReplayAfterAuthenticationFailure("PUT"), false);
  assert.equal(canReplayAfterAuthenticationFailure("DELETE"), false);
});

test("a read-only 401 forces one token refresh and replays once", async (context) => {
  const accessRequests: AccessTokenRequest[] = [];
  const authorizationHeaders: string[] = [];
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    authorizationHeaders.push(new Headers(init?.headers).get("authorization") || "");
    if (authorizationHeaders.length === 1) {
      return new Response(JSON.stringify({ error: "authentication_required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ user: {
      userId: "user_1",
      email: "appraiser@example.test",
      displayName: "Appraiser",
      organizations: [],
    } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new MobileApi(config, async (request = {}) => {
    accessRequests.push(request);
    return request.forceRefresh ? "refreshed-token" : "cached-token";
  });
  const user = await api.me();
  assert.equal(user.userId, "user_1");
  assert.deepEqual(accessRequests, [{}, { forceRefresh: true }]);
  assert.deepEqual(authorizationHeaders, ["Bearer cached-token", "Bearer refreshed-token"]);
});

test("a mutating 401 is never replayed implicitly", async (context) => {
  let fetchCalls = 0;
  let accessCalls = 0;
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: "authentication_required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new MobileApi(config, async () => {
    accessCalls += 1;
    return "cached-token";
  });
  await assert.rejects(api.createFile({
    organizationId: "org_1",
    accountId: "account_1",
    workflowType: "custom_appraisal",
    clientRequestId: "request_1",
  }), (error: unknown) => error instanceof ApiError && error.status === 401);
  assert.equal(fetchCalls, 1);
  assert.equal(accessCalls, 1);
});

test("a repeated read-only 401 is returned after exactly one replay", async (context) => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: "authentication_required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  const api = new MobileApi(config, async ({ forceRefresh = false } = {}) => (
    forceRefresh ? "refreshed-token" : "cached-token"
  ));
  await assert.rejects(api.me(), (error: unknown) => (
    error instanceof ApiError && error.status === 401
  ));
  assert.equal(fetchCalls, 2);
});
