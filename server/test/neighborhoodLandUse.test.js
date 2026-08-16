import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateLandUsePercentages,
  buildNeighborhoodPropertyProfile,
  buildNeighborhoodLandUseAnalysis,
  classifyBuiltUpBand,
  classifyDcadLandUse,
  clearNeighborhoodLandUseAnalysisCache,
  evaluateSubjectSiteSize,
  fetchDcadLandUseParcels,
  isDcadParcelBuiltUp,
} from "../src/services/neighborhoodLandUse.js";

test("profiles all improved one-unit properties whether or not they sold", () => {
  const profile = buildNeighborhoodPropertyProfile([
    {
      classification: { category: "one_unit" },
      built_up: true,
      attributes: { CNTASSDVAL: 200_000, RESFLRAREA: 1_000, RESYRBLT: 2000 },
    },
    {
      classification: { category: "one_unit" },
      built_up: true,
      attributes: { CNTASSDVAL: 300_000, RESFLRAREA: 1_500, RESYRBLT: 2010 },
    },
    {
      classification: { category: "one_unit" },
      built_up: true,
      attributes: { CNTASSDVAL: 500_000, RESFLRAREA: 2_500, RESYRBLT: 2020 },
    },
    {
      classification: { category: "commercial" },
      built_up: true,
      attributes: { CNTASSDVAL: 9_000_000, BLDGAREA: 50_000, RESYRBLT: 1990 },
    },
    {
      classification: { category: "one_unit" },
      built_up: false,
      attributes: { CNTASSDVAL: 100_000 },
    },
  ], { asOfYear: 2026 });

  assert.equal(profile.property_count, 3);
  assert.deepEqual(profile.house_price, {
    count: 3,
    low: 200_000,
    high: 500_000,
    predominant: 300_000,
  });
  assert.deepEqual(profile.price_per_square_foot, {
    count: 3,
    low: 200,
    high: 200,
    predominant: 200,
  });
  assert.deepEqual(profile.age, { count: 3, low: 6, high: 26, predominant: 16 });
  assert.deepEqual(profile.living_area, {
    count: 3,
    low: 1_000,
    high: 2_500,
    predominant: 1_500,
  });
});

test("classifies common DCAD land-use descriptions", () => {
  assert.equal(classifyDcadLandUse({ USEDSCRP: "SINGLE FAMILY RESIDENCE" }).category, "one_unit");
  assert.equal(classifyDcadLandUse({ USEDSCRP: "DUPLEX" }).category, "two_to_four_unit");
  assert.equal(classifyDcadLandUse({ USEDSCRP: "APARTMENT COMPLEX" }).category, "multifamily");
  assert.equal(classifyDcadLandUse({ USEDSCRP: "RETAIL SHOPPING CENTER" }).category, "commercial");
  assert.equal(classifyDcadLandUse({ USEDSCRP: "VACANT LAND" }).category, "other_vacant");
  assert.equal(classifyDcadLandUse({ CLASSCD: "6", CLASSDSCRP: "MFR - DUPLEXES" }).category, "two_to_four_unit");
  assert.equal(classifyDcadLandUse({ CLASSCD: "5", CLASSDSCRP: "MFR - APARTMENTS" }).category, "multifamily");
  assert.equal(classifyDcadLandUse({ CLASSCD: "7", CLASSDSCRP: "SFR - VACANT LOTS/TRACTS" }).category, "other_vacant");
});

test("flags ambiguous residential and mixed uses for appraiser review", () => {
  const condo = classifyDcadLandUse({ USEDSCRP: "CONDOMINIUMS" });
  assert.equal(condo.category, "one_unit");
  assert.equal(condo.requires_review, true);
  const mixed = classifyDcadLandUse({ USEDSCRP: "MIXED USE DEVELOPMENT" });
  assert.equal(mixed.category, "commercial");
  assert.equal(mixed.requires_review, true);
});

