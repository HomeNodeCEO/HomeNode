import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { getUadMigrationManifest } from "../src/database/uadMigrations.js";
import { APPENDIX_H1_RULE_IDS } from "../src/modules/uad/appendixH.js";
import {
  buildUadOperationalReadiness,
  createCachedUadReadinessLoader,
  getUadOperationalReadiness,
} from "../src/modules/uad/uadOperationalReadiness.js";

const routerSource = fs.readFileSync(new URL("../src/modules/uad/router.js", import.meta.url), "utf8");

function readyDatabase(overrides = {}) {
  return {
    connected: true,
    ready: true,
    expected_migration_count: 40,
    applied_migration_count: 40,
    missing_migration_count: 0,
    checksum_mismatch_count: 0,
    latest_expected_migration: "20260925_appraisal_delivery_hub.sql",
    release_current: true,
    required_relation_count: 11,
    missing_relation_count: 0,
    appendix_h_version: "1.5",
    appendix_h_expected_rule_count: 728,
    appendix_h_cataloged_rule_count: 728,
    appendix_h_missing_rule_count: 0,
    appendix_h_unknown_rule_count: 0,
    appendix_h_reference_only_rule_count: 345,
    appendix_h_mapped_unverified_rule_count: 383,
    appendix_h_locally_verified_rule_count: 0,
    appendix_h_catalog_complete: true,
    appendix_h_local_gse_equivalence_complete: false,
    gse_equivalence_claimed: false,
    error_code: null,
    ...overrides,
  };
}

test("builds a credential-safe local-delivery readiness result", () => {
  const readiness = buildUadOperationalReadiness({
    enabled: true,
    storage: { provider: "r2", configured: true, bucket: "must-not-display" },
    verifier: {
      configured: true,
      issuer: "https://identity.private.example",
      audience: "private-audience",
    },
    compliance: {
      enabled: false,
      providers: {
        fannie: { enabled: false, configured: false, environment: "acpt", secret: "hidden" },
      },
    },
    database: readyDatabase(),
    checkedAt: "2026-08-21T12:00:00.000Z",
  });

  assert.equal(readiness.ok, true);
  assert.equal(readiness.local_delivery_ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.deepEqual(readiness.checks.object_storage, {
    provider: "r2",
    configured: true,
    ready: true,
  });
  assert.equal(readiness.checks.compliance.providers.fannie.ready, false);
  const serialized = JSON.stringify(readiness);
  assert.doesNotMatch(serialized, /must-not-display|identity\.private|private-audience|hidden/);
});

test("mounts readiness before the disabled-workspace guard", () => {
  const route = routerSource.indexOf('router.get("/readiness"');
  const guard = routerSource.indexOf("if (enabled) return next();");
  assert.ok(route > 0);
  assert.ok(guard > route);
  assert.match(routerSource, /cache-control", "no-store"/);
});

test("reports bounded blocker codes without leaking database errors", () => {
  const readiness = buildUadOperationalReadiness({
    enabled: false,
    storage: { provider: "r2", configured: false },
    verifier: { configured: false },
    compliance: { enabled: false, providers: {} },
    database: readyDatabase({
      connected: false,
      ready: false,
      applied_migration_count: 0,
      missing_migration_count: 40,
      release_current: false,
      missing_relation_count: 10,
      error_code: "uad_database_connection_failed",
    }),
  });

  assert.equal(readiness.ok, false);
  assert.deepEqual(readiness.blockers, [
    "uad_workspace_disabled",
    "uad_database_unavailable",
    "uad_migrations_incomplete",
    "uad_release_not_current",
    "uad_relations_missing",
    "uad_object_storage_not_configured",
    "uad_oidc_not_configured",
  ]);
});

test("strict red-team readiness refuses incomplete security enforcement", () => {
  const readiness = buildUadOperationalReadiness({
    enabled: true,
    storage: { provider: "r2", configured: true },
    verifier: { configured: true },
    compliance: { enabled: false, providers: {} },
    database: readyDatabase(),
    security: {
      strict: true,
      authenticationRequired: false,
      corsRestricted: false,
      rateLimitEnabled: false,
    },
  });
  assert.equal(readiness.ok, false);
  assert.deepEqual(readiness.blockers, [
    "uad_authentication_not_enforced",
    "uad_cors_not_restricted",
    "uad_rate_limit_not_enforced",
  ]);
  assert.equal(readiness.checks.security.ready, false);

  const secured = buildUadOperationalReadiness({
    enabled: true,
    storage: { provider: "r2", configured: true },
    verifier: { configured: true },
    compliance: { enabled: false, providers: {} },
    database: readyDatabase(),
    security: {
      strict: true,
      authenticationRequired: true,
      corsRestricted: true,
      rateLimitEnabled: true,
    },
  });
  assert.equal(secured.ok, true);
  assert.equal(secured.checks.security.ready, true);
});

test("checks applied migration checksums, current release, and required relations", async () => {
  const manifest = await getUadMigrationManifest();
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql === "SELECT 1 AS ok") return { rows: [{ ok: 1 }] };
      if (sql.includes("app.schema_migrations")) return { rows: manifest };
      if (sql.includes("uad_ref.specification_releases")) return { rows: [{ release_current: true }] };
      if (sql.includes("to_regclass")) return { rows: [{ missing_count: 0 }] };
      if (sql.includes("uad_ref.compliance_rules")) return {
        rows: APPENDIX_H1_RULE_IDS.map((rule_id) => ({ rule_id, local_evaluation_status: "reference_only" })),
      };
      throw new Error("unexpected query");
    },
  };

  const readiness = await getUadOperationalReadiness(pool, {
    enabled: true,
    storage: { provider: "r2", configured: true },
    verifier: { configured: true },
    compliance: { enabled: false, providers: {} },
  });

  assert.equal(readiness.ok, true);
  assert.equal(readiness.checks.database.expected_migration_count, manifest.length);
  assert.equal(readiness.checks.database.applied_migration_count, manifest.length);
  assert.equal(queries.length, 5);
  assert.equal(readiness.checks.database.appendix_h_catalog_complete, true);
});

