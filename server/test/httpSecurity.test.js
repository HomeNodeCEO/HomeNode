import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import {
  authenticatedApiRateLimitKey,
  createCorsMiddleware,
  createHttpSecurityConfiguration,
  jsonErrorHandler,
  securityHeaders,
  shouldSkipGlobalApiRateLimit,
} from "../src/security/httpSecurity.js";

test("strict UAD security fails closed without authentication and explicit CORS", () => {
  assert.throws(
    () => createHttpSecurityConfiguration({ UAD_SECURITY_STRICT: "true" }),
    /uad_strict_security_requires_authentication/,
  );
  assert.throws(
    () => createHttpSecurityConfiguration({
      UAD_SECURITY_STRICT: "true",
      UAD_AUTHENTICATION_REQUIRED: "true",
    }),
    /uad_strict_security_requires_cors_origins/,
  );
});

test("strict UAD security accepts only explicit HTTPS origins", () => {
  const configuration = createHttpSecurityConfiguration({
    NODE_ENV: "production",
    UAD_SECURITY_STRICT: "true",
    UAD_AUTHENTICATION_REQUIRED: "true",
    CORS_ORIGIN: "https://redteam.homenode.com,https://review.homenode.com",
    TRUST_PROXY_HOPS: "1",
  });
  assert.equal(configuration.strict, true);
  assert.equal(configuration.authenticationRequired, true);
  assert.equal(configuration.corsRestricted, true);
  assert.equal(configuration.rateLimitEnabled, true);
  assert.equal(configuration.apiRateLimitEnabled, true);
  assert.equal(configuration.apiRateLimitMax, 600);
  assert.equal(configuration.signupRateLimitWindowMs, 15 * 60_000);
  assert.equal(configuration.signupRateLimitMax, 10);
  assert.equal(configuration.trustProxyHops, 1);
  assert.equal(configuration.rateLimitClientIpHeader, null);
  assert.deepEqual(configuration.corsOrigins, [
    "https://redteam.homenode.com",
    "https://review.homenode.com",
  ]);
  assert.throws(
    () => createHttpSecurityConfiguration({
      NODE_ENV: "production",
      CORS_ORIGIN: "http://redteam.homenode.com",
    }),
    /invalid_cors_origin/,
  );
});

test("unified application authentication also protects UAD routes", () => {
  const configuration = createHttpSecurityConfiguration({
    APPLICATION_AUTHENTICATION_REQUIRED: "true",
  });
  assert.equal(configuration.authenticationRequired, true);
});

test("signup throttling remains independently bounded", () => {
  const configuration = createHttpSecurityConfiguration({
    SIGNUP_RATE_LIMIT_WINDOW_MS: "999999999",
    SIGNUP_RATE_LIMIT_MAX: "999999",
  });
  assert.equal(configuration.signupRateLimitWindowMs, 24 * 60 * 60_000);
  assert.equal(configuration.signupRateLimitMax, 100);
});

test("Render rate limiting uses Cloudflare's single-address client header", () => {
  const configuration = createHttpSecurityConfiguration({
    RENDER: "true",
    UAD_RATE_LIMIT_ENABLED: "true",
  });
  assert.equal(configuration.rateLimitClientIpHeader, "cf-connecting-ip");

  assert.throws(
    () => createHttpSecurityConfiguration({
      UAD_RATE_LIMIT_CLIENT_IP_HEADER: "x-forwarded-for",
    }),
    /invalid_rate_limit_client_ip_header/,
  );

  assert.throws(
    () => createHttpSecurityConfiguration({
      RENDER: "true",
      UAD_SECURITY_STRICT: "true",
      UAD_AUTHENTICATION_REQUIRED: "true",
      CORS_ORIGIN: "https://redteam.homenode.com",
      UAD_RATE_LIMIT_CLIENT_IP_HEADER: "none",
    }),
    /uad_strict_security_requires_render_client_ip_header/,
  );
});

