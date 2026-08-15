import assert from "node:assert/strict";
import test from "node:test";

import { loadSpatialContext } from "../src/services/propertyContext.js";

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
