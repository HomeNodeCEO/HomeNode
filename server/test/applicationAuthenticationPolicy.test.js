import assert from "node:assert/strict";
import test from "node:test";

import {
  applicationAuthenticationOperationalState,
  assertApplicationAuthenticationStartup,
  createApplicationAuthenticationPolicy,
} from "../src/security/applicationAuthenticationPolicy.js";

const NOW = () => new Date("2026-09-01T12:00:00.000Z");
const COMPLETE_WORKOS = Object.freeze({
  OIDC_CLIENT_ID: "mobile-client-id",
  OIDC_WEB_CLIENT_ID: "client-id",
  OIDC_WEB_CLIENT_SECRET: "client-secret",
  OIDC_WEB_REDIRECT_URI: "https://api.example.test/api/auth/callback",
  WEB_APP_URL: "https://app.example.test",
  APP_SESSION_SECRET: "s".repeat(32),
  APP_SIGNING_SECRET: "g".repeat(32),
});
const COMPLETE_REDTEAM_BEARER = Object.freeze({
  HOMENODE_DEPLOYMENT_ENVIRONMENT: "redteam",
  REDTEAM_ISOLATION_STRICT: "true",
  REDTEAM_DATA_CLASSIFICATION: "synthetic_only",
  UAD_SECURITY_STRICT: "true",
  UAD_AUTHENTICATION_REQUIRED: "true",
  APPLICATION_AUTHENTICATION_REQUIRED: "true",
  APPLICATION_AUTHENTICATION_BEARER_ONLY: "true",
  OIDC_ISSUER: "https://identity-redteam.example.invalid/",
  OIDC_AUDIENCE: "homenode-redteam-api",
  OIDC_JWKS_URI: "https://keys.example.invalid/redteam-jwks.json",
});

function production(overrides = {}) {
  return { NODE_ENV: "production", ...overrides };
}

test("production rejects a missing, blank, or invalid authentication setting", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.throws(
      () => createApplicationAuthenticationPolicy(production({
        APPLICATION_AUTHENTICATION_REQUIRED: value,
      }), { now: NOW }),
      { message: "application_authentication_setting_required" },
    );
  }
  for (const value of ["flase", "tru", "TRUE", "1", "yes", "enabled", " true "]) {
    assert.throws(
      () => createApplicationAuthenticationPolicy(production({
        APPLICATION_AUTHENTICATION_REQUIRED: value,
      }), { now: NOW }),
      { message: "application_authentication_setting_invalid" },
    );
  }
});

test("production rollout mode requires a strict, valid, future ISO date", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.throws(
      () => createApplicationAuthenticationPolicy(production({
        APPLICATION_AUTHENTICATION_REQUIRED: "false",
        LEGACY_AUTH_ROLLOUT_UNTIL: value,
      }), { now: NOW }),
      { message: "legacy_auth_rollout_until_required" },
    );
  }
  for (const value of [
    "09/30/2026",
    "2026-9-30",
    "2026-02-29",
    "2026-09-31",
    " 2026-09-30 ",
    "later",
  ]) {
    assert.throws(
      () => createApplicationAuthenticationPolicy(production({
        APPLICATION_AUTHENTICATION_REQUIRED: "false",
        LEGACY_AUTH_ROLLOUT_UNTIL: value,
      }), { now: NOW }),
      { message: "legacy_auth_rollout_until_invalid" },
    );
  }
  for (const value of ["2026-08-31", "2026-09-01"]) {
    assert.throws(
      () => createApplicationAuthenticationPolicy(production({
        APPLICATION_AUTHENTICATION_REQUIRED: "false",
        LEGACY_AUTH_ROLLOUT_UNTIL: value,
      }), { now: NOW }),
      { message: "legacy_auth_rollout_expired" },
    );
  }
});

test("production false with a future date enters temporary rollout mode", () => {
  const authenticationPolicy = createApplicationAuthenticationPolicy(production({
    APPLICATION_AUTHENTICATION_REQUIRED: "false",
    LEGACY_AUTH_ROLLOUT_UNTIL: "2026-09-30",
  }), { now: NOW });
  assert.deepEqual(authenticationPolicy, {
    mode: "production_rollout",
    authenticationRequired: false,
    legacyRolloutUntil: "2026-09-30",
  });
  assert.equal(Object.isFrozen(authenticationPolicy), true);
  assert.equal(
    assertApplicationAuthenticationStartup({ authenticationPolicy, environment: {} }),
    authenticationPolicy,
  );
});

test("production true with complete WorkOS configuration enters enforced mode", () => {
  const environment = production({
    ...COMPLETE_WORKOS,
    APPLICATION_AUTHENTICATION_REQUIRED: "true",
  });
  const authenticationPolicy = createApplicationAuthenticationPolicy(environment, { now: NOW });
  assert.deepEqual(authenticationPolicy, {
    mode: "enforced",
    authenticationRequired: true,
    legacyRolloutUntil: null,
  });
  assert.equal(assertApplicationAuthenticationStartup({
    authenticationPolicy,
    environment,
    webOidcConfigured: true,
  }), authenticationPolicy);
});

