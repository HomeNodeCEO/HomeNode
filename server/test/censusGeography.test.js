import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedCountyFips,
  lookupAccountCensusGeographyNow,
  parseCensusAddressBatchResponse,
  parseCensusCoordinatesBatchResponse,
  validateCensusGeography,
} from "../src/services/censusGeography.js";

test("parses Census coordinate batch tract results", () => {
  const rows = parseCensusCoordinatesBatchResponse(
    '"26272500060150000","-96.6300","32.9200","Match","48","113","019004","1001"\n',
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    account_id: "26272500060150000",
    longitude: -96.63,
    latitude: 32.92,
    matched: true,
    state_fips: "48",
    county_fips: "113",
    tract_code: "019004",
    tract_geoid: "48113019004",
    block_code: "1001",
    response_status: "Match",
  });
});

test("parses Census address batch results and the returned coordinate", () => {
  const rows = parseCensusAddressBatchResponse(
    '"26272500060150000","1909 SNOWMASS LN, GARLAND, TX, 75044","Match","Exact","1909 SNOWMASS LN, GARLAND, TX, 75044","-96.656200410661,32.946676823261","102925595","R","48","113","019029","3017"\n',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tract_geoid, "48113019029");
  assert.equal(rows[0].longitude, -96.656200410661);
  assert.equal(rows[0].latitude, 32.946676823261);
  assert.equal(rows[0].match_type, "Exact");
});

test("validates Texas county FIPS without accepting a cross-county point", () => {
  assert.equal(expectedCountyFips("Dallas County"), "113");
  assert.equal(expectedCountyFips("Collin"), "085");
  assert.deepEqual(
    validateCensusGeography({
      matched: true,
      state_fips: "48",
      county_fips: "113",
      tract_geoid: "48113019004",
    }, "Dallas County"),
    { valid: true, reason: null },
  );
  assert.match(
    validateCensusGeography({
      matched: true,
      state_fips: "48",
      county_fips: "085",
      tract_geoid: "48085000100",
    }, "Dallas County").reason,
    /county_fips_mismatch/,
  );
});

test("looks up and persists one account immediately using its address fallback", async () => {
  const calls = [];
  const pool = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("CREATE TABLE IF NOT EXISTS core.account_census_geographies")) {
        return { rows: [] };
      }
      if (sql.includes("FROM core.accounts account")) {
        return {
          rows: [{
            account_id: "26272500060150000",
            county: "Dallas",
            source_latitude: null,
            source_longitude: null,
            source_address: "1909 SNOWMASS LN",
            source_city: "GARLAND",
            source_state: "TX",
            source_postal_code: "75044",
          }],
        };
      }
      if (sql.includes("INSERT INTO core.account_census_geographies")) {
        return {
          rows: [{
            tract_geoid: values[1],
            tract_code: values[2],
            state_fips: values[3],
            county_fips: values[4],
            status: values[15],
            source_method: values[14],
          }],
        };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
  const fetchImpl = async () => new Response(
    '"26272500060150000","1909 SNOWMASS LN, GARLAND, TX, 75044","Match","Exact","1909 SNOWMASS LN, GARLAND, TX, 75044","-96.656200410661,32.946676823261","102925595","R","48","113","019029","3017"\n',
    { status: 200 },
  );

  const result = await lookupAccountCensusGeographyNow(
    pool,
    "26272500060150000",
    { fetchImpl },
  );

  assert.equal(result.tract_geoid, "48113019029");
  assert.equal(result.status, "matched");
  assert.equal(result.source_method, "address");
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO core.account_census_geographies")).length, 1);
});
