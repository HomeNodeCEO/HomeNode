import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchArcGisObjectIds,
  normalizeDcadParcelFeature,
  normalizeRoadFeature,
  syncDcadPropertyContext,
} from "../src/services/propertyContextSync.js";

test("ArcGIS object IDs are numeric, unique, and sorted", async () => {
  let requestBody = null;
  const objectIds = await fetchArcGisObjectIds("https://example.test/query", {
    where: "LASTUPDATE IS NOT NULL",
    fetchImpl: async (_url, options) => {
      requestBody = new URLSearchParams(String(options.body));
      return {
        ok: true,
        json: async () => ({ objectIds: [9, "2", 9, 4, null, "bad"] }),
      };
    },
  });

  assert.deepEqual(objectIds, [2, 4, 9]);
  assert.equal(requestBody.get("returnIdsOnly"), "true");
  assert.equal(requestBody.get("where"), "LASTUPDATE IS NOT NULL");
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
  assert.equal(record.geometry.type, "Polygon");
  assert.equal(record.source_record_hash.length, 64);
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

test("an implausibly small full DCAD response cannot delete the last good mirror", async () => {
  const statements = [];
  const pool = {
    query: async (sql, params) => {
      statements.push({ sql: String(sql), params });
      if (String(sql).includes("SELECT last_success_at")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ objectIds: [1, 2, 3] }),
  });

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
    statements.some(({ sql, params }) => (
      params && sql.trim().split(";").filter(Boolean).length > 1
    )),
    false,
    "parameterized sync queries must contain a single PostgreSQL statement",
  );
});
