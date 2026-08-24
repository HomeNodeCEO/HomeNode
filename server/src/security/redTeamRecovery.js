import { getUadMigrationManifest } from "../database/uadMigrations.js";
import {
  assertRedTeamDatabaseName,
  verifyRedTeamSyntheticBoundary,
} from "./redTeamIsolation.js";
import { REDTEAM_ORGANIZATIONS, REDTEAM_PERSONAS } from "./redTeamFixtures.js";

const RECOVERY_SERVICE_ID_PATTERN = /^dpg-[a-z0-9-]{12,}$/;
const EXPECTED_FIXTURE_COUNTS = Object.freeze({
  accounts: 1,
  organizations: Object.keys(REDTEAM_ORGANIZATIONS).length,
  users: REDTEAM_PERSONAS.length,
  oidc_identities: REDTEAM_PERSONAS.length,
  uad_workfiles: 3,
});

function required(environment, key) {
  const configured = String(environment[key] || "").trim();
  if (!configured) throw new Error(`redteam_recovery_${key.toLowerCase()}_required`);
  return configured;
}

function parsePostgresUrl(rawValue) {
  try {
    const parsed = new URL(rawValue);
    if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || !parsed.pathname) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new Error("redteam_recovery_database_url_invalid");
  }
}

export function createRedTeamRecoveryConfiguration(environment = process.env) {
  const connectionString = required(environment, "REDTEAM_RECOVERY_DATABASE_URL");
  const serviceId = required(environment, "REDTEAM_RECOVERY_DATABASE_SERVICE_ID").toLowerCase();
  if (!RECOVERY_SERVICE_ID_PATTERN.test(serviceId)) {
    throw new Error("redteam_recovery_service_id_invalid");
  }

  const parsed = parsePostgresUrl(connectionString);
  if (parsed.hostname !== serviceId && !parsed.hostname.startsWith(`${serviceId}.`)) {
    throw new Error("redteam_recovery_service_id_mismatch");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  assertRedTeamDatabaseName(databaseName);

  if (environment.DATABASE_URL) {
    const primary = parsePostgresUrl(String(environment.DATABASE_URL));
    if (primary.hostname === parsed.hostname && primary.pathname === parsed.pathname) {
      throw new Error("redteam_recovery_primary_database_prohibited");
    }
  }

  return Object.freeze({ connectionString, serviceId, databaseName });
}

function normalizedCounts(row = {}) {
  return Object.fromEntries(Object.keys(EXPECTED_FIXTURE_COUNTS).map((key) => [key, Number(row[key] || 0)]));
}

export async function verifyRedTeamRecoveryDatabase(pool) {
  const identity = await pool.query("SELECT current_database() AS database_name");
  const databaseName = assertRedTeamDatabaseName(identity.rows[0]?.database_name);
  await verifyRedTeamSyntheticBoundary(pool);

  const manifest = await getUadMigrationManifest();
  const applied = await pool.query(
    `SELECT migration_name, checksum_sha256
       FROM app.schema_migrations
      WHERE migration_name = ANY($1::text[])`,
    [manifest.map((entry) => entry.migration_name)],
  );
  const appliedByName = new Map(applied.rows.map((entry) => [entry.migration_name, entry.checksum_sha256]));
  const migrationFailures = manifest.filter(
    (entry) => appliedByName.get(entry.migration_name) !== entry.checksum_sha256,
  );
  if (migrationFailures.length) {
    const sample = migrationFailures.slice(0, 5).map((entry) => entry.migration_name).join(",");
    throw new Error(`redteam_recovery_uad_migration_mismatch:${migrationFailures.length}:${sample}`);
  }

  const fixtures = await pool.query(`
    SELECT
      (SELECT count(*)::integer FROM core.accounts) AS accounts,
      (SELECT count(*)::integer FROM app_auth.organizations) AS organizations,
      (SELECT count(*)::integer FROM app_auth.users) AS users,
      (SELECT count(*)::integer FROM app_auth.oidc_identities) AS oidc_identities,
      (SELECT count(*)::integer FROM appraisal.uad_workfiles) AS uad_workfiles
  `);
  const fixtureCounts = normalizedCounts(fixtures.rows[0]);
  const fixtureMismatches = Object.entries(EXPECTED_FIXTURE_COUNTS)
    .filter(([key, expected]) => fixtureCounts[key] !== expected)
    .map(([key, expected]) => `${key}:${fixtureCounts[key]}:${expected}`);
  if (fixtureMismatches.length) {
    throw new Error(`redteam_recovery_fixture_count_mismatch:${fixtureMismatches.join(",")}`);
  }

  return Object.freeze({
    verified: true,
    synthetic_only: true,
    database_name: databaseName,
    uad_migrations: Object.freeze({ expected: manifest.length, matched: manifest.length }),
    fixture_counts: Object.freeze(fixtureCounts),
  });
}
