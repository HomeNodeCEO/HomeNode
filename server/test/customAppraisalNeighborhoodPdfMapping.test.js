import assert from "node:assert/strict";
import test from "node:test";

import { extractText } from "unpdf";

import {
  buildCustomAppraisalReportPdf,
  CUSTOM_APPRAISAL_REPORT_PAGE_COUNT,
  customAppraisalReportReadiness,
  ensureSignedCustomAppraisalReportArtifact,
} from "../src/services/customAppraisalReportPdf.js";
import { customAppraisalReportFixture } from "./fixtures/customAppraisalReportFixture.js";

// These tests inspect the actual builder's in-memory PDF text. They prove field
// mapping, not visual layout; rendered visual QA remains a separate check.
const ALIASES = [
  ["neighborhood_house_price_low", "neighborhood_price_low", 501001, 901001],
  ["neighborhood_house_price_predominant", "neighborhood_price_predominant", 502002, 902002],
  ["neighborhood_all_house_price_low", "neighborhood_all_price_low", 401003, 903003],
  ["neighborhood_all_house_price_predominant", "neighborhood_all_price_predominant", 402004, 904004],
];
const moneyText = value => `$${value.toLocaleString("en-US")}`;

function fixture() {
  const result = customAppraisalReportFixture();
  const details = result.snapshot.assignment.assignment_details;
  for (const [canonical, legacy, _current, older] of ALIASES) {
    delete details[canonical];
    details[legacy] = older;
  }
  delete details.neighborhood_land_use_two_to_four_unit_pct;
  details.neighborhood_land_use_two_to_four_pct = 17;
  return { ...result, details };
}

async function neighborhoodText(snapshot) {
  const before = structuredClone(snapshot);
  const report = await buildCustomAppraisalReportPdf({
    query(sql, params) {
      assert.equal(sql, "SELECT to_regclass($1) AS name", "Fixture rendering must not fetch newer database evidence");
      assert.deepEqual(params, ["app.inspection_photos"]);
      return { rows: [{ name: null }] };
    },
  }, {
    accountId: snapshot.assignment.account_id,
    assignmentFileId: snapshot.assignment.id,
    snapshot,
    includeExternalImages: false,
  });
  assert.deepEqual(snapshot, before, "Report projection must not modify stored assignment or snapshot");
  assert.equal(report.page_count, CUSTOM_APPRAISAL_REPORT_PAGE_COUNT);
  assert.equal(report.content.subarray(0, 5).toString("ascii"), "%PDF-");
  const extracted = await extractText(new Uint8Array(report.content), { mergePages: false });
  assert.equal(extracted.totalPages, CUSTOM_APPRAISAL_REPORT_PAGE_COUNT);
  return extracted.text[2].replace(/\s+/g, " ");
}

test("neighborhood PDF reads canonical UI values before conflicting legacy aliases", async () => {
  const { snapshot, details } = fixture();
  for (const [canonical, _legacy, current] of ALIASES) details[canonical] = current;
  details.neighborhood_land_use_two_to_four_unit_pct = 13;
  const text = await neighborhoodText(snapshot);
  for (const [_canonical, _legacy, current, older] of ALIASES) {
    assert.ok(text.includes(moneyText(current)), `Missing canonical value ${current}`);
    assert.equal(text.includes(moneyText(older)), false, `Stale alias value ${older} leaked into PDF`);
  }
  assert.match(text, /2-4 UNIT 13%/i);
  assert.doesNotMatch(text, /2-4 UNIT 17%/i);
  assert.match(text, /Sale Price \/ CAD Value/);
  assert.match(text, /Sale \/ CAD Value per SF/);
  assert.match(text, /SALES MEDIAN/);
  assert.match(text, /ALL MEDIAN/);
});

test("neighborhood PDF retains aliases for older saved files only when canonical fields are absent", async () => {
  const { snapshot } = fixture();
  const text = await neighborhoodText(snapshot);
  for (const [_canonical, _legacy, _current, older] of ALIASES) {
    assert.ok(text.includes(moneyText(older)), `Missing older saved value ${older}`);
  }
  assert.match(text, /2-4 UNIT 17%/i);
});

for (const [name, value] of [["blank", ""], ["null", null], ["zero", 0], ["own undefined", undefined]]) {
  test(`neighborhood PDF never falls through a canonical ${name} to a populated legacy alias`, async () => {
    const { snapshot, details } = fixture();
    for (const [canonical] of ALIASES) details[canonical] = value;
    details.neighborhood_land_use_two_to_four_unit_pct = value;
    const text = await neighborhoodText(snapshot);
    for (const [_canonical, _legacy, _current, older] of ALIASES) {
      assert.equal(text.includes(moneyText(older)), false);
    }
    if (value === 0) {
      assert.match(text, /2-4 UNIT 0%/i);
      assert.equal((text.match(/\$0\b/g) || []).length, 4);
    } else {
      assert.match(text, /2-4 UNIT Not reported/i);
      assert.ok((text.match(/Not reported/g) || []).length >= 5);
    }
  });
}

test("neighborhood land-use readiness uses the same absent-only canonical precedence", () => {
  const { snapshot, property } = customAppraisalReportFixture();
  const details = snapshot.assignment.assignment_details;
  const blocked = () => customAppraisalReportReadiness(snapshot, property).blockers
    .some(item => item.code === "land_use_total_invalid");
  assert.equal(blocked(), false, "Original alias-only fixture totals 100 percent");
  for (const value of ["", null, 0, undefined]) {
    details.neighborhood_land_use_two_to_four_unit_pct = value;
    assert.equal(blocked(), true, "An explicit missing/zero field must not reuse the older two percent");
  }
  delete details.neighborhood_land_use_two_to_four_unit_pct;
  assert.equal(blocked(), false);
});

test("neighborhood PDF does not infer missing representativeness values from rendered ranges", async () => {
  const { snapshot, details } = fixture();
  delete details.neighborhood_sales_representativeness_score;
  for (const metric of ["price", "ppsf", "age", "gla"]) {
    delete details[`neighborhood_representativeness_${metric}_deviation_pct`];
  }
  const text = await neighborhoodText(snapshot);
  assert.match(text, /SALES REPRESENTATIVENESS Not reported/i);
  assert.equal((text.match(/Not reported/g) || []).length, 5);
});

test("existing signed PDF artifact is returned unchanged without rendering or rewriting it", async () => {
  const content = Buffer.from("Previously signed immutable PDF bytes");
  const existing = { canonical_file_name: "signed.pdf", content, report_version: 1,
    content_sha256: "a".repeat(64), page_count: 9, byte_size: content.length };
  const statements = [];
  const pool = { async query(sql) {
    statements.push(sql);
    if (/CREATE TABLE IF NOT EXISTS app\.custom_appraisal_report_artifacts/.test(sql)) return { rows: [] };
    assert.match(sql, /SELECT canonical_file_name, report_version, workfile_checksum_sha256/);
    return { rows: [existing] };
  } };
  const result = await ensureSignedCustomAppraisalReportArtifact(pool, {
    accountId: "synthetic", assignmentFileId: 125, snapshot: null,
    signedSnapshotId: "abcdef01-0000-4000-8000-000000000001", workfileChecksum: "b".repeat(64),
  });
  assert.equal(result, existing);
  assert.equal(result.content, content);
  assert.equal(statements.length, 2);
  assert.equal(statements.some(sql => /INSERT INTO app\.custom_appraisal_report_artifacts/.test(sql)), false);
});
