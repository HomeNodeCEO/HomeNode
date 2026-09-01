import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const chooser = fs.readFileSync(new URL("../src/components/ReportTypeChooser.tsx", import.meta.url), "utf8");
const destinations = fs.readFileSync(new URL("../src/lib/reportDestinations.ts", import.meta.url), "utf8");
const report = fs.readFileSync(new URL("../src/pages/PropertyReport.tsx", import.meta.url), "utf8");

test("the home report chooser lists existing assignments before creating a new one", () => {
  assert.match(chooser, /Continue an existing file/);
  assert.match(chooser, /Start New Assignment/);
  assert.match(chooser, /createCanonicalReportFile/);
  assert.match(chooser, /getCanonicalReportFiles/);
});

test("every report destination carries its canonical target identifier", () => {
  assert.match(destinations, /assignmentFileId/);
  assert.match(destinations, /workfileId/);
  assert.match(destinations, /params\.set\("fileId", targetId\)/);
});

test("the Custom Appraisal header no longer asks for a manually entered file number", () => {
  assert.doesNotMatch(report, /placeholder="Enter assignment number"/);
  assert.match(report, /Choose or Start Another File/);
});

test("the Custom Appraisal uses the same protected autosave pattern as UAD", () => {
  assert.match(report, /CUSTOM_APPRAISAL_AUTOSAVE_IDLE_MS/);
  assert.match(report, /CUSTOM_APPRAISAL_AUTOSAVE_MAX_WAIT_MS/);
  assert.match(report, /visibilitychange/);
  assert.match(report, /Save Everything/);
  assert.match(report, /Keep My Values/);
  assert.match(report, /Use Newer Saved Values/);
});
