import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCustomAppraisalReportPdf,
  CUSTOM_APPRAISAL_REPORT_PAGE_COUNT,
  customAppraisalReportFileName,
  customAppraisalReportReadiness,
  customAppraisalReportReadinessErrors,
  loadCustomAppraisalPropertySnapshot,
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

test("verified subject photos are retained in labeled appendix pages", async () => {
  const { snapshot, property } = customAppraisalReportFixture();
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const assignmentPhotos = Array.from({ length: 5 }, (_, index) => ({
    id: `photo-${index + 1}`,
    label: index === 0 ? "Dwelling Front" : `Interior ${index}`,
    category: index === 0 ? "Front" : "Living area",
    caption: index === 0 ? "Subject front elevation" : `Interior photo ${index}`,
    origin: "Mobile inspection",
    capturedAt: "2026-08-30T15:00:00.000Z",
    buffer: pixel,
  }));
  const content = await renderCustomAppraisalReportPdf({
    snapshot,
    property,
    assignmentPhotos,
    checksum: "b".repeat(64),
  });
  const pageObjects = content.toString("latin1").match(/\/Type \/Page\b/g) || [];
  assert.equal(pageObjects.length, CUSTOM_APPRAISAL_REPORT_PAGE_COUNT + 2);
});

test("report builder downloads verified assignment photos from private storage", async () => {
  const { snapshot } = customAppraisalReportFixture();
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const photoRows = Array.from({ length: 5 }, (_, index) => ({
    id: `photo-${index + 1}`,
    origin_channel: "mobile",
    category: index === 0 ? "Front" : "Living area",
    room_label: index === 0 ? null : `Room ${index}`,
    caption: null,
    position: index + 1,
    captured_at: "2026-08-30T15:00:00.000Z",
    object_key: `reports/photo-${index + 1}.png`,
    content_type: "image/png",
  }));
  const client = {
    async query(sql) {
      return String(sql).includes("to_regclass")
        ? { rows: [{ name: "app.inspection_photos" }] }
        : { rows: photoRows };
    },
  };
  const downloads = [];
  const objectStorage = {
    configured: true,
    async getObject({ objectKey }) {
      downloads.push(objectKey);
      return { body: pixel };
    },
  };
  const report = await buildCustomAppraisalReportPdf(client, {
    accountId: "125",
    assignmentFileId: 25,
    snapshot,
    includeExternalImages: false,
    objectStorage,
  });
  assert.equal(report.page_count, CUSTOM_APPRAISAL_REPORT_PAGE_COUNT + 2);
  assert.equal(report.report_version, 2);
  assert.deepEqual(downloads, photoRows.map((photo) => photo.object_key));
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

test("authoritative readiness enforces contract and neighborhood E&O rules", () => {
  const { snapshot, property } = customAppraisalReportFixture();
  const details = property.assignment.assignment_details;
  details.subject_under_contract = true;
  details.contract_arms_length = null;
  details.contract_price = "";
  details.contract_date = "";
  details.contract_closing_date = "";
  details.seller_matches_public_records = false;
  details.seller_mismatch_explanation = "";
  details.subject_conforms_to_neighborhood = false;
  details.subject_nonconformity_type = "";
  details.subject_nonconformity_explanation = "";
  const readiness = customAppraisalReportReadiness(snapshot, property);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((item) => item.code === "contract_arms_length_missing"));
  assert.ok(readiness.blockers.some((item) => item.code === "contract_price_missing"));
  assert.ok(readiness.blockers.some((item) => item.code === "contract_date_missing"));
  assert.ok(readiness.blockers.some((item) => item.code === "contract_closing_date_missing"));
  assert.ok(readiness.blockers.some((item) => item.code === "contract_seller_mismatch_unexplained"));
  assert.ok(readiness.blockers.some((item) => item.code === "subject_nonconformity_type_missing"));
  assert.ok(readiness.blockers.some((item) => item.code === "subject_nonconformity_unexplained"));
});

test("source repair concerns are explicit warnings instead of silent signing failures", () => {
  const { snapshot, property } = customAppraisalReportFixture();
  property.account.data_quality_status = "refresh_queued";
  property.account.data_quality_flags = ["missing_market_value", "suspicious_success"];
  property.owner = null;
  property.legal = null;
  property.account.legal_description = null;
  property.land = [];
  property.improvement.living_area_sqft = null;
  property.improvement.total_living_area = null;
  property.assignment.assignment_details.subject_condition_rating = "";
  const readiness = customAppraisalReportReadiness(snapshot, property);
  assert.equal(readiness.ready, true);
  assert.deepEqual(
    new Set(readiness.warning_codes),
    new Set([
      "account_data_quality_review",
      "account_data_quality_flags",
      "subject_owner_missing",
      "subject_legal_description_missing",
      "subject_site_area_missing",
      "subject_gla_missing",
      "subject_condition_rating_missing",
    ]),
  );
});

test("vacant-land subjects do not receive an erroneous missing-GLA warning", () => {
  const { snapshot, property } = customAppraisalReportFixture();
  property.improvement = null;
  property.land = [{ state_code: "SFR - Vacant Lots/Tracts", area_sqft: 9000 }];
  const readiness = customAppraisalReportReadiness(snapshot, property);
  assert.equal(readiness.warning_codes.includes("subject_gla_missing"), false);
});

test("final reconciliation becomes stale when a source approach changes", () => {
  const { snapshot, property } = customAppraisalReportFixture();
  snapshot.sections.sales_comparison.revision += 1;
  const readiness = customAppraisalReportReadiness(snapshot, property);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.blockers.some((item) => item.code === "final_reconciliation_stale"));
});

test("property snapshot supports legacy account-location rows without provenance columns", async () => {
  let locationSql = "";
  const client = {
    async query(sql, params = []) {
      if (sql.includes("to_regclass")) return { rows: [{ name: params[0] }] };
      if (sql.includes("FROM core.accounts a")) {
        return { rows: [{ account_id: "legacy-location-account", address: "1 Main St" }] };
      }
      if (sql.includes("FROM app.assignment_files")) {
        return { rows: [{ id: 7, account_id: "legacy-location-account", assignment_details: {} }] };
      }
      if (sql.includes("FROM core.account_locations")) {
        locationSql = sql;
        if (/geocode_source|geocoded_at/.test(sql)) {
          const error = new Error("column does not exist");
          error.code = "42703";
          throw error;
        }
        return { rows: [{ account_id: "legacy-location-account", latitude: 32.9, longitude: -96.8 }] };
      }
      return { rows: [] };
    },
  };

  const snapshot = await loadCustomAppraisalPropertySnapshot(client, {
    accountId: "legacy-location-account",
    assignmentFileId: 7,
  });

  assert.match(locationSql, /SELECT \*/);
  assert.equal(snapshot.location.latitude, 32.9);
  assert.equal(snapshot.location.longitude, -96.8);
});
