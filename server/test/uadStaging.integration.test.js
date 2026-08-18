import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

test("UAD staging bootstrap supports the shared search-tile contract", {
  skip: !databaseUrl || !databaseUrl.toLowerCase().includes("staging"),
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query(`
      SELECT
        a.account_id,
        a.address,
        a.street_name,
        a.city,
        a.postal_code,
        a.county,
        a.neighborhood_code,
        a.subdivision,
        a.legal_description,
        a.data_quality_status,
        a.data_quality_flags,
        a.canonical_account_id,
        native_identifier.native_account_id,
        COALESCE(vsc.certified_year, mv.tax_year) AS latest_tax_year,
        COALESCE(vsc.market_value, mv.total_value) AS latest_market_value,
        COALESCE(vsc.improvement_value, mv.imp_value) AS latest_improvement_value,
        COALESCE(vsc.land_value, mv.land_value) AS latest_land_value,
        COALESCE(vsc.capped_value, mv.homestead_cap_value) AS latest_capped_value
      FROM core.accounts a
      LEFT JOIN LATERAL (
        SELECT identifier.native_account_id
          FROM app.county_account_identifiers identifier
         WHERE identifier.account_id = a.account_id
         ORDER BY
           (identifier.verification_source = 'collin_cad_open_data') DESC,
           identifier.updated_at DESC
         LIMIT 1
      ) native_identifier ON TRUE
      LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
      LEFT JOIN LATERAL (
        SELECT value.*
          FROM core.market_values value
         WHERE value.account_id = a.account_id
         ORDER BY value.tax_year DESC
         LIMIT 1
      ) mv ON TRUE
      LEFT JOIN LATERAL (
        SELECT raw.raw
          FROM core.dcad_json_raw raw
         WHERE raw.account_id = a.account_id
         ORDER BY raw.tax_year DESC, raw.fetched_at DESC
         LIMIT 1
      ) raw_record ON TRUE
      WHERE a.account_id = 'UAD-STAGING-SFR-0001'
    `);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, "100 Test Subject Dr");
    assert.equal(rows[0].street_name, "TEST SUBJECT DR");
    assert.equal(rows[0].latest_tax_year, 2026);
    assert.equal(Number(rows[0].latest_market_value), 425000);

    const realRows = await pool.query(
      "SELECT count(*)::integer AS count FROM core.accounts WHERE account_id <> $1",
      ["UAD-STAGING-SFR-0001"],
    );
    assert.equal(realRows.rows[0].count, 0);
  } finally {
    await pool.end();
  }
});
