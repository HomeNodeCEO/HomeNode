import { getUadMigrationManifest } from "../../database/uadMigrations.js";
import {
  APPENDIX_H1_MANIFEST,
  APPENDIX_H1_RULE_IDS,
  buildAppendixH1Coverage,
} from "./appendixH.js";
import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";

const REQUIRED_RELATIONS = Object.freeze([
  "appraisal.uad_workfiles",
  "appraisal.uad_field_values",
  "appraisal.uad_validation_runs",
  "appraisal.uad_assets",
  "appraisal.uad_generated_artifacts",
  "appraisal.uad_signatures",
  "appraisal.uad_compliance_exchanges",
  "appraisal.delivery_destinations",
  "appraisal.delivery_attempts",
  "uad_ref.fields",
  "uad_ref.compliance_rule_source_manifests",
]);

function providerReadiness(compliance, localDeliveryReady) {
  return Object.fromEntries(Object.entries(compliance?.providers || {}).map(([key, provider]) => [
    key,
    Object.freeze({
      enabled: Boolean(compliance?.enabled && provider?.enabled),
      configured: Boolean(compliance?.enabled && provider?.configured),
      environment: provider?.environment || null,
      ready: Boolean(localDeliveryReady && compliance?.enabled && provider?.configured),
    }),
  ]));
}

export function buildUadOperationalReadiness({
  enabled,
  storage,
  verifier,
  compliance,
  database,
  security = {},
  checkedAt = new Date().toISOString(),
}) {
  const blockers = [];
  if (!enabled) blockers.push("uad_workspace_disabled");
  if (!database.connected) blockers.push("uad_database_unavailable");
  if (database.missing_migration_count > 0) blockers.push("uad_migrations_incomplete");
  if (database.checksum_mismatch_count > 0) blockers.push("uad_migration_checksum_mismatch");
  if (!database.release_current) blockers.push("uad_release_not_current");
  if (database.missing_relation_count > 0) blockers.push("uad_relations_missing");
  if (!database.appendix_h_catalog_complete) blockers.push("uad_appendix_h_catalog_incomplete");
  if (!storage?.configured) blockers.push("uad_object_storage_not_configured");
  if (!verifier?.configured) blockers.push("uad_oidc_not_configured");
  if (security.strict && !security.authenticationRequired) {
    blockers.push("uad_authentication_not_enforced");
  }
  if (security.strict && !security.corsRestricted) blockers.push("uad_cors_not_restricted");
  if (security.strict && !security.rateLimitEnabled) blockers.push("uad_rate_limit_not_enforced");

  const localDeliveryReady = blockers.length === 0;
  const providers = providerReadiness(compliance, localDeliveryReady);
  return Object.freeze({
    ok: localDeliveryReady,
    status: localDeliveryReady ? "ready" : "degraded",
    checked_at: checkedAt,
    specification_release_key: CURRENT_UAD_RELEASE_KEY,
    local_delivery_ready: localDeliveryReady,
    blockers,
    checks: Object.freeze({
      workspace: Object.freeze({ enabled: Boolean(enabled), ready: Boolean(enabled) }),
      database: Object.freeze(database),
      object_storage: Object.freeze({
        provider: storage?.provider || null,
        configured: Boolean(storage?.configured),
        ready: Boolean(storage?.configured),
      }),
      oidc: Object.freeze({
        configured: Boolean(verifier?.configured),
        ready: Boolean(verifier?.configured),
      }),
      security: Object.freeze({
        strict: Boolean(security.strict),
        authentication_required: Boolean(security.authenticationRequired),
        cors_restricted: Boolean(security.corsRestricted),
        rate_limit_enabled: Boolean(security.rateLimitEnabled),
        ready: !security.strict || Boolean(
          security.authenticationRequired
          && security.corsRestricted
          && security.rateLimitEnabled
        ),
      }),
      compliance: Object.freeze({
        enabled: Boolean(compliance?.enabled),
        providers: Object.freeze(providers),
      }),
    }),
  });
}

