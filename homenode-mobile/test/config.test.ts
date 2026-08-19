import assert from "node:assert/strict";
import test from "node:test";

import { createMobileConfig } from "../src/config";
import { propertySearchPath } from "../src/api/client";

test("builds a secret-free managed OIDC configuration", () => {
  const config = createMobileConfig({
    EXPO_PUBLIC_API_BASE_URL: "https://api.homenode.test/",
    EXPO_PUBLIC_OIDC_ISSUER: "https://homenode.authkit.app/",
    EXPO_PUBLIC_OIDC_CLIENT_ID: "client_123ABC",
  });
  assert.equal(config.apiBaseUrl, "https://api.homenode.test");
  assert.equal(config.oidcIssuer, "https://homenode.authkit.app");
  assert.equal(config.redirectUri, "homenode://oauth/callback");
  assert.equal("clientSecret" in config, false);
});

test("rejects insecure remote endpoints while allowing emulator loopback", () => {
  assert.throws(() => createMobileConfig({
    EXPO_PUBLIC_API_BASE_URL: "http://api.homenode.test",
    EXPO_PUBLIC_OIDC_ISSUER: "https://homenode.authkit.app",
    EXPO_PUBLIC_OIDC_CLIENT_ID: "client_123",
  }), /api_base_url_must_use_https/);
  assert.equal(createMobileConfig({
    EXPO_PUBLIC_API_BASE_URL: "http://10.0.2.2:8787",
    EXPO_PUBLIC_OIDC_ISSUER: "https://homenode.authkit.app",
    EXPO_PUBLIC_OIDC_CLIENT_ID: "client_123",
  }).apiBaseUrl, "http://10.0.2.2:8787");
});

test("accepts the legacy WorkOS client variable during the transition", () => {
  const config = createMobileConfig({
    EXPO_PUBLIC_API_BASE_URL: "https://api.homenode.test",
    EXPO_PUBLIC_OIDC_ISSUER: "https://homenode.authkit.app",
    EXPO_PUBLIC_WORKOS_CLIENT_ID: "client_legacy123",
  });
  assert.equal(config.clientId, "client_legacy123");
});

test("rejects an unsafe or missing public OIDC client identifier", () => {
  const base = {
    EXPO_PUBLIC_API_BASE_URL: "https://api.homenode.test",
    EXPO_PUBLIC_OIDC_ISSUER: "https://homenode.authkit.app",
  };
  assert.throws(() => createMobileConfig(base), /oidc_client_id_required/);
  assert.throws(() => createMobileConfig({ ...base, EXPO_PUBLIC_OIDC_CLIENT_ID: "client id?secret=1" }), /oidc_client_id_required/);
});

test("encodes property-search input", () => {
  assert.equal(propertySearchPath("100 Test & Main"), "/api/mobile/properties/search?q=100+Test+%26+Main&limit=20");
});
