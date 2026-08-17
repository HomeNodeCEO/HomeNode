import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../..");
const MIGRATIONS = Object.freeze(["20260816_uad_foundation.sql"]);
const ADVISORY_LOCK_KEY = 3_603_600_816;

function checksum(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export async function applyUadMigrations(pool, { logger = console } = {}) {
  await pool.query("CREATE SCHEMA IF NOT EXISTS app");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app.schema_migrations (
      migration_name text PRIMARY KEY,
      checksum_sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const client = await pool.connect();
  const results = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    for (const migrationName of MIGRATIONS) {
      const migrationPath = path.join(SERVER_DIRECTORY, "migrations", migrationName);
      const sql = await fs.readFile(migrationPath, "utf8");
      const migrationChecksum = checksum(sql);
      const existing = await client.query(
        `SELECT checksum_sha256
           FROM app.schema_migrations
          WHERE migration_name = $1`,
        [migrationName],
      );

      if (existing.rows.length) {
        if (existing.rows[0].checksum_sha256 !== migrationChecksum) {
          throw new Error(`migration_checksum_mismatch:${migrationName}`);
        }
        results.push({ migration_name: migrationName, status: "already_applied" });
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO app.schema_migrations (migration_name, checksum_sha256)
           VALUES ($1, $2)`,
          [migrationName, migrationChecksum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      logger.info?.(`[migration] applied ${migrationName}`);
      results.push({ migration_name: migrationName, status: "applied" });
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
  return results;
}
