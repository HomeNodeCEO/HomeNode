import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import express from "express";

import { createSignupRouter } from "../src/modules/signup/router.js";

async function startRouter(routerOptions) {
  const { auth = null, ...options } = routerOptions;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (auth) req.mobileAuth = auth;
    next();
  });
  app.use(createSignupRouter(options));
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

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROPERTY_TAX_FILE_ID = "33333333-3333-4333-8333-333333333333";
const AUTH = Object.freeze({
  userId: USER_ID,
  organizations: [{ organizationId: ORGANIZATION_ID, roles: ["appraiser"] }],
});

function validBody(overrides = {}) {
  return {
    accountId: " 123 ",
    authorization: {
      appraisalDistrictName: "Dallas Central Appraisal District",
      ownerName: " Owner ",
      ownerTelephone: " 555-0100 ",
      ownerAddress: "100 Main Street",
      ownerCity: "Dallas",
      ownerState: "Texas",
      ownerZip: "75201",
      allPropertyAtAddress: true,
      listedProperties: [{
        accountNumber: "123",
        situsAddress: "100 Main Street",
        legalDescription: "LOT 1",
      }],
      additionalSheets: "",
      agentName: "HomeNode, Inc.",
      agentTelephone: "719-888-0042",
      agentAddress: "1717 Independence Pkwy",
      agentCity: "Plano",
      agentState: "Texas",
      agentZip: "75075",
      representAll: true,
      representSpecificText: "",
      consentConfidentialInfo: true,
      communicationsChiefAppraiser: true,
      communicationsReviewBoard: true,
      communicationsAllTaxingUnits: true,
      authorityEnds: "",
      signatureDate: "2026-09-04",
      signerPrintedName: "Owner",
      signerTitle: "Owner",
      signerRole: "owner",
    },
    clientSubmissionId: randomUUID(),
    propertyTaxFileId: PROPERTY_TAX_FILE_ID,
    signatureAttestation: true,
    signatureDataUrl: `data:image/png;base64,${Buffer.alloc(64, 1).toString("base64")}`,
    ...overrides,
  };
}

function signatureResult() {
  return {
    content: Buffer.from("canonical-signature"),
    height: 40,
    sha256: "a".repeat(64),
    width: 120,
  };
}

function authorizePropertyTaxFile(_pool, auth, input) {
  assert.equal(auth, AUTH);
  assert.deepEqual(input, {
    accountId: "123",
    propertyTaxFileId: PROPERTY_TAX_FILE_ID,
    permission: "write",
  });
  return Promise.resolve({
    account_id: "123",
    organization_id: ORGANIZATION_ID,
    report_file_id: PROPERTY_TAX_FILE_ID,
  });
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
        return { rows: [{ id: 42, created: true, verification_status: "pending_manual_verification" }] };
      },
    },
    signupRateLimiter(_req, _res, next) { limiterCalls += 1; next(); },
    auth: AUTH,
    authorizePropertyTaxFile,
    verifySignature: async () => signatureResult(),
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
    body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    id: 42,
    idempotent: false,
    verification_status: "pending_manual_verification",
    email_sent: true,
    email_status: "sent",
  });
  assert.equal(limiterCalls, 1);
  assert.deepEqual(transports, ["smtp://fixture.invalid"]);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO app\.signups/);
  assert.match(queries[0].sql, /JOIN app\.tax_protest_files protest/);
  assert.match(queries[0].sql, /protest\.organization_id = report_file\.organization_id/);
  assert.match(queries[0].sql, /report_file\.organization_id = \$5/);
  assert.equal(queries[0].params[0], "web-authorization-request");
  assert.deepEqual(queries[0].params.slice(2, 13), [
    "123",
    PROPERTY_TAX_FILE_ID,
    ORGANIZATION_ID,
    USER_ID,
    "Owner",
    "555-0100",
    null,
    "Owner",
    "Owner",
    "owner",
    "a".repeat(64),
  ]);
  assert.equal(Buffer.isBuffer(queries[0].params[13]), true);
  assert.match(queries[0].params[14], /^[a-f0-9]{64}$/);
  assert.equal(queries[0].params[16], "pending_manual_verification");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].from, "sender@example.invalid");
  assert.match(deliveries[0].subject, /UNVERIFIED.*123/);
  assert.match(deliveries[0].text, /Do not treat this request as authorization/);
});

