import assert from "node:assert/strict";
import test from "node:test";

import {
  censusGeographyInternals,
  expectedCountyFips,
  fetchCensusAddressBatch,
  fetchCensusCoordinatesBatch,
  lookupAccountCensusGeographyNow,
  parseCensusAddressBatchResponse,
  parseCensusCoordinatesBatchResponse,
  validateCensusGeography,
} from "../src/services/censusGeography.js";

const coordinateRow = {
  account_id: "26272500060150000",
  source_longitude: -96.63,
  source_latitude: 32.92,
};

const addressRow = {
  account_id: "26272500060150000",
  source_address: "1909 SNOWMASS LN",
  source_city: "GARLAND",
  source_state: "TX",
  source_postal_code: "75044",
};

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

test("Census batch requests refuse redirects and request CSV responses", async () => {
  const calls = [];
  const rows = await fetchCensusCoordinatesBatch([coordinateRow], {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        '"26272500060150000","-96.6300","32.9200","Match","48","113","019004","1001"\n',
        { headers: { "content-type": "text/csv" } },
      );
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.accept, "text/csv");
  assert.equal(calls[0].options.signal instanceof AbortSignal, true);
});

test("Census batch responses are size bounded and cancelled", async () => {
  let cancelled = false;
  await assert.rejects(
    fetchCensusAddressBatch([addressRow], {
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }), {
        headers: {
          "content-length": String(
            censusGeographyInternals.MAX_CENSUS_BATCH_RESPONSE_BYTES + 1
          ),
          "content-type": "text/csv",
        },
      }),
    }),
    { message: "census_address_batch_response_too_large" },
  );
  assert.equal(cancelled, true);
});

test("Census batch HTTP and redirect failures cancel response bodies", async () => {
  for (const [response, expectedMessage] of [
    [
      { ok: false, status: 503, redirected: false },
      "census_coordinates_batch_http_503",
    ],
    [
      { ok: true, status: 200, redirected: true },
      "census_coordinates_batch_redirect_forbidden",
    ],
  ]) {
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      fetchCensusCoordinatesBatch([coordinateRow], {
        fetchImpl: async () => ({
          ...response,
          body,
          headers: new Headers(),
        }),
      }),
      { message: expectedMessage },
    );
    assert.equal(cancelled, true);
  }
});

test("Census batch transport failures do not expose provider diagnostics", async () => {
  await assert.rejects(
    fetchCensusAddressBatch([addressRow], {
      fetchImpl: async () => {
        throw new Error("private Census network diagnostic");
      },
    }),
    { message: "census_address_batch_unavailable" },
  );
});

test("Census batch deadlines remain active through stalled response bodies", async () => {
  let aborted = false;
  await assert.rejects(
    fetchCensusCoordinatesBatch([coordinateRow], {
      requestTimeoutMs: 250,
      fetchImpl: async (_url, options) => new Response(new ReadableStream({
        start(controller) {
          options.signal.addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("private Census body diagnostic"));
          }, { once: true });
        },
      }), { headers: { "content-type": "text/csv" } }),
    }),
    { message: "census_coordinates_batch_timeout" },
  );
  assert.equal(aborted, true);
});

test("Census batch rejects invalid UTF-8 with a stable error", async () => {
  await assert.rejects(
    fetchCensusAddressBatch([addressRow], {
      fetchImpl: async () => new Response(Uint8Array.from([0xc3, 0x28])),
    }),
    { message: "census_address_batch_response_invalid" },
  );
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