test("production true fails startup for incomplete WorkOS configuration", () => {
  const authenticationPolicy = createApplicationAuthenticationPolicy(production({
    APPLICATION_AUTHENTICATION_REQUIRED: "true",
  }), { now: NOW });
  const requiredValues = [
    "OIDC_CLIENT_ID",
    "OIDC_WEB_CLIENT_ID",
    "OIDC_WEB_CLIENT_SECRET",
    "OIDC_WEB_REDIRECT_URI",
    "WEB_APP_URL",
    "APP_SESSION_SECRET",
    "APP_SIGNING_SECRET",
  ];
  for (const missing of requiredValues) {
    const environment = { ...COMPLETE_WORKOS, [missing]: "" };
    assert.throws(
      () => assertApplicationAuthenticationStartup({
        authenticationPolicy,
        environment,
        webOidcConfigured: true,
      }),
      { message: "application_authentication_required_but_not_configured" },
      missing,
    );
  }
  assert.throws(
    () => assertApplicationAuthenticationStartup({
      authenticationPolicy,
      environment: COMPLETE_WORKOS,
      webOidcConfigured: false,
    }),
    { message: "application_authentication_required_but_not_configured" },
  );
});

test("strict synthetic red-team deployments may enforce bearer-only authentication", () => {
  const environment = production(COMPLETE_REDTEAM_BEARER);
  const authenticationPolicy = createApplicationAuthenticationPolicy(environment, { now: NOW });
  assert.equal(assertApplicationAuthenticationStartup({
    authenticationPolicy,
    environment,
    webOidcConfigured: false,
  }), authenticationPolicy);
});

test("bearer-only authentication is rejected outside the complete red-team boundary", () => {
  const authenticationPolicy = createApplicationAuthenticationPolicy(production({
    APPLICATION_AUTHENTICATION_REQUIRED: "true",
  }), { now: NOW });
  for (const missing of [
    "HOMENODE_DEPLOYMENT_ENVIRONMENT",
    "REDTEAM_ISOLATION_STRICT",
    "REDTEAM_DATA_CLASSIFICATION",
    "UAD_SECURITY_STRICT",
    "UAD_AUTHENTICATION_REQUIRED",
    "APPLICATION_AUTHENTICATION_BEARER_ONLY",
    "OIDC_ISSUER",
    "OIDC_AUDIENCE",
    "OIDC_JWKS_URI",
  ]) {
    assert.throws(
      () => assertApplicationAuthenticationStartup({
        authenticationPolicy,
        environment: production({ ...COMPLETE_REDTEAM_BEARER, [missing]: "" }),
        webOidcConfigured: false,
      }),
      { message: "application_authentication_required_but_not_configured" },
      missing,
    );
  }
  assert.throws(
    () => assertApplicationAuthenticationStartup({
      authenticationPolicy,
      environment: production({
        ...COMPLETE_REDTEAM_BEARER,
        HOMENODE_DEPLOYMENT_ENVIRONMENT: "production",
      }),
      webOidcConfigured: false,
    }),
    { message: "application_authentication_required_but_not_configured" },
  );
});

test("development and tests retain the existing missing-value behavior", () => {
  assert.deepEqual(createApplicationAuthenticationPolicy({}, { now: NOW }), {
    mode: "development_legacy",
    authenticationRequired: false,
    legacyRolloutUntil: null,
  });
  assert.equal(createApplicationAuthenticationPolicy({
    NODE_ENV: "development",
    APPLICATION_AUTHENTICATION_REQUIRED: "TRUE",
  }, { now: NOW }).authenticationRequired, true);
  assert.equal(createApplicationAuthenticationPolicy({
    NODE_ENV: "test",
    APPLICATION_AUTHENTICATION_REQUIRED: "flase",
  }, { now: NOW }).authenticationRequired, false);
});

test("operational state exposes stable rollout warnings without configuration values", () => {
  const authenticationPolicy = createApplicationAuthenticationPolicy(production({
    APPLICATION_AUTHENTICATION_REQUIRED: "false",
    LEGACY_AUTH_ROLLOUT_UNTIL: "2026-09-10",
  }), { now: NOW });
  assert.deepEqual(applicationAuthenticationOperationalState(authenticationPolicy, { now: NOW }), {
    status: "degraded",
    mode: "production_rollout",
    warnings: ["legacy_auth_rollout_active"],
  });
  assert.deepEqual(applicationAuthenticationOperationalState(authenticationPolicy, {
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  }), {
    status: "degraded",
    mode: "production_rollout",
    warnings: ["legacy_auth_rollout_active", "legacy_auth_rollout_expiring"],
  });
  assert.deepEqual(applicationAuthenticationOperationalState(authenticationPolicy, {
    now: () => new Date("2026-09-11T00:00:00.000Z"),
  }), {
    status: "degraded",
    mode: "production_rollout",
    warnings: ["legacy_auth_rollout_active", "legacy_auth_rollout_expired"],
  });
  assert.doesNotMatch(
    JSON.stringify(applicationAuthenticationOperationalState(authenticationPolicy, { now: NOW })),
    /2026|client|secret/i,
  );
});