test("allocates one-decimal percentages that total exactly one hundred", () => {
  const result = allocateLandUsePercentages({
    one_unit: 1,
    two_to_four_unit: 1,
    multifamily: 1,
    commercial: 1,
    other_vacant: 1,
  });
  assert.deepEqual(result, {
    one_unit: 20,
    two_to_four_unit: 20,
    multifamily: 20,
    commercial: 20,
    other_vacant: 20,
  });
  assert.equal(Object.values(allocateLandUsePercentages({
    one_unit: 7,
    two_to_four_unit: 3,
    multifamily: 2,
    commercial: 5,
    other_vacant: 4,
  })).reduce((sum, value) => sum + value, 0), 100);
});

test("derives built-up status and the appraisal checkbox band from DCAD fields", () => {
  assert.equal(isDcadParcelBuiltUp({ CLASSCD: "1", IMPVALUE: 0 }), true);
  assert.equal(isDcadParcelBuiltUp({ CLASSCD: "7", IMPVALUE: 25_000 }), false);
  assert.equal(isDcadParcelBuiltUp({ CLASSCD: "0", IMPVALUE: 25_000 }), true);
  assert.equal(isDcadParcelBuiltUp({ CLASSCD: "0", IMPVALUE: 0 }), false);
  assert.deepEqual(classifyBuiltUpBand(75.1), { key: "over_75", label: "Over 75%" });
  assert.deepEqual(classifyBuiltUpBand(75), { key: "25_to_75", label: "25-75%" });
  assert.deepEqual(classifyBuiltUpBand(25), { key: "25_to_75", label: "25-75%" });
  assert.deepEqual(classifyBuiltUpBand(24.9), { key: "under_25", label: "Under 25%" });
});

test("flags a subject site only when it is smaller than at least three same-use parcels", () => {
  const classifiedParcels = [
    { account_id: "26272500060150000", classification: { category: "one_unit" } },
    { account_id: "A", classification: { category: "one_unit" } },
    { account_id: "B", classification: { category: "one_unit" } },
    { account_id: "C", classification: { category: "one_unit" } },
    { account_id: "D", classification: { category: "commercial" } },
  ];
  const result = evaluateSubjectSiteSize(
    "26272500060150000",
    classifiedParcels,
    new Map([[0, 5_000], [1, 6_500], [2, 7_500], [3, 8_500], [4, 1_000]]),
  );
  assert.deepEqual(result, {
    subject_site_area_sqft: 5_000,
    comparison_min_site_area_sqft: 6_500,
    comparison_median_site_area_sqft: 7_500,
    comparison_parcel_count: 3,
    subject_smaller_than_all_comparisons: true,
  });
});

test("does not create a site-size flag when the subject parcel cannot be matched", () => {
  assert.deepEqual(evaluateSubjectSiteSize("missing", [], new Map()), {
    subject_site_area_sqft: null,
    comparison_min_site_area_sqft: null,
    comparison_median_site_area_sqft: null,
    comparison_parcel_count: 0,
    subject_smaller_than_all_comparisons: false,
  });
});

test("loads every intersecting DCAD parcel by object id with classification fields", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const params = new URLSearchParams(String(options.body));
    requests.push(params);
    if (params.get("returnIdsOnly") === "true") {
      return { ok: true, json: async () => ({ objectIds: [22, 11, 22] }) };
    }
    return {
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            id: 11,
            properties: {
              OBJECTID: 11,
              PARCELID: "26272500060150000",
              USECD: "1",
              USEDSCRP: "Residential",
              CLASSCD: "1",
              CLASSDSCRP: "SINGLE FAMILY RESIDENCES",
            },
            geometry: {
              type: "Polygon",
              coordinates: [[[-96.7, 32.9], [-96.69, 32.9], [-96.69, 32.91], [-96.7, 32.9]]],
            },
          },
        ],
      }),
    };
  };
  const parcels = await fetchDcadLandUseParcels({
    type: "Polygon",
    coordinates: [[[-96.7, 32.9], [-96.6, 32.9], [-96.6, 33], [-96.7, 32.9]]],
  }, { fetchImpl });
  assert.equal(parcels.length, 1);
  assert.equal(parcels[0].class_code, "1");
  assert.equal(parcels[0].class_description, "SINGLE FAMILY RESIDENCES");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].get("spatialRel"), "esriSpatialRelIntersects");
  assert.equal(requests[1].get("objectIds"), "22,11");
  assert.match(requests[1].get("outFields"), /CLASSDSCRP/);
});

