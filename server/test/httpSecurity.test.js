import assert from "node:assert/strict";
import test from "node:test";

import {
  createCorsMiddleware,
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
  assert.equal(configuration.apiRateLimitEnabled, true);
  assert.equal(configuration.apiRateLimitMax, 600);
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
