import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertRedTeamDatabaseName,
  assertRedTeamFixtureAccountId,
  createRedTeamIsolationConfiguration,
  verifyRedTeamSyntheticBoundary,
} from "../src/security/redTeamIsolation.js";

const serverSource = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");
const redTeamBaseSource = fs.readFileSync(new URL("../scripts/prepareRedteamBaseDatabase.js", import.meta.url), "utf8");
const mobileMigrationSource = fs.readFileSync(new URL("../src/database/mobileMigrations.js", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function safeEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    HOMENODE_DEPLOYMENT_ENVIRONMENT: "redteam",
    REDTEAM_ISOLATION_STRICT: "true",
    REDTEAM_DATA_CLASSIFICATION: "synthetic_only",
    UAD_SECURITY_STRICT: "true",
    UAD_AUTHENTICATION_REQUIRED: "true",
    UAD_RATE_LIMIT_ENABLED: "true",
    UAD_WORKSPACE_ENABLED: "true",
    MOBILE_INSPECTION_ENABLED: "true",
    CORS_ORIGIN: "https://homenode-uad-redteam.onrender.com",
    DATABASE_URL: "postgresql://user:secret@redteam-db.invalid/homenode_redteam",
    R2_BUCKET: "homenode-uad-redteam",
    R2_ACCOUNT_ID: "synthetic-account",
    R2_ACCESS_KEY_ID: "bucket-scoped-key",
    R2_SECRET_ACCESS_KEY: "bucket-scoped-secret",
    OIDC_ISSUER: "https://identity.example.com/",
    OIDC_AUDIENCE: "homenode-redteam-api",
    OIDC_JWKS_URI: "https://identity.example.com/jwks",
    DOCUMENT_OCR_PROVIDER: "disabled",
    UAD_COMPLIANCE_API_ENABLED: "false",
    FANNIE_UAD_COMPLIANCE_ENABLED: "false",
    FREDDIE_UAD_COMPLIANCE_ENABLED: "false",
    TRESTLE_ENABLED: "false",
    TRESTLE_REPLICATION_ENABLED: "false",
    TRESTLE_MEDIA_ENABLED: "false",
    LOCATION_BACKFILL_ENABLED: "false",
    CENSUS_GEOGRAPHY_ENABLED: "false",
    ...overrides,
  };
}

test("ordinary deployments do not activate the red-team boundary", () => {
  assert.deepEqual(createRedTeamIsolationConfiguration({}), {
    enabled: false,
    ready: false,
    external_status_enabled: true,
  });
});

test("accepts a fully isolated synthetic red-team configuration", () => {
  assert.deepEqual(createRedTeamIsolationConfiguration(safeEnvironment()), {
    enabled: true,
    ready: true,
    synthetic_only: true,
    external_status_enabled: false,
  });
  assert.equal(assertRedTeamDatabaseName("homenode_redteam"), "homenode_redteam");
  assert.equal(assertRedTeamFixtureAccountId("UAD-REDTEAM-SFR-0001"), "UAD-REDTEAM-SFR-0001");
});

test("accepts an explicitly disabled UAD workspace for kill-switch operation", () => {
  assert.deepEqual(createRedTeamIsolationConfiguration(safeEnvironment({
    UAD_WORKSPACE_ENABLED: "false",
  })), {
    enabled: true,
    ready: true,
    synthetic_only: true,
    external_status_enabled: false,
  });
});

test("rejects a missing or malformed UAD workspace switch", () => {
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    UAD_WORKSPACE_ENABLED: "",
  })), /workspace_switch_explicit/);
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    UAD_WORKSPACE_ENABLED: "sometimes",
  })), /workspace_switch_explicit/);
});

test("rejects fixture accounts outside the red-team namespace", () => {
  assert.throws(() => assertRedTeamFixtureAccountId("UAD-STAGING-SFR-0001"), /redteam_fixture_account_invalid/);
  assert.throws(() => assertRedTeamFixtureAccountId("100 Test Subject Dr"), /redteam_fixture_account_invalid/);
});

test("accepts a dedicated WorkOS application with a generated client audience", () => {
  assert.deepEqual(createRedTeamIsolationConfiguration(safeEnvironment({
    REDTEAM_OIDC_PROVIDER: "workos_authkit",
    REDTEAM_OIDC_APPLICATION_ID: "app_01REDTEAMBOUNDARY",
    REDTEAM_OIDC_APPLICATION_NAME: "HomeNode UAD Red Team",
    REDTEAM_OIDC_CLIENT_ID: "client_01REDTEAMBOUNDARY",
    OIDC_ISSUER: "https://redteam-staging.authkit.app/",
    OIDC_AUDIENCE: "client_01REDTEAMBOUNDARY",
    OIDC_JWKS_URI: "https://redteam-staging.authkit.app/oauth2/jwks",
  })), {
    enabled: true,
    ready: true,
    synthetic_only: true,
    external_status_enabled: false,
  });
});

