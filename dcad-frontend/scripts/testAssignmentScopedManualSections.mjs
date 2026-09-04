import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyReportManualValues } from "../src/lib/legacyDcadDetail.ts";

const directory = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath) => fs.readFileSync(path.resolve(directory, relativePath), "utf8");

function baseDetail() {
  return {
    property_location: { address: "1 Original St", county: "Dallas" },
    owner: { owner_name: "Original Owner", parties: [] },
    value_summary: { market_value: 100_000 },
    main_improvement: { living_area_sqft: 1_000 },
    housing_profile: { housing_type: "Single Family Detached" },
    additional_improvements: [],
    secondary_improvements: [],
    land_detail: [{ land_type: "Residential" }],
    exemptions: {},
    legal_description: { lines: ["LOT 1"] },
    homestead_yes: false,
    sales_history: [],
    property_activity_history: [],
    census_geography: null,
    property_context: null,
    photos: [],
    assignment_details: { appraisal_purpose: "Purchase" },
    report_manual_values: {},
  };
}

test("assignment-scoped report sections overlay the report without mutating source detail", () => {
  const source = baseDetail();
  const scoped = applyReportManualValues(source, {
    "report.subject_identification": {
      value: {
        property_location: { address: "2 Reviewed St" },
        owner: { owner_name: "Reviewed Owner", parties: [] },
      },
    },
    "report.property_characteristics": {
      value: { main_improvement: { living_area_sqft: 1_250 } },
    },
    "report.appraisal_values": {
      value: { value_summary: { market_value: 150_000 } },
    },
  });

  assert.equal(scoped.property_location.address, "2 Reviewed St");
  assert.equal(scoped.property_location.county, "Dallas");
  assert.equal(scoped.owner.owner_name, "Reviewed Owner");
  assert.equal(scoped.main_improvement.living_area_sqft, 1_250);
  assert.equal(scoped.value_summary.market_value, 150_000);
  assert.deepEqual(scoped.assignment_details, { appraisal_purpose: "Purchase" });
  assert.equal(source.property_location.address, "1 Original St");
  assert.equal(source.main_improvement.living_area_sqft, 1_000);
  assert.equal(source.value_summary.market_value, 100_000);
});

test("browser saves send the selected assignment and hydrate its returned revision", () => {
  const api = read("../src/lib/api.ts");
  const hook = read("../src/hooks/useManualReportSections.ts");
  const scopedHook = read("../src/hooks/useAssignmentScopedReportSections.ts");
  const report = read("../src/pages/PropertyReport.tsx");

  assert.match(api, /assignment_file_id: assignmentFileId \|\| undefined/);
  assert.match(hook, /Choose or start a Custom Appraisal assignment file/);
  assert.match(hook, /onSaved\?\.\(response\.manual_values\)/);
  assert.match(hook, /This report section changed after you opened it/);
  assert.match(scopedHook, /applyReportManualValues/);
  assert.match(scopedHook, /getAssignmentFiles\(accountId, activeAssignmentFile\.id\)/);
  assert.match(scopedHook, /custom_appraisal_sections: sections/);
  assert.match(scopedHook, /assignmentFileId: activeAssignmentFile\?\.id \|\| null/);
  assert.match(report, /useAssignmentScopedReportSections/);
});
