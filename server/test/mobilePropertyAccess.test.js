import assert from "node:assert/strict";
import test from "node:test";

import { searchMobileProperties } from "../src/modules/mobile/properties.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";

function propertyRow() {
  return {
    account_id: "10909-SNOWMASS",
    address: "10909 Snowmass Lane",
    city: "Garland",
    postal_code: "75044",
    county: "Dallas",
    neighborhood_code: "N-1",
    subdivision: "Synthetic Estates",
    year_built: 1980,
    living_area_sqft: 1800,
    bedroom_count: 3,
    bath_count: 2,
    report_file_id: "21111111-1111-4111-8111-111111111111",
    report_file_organization_id: ORGANIZATION_ID,
    workflow_type: "custom_appraisal",
    file_number: "CA-2026-000001",
    is_current: true,
    report_file_updated_at: "2026-09-01T12:00:00.000Z",
  };
}

test("mobile property search never attaches files for memberships without a workflow role", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [propertyRow()] };
    },
  };
  const auth = {
    userId: "71111111-1111-4111-8111-111111111111",
    organizations: [{ organizationId: ORGANIZATION_ID, roles: [] }],
  };
  const result = await searchMobileProperties(pool, auth, { query: "Snowmass" });
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0].workflows, {
    custom_appraisal: { count: 0, current_file: null },
    uad_3_6: { count: 0, current_file: null },
    property_tax_protest: { count: 0, current_file: null },
  });
  assert.deepEqual(calls[0].params, ["Snowmass", "%Snowmass%", [], [], 20]);
  assert.match(calls[0].sql, /unnest\(\$3::uuid\[\], \$4::text\[\]\)/);
});

test("mobile property search attaches only an authorized workflow file", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [propertyRow()] };
    },
  };
  const auth = {
    userId: "71111111-1111-4111-8111-111111111111",
    organizations: [{ organizationId: ORGANIZATION_ID, roles: ["read_only"] }],
  };
  const result = await searchMobileProperties(pool, auth, { query: "Snowmass", limit: 10 });
  assert.equal(result.results[0].workflows.custom_appraisal.count, 1);
  assert.equal(
    result.results[0].workflows.custom_appraisal.current_file.file_number,
    "CA-2026-000001",
  );
  assert.deepEqual(calls[0].params, [
    "Snowmass",
    "%Snowmass%",
    [ORGANIZATION_ID, ORGANIZATION_ID, ORGANIZATION_ID],
    ["custom_appraisal", "uad_3_6", "property_tax_protest"],
    10,
  ]);
});
