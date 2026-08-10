import assert from "node:assert/strict";
import test from "node:test";

import {
  expectedCountyFips,
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
