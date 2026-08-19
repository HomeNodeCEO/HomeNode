import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOM_APPRAISAL_REPORT_PAGE_COUNT,
  customAppraisalReportFileName,
  customAppraisalReportReadinessErrors,
  renderCustomAppraisalReportPdf,
} from "../src/services/customAppraisalReportPdf.js";
import { customAppraisalReportFixture } from "./fixtures/customAppraisalReportFixture.js";

test("fixed-layout appraisal PDF is valid, named, and contains nine Letter pages", async () => {
  const { snapshot, property } = customAppraisalReportFixture();
  const content = await renderCustomAppraisalReportPdf({
    snapshot,
    property,
    checksum: "a".repeat(64),
  });
  assert.equal(content.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.ok(content.length > 20_000);
  const pageObjects = content.toString("latin1").match(/\/Type \/Page\b/g) || [];
  assert.equal(pageObjects.length, CUSTOM_APPRAISAL_REPORT_PAGE_COUNT);
  assert.equal(customAppraisalReportFileName(snapshot), "fas-2026-00125-125.appraisal-report.pdf");
});

test("signing readiness reports material E&O omissions", () => {
  const { snapshot, property } = customAppraisalReportFixture();
  assert.deepEqual(customAppraisalReportReadinessErrors(snapshot, property), []);
  delete snapshot.sections.sales_comparison.value.opinionOfValue;
  property.assignment.assignment_details.neighborhood_boundary_east = "";
  const errors = customAppraisalReportReadinessErrors(snapshot, property);
  assert.ok(errors.some((error) => /east neighborhood boundary/i.test(error)));
  assert.ok(errors.some((error) => /positive Sales Comparison Approach value/i.test(error)));
});
