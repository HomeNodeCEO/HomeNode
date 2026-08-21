import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  assertRedTeamDatabaseName,
  createRedTeamIsolationConfiguration,
  verifyRedTeamSyntheticBoundary,
} from "../src/security/redTeamIsolation.js";

const serverSource = fs.readFileSync(new URL("../src/oldServer.js", import.meta.url), "utf8");

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