export async function getUadOperationalReadiness(pool, options = {}) {
  const manifest = await getUadMigrationManifest();
  const expectedByName = new Map(manifest.map((item) => [item.migration_name, item.checksum_sha256]));
  const database = {
    connected: false,
    ready: false,
    expected_migration_count: manifest.length,
    applied_migration_count: 0,
    missing_migration_count: manifest.length,
    checksum_mismatch_count: 0,
    latest_expected_migration: manifest.at(-1)?.migration_name || null,
    release_current: false,
    required_relation_count: REQUIRED_RELATIONS.length,
    missing_relation_count: REQUIRED_RELATIONS.length,
    appendix_h_version: APPENDIX_H1_MANIFEST.version,
    appendix_h_expected_rule_count: APPENDIX_H1_MANIFEST.active_rule_count,
    appendix_h_cataloged_rule_count: 0,
    appendix_h_missing_rule_count: APPENDIX_H1_MANIFEST.active_rule_count,
    appendix_h_unknown_rule_count: 0,
    appendix_h_reference_only_rule_count: 0,
    appendix_h_mapped_unverified_rule_count: 0,
    appendix_h_locally_verified_rule_count: 0,
    appendix_h_catalog_complete: false,
    appendix_h_local_gse_equivalence_complete: false,
    gse_equivalence_claimed: false,
    error_code: null,
  };

  try {
    await pool.query("SELECT 1 AS ok");
    database.connected = true;

    const migrations = await pool.query(
      `SELECT migration_name, checksum_sha256
         FROM app.schema_migrations
        WHERE migration_name = ANY($1::text[])`,
      [[...expectedByName.keys()]],
    );
    database.applied_migration_count = migrations.rows.length;
    database.missing_migration_count = manifest.length - migrations.rows.length;
    database.checksum_mismatch_count = migrations.rows.reduce((count, row) => (
      expectedByName.get(row.migration_name) === row.checksum_sha256 ? count : count + 1
    ), 0);

    const release = await pool.query(
      `SELECT status = 'current' AS release_current
         FROM uad_ref.specification_releases
        WHERE release_key = $1`,
      [CURRENT_UAD_RELEASE_KEY],
    );
    database.release_current = release.rows[0]?.release_current === true;

    const relations = await pool.query(
      `SELECT count(*) FILTER (WHERE to_regclass(relation_name) IS NULL)::integer AS missing_count
         FROM unnest($1::text[]) AS required(relation_name)`,
      [REQUIRED_RELATIONS],
    );
    database.missing_relation_count = Number(relations.rows[0]?.missing_count ?? REQUIRED_RELATIONS.length);

    const appendixHRows = await pool.query(
      `SELECT rule_id, local_evaluation_status
         FROM uad_ref.compliance_rules
        WHERE release_key = $1
          AND rule_id = ANY($2::text[])`,
      [CURRENT_UAD_RELEASE_KEY, APPENDIX_H1_RULE_IDS],
    );
    const appendixHCoverage = buildAppendixH1Coverage(appendixHRows.rows);
    database.appendix_h_cataloged_rule_count = appendixHCoverage.cataloged_rule_count;
    database.appendix_h_missing_rule_count = appendixHCoverage.missing_rule_count;
    database.appendix_h_unknown_rule_count = appendixHCoverage.unknown_rule_count;
    database.appendix_h_reference_only_rule_count = appendixHCoverage.reference_only_rule_count;
    database.appendix_h_mapped_unverified_rule_count = appendixHCoverage.mapped_unverified_rule_count;
    database.appendix_h_locally_verified_rule_count = appendixHCoverage.locally_verified_rule_count;
    database.appendix_h_catalog_complete = appendixHCoverage.catalog_complete;
    database.appendix_h_local_gse_equivalence_complete = appendixHCoverage.local_gse_equivalence_complete;
    database.ready = database.missing_migration_count === 0
      && database.checksum_mismatch_count === 0
      && database.release_current
      && database.missing_relation_count === 0
      && database.appendix_h_catalog_complete;
  } catch {
    database.error_code = database.connected
      ? "uad_database_schema_unavailable"
      : "uad_database_connection_failed";
  }

  return buildUadOperationalReadiness({ ...options, database });
}

export function createCachedUadReadinessLoader(pool, options = {}, {
  cacheMilliseconds = 15_000,
  now = () => Date.now(),
} = {}) {
  const ttl = Math.max(1_000, Math.min(Number(cacheMilliseconds) || 15_000, 60_000));
  let cached = null;
  let pending = null;
  return async function loadUadReadiness() {
    const currentTime = now();
    if (cached && cached.expires_at > currentTime) return cached.value;
    if (pending) return pending;
    pending = getUadOperationalReadiness(pool, options)
      .then((value) => {
        cached = { value, expires_at: now() + ttl };
        return value;
      })
      .finally(() => { pending = null; });
    return pending;
  };
}
