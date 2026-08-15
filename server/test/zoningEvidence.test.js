import assert from "node:assert/strict";
import test from "node:test";

import { getPropertyZoningEvidence } from "../src/services/zoningEvidence.js";

test("property zoning evidence only accepts the subject city's official GIS provider", async () => {
  let automaticLookup = null;
  const pool = {
    async query(sql, values = []) {
      if (/CREATE TABLE IF NOT EXISTS gis\.zoning_source_documents/.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT account_id, address, city, county/.test(sql)) {
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