test("global rate limiting leaves UAD and mobile policy headers to their routers", () => {
  const enabled = createHttpSecurityConfiguration({ NODE_ENV: "production" });
  for (const path of [
    "/api/uad",
    "/api/uad/capabilities",
    "/api/mobile",
    "/api/mobile/assignments",
  ]) {
    assert.equal(shouldSkipGlobalApiRateLimit({ path }, enabled), true, path);
  }
  assert.equal(shouldSkipGlobalApiRateLimit({ path: "/api/properties/search" }, enabled), false);
  assert.equal(shouldSkipGlobalApiRateLimit({ path: "/api/uad-legacy" }, enabled), false);

  const disabled = createHttpSecurityConfiguration({ NODE_ENV: "test" });
  assert.equal(shouldSkipGlobalApiRateLimit({ path: "/api/properties/search" }, disabled), true);
});

test("authenticated API rate limiting isolates signed-in users", () => {
  assert.equal(authenticatedApiRateLimitKey({}), null);
  assert.equal(authenticatedApiRateLimitKey({ mobileAuth: {} }), null);
  assert.equal(
    authenticatedApiRateLimitKey({ mobileAuth: { userId: " user-123 " } }),
    "user:user-123",
  );
});

test("CORS policy permits same-origin and allowlisted origins while rejecting others", () => {
  const configuration = createHttpSecurityConfiguration({
    CORS_ORIGIN: "https://redteam.homenode.com",
  });
  const middleware = createCorsMiddleware(configuration);
  const run = ({ origin, host = "api.homenode.com", method = "GET" }) => {
    const headers = new Map();
    const response = {
      statusCode: 200,
      body: null,
      setHeader(name, value) { headers.set(name, value); },
      getHeader(name) { return headers.get(name); },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      end() { return this; },
    };
    let continued = false;
    middleware({ method, get: (name) => ({ origin, host })[name] }, response, () => {
      continued = true;
    });
    return { continued, headers, response };
  };
  assert.equal(run({ origin: "https://api.homenode.com" }).continued, true);
  assert.equal(run({ origin: "https://redteam.homenode.com" }).continued, true);
  const rejected = run({ origin: "https://attacker.example" });
  assert.equal(rejected.continued, false);
  assert.equal(rejected.response.statusCode, 403);
  assert.deepEqual(rejected.response.body, { error: "cors_origin_denied" });
  const preflight = run({ origin: "https://redteam.homenode.com", method: "OPTIONS" });
  assert.equal(preflight.response.statusCode, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://redteam.homenode.com");
  const allowedHeaders = preflight.headers.get("access-control-allow-headers");
  for (const header of [
    "Authorization",
    "Content-Type",
    "Idempotency-Key",
    "X-Assignment-File-Id",
    "X-Document-Type",
    "X-Document-Title",
    "X-Document-File-Name",
    "X-Document-Uploaded-By",
  ]) {
    assert.match(allowedHeaders, new RegExp(`(?:^|, )${header}(?:,|$)`, "i"), header);
  }
});

test("security headers remove browser interpretation and embedding ambiguity", () => {
  const headers = new Map();
  let continued = false;
  securityHeaders({}, { setHeader: (name, value) => headers.set(name, value) }, () => {
    continued = true;
  });
  assert.equal(continued, true);
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.match(headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(headers.get("strict-transport-security"), /max-age=31536000/);
});

test("global JSON errors remain bounded and do not reach route handlers", async () => {
  const app = express();
  let routeCalls = 0;
  app.use(express.json({ limit: "32b" }));
  app.post("/probe", (_req, res) => {
    routeCalls += 1;
    res.json({ ok: true });
  });
  app.use(jsonErrorHandler);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const malformed = await fetch(`${baseUrl}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.headers.get("cache-control"), "no-store");
    assert.deepEqual(await malformed.json(), { error: "invalid_json_body" });

    const oversized = await fetch(`${baseUrl}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(64) }),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: "request_body_too_large" });
    assert.equal(routeCalls, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
