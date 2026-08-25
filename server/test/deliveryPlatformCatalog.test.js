import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGuidedDeliveryPlan,
  listDeliveryPlatforms,
  resolveDeliveryDestination,
} from "../src/modules/delivery/platformCatalog.js";

test("SPUR AMS resolves as the ValueLink family and recognizes AmeriMac", () => {
  const destination = resolveDeliveryDestination({
    portal_url: "https://amerimacamc.spurams.com/login.aspx",
  });
  assert.equal(destination.platform_key, "valuelink_spur");
  assert.equal(destination.tenant_key, "amerimac");
  assert.equal(destination.tenant_display_name, "AmeriMac Appraisal Management");
  assert.equal(destination.known_tenant, true);
  assert.equal(destination.automated_submission, false);
  assert.equal(destination.portal_url, "https://amerimacamc.spurams.com/login.aspx");
});

test("unknown SPUR tenants inherit the same adapter family", () => {
  const destination = resolveDeliveryDestination({
    portal_url: "https://future-amc.spurams.com/SignIn",
  });
  assert.equal(destination.platform_key, "valuelink_spur");
  assert.equal(destination.tenant_key, "future-amc");
  assert.equal(destination.known_tenant, false);
});

test("unrecognized HTTPS portals receive the universal manual fallback", () => {
  const destination = resolveDeliveryDestination({
    portal_url: "https://orders.example-lender.com/appraisals",
  });
  assert.equal(destination.platform_key, "generic_manual");
  assert.equal(destination.delivery_mode, "guided_manual");
});

test("portal resolver rejects insecure, credential-bearing, and tokenized URLs", () => {
  assert.throws(
    () => resolveDeliveryDestination({ portal_url: "http://amerimacamc.spurams.com" }),
    /delivery_portal_url_invalid/,
  );
  assert.throws(
    () => resolveDeliveryDestination({ portal_url: "https://user:secret@amerimacamc.spurams.com" }),
    /delivery_portal_url_invalid/,
  );
  assert.throws(
    () => resolveDeliveryDestination({ portal_url: "https://amerimacamc.spurams.com/?token=secret" }),
    /delivery_portal_url_invalid/,
  );
});

test("portal resolver rejects local, literal-address, alternate-port, and whitespace targets", () => {
  for (const portalUrl of [
    "https://127.0.0.1/login",
    "https://[::1]/login",
    "https://169.254.169.254/latest/meta-data",
    "https://portal.internal/login",
    "https://portal.local/login",
    "https://portal.home.arpa/login",
    "https://single-label/login",
    "https://orders.example.com:8443/login",
    "https://orders.example.com/line\nbreak",
  ]) {
    assert.throws(
      () => resolveDeliveryDestination({ portal_url: portalUrl }),
      /delivery_portal_url_invalid/,
      portalUrl,
    );
  }
});

test("explicit platform keys cannot disguise a different host", () => {
  assert.throws(
    () => resolveDeliveryDestination({
      platform_key: "valuelink_spur",
      portal_url: "https://orders.example.com",
    }),
    /delivery_platform_host_mismatch/,
  );
});

test("guided plan binds the portal to an immutable package identity", () => {
  const destination = {
    platform_key: "valuelink_spur",
    tenant_key: "amerimac",
    base_url: "https://amerimacamc.spurams.com/login.aspx",
    direct_integration: "partner_documentation_required",
  };
  const attempt = { external_order_id: "AM-10001" };
  const artifact = {
    id: "7f6cc02c-1959-4ea1-b301-32d76d4f2ba0",
    content_type: "application/zip",
    byte_size: 2048,
    checksum_sha256: "a".repeat(64),
    revision_number: 2,
  };
  const plan = buildGuidedDeliveryPlan({ destination, attempt, artifact });
  assert.equal(plan.platform_key, "valuelink_spur");
  assert.equal(plan.package.revision_number, 2);
  assert.equal(plan.package.checksum_sha256, "a".repeat(64));
  assert.equal(plan.steps.length, 6);
});

test("catalog exposes SPUR and a universal fallback without secrets", () => {
  const platforms = listDeliveryPlatforms();
  assert.ok(platforms.some((platform) => platform.key === "valuelink_spur"));
  assert.ok(platforms.some((platform) => platform.key === "generic_manual"));
  assert.equal(JSON.stringify(platforms).includes("password"), false);
  assert.equal(JSON.stringify(platforms).includes("api_key"), false);
});
