import { getUadMigrationManifest } from "../../database/uadMigrations.js";
import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";

const REQUIRED_RELATIONS = Object.freeze([
  "appraisal.uad_workfiles",
  "appraisal.uad_field_values",
  "appraisal.uad_validation_runs",
  "appraisal.uad_assets",
  "appraisal.uad_generated_artifacts",
  "appraisal.uad_signatures",
  "appraisal.uad_compliance_exchanges",
  "uad_ref.fields",
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
  checkedAt = new Date().toISOString(),
}) {
  const blockers = [];
  if (!enabled) blockers.push("uad_workspace_disabled");
  if (!database.connected) blockers.push("uad_database_unavailable");
  if (database.missing_migration_count > 0) blockers.push("uad_migrations_incomplete");
  if (database.checksum_mismatch_count > 0) blockers.push("uad_migration_checksum_mismatch");
  if (!database.release_current) blockers.push("uad_release_not_current");
  if (database.missing_relation_count > 0) blockers.push("uad_relations_missing");
  if (!storage?.configured) blockers.push("uad_object_storage_not_configured");
  if (!verifier?.configured) blockers.push("uad_oidc_not_configured");

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
    database.ready = database.missing_migration_count === 0
      && database.checksum_mismatch_count === 0
      && database.release_current
      && database.missing_relation_count === 0;
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