test("invalid signup input is bounded before persistence or delivery", async (context) => {
  let limiterCalls = 0;
  let queryCalls = 0;
  let transportCalls = 0;
  const server = await startRouter({
    pool: { async query() { queryCalls += 1; return { rows: [] }; } },
    signupRateLimiter(_req, _res, next) { limiterCalls += 1; next(); },
    auth: AUTH,
    authorizePropertyTaxFile,
    verifySignature: async () => signatureResult(),
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
    body: JSON.stringify(validBody({
      authorization: { ...validBody().authorization, ownerName: "" },
    })),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "missing_owner_name" });
  assert.equal(limiterCalls, 1);
  assert.equal(queryCalls, 0);
  assert.equal(transportCalls, 0);
});

test("anonymous signup submissions fail before payload processing or persistence", async (context) => {
  let queryCalls = 0;
  let authorizationCalls = 0;
  const server = await startRouter({
    pool: { async query() { queryCalls += 1; return { rows: [] }; } },
    signupRateLimiter(_req, _res, next) { next(); },
    authorizePropertyTaxFile: async () => { authorizationCalls += 1; },
    verifySignature: async () => signatureResult(),
    mailer: { createTransport() { throw new Error("mailer_must_not_run"); } },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "authentication_required" });
  assert.equal(authorizationCalls, 0);
  assert.equal(queryCalls, 0);
});

test("cross-organization property files fail before signature persistence or delivery", async (context) => {
  let signatureCalls = 0;
  let queryCalls = 0;
  const server = await startRouter({
    auth: AUTH,
    pool: { async query() { queryCalls += 1; return { rows: [] }; } },
    signupRateLimiter(_req, _res, next) { next(); },
    authorizePropertyTaxFile: async () => { throw new Error("property_tax_protest_file_access_denied"); },
    verifySignature: async () => { signatureCalls += 1; return signatureResult(); },
    mailer: { createTransport() { throw new Error("mailer_must_not_run"); } },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "property_tax_protest_file_access_denied" });
  assert.equal(signatureCalls, 0);
  assert.equal(queryCalls, 0);
});

test("blank signatures fail before durable authorization or delivery", async (context) => {
  let queryCalls = 0;
  const server = await startRouter({
    auth: AUTH,
    pool: { async query() { queryCalls += 1; return { rows: [] }; } },
    signupRateLimiter(_req, _res, next) { next(); },
    authorizePropertyTaxFile,
    verifySignature: async () => { throw new Error("signature_image_blank"); },
    mailer: { createTransport() { throw new Error("mailer_must_not_run"); } },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "signature_image_blank" });
  assert.equal(queryCalls, 0);
});

test("idempotent retries do not send duplicate staff notifications", async (context) => {
  let transportCalls = 0;
  const server = await startRouter({
    auth: AUTH,
    pool: { query: async () => ({
      rows: [{ id: 42, created: false, verification_status: "pending_manual_verification" }],
    }) },
    signupRateLimiter(_req, _res, next) { next(); },
    authorizePropertyTaxFile,
    verifySignature: async () => signatureResult(),
    environment: { SMTP_URL: "smtp://fixture.invalid" },
    mailer: { createTransport() { transportCalls += 1; return {}; } },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    id: 42,
    idempotent: true,
    verification_status: "pending_manual_verification",
    email_sent: false,
    email_status: "not_repeated",
  });
  assert.equal(transportCalls, 0);
});

test("idempotency-key payload changes conflict without staff notification", async (context) => {
  let transportCalls = 0;
  const server = await startRouter({
    auth: AUTH,
    pool: { query: async () => ({ rows: [] }) },
    signupRateLimiter(_req, _res, next) { next(); },
    authorizePropertyTaxFile,
    verifySignature: async () => signatureResult(),
    environment: { SMTP_URL: "smtp://fixture.invalid" },
    mailer: { createTransport() { transportCalls += 1; return {}; } },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "signup_submission_conflict" });
  assert.equal(transportCalls, 0);
});

test("persistence failure is fail-closed before staff notification", async (context) => {
  let transportCalls = 0;
  const server = await startRouter({
    auth: AUTH,
    pool: { query: async () => { throw Object.assign(new Error("private"), { code: "XX000" }); } },
    signupRateLimiter(_req, _res, next) { next(); },
    authorizePropertyTaxFile,
    verifySignature: async () => signatureResult(),
    environment: { SMTP_URL: "smtp://fixture.invalid" },
    mailer: { createTransport() { transportCalls += 1; return {}; } },
    logger: { error() {} },
  });
  context.after(server.close);

  const response = await fetch(`${server.baseUrl}/api/signup/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody()),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "signup_persistence_unavailable" });
  assert.equal(transportCalls, 0);
});