test("loads large DCAD parcel sets with bounded parallel batch requests", async () => {
  let activeBatches = 0;
  let maximumActiveBatches = 0;
  let batchRequests = 0;
  const fetchImpl = async (_url, options) => {
    const params = new URLSearchParams(String(options.body));
    if (params.get("returnIdsOnly") === "true") {
      return {
        ok: true,
        json: async () => ({ objectIds: Array.from({ length: 4_001 }, (_, index) => index + 1) }),
      };
    }
    batchRequests += 1;
    activeBatches += 1;
    maximumActiveBatches = Math.max(maximumActiveBatches, activeBatches);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeBatches -= 1;
    const firstId = Number(params.get("objectIds").split(",")[0]);
    return {
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          id: firstId,
          properties: { OBJECTID: firstId, PARCELID: String(firstId).padStart(17, "0"), CLASSCD: "1" },
          geometry: {
            type: "Polygon",
            coordinates: [[[-96.7, 32.9], [-96.69, 32.9], [-96.69, 32.91], [-96.7, 32.9]]],
          },
        }],
      }),
    };
  };
  const parcels = await fetchDcadLandUseParcels({
    type: "Polygon",
    coordinates: [[[-96.7, 32.9], [-96.6, 32.9], [-96.6, 33], [-96.7, 32.9]]],
  }, { fetchImpl });
  assert.equal(batchRequests, 3);
  assert.equal(maximumActiveBatches, 3);
  assert.equal(parcels.length, 3);
});

test("reuses a completed neighborhood analysis for the same subject and boundary", async () => {
  clearNeighborhoodLandUseAnalysisCache();
  const boundary = {
    type: "Polygon",
    coordinates: [[[-96.7, 32.9], [-96.6, 32.9], [-96.6, 33], [-96.7, 32.9]]],
  };
  let fetchRequests = 0;
  const fetchImpl = async (_url, options) => {
    fetchRequests += 1;
    const params = new URLSearchParams(String(options.body));
    if (params.get("returnIdsOnly") === "true") {
      return { ok: true, json: async () => ({ objectIds: [1] }) };
    }
    return {
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          id: 1,
          properties: {
            OBJECTID: 1,
            PARCELID: "26272500060150000",
            CLASSCD: "1",
            IMPVALUE: 250_000,
          },
          geometry: {
            type: "Polygon",
            coordinates: [[[-96.7, 32.9], [-96.69, 32.9], [-96.69, 32.91], [-96.7, 32.9]]],
          },
        }],
      }),
    };
  };
  let databaseQueries = 0;
  const pool = {
    query: async (sql) => {
      databaseQueries += 1;
      if (String(sql).includes("FROM core.accounts")) {
        return { rows: [{ account_id: "26272500060150000", county: "Dallas" }] };
      }
      return { rows: [{
        boundary_area_sqft: 1_000,
        covered_area_sqft: 500,
        built_up_area_sqft: 500,
        built_up_parcel_count: 1,
        raw_category_area_sqft: 500,
        category_areas: { one_unit: 500 },
        parcel_areas: [{ source_index: 0, area_sqft: 500, full_area_sqft: 600 }],
      }] };
    },
  };
  const first = await buildNeighborhoodLandUseAnalysis(pool, {
    subjectAccountId: "26272500060150000",
    customGeometry: boundary,
    fetchImpl,
    preferLocalMirror: false,
    persistentCache: false,
  });
  const second = await buildNeighborhoodLandUseAnalysis(pool, {
    subjectAccountId: "26272500060150000",
    customGeometry: boundary,
    fetchImpl,
    preferLocalMirror: false,
    persistentCache: false,
  });
  assert.equal(first.cache_hit, false);
  assert.equal(second.cache_hit, true);
  assert.equal(fetchRequests, 2);
  assert.equal(databaseQueries, 2);
  clearNeighborhoodLandUseAnalysisCache();
});
