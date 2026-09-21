import assert from "node:assert/strict";
import test from "node:test";

import {
  deduplicateSourceRecords,
  fetchArcGisObjectIds,
  normalizeDcadParcelFeature,
  normalizeFemaFloodFeature,
  normalizeOfficialZoningFeature,
  normalizeRoadFeature,
  normalizeTrafficVolumeFeature,
  propertyContextSyncInternals,
  rebuildRoadGraph,
  requestArcGis,
  syncDcadPropertyContext,
  syncOfficialZoningContext,
  syncTigerRoadContext,
  syncTxdotTrafficContext,
  tigerRoadOutFields,
} from "../src/services/propertyContextSync.js";

function arcGisResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("rebuilds durable road corridors and intersection graph from the local mirror", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      if (/SELECT[\s\S]+corridor_count/.test(String(sql))) {
        return { rows: [{ corridor_count: 200, node_count: 500, edge_count: 700 }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await rebuildRoadGraph(pool);
  assert.equal(result.corridor_count, 200);
  assert.ok(statements.some((sql) => /gis\.road_corridor_aliases/.test(sql)));
  assert.ok(statements.some((sql) => /TRUNCATE gis\.road_graph_edges/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO gis\.road_graph_edges/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO gis\.road_graph_nodes/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO gis\.road_corridors/.test(sql)));
});

test("ArcGIS object IDs are numeric, unique, and sorted", async () => {
  let requestBody = null;
  const objectIds = await fetchArcGisObjectIds("https://example.test/query", {
    where: "LASTUPDATE IS NOT NULL",
    fetchImpl: async (_url, options) => {
      requestBody = new URLSearchParams(String(options.body));
      assert.equal(options.redirect, "error");
      assert.equal(options.signal instanceof AbortSignal, true);
      return arcGisResponse({ objectIds: [9, "2", 9, 4, null, "bad"] });
    },
  });

  assert.deepEqual(objectIds, [2, 4, 9]);
  assert.equal(requestBody.get("returnIdsOnly"), "true");
  assert.equal(requestBody.get("where"), "LASTUPDATE IS NOT NULL");
});

test("ArcGIS requests reject unsafe URLs before issuing a request", async () => {
  let calls = 0;
  for (const url of [
    "http://example.test/query",
    "https://user:secret@example.test/query",
    "https://example.test/query?token=secret",
    "https://example.test/query#fragment",
  ]) {
    await assert.rejects(
      requestArcGis(url, { f: "json" }, {
        fetchImpl: async () => {
          calls += 1;
          return arcGisResponse({});
        },
        maximumAttempts: 1,
      }),
      { message: "property_context_source_url_invalid" },
    );
  }
  assert.equal(calls, 0);
});

test("ArcGIS requests reject and cancel oversized responses", async () => {
  let cancelled = false;
  await assert.rejects(
    requestArcGis("https://example.test/query", { f: "json" }, {
      maximumAttempts: 1,
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }), {
        headers: {
          "content-length": String(propertyContextSyncInternals.MAX_ARCGIS_RESPONSE_BYTES + 1),
          "content-type": "application/json",
        },
      }),
    }),
    { message: "property_context_source_response_too_large" },
  );
  assert.equal(cancelled, true);
});

