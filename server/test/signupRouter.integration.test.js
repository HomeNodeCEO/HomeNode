import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { createSignupRouter } from "../src/modules/signup/router.js";

async function startRouter(routerOptions) {
  const app = express();
  app.use(express.json());
  app.use(createSignupRouter(routerOptions));
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_unavailable");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

test("signup status exposes configuration booleans without credential values", async (context) => {
  const server = await startRouter({
    pool: { query: async () => ({ rows: [] }) },
    signupRateLimiter(_req, _res, next) { next(); },
    environment: {
      SMTP_URL: "smtp://user:secret@example.invalid",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "user",
      SMTP_PASS: "secret",
      MAIL_FROM: "sender@example.invalid",
      CORS_ORIGIN: "https://app.example.invalid",
    },
    mailer: { createTransport() { return { sendMail: async () => undefined }; } },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/smtp-status`);
  assert.deepEqual(await response.json(), {
    ok: true,
    smtp: {
      configured: true,
      using_url: true,
      has_host: false,
      port: 465,
      secure: true,
      has_user: true,
      has_pass: true,
      from_set: true,
    },
    cors_origin: "https://app.example.invalid",
  });
  assert.doesNotMatch(JSON.stringify(await (await fetch(`${server.baseUrl}/api/signup/smtp-status`)).json()), /secret/);
});

test("signup submission preserves limiter, persistence, delivery, and response contracts", async (context) => {
  let limiterCalls = 0;
  const queries = [];
  const deliveries = [];
  const transports = [];
  const server = await startRouter({
    pool: {
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ id: 42 }] };
      },
    },
    signupRateLimiter(_req, _res, next) { limiterCalls += 1; next(); },
    environment: {
      SMTP_URL: "smtp://fixture.invalid",
      MAIL_FROM: "sender@example.invalid",
    },
    mailer: {
      createTransport(configuration) {
        transports.push(configuration);
        return { async sendMail(message) { deliveries.push(message); } };
      },
    },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "signup-test",
      referer: "https://app.example.invalid/enroll",
    },
    body: JSON.stringify({
      accountId: " 123 ",
      ownerEmail: " owner@example.invalid ",
      ownerName: " Owner ",
      ownerTelephone: " 555-0100 ",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    id: 42,
    email_sent: true,
    email_status: "sent",
  });
  assert.equal(limiterCalls, 1);
  assert.deepEqual(transports, ["smtp://fixture.invalid"]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO app\.signups/);
  assert.deepEqual(queries[0].params.slice(0, 5), [
    "web-signup",
    "123",
    "Owner",
    "555-0100",
    "owner@example.invalid",
  ]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].from, "sender@example.invalid");
  assert.match(deliveries[0].subject, /123/);
});

test("invalid signup input is bounded before persistence or delivery", async (context) => {
  let limiterCalls = 0;
  let queryCalls = 0;
  let transportCalls = 0;
  const server = await startRouter({
    pool: { async query() { queryCalls += 1; return { rows: [] }; } },
    signupRateLimiter(_req, _res, next) { limiterCalls += 1; next(); },
    environment: { SMTP_URL: "smtp://fixture.invalid" },
    mailer: {
      createTransport() {
        transportCalls += 1;
        return { sendMail: async () => undefined };
      },
    },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ownerName: "", ownerTelephone: "555" }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "missing_owner_name" });
  assert.equal(limiterCalls, 1);
  assert.equal(queryCalls, 0);
  assert.equal(transportCalls, 0);
});
