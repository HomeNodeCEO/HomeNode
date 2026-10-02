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
  runCensusGeographyBatch,
  safeCensusReviewReason,
  startCensusGeographyWorker,
  validateCensusGeography,
} from "../src/services/censusGeography.js";

test("Census worker failures log bounded codes and tolerate a failing logger", async (context) => {
  const failure = new Error("postgresql://private-user:private-password@database.example/private-db");
  const warnings = [];
  const worker = startCensusGeographyWorker({
    query: async () => { throw failure; },
  }, {
    initialDelayMs: 300_000,
    logger: { warn: (...args) => warnings.push(args) },
  });
  context.after(worker.stop);
  await worker.runNow();
  assert.deepEqual(warnings, [["[census-geography] cycle failed; will retry", "unknown"]]);
  assert.doesNotMatch(JSON.stringify(warnings), /private-password/);

  const throwingLoggerWorker = startCensusGeographyWorker({
    query: async () => { throw failure; },
  }, {
    initialDelayMs: 300_000,
    logger: { warn: () => { throw new Error("logger_offline"); } },
  });
  context.after(throwingLoggerWorker.stop);
  await throwingLoggerWorker.runNow();
});

test("Census review reasons preserve known codes and mask historical diagnostics", () => {
  assert.equal(safeCensusReviewReason("census_coordinates_batch_http_503"),
    "census_coordinates_batch_http_503");
  assert.equal(safeCensusReviewReason("county_fips_mismatch:expected_113:received_085"),
    "county_fips_mismatch:expected_113:received_085");
  assert.equal(safeCensusReviewReason("postgresql://private-password@database"),
    "census_batch_failed");
});

test("failed Census batches persist and return bounded diagnostics", async () => {
  const stored = [];
  const claimed = {
    account_id: "26272500060150000", source_method: "coordinate",
    source_longitude: -96.63, source_latitude: 32.92,
    benchmark: "Public_AR_Current", vintage: "Current_Current",
    county: "Dallas", attempts: 1, worker_id: "worker-1",
  };
  const pool = {
    async connect() { return {
      async query(sql) {
        if (sql.includes("RETURNING geography.account_id")) return { rows: [claimed] };
        return { rows: [] };
      },
      release() {},
    }; },
    async query(sql, values) {
      if (sql.includes("SET tract_geoid = outcome.tract_geoid")) {
        throw new Error("postgresql://private-password@database");
      }
      stored.push({ sql, values });
      return { rows: [] };
    },
  };
  const result = await runCensusGeographyBatch(pool, {
    workerId: "worker-1", batchSize: 1,
    fetchImpl: async () => new Response(
      '"26272500060150000","-96.6300","32.9200","Match","48","113","019004","1001"\n',
    ),
  });
  assert.equal(result.retry, 1);
  assert.equal(result.error, "census_batch_failed");
  assert.equal(JSON.parse(stored[0].values[0])[0].review_reason, "census_batch_failed");
  assert.equal(JSON.stringify({ result, stored }).includes("private-password"), false);

  const providerFailure = await runCensusGeographyBatch(pool, {
    workerId: "worker-1", batchSize: 1,
    fetchImpl: async () => new Response(null, { status: 503 }),
  });
  assert.equal(providerFailure.error, "census_coordinates_batch_http_503");
  assert.equal(JSON.parse(stored[1].values[0])[0].review_reason,
    "census_coordinates_batch_http_503");
});

for (const failureStage of ["BEGIN", "lease recovery", "claim", "COMMIT"]) {
  for (const rollbackFails of [false, true]) {
    test(`Census ${failureStage} failure preserves its error and ${rollbackFails ? "retires" : "reuses"} the client`, async () => {
      const primaryError = new Error("private claim operation detail");
      const rollbackError = new Error("private rollback connection detail");
      const statements = [];
      const releases = [];
      const client = {
        async query(sql) {
          statements.push(sql);
          if (sql === "ROLLBACK" && rollbackFails) throw rollbackError;
          if (sql === failureStage
              || (failureStage === "lease recovery" && sql.includes("SET status = 'retry'"))
              || (failureStage === "claim" && sql.includes("RETURNING geography.account_id"))) {
            throw primaryError;
          }
          return { rows: [] };
        },
        release(error) { releases.push(error); },
      };
      const pool = {
        async connect() { return client; },
        async query() { assert.fail("failed claims must not settle queue items"); },
      };
      await assert.rejects(runCensusGeographyBatch(pool, {
        fetchImpl: async () => { assert.fail("failed claims must not call Census"); },
      }), error => error === primaryError);
      assert.equal(statements.at(-1), "ROLLBACK");
      assert.equal(statements.filter(sql => sql === "ROLLBACK").length, 1);
      assert.equal(releases.length, 1);
      if (rollbackFails) {
        assert.ok(releases[0] instanceof Error);
        assert.equal(releases[0].message, "census_geography_rollback_failed");
        assert.notEqual(releases[0], primaryError);
        assert.notEqual(releases[0], rollbackError);
      } else {
        assert.equal(releases[0], undefined);
      }
    });
  }
}

test("an empty Census claim commits and releases a reusable client", async () => {
  const statements = [];
  const releases = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rows: [] };
    },
    release(error) { releases.push(error); },
  };
  const result = await runCensusGeographyBatch({
    async connect() { return client; },
    async query() { assert.fail("an empty batch needs no settlement"); },
  }, {
    workerId: "claim-test-worker",
    batchSize: 7,
    fetchImpl: async () => { assert.fail("an empty batch must not call Census"); },
  });
  assert.deepEqual(result, { claimed: 0, matched: 0, retry: 0, reviewRequired: 0 });
  assert.equal(statements[0].sql, "BEGIN");
  assert.match(statements[1].sql, /SET status = 'retry'/);
  assert.deepEqual(statements[2].params, [7, "claim-test-worker"]);
  assert.equal(statements[3].sql, "COMMIT");
  assert.equal(statements.length, 4);
  assert.deepEqual(releases, [undefined]);
});

test("Census connection failure preserves its cause without provider or settlement work", async () => {
  const primaryError = new Error("claim connection unavailable");
  await assert.rejects(runCensusGeographyBatch({
    async connect() { throw primaryError; },
    async query() { assert.fail("connection failure must not settle claims"); },
  }, {
    fetchImpl: async () => { assert.fail("connection failure must not call Census"); },
  }), error => error === primaryError);
});

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
