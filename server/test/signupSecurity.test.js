import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import {
  normalizeSignupPayload,
  signupAuthorizationSha256,
  signupDeliveryStatus,
  signupRequestMetadata,
  verifySignupSignaturePng,
} from "../src/security/signupSecurity.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function authorization(overrides = {}) {
  return {
    appraisalDistrictName: "Dallas Central Appraisal District",
    ownerName: " Synthetic Owner ",
    ownerTelephone: " 555-0100 ",
    ownerAddress: "100 Main Street",
    ownerCity: "Dallas",
    ownerState: "Texas",
    ownerZip: "75201",
    allPropertyAtAddress: true,
    listedProperties: [{
      accountNumber: " UAD-REDTEAM-SFR-0001 ",
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
    signerPrintedName: "Synthetic Owner",
    signerTitle: "Owner",
    signerRole: "owner",
    ...overrides,
  };
}

function signupPayload(overrides = {}) {
  return {
    accountId: " UAD-REDTEAM-SFR-0001 ",
    authorization: authorization(),
    clientSubmissionId: randomUUID(),
    propertyTaxFileId: randomUUID(),
    signatureAttestation: true,
    signatureDataUrl: `data:image/png;base64,${Buffer.alloc(64, 1).toString("base64")}`,
    ...overrides,
  };
}

test("signup fields, full authorization, signature artifact, and workfile binding are normalized", () => {
  const normalized = normalizeSignupPayload(signupPayload());
  assert.equal(normalized.accountId, "UAD-REDTEAM-SFR-0001");
  assert.match(normalized.clientSubmissionId, /^[a-f0-9-]{36}$/);
  assert.match(normalized.propertyTaxFileId, /^[a-f0-9-]{36}$/);
  assert.equal(normalized.authorization.ownerName, "Synthetic Owner");
  assert.equal(normalized.authorization.ownerTelephone, "555-0100");
  assert.equal(normalized.authorization.listedProperties[0].accountNumber, "UAD-REDTEAM-SFR-0001");
  assert.equal(normalized.signaturePng.length, 64);

  assert.throws(() => normalizeSignupPayload([]), /invalid_signup_payload/);
  assert.throws(() => normalizeSignupPayload(signupPayload({ extra: true })), /invalid_signup_payload/);
  assert.throws(() => normalizeSignupPayload(signupPayload({ signatureAttestation: false })), /signature_attestation_required/);
  assert.throws(() => normalizeSignupPayload(signupPayload({ propertyTaxFileId: "not-a-uuid" })), /invalid_property_tax_file_id/);
  assert.throws(() => normalizeSignupPayload(signupPayload({ signatureDataUrl: "data:text/html;base64,AAAA" })), /invalid_signature_data/);
  assert.throws(
    () => normalizeSignupPayload(signupPayload({ authorization: authorization({ ownerName: "" }) })),
    /missing_owner_name/,
  );
  assert.throws(
    () => normalizeSignupPayload(signupPayload({ authorization: authorization({ signerRole: "administrator" }) })),
    /invalid_signer_role/,
  );
  assert.throws(
    () => normalizeSignupPayload(signupPayload({ authorization: authorization({ signatureDate: "2026-02-30" }) })),
    /invalid_signature_date/,
  );
});

test("signature verification rejects blank images and canonicalizes nonblank PNGs", async () => {
  const nonblank = await sharp({
    create: { width: 120, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  }).png().toBuffer();
  const verified = await verifySignupSignaturePng(nonblank);
  assert.equal(verified.width, 120);
  assert.equal(verified.height, 40);
  assert.match(verified.sha256, /^[a-f0-9]{64}$/);
  assert.equal(verified.content.subarray(1, 4).toString("ascii"), "PNG");

  const blank = await sharp({
    create: { width: 120, height: 40, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  }).png().toBuffer();
  await assert.rejects(() => verifySignupSignaturePng(blank), /signature_image_blank/);
});

test("the authorization digest binds account, workfile, form fields, and signature", () => {
  const payload = normalizeSignupPayload(signupPayload());
  const signature = "a".repeat(64);
  const baseline = signupAuthorizationSha256(payload, signature);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.notEqual(
    baseline,
    signupAuthorizationSha256({ ...payload, accountId: "DIFFERENT" }, signature),
  );
  assert.notEqual(baseline, signupAuthorizationSha256(payload, "b".repeat(64)));
});

test("signup request metadata ignores spoofable forwarding headers and caps text", () => {
  const headers = new Map([
    ["user-agent", "u".repeat(1_000)],
    ["referer", `https://example.invalid/${"r".repeat(3_000)}`],
    ["x-forwarded-for", "203.0.113.99"],
  ]);
  const metadata = signupRequestMetadata({
    ip: "192.0.2.10",
    get: (name) => headers.get(name),
  });
  assert.equal(metadata.ip, "192.0.2.10");
  assert.equal(metadata.userAgent.length, 512);
  assert.equal(metadata.referer.length, 2_048);
  assert.equal(signupRequestMetadata({ ip: "spoofed", get: () => null }).ip, null);
});

test("signup delivery status never contains provider diagnostics", () => {
  assert.equal(signupDeliveryStatus({ configured: false, sent: false }), "not_configured");
  assert.equal(signupDeliveryStatus({ configured: true, sent: false }), "failed");
  assert.equal(signupDeliveryStatus({ configured: true, sent: true }), "sent");
});

test("the public signup route uses its dedicated limiter and generic diagnostics", () => {
  const entrypoint = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/oldServer.js"), "utf8");
  const router = fs.readFileSync(
    path.join(TEST_DIRECTORY, "../src/modules/signup/router.js"),
    "utf8",
  );
  const migration = fs.readFileSync(
    path.join(TEST_DIRECTORY, "../migrations/20261009_signup_authorization_integrity.sql"),
    "utf8",
  );
  const migrationRunner = fs.readFileSync(
    path.join(TEST_DIRECTORY, "../src/database/mobileMigrations.js"),
    "utf8",
  );
  assert.match(entrypoint, /app\.use\(createSignupRouter\(\{ pool, signupRateLimiter \}\)\)/);
  assert.match(entrypoint, /signup_rate_limit_exceeded/);
  assert.match(router, /router\.post\("\/api\/signup\/email", signupRateLimiter,/);
  assert.match(router, /if \(!req\.mobileAuth\)/);
  assert.match(router, /authorizePropertyTaxFile\(pool, req\.mobileAuth,/);
  assert.match(router, /verifySignature\(payload\.signaturePng\)/);
  assert.match(router, /pending_manual_verification/);
  assert.match(router, /signupRequestMetadata\(req\)/);
  assert.doesNotMatch(router, /email_error:/);
  assert.doesNotMatch(router, /req\.headers\["x-forwarded-for"\]/);
  assert.doesNotMatch(router, /json\(\{ error: "email_failed", message:/);
  assert.match(migration, /verification_status text NOT NULL DEFAULT 'legacy_unverified'/);
  assert.match(migration, /pending_manual_verification/);
  assert.match(migration, /FOREIGN KEY \(property_tax_file_id\)/);
  assert.match(migration, /signups_submission_id_uidx/);
  assert.match(migrationRunner, /20261009_signup_authorization_integrity\.sql/);
});
