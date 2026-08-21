import assert from "node:assert/strict";
import test from "node:test";

import {
  corsOriginPolicy,
  createFixedWindowRateLimiter,
  createHttpSecurityConfiguration,
  securityHeaders,
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
  assert.equal(configuration.trustProxyHops, 1);
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

test("CORS policy permits same-origin requests and rejects unlisted browser origins", async () => {
  const configuration = createHttpSecurityConfiguration({
    CORS_ORIGIN: "https://redteam.homenode.com",
  });
  const policy = corsOriginPolicy(configuration);
  const evaluate = (origin) => new Promise((resolve) => {
    policy(origin, (error, allowed) => resolve({ error, allowed }));
  });
  assert.deepEqual(await evaluate(undefined), { error: null, allowed: true });
  assert.deepEqual(await evaluate("https://redteam.homenode.com"), { error: null, allowed: true });
  const rejected = await evaluate("https://attacker.example");
  assert.equal(rejected.allowed, undefined);
  assert.equal(rejected.error.message, "cors_origin_denied");
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

test("fixed-window limiter returns a bounded generic 429 response", () => {
  let currentTime = 1_000;
  const limiter = createFixedWindowRateLimiter({
    enabled: true,
    windowMs: 1_000,
    maximum: 10,
    now: () => currentTime,
  });
  const request = { ip: "192.0.2.10", method: "GET" };
  let nextCalls = 0;
  function response() {
    const headers = new Map();
    return {
      headers,
      statusCode: 200,
      body: null,
      setHeader(name, value) { headers.set(name, value); },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }
  for (let index = 0; index < 10; index += 1) {
    limiter(request, response(), () => { nextCalls += 1; });
  }
  assert.equal(nextCalls, 10);
  const blocked = response();
  limiter(request, blocked, () => { nextCalls += 1; });
  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.body, { error: "rate_limit_exceeded" });
  assert.equal(blocked.headers.get("retry-after"), "1");
  currentTime += 1_001;
  limiter(request, response(), () => { nextCalls += 1; });
  assert.equal(nextCalls, 11);
});

