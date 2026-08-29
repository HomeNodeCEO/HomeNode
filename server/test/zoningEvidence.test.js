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
          }],
        };
      }
      if (/FROM gis\.zoning_source_documents/.test(sql)) return { rows: [] };
      if (/FROM app\.property_zoning_verifications/.test(sql)) return { rows: [] };
      if (/JOIN gis\.zoning_districts zoning/.test(sql)) {
        automaticLookup = { sql, values };
        return { rows: [] };
      }
      throw new Error(`unexpected_query:${sql.slice(0, 80)}`);
    },
  };

  const result = await getPropertyZoningEvidence(pool, {
    accountId: "00000000000000000",
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
          return { features: [{ attributes: { FID: 15, NEW_ZONING: "SF-10" } }] };
        },
      };
    },
  });

  assert.equal(requestedUrl.origin, "https://services3.arcgis.com");
  assert.equal(requestedUrl.pathname.endsWith("/Zoning_view/FeatureServer/0/query"), true);
  assert.equal(requestedUrl.searchParams.get("outFields"), "FID,NEW_ZONING");
  assert.equal(requestedUrl.searchParams.get("geometryType"), "esriGeometryPoint");
  assert.equal(result.zoning_code, "SF-10");
  assert.equal(result.source_record_id, "15");
  assert.equal(result.lookup_mode, "official_gis_live");
});
