import assert from "node:assert/strict";
import test from "node:test";

import { MobileApi, ApiError } from "../src/api/client";
import {
  canUseCachedIdentityAfterMeFailure,
  recoverCachedIdentityAfterMeFailure,
} from "../src/auth/offlineAccessPolicy";
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

test("cached identity fallback is limited to explicit temporary failures", () => {
  assert.equal(canUseCachedIdentityAfterMeFailure(new ApiError(0, "network_request_failed")), true);
  assert.equal(canUseCachedIdentityAfterMeFailure(new ApiError(408, "request_timeout")), true);
  assert.equal(canUseCachedIdentityAfterMeFailure(new ApiError(429, "rate_limited")), true);
  assert.equal(canUseCachedIdentityAfterMeFailure(new ApiError(503, "service_unavailable")), true);
  assert.equal(canUseCachedIdentityAfterMeFailure({ code: "token_refresh_temporarily_unavailable" }), true);
  assert.equal(canUseCachedIdentityAfterMeFailure(new ApiError(401, "authentication_required")), false);
  assert.equal(canUseCachedIdentityAfterMeFailure(new ApiError(403, "mobile_identity_not_provisioned")), false);
  assert.equal(canUseCachedIdentityAfterMeFailure(new Error("unexpected_failure")), false);
});

test("a definitive authorization denial locks cached access without deleting evidence", async () => {
  const denial = new ApiError(403, "mobile_organization_membership_required");
  let loadCalls = 0;
  let lockCalls = 0;
  await assert.rejects(recoverCachedIdentityAfterMeFailure(denial, {
    loadCachedIdentity: async () => {
      loadCalls += 1;
      return { userId: "cached-user" };
    },
    lockCachedIdentity: async () => {
      lockCalls += 1;
    },
  }), (reason: unknown) => reason === denial);
  assert.equal(loadCalls, 0);
  assert.equal(lockCalls, 1);
});

test("a temporary outage may recover the cached identity without locking it", async () => {
  let loadCalls = 0;
  let lockCalls = 0;
  const cachedUser = { userId: "cached-user" };
  const recovered = await recoverCachedIdentityAfterMeFailure(
    new ApiError(503, "service_unavailable"),
    {
      loadCachedIdentity: async () => {
        loadCalls += 1;
        return cachedUser;
      },
      lockCachedIdentity: async () => {
        lockCalls += 1;
      },
    },
  );
  assert.equal(recovered, cachedUser);
  assert.equal(loadCalls, 1);
  assert.equal(lockCalls, 0);
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
