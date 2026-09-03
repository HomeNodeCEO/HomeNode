import assert from "node:assert/strict";
import test from "node:test";

import { saveDesktopPropertyTaxFile } from "../src/modules/mobile/desktopPropertyTax.js";
import { mergePropertyTaxWorkfileUpdate } from "../src/modules/mobile/propertyTaxWorkfile.js";

const FILE_ID = "00000000-0000-4000-8000-000000000711";
const REPORT_ID = "00000000-0000-4000-8000-000000000712";
const ACTOR_ID = "00000000-0000-4000-8000-000000000713";

function comparable(overrides = {}) {
  return {
    id: "district:41:1",
    source: "district_evidence",
    sourceLabel: "District evidence",
    sourceReference: "document:41:candidate:1",
    documentId: 41,
    documentPage: 2,
    saleId: "SALE-1",
    accountId: "ACCOUNT-1",
    address: "123 Main St",
    saleDate: "2026-01-15",
    salePrice: 300000,
    districtAdjustedValue: 295000,
    concessions: 0,
    adjustmentAmount: -5000,
    propertyUse: "single_family_residential",
    neighborhoodCode: "N-1",
    buildingClass: "17",
    livingAreaSqft: 1800,
    siteSizeSqft: 7500,
    yearBuilt: 1998,
    bedroomCount: 3,
    bathCount: 2,
    garageSpaces: 2,
    pool: false,
    reviewStatus: "verified",
    armsLength: true,
    ...overrides,
  };
}

test("desktop Property Tax updates change only reviewed fields and preserve stored extensions", () => {
  const stored = {
    legacy_extension: { retained: true },
    subject: {
      condition_rating: "C4",
      server_owned_future_state: { locked: true },
    },
    analysis: { server_packet_digest: "immutable" },
  };
  const submitted = {
    legacy_extension: { retained: true },
    protest_case: {
      district_code: "tx-dallas-cad",
      property_use: "single_family_residential",
      market_value_ground: "yes",
      unequal_appraisal_ground: "no",
      protest_status: "prepared",
    },
    subject: {
      condition_rating: "C3",
      living_area_sqft: "1850",
      server_owned_future_state: { locked: true },
    },
    analysis: {
      sales_comparison_notes: "Reviewed against district evidence.",
      server_packet_digest: "immutable",
      comparable_grid: {
        version: 1,
        rows: [comparable()],
        updated_at: "2026-09-02T12:00:00.000Z",
        recommendation_policy: "dcad-residential-comparables-2026.1",
      },
    },
  };

  const result = mergePropertyTaxWorkfileUpdate(stored, submitted);
  assert.equal(result.subject.condition_rating, "C3");
  assert.equal(result.subject.living_area_sqft, 1850);
  assert.deepEqual(result.legacy_extension, { retained: true });
  assert.deepEqual(result.subject.server_owned_future_state, { locked: true });
  assert.equal(result.analysis.server_packet_digest, "immutable");
  assert.equal(result.analysis.comparable_grid.rows[0].adjustmentAmount, -5000);
});

test("desktop Property Tax updates cannot create, alter, or delete unknown server-owned fields", () => {
  const stored = {
    subject: { condition_rating: "C4", server_state: { filing_status: "locked" } },
    immutable_packet: { checksum: "abc" },
  };

  assert.throws(
    () => mergePropertyTaxWorkfileUpdate(stored, {
      subject: { condition_rating: "C3", server_state: { filing_status: "open" } },
    }),
    /invalid_property_tax_protest_workfile/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate(stored, { new_server_switch: true }),
    /invalid_property_tax_protest_workfile/,
  );

  const omitted = mergePropertyTaxWorkfileUpdate(stored, { subject: { condition_rating: "C3" } });
  assert.deepEqual(omitted.immutable_packet, { checksum: "abc" });
  assert.deepEqual(omitted.subject.server_state, { filing_status: "locked" });
});

test("Property Tax comparable-grid input has exact bounded rows", () => {
  const grid = (rows) => ({
    analysis: {
      comparable_grid: {
        version: 1,
        rows,
        updated_at: null,
        recommendation_policy: "policy-1",
      },
    },
  });
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate({}, grid([comparable({ privileged: true })])),
    /invalid_property_tax_protest_workfile/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate({}, grid([comparable(), comparable()])),
    /invalid_property_tax_protest_workfile/,
  );
  assert.throws(
    () => mergePropertyTaxWorkfileUpdate({}, grid(Array.from({ length: 41 }, (_, index) => comparable({ id: `sale-${index}`, saleId: `sale-${index}` })))),
    /invalid_property_tax_protest_workfile/,
  );
});

test("authenticated desktop saves record the server identity on every audit record", async () => {
  const calls = [];
  const row = {
    report_file_id: REPORT_ID,
    registry_revision: 1,
    is_current: true,
    organization_id: "00000000-0000-4000-8000-000000000714",
    tax_protest_file_id: FILE_ID,
    account_id: "ACCOUNT-1",
    file_number: "PT-2026-1",
    previous_file_id: null,
    workfile_data: { subject: { condition_rating: "C4" } },
    assigned_appraiser_user_id: ACTOR_ID,
    status: "draft",
    revision: 1,
    completed_at: null,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  };
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("SELECT report_file.id")) return { rows: [row] };
      if (sql.includes("UPDATE app.tax_protest_files")) {
        return { rows: [{ ...row, revision: 2, status: "in_progress", workfile_data: JSON.parse(values[1]) }] };
      }
      if (sql.includes("UPDATE app.report_files")) return { rows: [{ registry_revision: 2 }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  await saveDesktopPropertyTaxFile(
    pool,
    "ACCOUNT-1",
    FILE_ID,
    {
      expected_revision: 1,
      workfile_data: { subject: { condition_rating: "C3" } },
      reviewer: "Browser supplied identity",
    },
    { actorUserId: ACTOR_ID, actorLabel: "Taylor Appraiser" },
  );

  const update = calls.find(({ sql }) => sql.includes("UPDATE app.tax_protest_files"));
  assert.match(update.sql, /updated_by_user_id = \$4/);
  assert.equal(update.values[3], ACTOR_ID);
  const history = calls.find(({ sql }) => sql.includes("INSERT INTO app.tax_protest_file_history"));
  assert.match(history.sql, /changed_by_user_id/);
  assert.equal(history.values[4], ACTOR_ID);
  assert.match(history.values[5], /Taylor Appraiser/);
  assert.doesNotMatch(history.values[5], /Browser supplied identity/);
  const event = calls.find(({ sql }) => sql.includes("INSERT INTO app.report_file_events"));
  assert.match(event.sql, /actor_user_id/);
  assert.equal(event.values[1], ACTOR_ID);
  assert.deepEqual(JSON.parse(event.values[5]), {
    tax_protest_revision: 2,
    reviewer: "Taylor Appraiser",
    authentication_mode: "authenticated",
  });
});
