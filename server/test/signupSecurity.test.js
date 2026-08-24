import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizeSignupPayload,
  signupDeliveryStatus,
  signupRequestMetadata,
} from "../src/security/signupSecurity.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

test("signup fields are normalized and bounded before storage or delivery", () => {
  assert.deepEqual(normalizeSignupPayload({
    accountId: " UAD-REDTEAM-SFR-0001 ",
    ownerEmail: " synthetic@example.invalid ",
    ownerName: " Synthetic Owner ",
    ownerTelephone: " 555-0100 ",
  }), {
    accountId: "UAD-REDTEAM-SFR-0001",
    ownerEmail: "synthetic@example.invalid",
    ownerName: "Synthetic Owner",
    ownerTelephone: "555-0100",
  });
  assert.throws(() => normalizeSignupPayload([]), /invalid_signup_payload/);
  assert.throws(() => normalizeSignupPayload({ ownerName: "", ownerTelephone: "555" }), /missing_owner_name/);
  assert.throws(() => normalizeSignupPayload({ ownerName: "Owner", ownerTelephone: { value: "555" } }), /invalid_owner_telephone/);
  assert.throws(() => normalizeSignupPayload({ ownerName: "Owner\r\nBcc: attacker", ownerTelephone: "555" }), /invalid_owner_name/);
  assert.throws(() => normalizeSignupPayload({ ownerName: "Owner", ownerTelephone: "555", accountId: "x".repeat(129) }), /invalid_account_id/);
  assert.throws(() => normalizeSignupPayload({ ownerName: "Owner", ownerTelephone: "555", ownerEmail: "invalid" }), /invalid_owner_email/);
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
  const source = fs.readFileSync(path.join(TEST_DIRECTORY, "../src/oldServer.js"), "utf8");
  assert.match(source, /app\.post\("\/api\/signup\/email", signupRateLimiter,/);
  assert.match(source, /signup_rate_limit_exceeded/);
  assert.match(source, /signupRequestMetadata\(req\)/);
  assert.doesNotMatch(source, /email_error:/);
  assert.doesNotMatch(source, /req\.headers\["x-forwarded-for"\]/);
  assert.doesNotMatch(source, /json\(\{ error: "email_failed", message:/);
});
