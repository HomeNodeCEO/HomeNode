import assert from "node:assert/strict";
import test from "node:test";

import { getUadMigrationManifest } from "../src/database/uadMigrations.js";
import {
  createRedTeamRecoveryConfiguration,
  verifyRedTeamRecoveryDatabase,
} from "../src/security/redTeamRecovery.js";

const recoveryServiceId = "dpg-redteamrecovery123-a";
const recoveryUrl = `postgresql://user:secret@${recoveryServiceId}.oregon-postgres.render.com/homenode_redteam_restore`;

test("accepts only an explicitly identified red-team recovery database", () => {
  const configuration = createRedTeamRecoveryConfiguration({
    REDTEAM_RECOVERY_DATABASE_URL: recoveryUrl,
    REDTEAM_RECOVERY_DATABASE_SERVICE_ID: recoveryServiceId,
  });
  assert.equal(configuration.serviceId, recoveryServiceId);
  assert.equal(configuration.databaseName, "homenode_redteam_restore");
});

test("rejects the primary database and mismatched recovery service identities", () => {
  assert.throws(() => createRedTeamRecoveryConfiguration({
    DATABASE_URL: recoveryUrl,
    REDTEAM_RECOVERY_DATABASE_URL: recoveryUrl,
    REDTEAM_RECOVERY_DATABASE_SERVICE_ID: recoveryServiceId,
  }), /primary_database_prohibited/);
  assert.throws(() => createRedTeamRecoveryConfiguration({
    REDTEAM_RECOVERY_DATABASE_URL: recoveryUrl,
    REDTEAM_RECOVERY_DATABASE_SERVICE_ID: "dpg-differentrecovery123-a",
  }), /service_id_mismatch/);
  assert.throws(() => createRedTeamRecoveryConfiguration({
    REDTEAM_RECOVERY_DATABASE_URL: recoveryUrl.replace("homenode_redteam_restore", "homenodedb"),
    REDTEAM_RECOVERY_DATABASE_SERVICE_ID: recoveryServiceId,
  }), /redteam_database_identity_mismatch/);
});

test("verifies synthetic fixture counts and every UAD migration checksum", async () => {
  const manifest = await getUadMigrationManifest();
  const pool = {
    async query(sql) {
      if (sql.includes("current_database()")) return { rows: [{ database_name: "homenode_redteam_restore" }] };
      if (sql.includes("to_regclass")) {
        return { rows: [
          { relation_name: "app_auth.organizations", available: true },
          { relation_name: "app_auth.users", available: true },
          { relation_name: "core.accounts", available: true },
          { relation_name: "appraisal.uad_workfiles", available: true },
          { relation_name: "app.report_files", available: true },
        ] };
      }
      if (sql.includes("COALESCE(metadata->>'synthetic'")) return { rows: [{ count: 0 }] };
      if (sql.includes("account_id !~")) return { rows: [{ count: 0 }] };
      if (sql.includes("FROM app.schema_migrations")) return { rows: manifest };
      if (sql.includes("AS oidc_identities")) {
        return { rows: [{ accounts: 1, organizations: 2, users: 11, oidc_identities: 11, uad_workfiles: 3 }] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  const result = await verifyRedTeamRecoveryDatabase(pool);
  assert.equal(result.verified, true);
  assert.equal(result.uad_migrations.matched, manifest.length);
  assert.deepEqual(result.fixture_counts, {
    accounts: 1,
    organizations: 2,
    users: 11,
    oidc_identities: 11,
    uad_workfiles: 3,
  });
});

test("fails closed on altered recovery fixtures", async () => {
  const manifest = await getUadMigrationManifest();
  const pool = {
    async query(sql) {
      if (sql.includes("current_database()")) return { rows: [{ database_name: "homenode_redteam_restore" }] };
      if (sql.includes("to_regclass")) return { rows: [] };
      if (sql.includes("FROM app.schema_migrations")) return { rows: manifest };
      if (sql.includes("AS oidc_identities")) {
        return { rows: [{ accounts: 1, organizations: 2, users: 12, oidc_identities: 11, uad_workfiles: 3 }] };
      }
      throw new Error(`unexpected_query:${sql}`);
    },
  };
  await assert.rejects(
    verifyRedTeamRecoveryDatabase(pool),
    /fixture_count_mismatch:users:12:11/,
  );
});
