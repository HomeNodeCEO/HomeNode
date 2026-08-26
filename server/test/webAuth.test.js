import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createWebAuthRouter } from "../src/security/webAuth.js";

const CONFIGURED_ENVIRONMENT = Object.freeze({
  OIDC_WEB_CLIENT_ID: "client-id",
  OIDC_WEB_CLIENT_SECRET: "client-secret",
  OIDC_WEB_REDIRECT_URI: "https://api.example.test/api/auth/callback",
  WEB_APP_URL: "https://app.example.test",
  APP_SESSION_SECRET: "a".repeat(32),
});

async function withAuthServer(environment, callback, {
  fetchImpl = async () => { throw new Error("unexpected_discovery_request"); },
} = {}) {
  const app = express();
  app.use("/api/auth", createWebAuthRouter({
    pool: { query: async () => ({ rows: [] }) },
    verifier: { configured: true, issuer: "https://identity.example.test" },
    environment,
    fetchImpl,
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