test("ArcGIS request deadlines remain active through stalled response bodies", async () => {
  let aborted = false;
  let keepAlive;
  try {
    await assert.rejects(
      requestArcGis("https://example.test/query", { f: "json" }, {
        timeoutMs: 250,
        maximumAttempts: 1,
        fetchImpl: async (_url, options) => new Response(new ReadableStream({
          start(controller) {
            keepAlive = setTimeout(() => {}, 1_000);
            options.signal.addEventListener("abort", () => {
              aborted = true;
              clearTimeout(keepAlive);
              controller.error(new Error("private ArcGIS transport detail"));
            }, { once: true });
          },
        }), { headers: { "content-type": "application/json" } }),
      }),
      { message: "property_context_source_timeout" },
    );
    assert.equal(aborted, true);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("ArcGIS HTTP and provider failures are cancelled and sanitized", async () => {
  let cancelled = false;
  await assert.rejects(
    requestArcGis("https://example.test/query", { f: "json" }, {
      maximumAttempts: 1,
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }), { status: 503 }),
    }),
    { message: "property_context_source_http_503" },
  );
  assert.equal(cancelled, true);

  await assert.rejects(
    requestArcGis("https://example.test/query", { f: "json" }, {
      maximumAttempts: 1,
      fetchImpl: async () => arcGisResponse({
        error: { code: 499, message: "private provider diagnostic" },
      }),
    }),
    { message: "property_context_source_provider_499" },
  );
});

test("ArcGIS malformed JSON and invalid tuning values fail within fixed bounds", async () => {
  let calls = 0;
  await assert.rejects(
    requestArcGis("https://example.test/query", { f: "json" }, {
      timeoutMs: Number.POSITIVE_INFINITY,
      maximumAttempts: Number.POSITIVE_INFINITY,
      fetchImpl: async () => {
        calls += 1;
        return new Response("not-json");
      },
    }),
    { message: "property_context_source_invalid_response" },
  );
  assert.equal(calls, 3);
});

test("DCAD parcel normalization retains appraisal and land-use evidence", () => {
  const record = normalizeDcadParcelFeature({
    type: "Feature",
    id: 42,
    properties: {
      OBJECTID: 42,
      PARCELID: "26272500060150000",
      SITEADDRESS: "1909 SNOWMASS LN",
      CLASSCD: "1",
      CLASSDSCRP: "SINGLE FAMILY RESIDENCES",
      RESFLRAREA: 1_850,
      RESYRBLT: 1978,
      IMPVALUE: 200_000,
      LASTUPDATE: 8.64e15 + 1,
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[-96.7, 32.9], [-96.69, 32.9], [-96.69, 32.91], [-96.7, 32.9]]],
    },
  }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

  assert.equal(record.account_id, "26272500060150000");
  assert.equal(record.land_use_category, "one_unit");
  assert.equal(record.residential_area_sqft, 1_850);
  assert.equal(record.residential_year_built, 1978);
  assert.equal(record.built_up, true);
  assert.equal(record.source_updated_at, null);
  assert.equal(record.geometry.type, "Polygon");
  assert.equal(record.source_record_hash.length, 64);
});

