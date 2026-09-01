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
  "20260914_uad_sales_comparison_overall_quality_condition.sql",
  "20260915_uad_sales_comparison_property_amenities.sql",
  "20260916_uad_sales_comparison_vehicle_storage.sql",
  "20260917_uad_sales_comparison_outbuildings.sql",
  "20260918_uad_sales_comparison_summary.sql",
  "20260919_uad_sales_comparison_reconciliation.sql",
  "20260921_uad_reconciliation.sql",
  "20260922_uad_certifications.sql",
  "20260923_uad_system_package.sql",
  "20260924_uad_compliance_api.sql",
  "20260925_appraisal_delivery_hub.sql",
  "20260926_uad_appendix_h1_v1_5.sql",
  "20260927_uad_mobile_evidence.sql",
  "20260928_uad_sketch_editor.sql",
  "20261002_uad_document_evidence.sql",
]);
export const UAD_MIGRATION_NAMES = MIGRATIONS;
const ADVISORY_LOCK_KEY = 3_603_600_816;

function checksum(contents) {
  // Git may materialize SQL files with CRLF on Windows while Render and CI use
  // LF. Migration identity must describe the SQL, not the checkout platform.
  return createHash("sha256").update(contents.replace(/\r\n/g, "\n")).digest("hex");
}

export async function getUadMigrationManifest() {
  return Promise.all(MIGRATIONS.map(async (migrationName) => {
    const migrationPath = path.join(SERVER_DIRECTORY, "migrations", migrationName);
    const sql = await fs.readFile(migrationPath, "utf8");
    return Object.freeze({
      migration_name: migrationName,
      checksum_sha256: checksum(sql),
    });
  }));
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
