import assert from "node:assert/strict";
import test from "node:test";

import { analyzePropertyContext, loadSpatialContext } from "../src/services/propertyContext.js";

test("bulk influence lookups prefilter countywide layers through geometry indexes", async () => {
  const statements = [];
  const parameters = [];
  const responses = [
    [{
      object_id: 1,
      account_id: "26272500060150000",
      parcel_area_sqft: 8_000,
      match_method: "account_id",
      subject_point: { type: "Point", coordinates: [-96.63, 32.91] },
    }],
    [],
    [],
    [],
    [],
    [],
  ];
  const pool = {
    async query(sql, values = []) {
      statements.push(sql);
      parameters.push(values);
      return { rows: responses.shift() || [] };
    },
  };

  await loadSpatialContext(
    pool,
    {
      account_id: "26272500060150000",
      address: "1909 Snowmass Ln",
      city: "Garland",
      longitude: -96.63,
      latitude: 32.91,
    },
    null,
    { includeSiteStatistics: false },
  );

  assert.equal(statements.length, 6);
  assert.match(statements[1], /parcel\.geom && ST_Expand\(subject\.geom/);
  assert.match(statements[2], /road\.geom && ST_Expand\(subject\.geom/);
  assert.match(statements[3], /traffic\.geom && ST_Expand\(subject\.geom/);
  assert.match(statements[4], /zoning\.provider_key = \$2/);
  assert.deepEqual(parameters[4], [1, "city_garland_official"]);
});

test("market-study context mode avoids both fixed-radius peer aggregates", async () => {
  const statements = [], accountId = "12345678901234567";
  const pool = { async query(sql, values = []) {
    statements.push(sql);
    if (sql.includes("FROM core.accounts account")) return { rows: [{ account_id: accountId, address: "10 Test Dr", city: "Garland",
      living_area_sqft: 1500, year_built: 1960, latitude: 32.91, longitude: -96.63 }] };
    if (sql.includes("AS match_method")) return { rows: [{ object_id: 1, account_id: accountId, parcel_area_sqft: 8000,
      match_method: "account_id", subject_point: { type: "Point", coordinates: [-96.63, 32.91] } }] };
    if (sql.startsWith("INSERT INTO app.property_complexity_assessments")) return { rows: [{ account_id: accountId,
      assignment_file_id: 7, scope_key: values[1], automatic_assessment: JSON.parse(values[7]), computed_at: values[8],
      automatic_complexity: values[3], automatic_score: values[4], automatic_confidence: values[5] }] };
    return { rows: [] };
  } };
  const value = await analyzePropertyContext(pool, { accountId, assignmentFileId: 7, marketStudyContextOnly: true });
  assert.equal(value.peer_statistics.context, "market_studies");
  assert.equal(value.subject.gross_living_area_sqft, 1500);
  assert.equal(statements.some(sql => sql.includes("percentile_cont(0.5)")), false, "no two-mile aggregate");
  assert.equal(statements.some(sql => sql.includes("road.geom && ST_Expand")), true, "local influences still measured");
  assert.equal(value.spatial_context.site_comparison_count, 0);
});
