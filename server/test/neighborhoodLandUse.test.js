import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateLandUsePercentages,
  classifyDcadLandUse,
  fetchDcadLandUseParcels,
} from "../src/services/neighborhoodLandUse.js";

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