test("rejects an incomplete or cross-origin WorkOS application boundary", () => {
  const workosEnvironment = {
    REDTEAM_OIDC_PROVIDER: "workos_authkit",
    REDTEAM_OIDC_APPLICATION_ID: "app_01REDTEAMBOUNDARY",
    REDTEAM_OIDC_APPLICATION_NAME: "HomeNode UAD Red Team",
    REDTEAM_OIDC_CLIENT_ID: "client_01REDTEAMBOUNDARY",
    OIDC_ISSUER: "https://redteam-staging.authkit.app/",
    OIDC_AUDIENCE: "client_01REDTEAMBOUNDARY",
    OIDC_JWKS_URI: "https://redteam-staging.authkit.app/oauth2/jwks",
  };
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    ...workosEnvironment,
    REDTEAM_OIDC_APPLICATION_NAME: "HomeNode Production",
  })), /oidc_audience_marker/);
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    ...workosEnvironment,
    REDTEAM_OIDC_CLIENT_ID: "client_01DIFFERENT",
  })), /oidc_audience_marker/);
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    ...workosEnvironment,
    OIDC_JWKS_URI: "https://shared.example.com/oauth2/jwks",
  })), /oidc_audience_marker/);
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    ...workosEnvironment,
    OIDC_JWKS_URI: "https://redteam-staging.authkit.app/other/jwks",
  })), /oidc_audience_marker/);
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    ...workosEnvironment,
    OIDC_ISSUER: "https://redteam-staging.authkit.app/shared",
  })), /oidc_audience_marker/);
});

test("rejects production-shaped database, storage, origin, and OIDC boundaries", () => {
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    DATABASE_URL: "postgresql://user:secret@prod.invalid/homenodedb",
    R2_BUCKET: "homenode-uad-production",
    CORS_ORIGIN: "https://homenode.onrender.com",
    OIDC_AUDIENCE: "homenode-production-api",
  })), /database_marker.*r2_bucket_marker.*cors_redteam_origin.*oidc_audience_marker/);
  assert.throws(() => assertRedTeamDatabaseName("homenodedb"), /redteam_database_identity_mismatch/);
});

test("rejects live provider flags or credentials even when another flag is off", () => {
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    TRESTLE_ENABLED: "true",
    TRESTLE_CLIENT_SECRET: "must-never-be-copied",
    DOCUMENT_OCR_PROVIDER: "azure",
    SMTP_HOST: "smtp.production.example",
  })), /document_ocr_disabled.*trestle_enabled_disabled.*trestle_client_secret_absent.*smtp_host_absent/);
});

test("rejects insecure or malformed OIDC boundaries before migration", () => {
  assert.throws(() => createRedTeamIsolationConfiguration(safeEnvironment({
    OIDC_ISSUER: "http://identity.example.com/",
    OIDC_JWKS_URI: "not-a-url",
  })), /oidc_issuer_https.*oidc_jwks_https/);
});

test("server startup evaluates isolation before database construction", () => {
  const isolation = serverSource.indexOf("createRedTeamIsolationConfiguration()");
  const databasePool = serverSource.indexOf("new pg.Pool");
  assert.ok(isolation > 0);
  assert.ok(databasePool > isolation);
});

test("red-team startup bootstraps the guarded synthetic base before migrations", () => {
  assert.equal(
    packageJson.scripts["start:redteam:uad"],
    "npm run verify:redteam:isolation && npm run prepare:redteam:base && npm run migrate:uad && npm run migrate:mobile && npm run prepare:redteam:uad && npm start",
  );
  const isolation = redTeamBaseSource.indexOf("createRedTeamIsolationConfiguration()");
  const databasePool = redTeamBaseSource.indexOf("new pg.Pool");
  const databaseAssertion = redTeamBaseSource.indexOf("assertRedTeamDatabaseName(identity");
  const syntheticBoundary = redTeamBaseSource.indexOf("verifyRedTeamSyntheticBoundary(pool)");
  const schemaMutation = redTeamBaseSource.indexOf("CREATE SCHEMA IF NOT EXISTS core");
  assert.ok(isolation > 0);
  assert.ok(databasePool > isolation);
  assert.ok(databaseAssertion > 0 && databaseAssertion < schemaMutation);
  assert.ok(syntheticBoundary > databasePool && syntheticBoundary < schemaMutation);
});

test("fresh databases create assignment files before dependent mobile tables", () => {
  const assignmentFiles = mobileMigrationSource.indexOf('"005_assignment_files.sql"');
  const mobileFoundation = mobileMigrationSource.indexOf('"20260821_mobile_foundation.sql"');
  assert.ok(assignmentFiles > 0 && assignmentFiles < mobileFoundation);
});

test("database boundary accepts only explicitly synthetic protected records", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("to_regclass")) {
        return { rows: [
          { relation_name: "app_auth.organizations", available: true },
          { relation_name: "app_auth.users", available: true },
          { relation_name: "core.accounts", available: true },
          { relation_name: "appraisal.uad_workfiles", available: true },
          { relation_name: "app.report_files", available: true },
        ] };
      }
      return { rows: [{ count: 0 }] };
    },
  };
  assert.deepEqual(await verifyRedTeamSyntheticBoundary(pool), {
    checked: true,
    relation_count: 5,
    synthetic_only: true,
  });
});

test("database boundary blocks a non-synthetic record before migration", async () => {
  const pool = {
    async query(sql) {
      if (sql.includes("to_regclass")) {
        return { rows: [{ relation_name: "core.accounts", available: true }] };
      }
      return { rows: [{ count: 1 }] };
    },
  };
  await assert.rejects(
    verifyRedTeamSyntheticBoundary(pool),
    /redteam_database_contains_nonsynthetic_records/,
  );
});