test("DCAD parcel normalization rejects non-positive numeric source timestamps", () => {
  for (const lastUpdate of [0, -1, "-1000"]) {
    const record = normalizeDcadParcelFeature({
      type: "Feature",
      id: 42,
      properties: {
        OBJECTID: 42,
        PARCELID: "26272500060150000",
        LASTUPDATE: lastUpdate,
      },
      geometry: {
        type: "Polygon",
        coordinates: [[[-96.7, 32.9], [-96.69, 32.9], [-96.69, 32.91], [-96.7, 32.9]]],
      },
    }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    assert.equal(record.source_updated_at, null);
  }
});

test("road normalization retains the named road and source class", () => {
  const record = normalizeRoadFeature({
    type: "Feature",
    id: 7,
    properties: { OBJECTID: 7, NAME: "N GARLAND AVE", MTFCC: "S1200" },
    geometry: { type: "LineString", coordinates: [[-96.7, 32.9], [-96.69, 32.91]] },
  }, {
    runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sourceLayer: "tiger_roads_secondary",
    roadClass: "secondary",
    sourceVintage: "2025",
  });

  assert.equal(record.name, "N GARLAND AVE");
  assert.equal(record.road_class, "secondary");
  assert.equal(record.source_vintage, "2025");
});

test("TxDOT traffic normalization retains authoritative traffic volume and route evidence", () => {
  const record = normalizeTrafficVolumeFeature({
    type: "Feature",
    id: 19,
    properties: {
      OBJECTID: 19,
      RTE_NM: "SH0078-KG",
      RTE_PRFX: "SH",
      RTE_NBR: "78",
      RDBD_TYPE: "KG",
      AADT_CUR: 42_750,
      EXT_DATE: "08-10-2026",
    },
    geometry: { type: "LineString", coordinates: [[-96.7, 32.9], [-96.69, 32.91]] },
  }, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");

  assert.equal(record.source_key, "txdot_aadt");
  assert.equal(record.current_aadt, 42_750);
  assert.equal(record.route_number, "78");
  assert.equal(record.source_date, "2026-08-10T00:00:00.000Z");
});

test("railroad sync requests only fields exposed by the TIGER railroad layer", () => {
  assert.equal(tigerRoadOutFields(3).includes("RTTYP"), false);
  assert.equal(tigerRoadOutFields(3).includes("SUFTYPEABRV"), true);
  assert.equal(tigerRoadOutFields(0).includes("RTTYP"), true);
});

test("FEMA records are deduplicated by stable source identity before upsert", () => {
  const records = [
    { source_key: "fema_nfhl", source_record_id: "same", flood_zone: "A" },
    { source_key: "fema_nfhl", source_record_id: "same", flood_zone: "AE" },
    { source_key: "fema_nfhl", source_record_id: "other", flood_zone: "X" },
  ];
  assert.deepEqual(deduplicateSourceRecords(records), [records[1], records[2]]);
});

test("municipal zoning records are deduplicated by provider and source identity", () => {
  const records = [
    { provider_key: "city_duncanville_official", source_record_id: "multi_address:77", zoning_code: "SF-7" },
    { provider_key: "city_duncanville_official", source_record_id: "multi_address:77", zoning_code: "PD" },
    { provider_key: "city_duncanville_official", source_record_id: "single_parcel:77", zoning_code: "SF-7" },
  ];
  assert.deepEqual(deduplicateSourceRecords(records), [records[1], records[2]]);
});

test("FEMA flood normalization preserves zone and special-hazard status", () => {
  const record = normalizeFemaFloodFeature({
    type: "Feature",
    properties: {
      OBJECTID: 11,
      GFID: "shared-firm-dataset",
      FLD_AR_ID: "flood-area-11",
      FLD_ZONE: "AE",
      ZONE_SUBTY: "FLOODWAY",
      SFHA_TF: "T",
      STATIC_BFE: 518.4,
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[-96.7, 32.9], [-96.69, 32.9], [-96.69, 32.91], [-96.7, 32.9]]],
    },
  }, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(record.source_record_id, "flood-area-11");
  assert.equal(record.flood_zone, "AE");
  assert.equal(record.special_flood_hazard, true);
  assert.equal(record.static_base_flood_elevation, 518.4);
});

test("official zoning normalization retains provider provenance and generalized use", () => {
  const record = normalizeOfficialZoningFeature({
    type: "Feature",
    properties: { OBJECTID: 17, BASE_ZONE: "SF-7", MISC: "Single Family Residential" },
    geometry: {
      type: "Polygon",
      coordinates: [[[-96.7, 32.9], [-96.69, 32.9], [-96.69, 32.91], [-96.7, 32.9]]],
    },
  }, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
    providerKey: "city_test_official",
    jurisdiction: "Test City",
    zoningCodeFields: ["BASE_ZONE"],
    descriptionFields: ["MISC"],
  });
  assert.equal(record.provider_key, "city_test_official");
  assert.equal(record.zoning_code, "SF-7");
  assert.equal(record.generalized_use, "residential");
});

