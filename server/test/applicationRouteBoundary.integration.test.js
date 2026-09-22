import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { mountApplicationRouteBoundary } from "../src/security/applicationRouteBoundary.js";
import { jsonErrorHandler } from "../src/security/httpSecurity.js";

const identity = Object.freeze({
  userId: "user_1",
  displayName: "Appraiser",
  organizations: Object.freeze([]),
});

async function startApplication({ authenticationRequired = true, readinessError = null } = {}) {
  const app = express();
  const rateLimitedRequests = [];
  mountApplicationRouteBoundary(app, {
    authenticationPolicy: {
      authenticationRequired,
      mode: authenticationRequired ? "enforced" : "development_legacy",
    },
    webSessionAuthenticator(req, _res, next) {
      if (req.get("x-test-web-session") === "active") req.mobileAuth = identity;
      next();
    },
    uadRouter(req, res) {
      res.json({ ok: true, surface: "uad", body_present: req.body !== undefined });
    },
    uadBodyParserErrorHandler(_error, _req, _res, next) { next(); },
    jsonBodyParser: express.json({ limit: "1mb" }),
    mobileRouter(req, res) {
      if (req.get("authorization") !== "Bearer mobile-token") {
        return res.status(401).json({ error: "authentication_required" });
      }
      return res.json({ ok: true, surface: "mobile", origin: req.get("origin") || null });
    },
    optionalApplicationAuthenticator(req, _res, next) {
      if (req.get("authorization") === "Bearer application-token") req.mobileAuth = identity;
      next();
    },
    globalApiRateLimiterOptions: {
      windowMs: 60_000,
      limit: 1_000,
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator(req) {
        rateLimitedRequests.push(req.originalUrl);
        return `integration:${rateLimitedRequests.length}`;
      },
    },
    webAuthRouter(req, res, next) {
      if (req.path === "/status") return res.json({ configured: true, required: true });
      return next();
    },
    buildSession: (applicationIdentity) => ({ user_id: applicationIdentity.userId }),
    loadAuthReadiness: async () => {
      if (readinessError) throw readinessError;
      return { activation_ready: true };
    },
    logger: { warn() {} },
  });
  app.get("/api/legacy", (_req, res) => res.json({ ok: true, surface: "legacy" }));
  app.post("/api/legacy", (req, res) => res.json({ ok: true, body: req.body }));
  app.post("/api/accounts/:id/neighborhood-cohort/catalog", express.json({ limit: 4_000_000 }), (req, res) => (
    res.json({ ok: true, payload_bytes: Buffer.byteLength(req.body.payload) })
  ));
  app.post(
    "/api/accounts/:id/assignment-files/:assignmentFileId/sales-imports/:batchId/reviews",
    (req, res, next) => {
      res.set("x-local-authorization-before-parser", String(req.body === undefined));
      next();
    },
    express.json({ limit: 262_144, inflate: false, strict: true }),
    (_req, res) => res.json({ ok: true }),
  );
  app.use(jsonErrorHandler);

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    rateLimitedRequests,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

test("application route boundary preserves UAD, mobile, web auth, and legacy ordering", async (context) => {
  const server = await startApplication();
  context.after(server.close);

  const uad = await fetch(`${server.baseUrl}/api/uad/binary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(uad.status, 200, "UAD must run before the legacy JSON parser");
  assert.deepEqual(await uad.json(), { ok: true, surface: "uad", body_present: false });

  const mobile = await fetch(`${server.baseUrl}/api/mobile/me`, {
    headers: { authorization: "Bearer mobile-token" },
  });
  assert.equal(mobile.status, 200, "native bearer routes must run before the legacy gate");
  assert.deepEqual(await mobile.json(), { ok: true, surface: "mobile", origin: null });

  const webStatus = await fetch(`${server.baseUrl}/api/auth/status`);
  assert.equal(webStatus.status, 200, "browser auth bootstrap must remain public");
  assert.deepEqual(await webStatus.json(), { configured: true, required: true });

  const anonymousLegacy = await fetch(`${server.baseUrl}/api/legacy`);
  assert.equal(anonymousLegacy.status, 401);
  assert.equal(anonymousLegacy.headers.get("cache-control"), "no-store");
  assert.deepEqual(await anonymousLegacy.json(), { error: "authentication_required" });

  const authenticatedLegacy = await fetch(`${server.baseUrl}/api/legacy`, {
    headers: { authorization: "Bearer application-token" },
  });
  assert.equal(authenticatedLegacy.status, 200);
  assert.deepEqual(server.rateLimitedRequests, [
    "/api/legacy",
    "/api/legacy",
  ]);
});

test("browser session hydration protects session and readiness endpoints", async (context) => {
  const server = await startApplication();
  context.after(server.close);

  const anonymous = await fetch(`${server.baseUrl}/api/auth/me`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get("cache-control"), "no-store");

  const headers = { "x-test-web-session": "active" };
  const session = await fetch(`${server.baseUrl}/api/auth/me`, { headers });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { ok: true, session: { user_id: "user_1" } });

  const readiness = await fetch(`${server.baseUrl}/api/auth/readiness`, { headers });
  assert.equal(readiness.status, 200);
  assert.deepEqual(await readiness.json(), { ok: true, readiness: { activation_ready: true } });
  assert.deepEqual(server.rateLimitedRequests, [
    "/api/auth/me",
    "/api/auth/me",
    "/api/auth/readiness",
  ]);
});

test("legacy authentication and rate limiting settle before JSON parsing", async (context) => {
  const server = await startApplication();
  context.after(server.close);
  const url = `${server.baseUrl}/api/legacy`;
  const malformed = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  };

  const anonymous = await fetch(url, malformed);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: "authentication_required" });

  const authenticated = await fetch(url, {
    ...malformed,
    headers: {
      ...malformed.headers,
      authorization: "Bearer application-token",
    },
  });
  assert.equal(authenticated.status, 400);
  assert.deepEqual(await authenticated.json(), { error: "invalid_json_body" });

  const compressed = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer application-token",
      "content-type": "application/json",
      "content-encoding": "gzip",
    },
    body: "not-a-gzip-stream",
  });
  assert.equal(compressed.status, 415);
  assert.deepEqual(await compressed.json(), { error: "unsupported_request_encoding" });
  assert.deepEqual(server.rateLimitedRequests, [
    "/api/legacy",
    "/api/legacy",
    "/api/legacy",
  ]);
});

test("route-local parser families retain their authorization and size boundaries", async (context) => {
  const server = await startApplication();
  context.after(server.close);
  const headers = {
    authorization: "Bearer application-token",
    "content-type": "application/json",
  };

  const neighborhood = await fetch(
    `${server.baseUrl}/api/accounts/A-1/neighborhood-cohort/catalog`,
    { method: "POST", headers, body: JSON.stringify({ payload: "x".repeat(1_100_000) }) },
  );
  assert.equal(neighborhood.status, 200, "the shared 1 MiB parser must not preempt the 4 MB parser");
  assert.deepEqual(await neighborhood.json(), { ok: true, payload_bytes: 1_100_000 });

  const salesReview = await fetch(
    `${server.baseUrl}/api/accounts/A-1/assignment-files/7/sales-imports/batch-1/reviews`,
    { method: "POST", headers, body: JSON.stringify({ payload: "x".repeat(300_000) }) },
  );
  assert.equal(salesReview.status, 413, "the route-local 256 KiB ceiling must remain authoritative");
  assert.equal(salesReview.headers.get("x-local-authorization-before-parser"), "true");
  assert.deepEqual(await salesReview.json(), { error: "request_body_too_large" });
});

test("readiness failures remain bounded and explicit local development preserves legacy access", async (context) => {
  const unavailable = await startApplication({ readinessError: new Error("postgres secret") });
  const deniedError = Object.assign(new Error("private authorization details"), {
    code: "auth_readiness_access_denied",
  });
  const denied = await startApplication({ readinessError: deniedError });
  const rollout = await startApplication({ authenticationRequired: false });
  context.after(async () => {
    await Promise.all([unavailable.close(), denied.close(), rollout.close()]);
  });

  const response = await fetch(`${unavailable.baseUrl}/api/auth/readiness`, {
    headers: { "x-test-web-session": "active" },
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, { error: "auth_readiness_unavailable" });
  assert.doesNotMatch(JSON.stringify(body), /postgres|secret/i);

  const forbidden = await fetch(`${denied.baseUrl}/api/auth/readiness`, {
    headers: { "x-test-web-session": "active" },
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "auth_readiness_access_denied" });

  const legacy = await fetch(`${rollout.baseUrl}/api/legacy`);
  assert.equal(legacy.status, 200);
  assert.deepEqual(await legacy.json(), { ok: true, surface: "legacy" });
});
