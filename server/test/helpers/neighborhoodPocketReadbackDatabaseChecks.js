import assert from "node:assert/strict";
import { ensureNeighborhoodRelevanceSchema, generateNeighborhoodRelevance,
  getLatestNeighborhoodRelevance } from "../../src/services/neighborhoodRelevanceEngine.js";

// The guarded native runner owns a fresh, isolated synthetic database and runs
// canonical schema preparation before calling this helper. No production data,
// query mocks, geometry repair, or external service access is used here.
export async function checkNeighborhoodPocketReadbackDatabase(pool) {
  const identity = (await pool.query("SELECT current_database() AS name")).rows[0];
  assert.match(identity.name, /^neighborhood_pocket_redteam_[a-z0-9_]+_test$/);
  await ensureNeighborhoodRelevanceSchema(pool);
  const accounts = ["UAD-REDTEAM-POCKET-SUBJECT", "UAD-REDTEAM-POCKET-KNOWN", "UAD-REDTEAM-POCKET-UNKNOWN"];
  assert.equal((await pool.query("SELECT 1 FROM core.accounts WHERE account_id = ANY($1::text[])", [accounts])).rowCount, 0);
  for (let i = 0; i < accounts.length; i += 1) {
    await pool.query(`INSERT INTO core.accounts (account_id, county, address, city, subdivision)
      VALUES ($1, 'Dallas', $2, 'Garland', $3)`,
    [accounts[i], `${100 + i} Synthetic Pocket Ln`, i === 2 ? null : "SYNTHETIC POCKET"]);
    await pool.query(`INSERT INTO gis.dcad_parcels (object_id, account_id, low_parcel_id,
      site_address, land_use_category, subdivision_name, residential_year_built,
      residential_area_sqft, parcel_area_sqft, current_market_value, source_record_hash, geom)
      VALUES ($1, $2, $2, $3, $4, $5, 1980, 1600, 7200, 280000, $2,
        ST_Multi(ST_MakeEnvelope($6::double precision, 32.9100, $6::double precision + 0.00015, 32.91015, 4326)))`,
    [91000001 + i, accounts[i], `${100 + i} Synthetic Pocket Ln`, "one_unit",
      i === 2 ? null : "SYNTHETIC POCKET", -96.65 + i * 0.0002]);
  }
  /** @type {{rows: Array<{closing_date: string}>}} */
  const calendarResult = await pool.query(`SELECT
    to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '1 month', 'YYYY-MM-DD') AS closing_date`);
  const expectedCalendarDate = calendarResult.rows[0].closing_date;
  // Real canonical view: include a first-of-month transaction to expose timezone
  // shifts when DATE is accidentally parsed as a local-midnight Date object.
  for (const [account, price, days, ageDays] of [[accounts[1], 282500, 0, 1], [accounts[1], 270000, 42, 300], [accounts[2], 250000, null, 2]]) {
    await pool.query(`INSERT INTO core.sales (account_id, closing_date, sale_price, days_on_market, source)
      VALUES ($1, CASE WHEN $3::numeric = 282500 THEN
        (date_trunc('month', CURRENT_DATE) - INTERVAL '1 month')::date
        ELSE CURRENT_DATE - $2::integer END, $3, $4, 'synthetic-pocket-native')`, [account, ageDays, price, days]);
  }
  const boundary = { type: "Polygon", coordinates: [[[-96.66, 32.90], [-96.64, 32.90], [-96.64, 32.92], [-96.66, 32.92], [-96.66, 32.90]]] };
  const { rows: boundaries } = await pool.query(`INSERT INTO app.neighborhood_boundary_assessments
    (account_id, scope_key, methodology_version, search_profile, discovery_radius_miles,
      input_signature, boundary, boundary_geojson, confidence)
    VALUES ($1, 'property', 1, 'suburban_simple', 3, 'synthetic-pocket-native-v1',
      ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $2::jsonb, 'moderate') RETURNING id`,
  [accounts[0], JSON.stringify(boundary)]);
  const generated = await generateNeighborhoodRelevance(pool, { accountId: accounts[0], boundaryAssessmentId: Number(boundaries[0].id) });
  assert.equal(generated.visualization.length, 2);
  const projected = (result) => JSON.parse(JSON.stringify(result.visualization.map(row => ({ account_id: row.account_id,
    subdivision_name: row.subdivision_name, land_use_category: row.land_use_category,
    sales: row.sales })).sort((a, b) => a.account_id.localeCompare(b.account_id))));
  const readback = await getLatestNeighborhoodRelevance(pool, { accountId: accounts[0] });
  assert.deepEqual(projected(readback), projected(generated));
  const known = readback.visualization.find(row => row.account_id === accounts[1]);
  assert.equal(known.subdivision_name, "SYNTHETIC POCKET");
  assert.equal(known.land_use_category, "one_unit");
  assert.deepEqual(known.sales.map(sale => sale.days_on_market), [0, 42]);
  assert.deepEqual(known.sales.map(sale => Number(sale.sale_price)), [282500, 270000]);
  assert.equal(known.sales[0].sale_date, expectedCalendarDate);
  const unknown = readback.visualization.find(row => row.account_id === accounts[2]);
  assert.equal(unknown.subdivision_name, null);
  assert.equal(unknown.land_use_category, "one_unit");
  assert.equal(unknown.sales[0].days_on_market, null);
  // Genuine historical absence stays unknown; do not synthesize current values.
  // Explicitly seed the legacy scalar DATE as well as the empty transaction list;
  // a newly generated candidate does not necessarily populate that old column.
  await pool.query(`UPDATE app.neighborhood_relevance_candidates SET subdivision_name = NULL,
    land_use_category = NULL, sale_date = $3::date,
    diagnostics = jsonb_set(diagnostics, '{sales}', '[]'::jsonb)
    WHERE assessment_id = $1 AND account_id = $2`, [readback.id, accounts[1], expectedCalendarDate]);
  const historical = (await getLatestNeighborhoodRelevance(pool, { accountId: accounts[0] })).visualization
    .find(row => row.account_id === accounts[1]);
  assert.equal(historical.subdivision_name, null);
  assert.equal(historical.land_use_category, null);
  assert.deepEqual(historical.sales, []);
  assert.equal(historical.sale_date, expectedCalendarDate);
  return { generated_candidates: 2, retained_transactions: 3, zero_dom_preserved: true,
    unknown_dom_preserved: true, historical_unknowns_preserved: true,
    calendar_roundtrip: { expected_date: expectedCalendarDate, sales: JSON.parse(JSON.stringify(known.sales)) } };
}
