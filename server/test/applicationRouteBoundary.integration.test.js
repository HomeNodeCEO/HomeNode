import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { mountApplicationRouteBoundary } from "../src/security/applicationRouteBoundary.js";

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
