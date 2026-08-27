import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createWebAuthRouter, createWebSessionAuthenticator } from "../src/security/webAuth.js";

const CONFIGURED_ENVIRONMENT = Object.freeze({
  OIDC_WEB_CLIENT_ID: "client-id",
  OIDC_WEB_CLIENT_SECRET: "client-secret",
  OIDC_WEB_REDIRECT_URI: "https://api.example.test/api/auth/callback",
  WEB_APP_URL: "https://app.example.test",
  APP_SESSION_SECRET: "a".repeat(32),
});
const CROSS_SITE_ENVIRONMENT = Object.freeze({
  ...CONFIGURED_ENVIRONMENT,
  WEB_SESSION_CROSS_SITE: "true",
  CORS_ORIGIN: CONFIGURED_ENVIRONMENT.WEB_APP_URL,
});

async function withAuthServer(environment, callback, {
  fetchImpl = async () => { throw new Error("unexpected_discovery_request"); },
  logger = { warn() {} },
  pool = { query: async () => ({ rows: [] }) },
  verifier = { configured: true, issuer: "https://identity.example.test" },
} = {}) {
  const app = express();
  app.use("/api/auth", createWebAuthRouter({
    pool,
    verifier,
    environment,
    fetchImpl,
    logger,
  }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
}

test("configured WorkOS remains optional until unified authentication is activated", async () => {
  await withAuthServer(CONFIGURED_ENVIRONMENT, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/status`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { configured: true, required: false });
  });
});

test("auth status reports enforcement only after explicit activation", async () => {
  await withAuthServer({
    ...CONFIGURED_ENVIRONMENT,
    APPLICATION_AUTHENTICATION_REQUIRED: "true",
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { configured: true, required: true });
  });
});

test("incomplete WorkOS configuration can never advertise required login", async () => {
  await withAuthServer({
    ...CONFIGURED_ENVIRONMENT,
    APP_SESSION_SECRET: "too-short",
    APPLICATION_AUTHENTICATION_REQUIRED: "true",
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { configured: false, required: false });
  });
});

test("login transaction cookie is host-only, secure, HTTP-only, and short-lived", async () => {
  const discovery = {
    issuer: "https://identity.example.test",
    authorization_endpoint: "https://identity.example.test/authorize",
    token_endpoint: "https://identity.example.test/token",
  };
  await withAuthServer(CONFIGURED_ENVIRONMENT, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"), /^https:\/\/identity\.example\.test\/authorize\?/);
    const authorizationUrl = new URL(response.headers.get("location"));
    assert.equal(authorizationUrl.searchParams.get("scope"), "openid profile email");
    assert.match(authorizationUrl.searchParams.get("nonce"), /^[A-Za-z0-9_-]{40,}$/);
    const setCookie = response.headers.get("set-cookie");
    assert.match(setCookie, /^__Host-homenode_auth_tx=/);
    assert.match(setCookie, /Path=\//i);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Max-Age=600/i);
    assert.doesNotMatch(setCookie, /Domain=/i);
  }, {
    fetchImpl: async () => new Response(JSON.stringify(discovery), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
});

test("cross-site sessions require an HTTPS frontend and its exact CORS origin", () => {
  const options = {
    pool: { query: async () => ({ rows: [] }) },
    verifier: { configured: true, issuer: "https://identity.example.test" },
  };
  assert.throws(
    () => createWebAuthRouter({
      ...options,
      environment: {
        ...CONFIGURED_ENVIRONMENT,
        WEB_SESSION_CROSS_SITE: "true",
        WEB_APP_URL: "http://app.example.test",
      },
    }),
    /cross_site_web_session_requires_https_web_app_url/,
  );
  assert.throws(
    () => createWebSessionAuthenticator({
      pool: options.pool,
      environment: {
        ...CONFIGURED_ENVIRONMENT,
        WEB_SESSION_CROSS_SITE: "true",
        CORS_ORIGIN: "https://another.example.test",
      },
    }),
    /cross_site_web_session_requires_exact_cors_origin/,
  );
});

test("callback verifies the client-bound ID token and creates a secure cross-site session", async () => {
  const discovery = {
    issuer: "https://identity.example.test",
    authorization_endpoint: "https://identity.example.test/authorize",
    token_endpoint: "https://identity.example.test/token",
  };
  const verifiedTokens = [];
  const queries = [];
  let expectedNonce;
  let requestCount = 0;
  await withAuthServer(CROSS_SITE_ENVIRONMENT, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual" });
    const authorizationUrl = new URL(login.headers.get("location"));
    expectedNonce = authorizationUrl.searchParams.get("nonce");
    const transactionCookie = login.headers.get("set-cookie").split(";", 1)[0];
    const callback = await fetch(
      `${baseUrl}/api/auth/callback?code=one-time-code&state=${authorizationUrl.searchParams.get("state")}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), CROSS_SITE_ENVIRONMENT.WEB_APP_URL);
    const setCookies = callback.headers.getSetCookie?.() || [callback.headers.get("set-cookie")];
    const sessionCookie = setCookies.find((value) => value.startsWith("__Host-homenode_session="));
    assert.match(sessionCookie, /Path=\//i);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /Secure/i);
    assert.match(sessionCookie, /SameSite=None/i);
    assert.doesNotMatch(sessionCookie, /Domain=/i);
  }, {
    fetchImpl: async () => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(JSON.stringify(discovery), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
        : new Response(JSON.stringify({
          access_token: "resource-access-token-with-a-different-audience",
          id_token: "client-bound-id-token",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    },
    verifier: {
      configured: true,
      issuer: discovery.issuer,
      async verify(token) {
        verifiedTokens.push(token);
        return { iss: discovery.issuer, sub: "workos-user", nonce: expectedNonce };
      },
    },
    pool: {
      async query(sql, parameters) {
        queries.push({ sql, parameters });
        if (sql.includes("FROM app_auth.oidc_identities")) {
          return { rows: [{
            user_id: "user-id",
            email: "user@example.test",
            display_name: "Test User",
            organization_id: "organization-id",
            organization_display_name: "Test Organization",
            role_code: "appraiser",
          }] };
        }
        if (sql.includes("INSERT INTO app_auth.web_sessions")) return { rows: [] };
        throw new Error("unexpected_query");
      },
    },
  });
  assert.deepEqual(verifiedTokens, ["client-bound-id-token"]);
  assert.equal(queries.length, 2);
});

test("cookie-authenticated writes require the exact configured frontend origin", async () => {
  const queries = [];
  const pool = {
    async query(sql, parameters) {
      queries.push({ sql, parameters });
      return { rows: [{
        user_id: "user-id",
        email: "user@example.test",
        display_name: "Test User",
        organization_id: "organization-id",
        organization_display_name: "Test Organization",
        role_code: "appraiser",
      }] };
    },
  };
  const authenticate = createWebSessionAuthenticator({
    pool,
    environment: CROSS_SITE_ENVIRONMENT,
  });
  const request = (origin) => ({
    method: "POST",
    get(name) {
      if (String(name).toLowerCase() === "cookie") return "__Host-homenode_session=opaque-session-token";
      if (String(name).toLowerCase() === "origin") return origin;
      return "";
    },
  });
  const response = () => ({
    statusCode: 200,
    body: null,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });

  for (const origin of ["", "https://attacker.example.test"]) {
    const denied = response();
    let nextCalled = false;
    await authenticate(request(origin), denied, () => { nextCalled = true; });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.body, { error: "csrf_origin_denied" });
    assert.equal(nextCalled, false);
  }
  assert.equal(queries.length, 0);

  const allowedRequest = request(CROSS_SITE_ENVIRONMENT.WEB_APP_URL);
  const allowed = response();
  let nextCalled = false;
  await authenticate(allowedRequest, allowed, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(allowedRequest.mobileAuth.userId, "user-id");
  assert.equal(queries.length, 1);
});

test("callback rejects an ID token that is not bound to the login nonce", async () => {
  const discovery = {
    issuer: "https://identity.example.test",
    authorization_endpoint: "https://identity.example.test/authorize",
    token_endpoint: "https://identity.example.test/token",
  };
  const warnings = [];
  let requestCount = 0;
  await withAuthServer(CONFIGURED_ENVIRONMENT, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual" });
    const authorizationUrl = new URL(login.headers.get("location"));
    const transactionCookie = login.headers.get("set-cookie").split(";", 1)[0];
    const callback = await fetch(
      `${baseUrl}/api/auth/callback?code=one-time-code&state=${authorizationUrl.searchParams.get("state")}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 401);
    assert.deepEqual(await callback.json(), { error: "authentication_failed" });
  }, {
    logger: { warn(message) { warnings.push(message); } },
    fetchImpl: async () => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(JSON.stringify(discovery), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
        : new Response(JSON.stringify({ id_token: "client-bound-id-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    },
    verifier: {
      configured: true,
      issuer: discovery.issuer,
      async verify() {
        return { iss: discovery.issuer, sub: "workos-user", nonce: "wrong-nonce" };
      },
    },
    pool: { async query() { throw new Error("identity_lookup_must_not_run"); } },
  });
  assert.deepEqual(warnings, [
    "[web-auth] callback failed stage=token_verification reason=nonce_mismatch",
  ]);
});

test("callback diagnostics identify the failing stage without logging provider secrets", async () => {
  const discovery = {
    issuer: "https://identity.example.test",
    authorization_endpoint: "https://identity.example.test/authorize",
    token_endpoint: "https://identity.example.test/token",
  };
  const warnings = [];
  let requestCount = 0;
  await withAuthServer(CONFIGURED_ENVIRONMENT, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/api/auth/login`, { redirect: "manual" });
    const authorizationUrl = new URL(login.headers.get("location"));
    const transactionCookie = login.headers.get("set-cookie").split(";", 1)[0];
    const callback = await fetch(
      `${baseUrl}/api/auth/callback?code=one-time-code&state=${authorizationUrl.searchParams.get("state")}`,
      { headers: { cookie: transactionCookie }, redirect: "manual" },
    );
    assert.equal(callback.status, 401);
    assert.deepEqual(await callback.json(), { error: "authentication_failed" });
  }, {
    logger: { warn(message) { warnings.push(message); } },
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify(discovery), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        error: "invalid_client",
        error_description: "must-not-appear-in-logs secret=top-secret",
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(warnings, [
    "[web-auth] callback failed stage=token_exchange reason=http_401:invalid_client",
  ]);
  assert.doesNotMatch(warnings[0], /top-secret|error_description|one-time-code/);
});
