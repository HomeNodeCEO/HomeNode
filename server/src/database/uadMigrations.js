import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../..");
const MIGRATIONS = Object.freeze([
  "20260816_uad_foundation.sql",
  "20260817_uad_assignment_subject.sql",
  "20260818_uad_site.sql",
  "20260819_uad_disaster_energy.sql",
  "20260820_uad_sketch.sql",
  "20260821_uad_dwelling_exterior.sql",
  "20260822_uad_manufactured_home.sql",
  "20260823_uad_unit_interior.sql",
  "20260824_uad_functional_obsolescence.sql",
  "20260825_uad_outbuilding.sql",
  "20260826_uad_vehicle_storage.sql",
  "20260827_uad_subject_property_amenities.sql",
  "20260828_uad_overall_quality_condition.sql",
  "20260829_uad_highest_best_use.sql",
  "20260830_uad_market.sql",
  "20260831_uad_project_information.sql",
  "20260901_uad_subject_listing_information.sql",
  "20260902_uad_sales_contract.sql",
  "20260903_uad_prior_sale_transfer_history.sql",
  "20260904_uad_sales_comparison_general.sql",
  "20260905_uad_sales_comparison_project.sql",
  "20260906_uad_sales_comparison_site.sql",
  "20260907_uad_sales_comparison_water_frontage.sql",
  "20260908_uad_sales_comparison_dwelling.sql",
  "20260909_uad_sales_comparison_energy_green.sql",
  "20260910_uad_sales_comparison_units.sql",
  "20260911_uad_sales_comparison_exterior_quality.sql",
  "20260912_uad_sales_comparison_interior_quality.sql",
  "20260913_uad_sales_comparison_adu_interior.sql",
]);
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
