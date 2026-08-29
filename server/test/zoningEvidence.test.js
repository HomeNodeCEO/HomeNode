import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOfficialZoningAtPoint,
  getPropertyZoningEvidence,
} from "../src/services/zoningEvidence.js";
import { DALLAS_COUNTY_ZONING_JURISDICTIONS } from "../src/services/propertyZoningSources.js";

test("property zoning evidence only accepts the subject city's official GIS provider", async () => {
  let automaticLookup = null;
  const pool = {
    async query(sql, values = []) {
      if (/CREATE TABLE IF NOT EXISTS gis\.zoning_source_documents/.test(sql)) {
        return { rows: [] };
      }
      if (/FROM core\.accounts account/.test(sql)) {
        return {
          rows: [{
            account_id: "00000000000000000",
            address: "1 TEST ST",
            city: "Dallas",
            county: "Dallas",
            latitude: 32.8,
            longitude: -96.8,
          }],
        };
      }
      if (/FROM gis\.zoning_source_documents/.test(sql)) return { rows: [] };
      if (/FROM app\.property_zoning_verifications/.test(sql)) return { rows: [] };
      if (/FROM core\.land_detail/.test(sql)) return { rows: [] };
      if (/JOIN gis\.zoning_districts zoning/.test(sql)) {
        automaticLookup = { sql, values };
        return { rows: [] };
      }
      throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
    },
  };

  const result = await getPropertyZoningEvidence(pool, {
    accountId: "00000000000000000",
    fetchImpl: async () => ({ ok: true, json: async () => ({ features: [] }) }),
  });

  assert.equal(result.jurisdiction.provider_key, "city_dallas_official");
  assert.match(automaticLookup.sql, /zoning\.provider_key = \$2/);
  assert.deepEqual(automaticLookup.values, [
    "00000000000000000",
    "city_dallas_official",
  ]);
});

test("live official zoning lookup maps Duncanville's current GIS attributes", async () => {
  const jurisdiction = DALLAS_COUNTY_ZONING_JURISDICTIONS.find(
    (entry) => entry.city === "Duncanville",
  );
  let requestedUrl = null;
  const result = await fetchOfficialZoningAtPoint(jurisdiction, {
    latitude: 32.65,
    longitude: -96.9,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return {
        ok: true,
        async json() {
          return { features: [{ attributes: {
            FID: 15,
            NEW_ZONING: "SF-10, Single-Family Residential District (SF-10)",
          } }] };
        },
      };
    },
  });

  assert.equal(requestedUrl.origin, "https://services3.arcgis.com");
  assert.equal(requestedUrl.pathname.endsWith("/Zoning_view/FeatureServer/0/query"), true);
  assert.equal(requestedUrl.searchParams.get("outFields"), "FID,NEW_ZONING");
  assert.equal(requestedUrl.searchParams.get("geometryType"), "esriGeometryPoint");
  assert.equal(result.zoning_code, "SF-10");
  assert.equal(result.zoning_description, "Single-Family Residential District (SF-10)");
  assert.equal(result.source_record_id, "15");
  assert.equal(result.lookup_mode, "official_gis_live");
});

test("live Duncanville zoning lookup classifies numbered planned developments", async () => {
  const jurisdiction = DALLAS_COUNTY_ZONING_JURISDICTIONS.find(
    (entry) => entry.city === "Duncanville",
  );
  const result = await fetchOfficialZoningAtPoint(jurisdiction, {
    latitude: 32.65,
    longitude: -96.9,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { features: [{ attributes: { FID: 16, NEW_ZONING: "PD-12" } }] };
      },
    }),
  });

  assert.equal(result.zoning_code, "PD-12");
  assert.equal(result.zoning_description, "Planned Development District");
});

test("review-required zoning retains the best CAD suggestion for appraiser review", async () => {
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS gis\.zoning_source_documents/.test(sql)) return { rows: [] };
      if (/FROM core\.accounts account/.test(sql)) {
        return { rows: [{
          account_id: "221508800I0190000",
          address: "1402 AARON PL",
          city: "Duncanville",
          county: "Dallas",
          latitude: null,
          longitude: null,
        }] };
      }
      if (/FROM gis\.zoning_source_documents/.test(sql)) return { rows: [] };
      if (/FROM app\.property_zoning_verifications/.test(sql)) return { rows: [] };
      if (/JOIN gis\.zoning_districts zoning/.test(sql)) return { rows: [] };
      if (/FROM core\.account_locations/.test(sql)) return { rows: [] };
      if (/FROM core\.land_detail/.test(sql)) {
        return { rows: [{ zoning: "PD, Planned Development District" }] };
      }
      throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
    },
  };

  const result = await getPropertyZoningEvidence(pool, {
    accountId: "221508800I0190000",
    refreshLocationsImpl: async () => ({ matched: 0 }),
  });
  assert.equal(result.review_required, true);
  assert.equal(result.automatic_result, null);
  assert.equal(result.suggested_result.zoning_code, "PD");
  assert.equal(result.suggested_result.zoning_description, "Planned Development District");
  assert.equal(result.jurisdiction.contact.planningPhone, "972-707-3878 / 972-707-3876");
  assert.equal(result.jurisdiction.contact.buildingPhone, "972-780-5000");
});

test("missing coordinates are repaired on demand before official zoning lookup", async () => {
  let refreshed = false;
  const pool = {
    async query(sql) {
      if (/CREATE TABLE IF NOT EXISTS gis\.zoning_source_documents/.test(sql)) return { rows: [] };
      if (/FROM core\.accounts account/.test(sql)) {
        return { rows: [{
          account_id: "221508800I0190000",
          address: "1402 AARON PL",
          city: "Duncanville",
          county: "Dallas",
          latitude: null,
          longitude: null,
        }] };
      }
      if (/FROM core\.account_locations\s+WHERE/.test(sql)) {
        return refreshed
          ? { rows: [{ latitude: 32.634289703627, longitude: -96.89040171769 }] }
          : { rows: [] };
      }
      if (/FROM gis\.zoning_source_documents/.test(sql)) return { rows: [] };
      if (/FROM app\.property_zoning_verifications/.test(sql)) return { rows: [] };
      if (/JOIN gis\.zoning_districts zoning/.test(sql)) return { rows: [] };
      if (/FROM core\.land_detail/.test(sql)) return { rows: [] };
      throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
    },
  };

  const result = await getPropertyZoningEvidence(pool, {
    accountId: "221508800I0190000",
    refreshLocationsImpl: async () => {
      refreshed = true;
      return { matched: 1 };
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { features: [{ attributes: {
          FID: 7,
          NEW_ZONING: "PD, Planned Development District",
        } }] };
      },
    }),
  });

  assert.equal(refreshed, true);
  assert.equal(result.review_required, false);
  assert.equal(result.automatic_result.zoning_code, "PD");
  assert.equal(result.automatic_result.zoning_description, "Planned Development District");
});
