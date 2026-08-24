import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const enabled = process.env.REDTEAM_INTEGRATION === "true";

test("red-team bootstrap contains only the deterministic synthetic boundary", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const database = await pool.query("SELECT current_database() AS name");
    assert.match(database.rows[0].name, /redteam/);

    const sharedSchema = await pool.query(`
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis,
        to_regclass('core.sales_source_records') IS NOT NULL AS sales_source_records,
        to_regclass('core.sale_parcels') IS NOT NULL AS sale_parcels,
        to_regclass('core.sales_source_media') IS NOT NULL AS sales_source_media,
        to_regclass('core.v_sales_media_summary') IS NOT NULL AS sales_media_summary,
        to_regclass('core.v_sales_enriched') IS NOT NULL AS sales_enriched,
        (
          SELECT count(*)::integer
          FROM information_schema.columns
          WHERE table_schema = 'core'
            AND table_name = 'account_locations'
            AND column_name IN (
              'source', 'precision', 'confidence', 'match_method',
              'geocoded_at', 'feature_count', 'review_required'
            )
        ) AS location_columns
    `);
    assert.deepEqual(sharedSchema.rows[0], {
      postgis: true,
      sales_source_records: true,
      sale_parcels: true,
      sales_source_media: true,
      sales_media_summary: true,
      sales_enriched: true,
      location_columns: 7,
    });

    const accounts = await pool.query(
      "SELECT account_id, data_quality_status FROM core.accounts ORDER BY account_id",
    );
    assert.deepEqual(accounts.rows, [{
      account_id: "UAD-REDTEAM-SFR-0001",
      data_quality_status: "synthetic",
    }]);

    const users = await pool.query(
      `SELECT count(*)::integer AS count,
              count(*) FILTER (WHERE metadata->>'synthetic' = 'true')::integer AS synthetic_count
         FROM app_auth.users`,
    );
    assert.deepEqual(users.rows[0], { count: 11, synthetic_count: 11 });

    const identities = await pool.query(
      `SELECT count(*)::integer AS count,
              count(DISTINCT subject)::integer AS distinct_subjects
         FROM app_auth.oidc_identities
        WHERE provider_key = 'redteam'`,
    );
    assert.deepEqual(identities.rows[0], { count: 11, distinct_subjects: 11 });

    const workfiles = await pool.query(
      `SELECT count(*)::integer AS count,
              count(DISTINCT organization_id)::integer AS organizations,
              bool_and(account_id = 'UAD-REDTEAM-SFR-0001') AS isolated_account
         FROM appraisal.uad_workfiles
        WHERE file_number LIKE 'HN-REDTEAM-%'`,
    );
    assert.deepEqual(workfiles.rows[0], {
      count: 2,
      organizations: 2,
      isolated_account: true,
    });

    const sales = await pool.query("SELECT count(*)::integer AS count FROM core.sales_source_records");
    assert.equal(sales.rows[0].count, 0);
  } finally {
    await pool.end();
  }
});