test("maps schema-query failures to a stable public error code", async () => {
  let queryNumber = 0;
  const pool = {
    async query() {
      queryNumber += 1;
      if (queryNumber === 1) return { rows: [{ ok: 1 }] };
      throw new Error("sensitive-internal-database-diagnostic");
    },
  };
  const readiness = await getUadOperationalReadiness(pool, {
    enabled: true,
    storage: { provider: "r2", configured: true },
    verifier: { configured: true },
    compliance: { enabled: false, providers: {} },
  });

  assert.equal(readiness.ok, false);
  assert.equal(readiness.checks.database.error_code, "uad_database_schema_unavailable");
  assert.doesNotMatch(JSON.stringify(readiness), /sensitive|internal-database-diagnostic/);
});

test("coalesces concurrent public readiness probes and caches the result briefly", async () => {
  const manifest = await getUadMigrationManifest();
  let queries = 0;
  let currentTime = 1_000;
  const pool = {
    async query(sql) {
      queries += 1;
      if (sql === "SELECT 1 AS ok") return { rows: [{ ok: 1 }] };
      if (sql.includes("app.schema_migrations")) return { rows: manifest };
      if (sql.includes("uad_ref.specification_releases")) return { rows: [{ release_current: true }] };
      if (sql.includes("to_regclass")) return { rows: [{ missing_count: 0 }] };
      return { rows: APPENDIX_H1_RULE_IDS.map((rule_id) => ({
        rule_id,
        local_evaluation_status: "reference_only",
      })) };
    },
  };
  const load = createCachedUadReadinessLoader(pool, {
    enabled: true,
    storage: { configured: true, provider: "r2" },
    verifier: { configured: true },
    compliance: { enabled: false, providers: {} },
  }, { cacheMilliseconds: 1_000, now: () => currentTime });

  const [first, concurrent] = await Promise.all([load(), load()]);
  assert.equal(first, concurrent);
  assert.equal(queries, 5);
  assert.equal(await load(), first);
  assert.equal(queries, 5);
  currentTime += 1_001;
  await load();
  assert.equal(queries, 10);
});

test("fails closed when the current Appendix H catalog is incomplete", () => {
  const readiness = buildUadOperationalReadiness({
    enabled: true,
    storage: { provider: "r2", configured: true },
    verifier: { configured: true },
    compliance: { enabled: false, providers: {} },
    database: readyDatabase({
      ready: false,
      appendix_h_cataloged_rule_count: 727,
      appendix_h_missing_rule_count: 1,
      appendix_h_catalog_complete: false,
    }),
  });
  assert.equal(readiness.ok, false);
  assert.ok(readiness.blockers.includes("uad_appendix_h_catalog_incomplete"));
});