test("an implausibly small full DCAD response cannot delete the last good mirror", async () => {
  const statements = [];
  const pool = {
    query: async (sql, params) => {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (String(sql).includes("SELECT last_success_at")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  const fetchImpl = async () => arcGisResponse({ objectIds: [1, 2, 3] });

  await assert.rejects(
    syncDcadPropertyContext(pool, {
      mode: "full",
      fetchImpl,
      logger: { log() {} },
    }),
    /full_sync_incomplete_3/,
  );
  assert.equal(
    statements.some(({ sql }) => sql.includes("DELETE FROM gis.dcad_parcels")),
    false,
  );
  assert.equal(
    statements.some(({ sql }) => sql.includes("SET status = 'failed'")),
    true,
  );
  assert.equal(
    statements.some(({ sql }) => (
      sql.includes("SET status = 'failed'") && sql.includes("last_run_id = $3")
    )),
    true,
    "a superseded run must not overwrite the active source state",
  );
  assert.equal(
    statements.some(({ sql }) => sql.includes("pg_advisory_unlock")),
    true,
  );
  assert.equal(
    statements.some(({ sql, params }) => (
      params && sql.trim().split(";").filter(Boolean).length > 1
    )),
    false,
    "parameterized sync queries must contain a single PostgreSQL statement",
  );
});

test("an overlapping source sync is skipped before it creates a run", async () => {
  const clientStatements = [];
  let released = false;
  const client = {
    async query(sql) {
      clientStatements.push(String(sql));
      if (String(sql).includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: false }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    },
  };
  const pool = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return client;
    },
  };

  const result = await syncDcadPropertyContext(pool, {
    fetchImpl: async () => {
      throw new Error("source_fetch_must_not_run");
    },
  });

  assert.deepEqual(result, {
    source_key: "dcad_parcels",
    skipped: true,
    reason: "property_context_sync_already_running",
  });
  assert.equal(
    clientStatements.some((sql) => sql.includes("INSERT INTO gis.source_sync_runs")),
    false,
  );
  assert.equal(released, true);
});

test("multi-source sync contention preserves the iterable CLI response contract", async () => {
  function contendedPool() {
    return {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return {
          async query(sql) {
            if (String(sql).includes("pg_try_advisory_lock")) {
              return { rows: [{ acquired: false }] };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
    };
  }

  const [roads, zoning] = await Promise.all([
    syncTigerRoadContext(contendedPool()),
    syncOfficialZoningContext(contendedPool()),
  ]);

  assert.deepEqual(roads, [{
    source_key: "tiger_roads",
    skipped: true,
    reason: "property_context_sync_already_running",
  }]);
  assert.deepEqual(zoning, [{
    source_key: "official_zoning",
    skipped: true,
    reason: "property_context_sync_already_running",
  }]);
});

test("a partial full-sync feature response cannot delete the last good mirror", async () => {
  const statements = [];
  const pool = {
    async query(sql, params) {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      return { rows: [], rowCount: String(sql).includes("INSERT INTO gis.traffic_volume_segments") ? 1 : 0 };
    },
  };
  const objectIds = Array.from({ length: 1_000 }, (_, index) => index + 1);
  const fetchImpl = async (_url, options) => {
    const body = new URLSearchParams(String(options.body));
    if (body.get("returnIdsOnly") === "true") {
      return arcGisResponse({ objectIds });
    }
    return arcGisResponse({
      features: [{
        id: 1,
        properties: { OBJECTID: 1, AADT_CUR: 12_000 },
        geometry: {
          type: "LineString",
          coordinates: [[-96.7, 32.9], [-96.69, 32.91]],
        },
      }],
    });
  };

  await assert.rejects(
    syncTxdotTrafficContext(pool, {
      fetchImpl,
      batchSize: 1_000,
      concurrency: 1,
      logger: { log() {} },
    }),
    /full_sync_feature_mismatch_1000_1_1_1/,
  );
  assert.equal(
    statements.some(({ sql }) => sql.includes("DELETE FROM gis.traffic_volume_segments")),
    false,
  );
  assert.equal(
    statements.some(({ sql }) => sql.includes("SET status = 'failed'")),
    true,
  );
  assert.equal(
    statements.some(({ sql }) => sql.includes("pg_advisory_unlock")),
    true,
  );
});
