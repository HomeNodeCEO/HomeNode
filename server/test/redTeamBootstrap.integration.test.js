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
          SELECT data_type
          FROM information_schema.columns
          WHERE table_schema = 'core'
            AND table_name = 'primary_improvements'
            AND column_name = 'pool'
        ) AS pool_data_type,
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
      pool_data_type: "boolean",
      location_columns: 7,
    });

    const accounts = await pool.query(
      `SELECT count(*)::integer AS count,
              bool_and(account_id LIKE 'UAD-REDTEAM-%') AS isolated,
              bool_and(data_quality_status = 'synthetic') AS synthetic
         FROM core.accounts`,
    );
    assert.deepEqual(accounts.rows[0], {
      count: 37,
      isolated: true,
      synthetic: true,
    });

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
              bool_and(account_id = 'UAD-REDTEAM-SFR-0001') AS isolated_account,
              array_agg(file_number ORDER BY file_number) AS file_numbers
         FROM appraisal.uad_workfiles
        WHERE file_number LIKE 'HN-REDTEAM-%'`,
    );
    assert.deepEqual(workfiles.rows[0], {
      count: 3,
      organizations: 2,
      isolated_account: true,
      file_numbers: [
        "HN-REDTEAM-A-0001",
        "HN-REDTEAM-B-0001",
        "HN-REDTEAM-DELIVERY-A-0001",
      ],
    });

    const sales = await pool.query(`
      SELECT
        count(*) FILTER (
          WHERE source_name = 'HomeNode synthetic red-team comparable fixture'
        )::integer AS comparable_sales,
        count(*) FILTER (
          WHERE source_name = 'HomeNode synthetic red-team reconciliation fixture'
        )::integer AS reconciliation_sales,
        count(*) FILTER (
          WHERE source_name = 'HomeNode synthetic red-team comparable fixture'
            AND primary_account_id LIKE 'UAD-REDTEAM-COMP-%'
        )::integer AS linked_comparable_sales
      FROM core.sales_source_records
    `);
    assert.deepEqual(sales.rows[0], {
      comparable_sales: 36,
      reconciliation_sales: 2,
      linked_comparable_sales: 36,
    });

    const valuationEvidence = await pool.query(`
      SELECT
        count(*)::integer AS valued_comparables,
        count(*) FILTER (
          WHERE values.land_value > 0
            AND values.improvement_value > 0
            AND values.market_value = values.land_value + values.improvement_value
        )::integer AS complete_allocations
      FROM core.value_summary_current values
      WHERE values.account_id LIKE 'UAD-REDTEAM-COMP-%'
    `);
    assert.deepEqual(valuationEvidence.rows[0], {
      valued_comparables: 36,
      complete_allocations: 36,
    });

    const ratings = await pool.query(`
      SELECT
        (SELECT count(*)::integer FROM app.sale_characteristic_reviews)
          AS comparable_ratings,
        (SELECT count(*)::integer FROM app.subject_appraisal_ratings
          WHERE account_id = 'UAD-REDTEAM-SFR-0001') AS subject_ratings
    `);
    assert.deepEqual(ratings.rows[0], {
      comparable_ratings: 36,
      subject_ratings: 1,
    });
  } finally {
    await pool.end();
  }
});
