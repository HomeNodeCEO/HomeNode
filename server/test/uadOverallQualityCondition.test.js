import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_CONDITION_RATINGS,
  UAD_OVERALL_QUALITY_CONDITION_REDISPLAY_FIELDS,
  UAD_QUALITY_RATINGS,
} from "../src/modules/uad/overallQualityConditionCatalog.js";

test("adds official always-displayed URAR Section 15", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "overall_quality_condition");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  );
  assert.equal(section?.title, "Overall Quality and Condition");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "overall_quality_condition").length, 3);
  assert.equal(getUadField("subject", "1600.0007")?.reportFieldId, "15.000");
  assert.equal(getUadField("subject", "1600.0006")?.reportFieldId, "15.005");
  assert.equal(getUadField("overall_quality_condition_commentary", "1600.0008")?.reportFieldId, "15.010");
});

test("uses exact Appendix A-1 quality and condition rating enumerations", () => {
  assert.deepEqual(UAD_QUALITY_RATINGS, ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]);
  assert.deepEqual(UAD_CONDITION_RATINGS, ["C1", "C2", "C3", "C4", "C5", "C6"]);
  assert.equal(normalizeAndValidateUadValue(getUadField("subject", "1600.0007"), "Q3").error, null);
  assert.equal(normalizeAndValidateUadValue(getUadField("subject", "1600.0007"), "Q7").error?.code, "enumeration");
  assert.equal(normalizeAndValidateUadValue(getUadField("subject", "1600.0006"), "C0").error?.code, "enumeration");
  assert.equal(getUadField("overall_quality_condition_commentary", "1600.0008")?.maxLength, 5000);
});

test("models Section 8 and 10 values as Section 15 redisplays without duplicate data fields", () => {
  assert.deepEqual(
    UAD_OVERALL_QUALITY_CONDITION_REDISPLAY_FIELDS.flatMap((field) => field.reportFieldIds),
    ["15.001", "15.006", "15.002", "15.007", "15.003", "15.008", "15.004", "15.009"],
  );
  assert.equal(
    UAD_OVERALL_QUALITY_CONDITION_REDISPLAY_FIELDS.find((field) => field.uid === "1600.0005")?.sourceSection,
    8,
  );
  assert.equal(
    UAD_OVERALL_QUALITY_CONDITION_REDISPLAY_FIELDS.find((field) => field.uid === "0700.0067")?.excludesAccessoryDwellingUnits,
    true,
  );
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "overall_quality_condition").length, 3);
});

test("validates the three appraiser-entered Section 15 values", () => {
  const valid = validateUadSectionValues("overall_quality_condition", [
    { context_key: "subject", uid: "1600.0007", value: "Q3" },
    { context_key: "subject", uid: "1600.0006", value: "C3" },
    { context_key: "overall_quality_condition_commentary", uid: "1600.0008", value: "Ratings reconcile the applicable exterior and non-ADU interior observations." },
  ]);
  assert.equal(valid.errors.length, 0);
  const invalid = validateUadSectionValues("overall_quality_condition", [
    { context_key: "subject", uid: "1600.0007", value: "Q7" },
  ]);
  assert.equal(invalid.errors[0]?.code, "enumeration");
});

test("seeds Section 15 fields, report locations, and official rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260828_uad_overall_quality_condition.sql"), "utf8");
  assert.match(sql, /field_report_locations/);
  assert.match(sql, /15\.001/);
  assert.match(sql, /15\.009/);
  assert.match(sql, /location_role.*redisplay/s);
  assert.match(sql, /UAD1384/);
  assert.match(sql, /UAD1385/);
  assert.match(sql, /UAD1387/);
  assert.match(sql, /HN-UAD-OVERALL-QC-003/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 15 cross-section rating sources", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(editor, /overall_qc_exterior_responsibility_required/);
  assert.match(editor, /overall_qc_exterior_quality_required/);
  assert.match(editor, /overall_qc_exterior_condition_required/);
  assert.match(editor, /overall_qc_adu_classification_required/);
  assert.match(editor, /overall_qc_interior_quality_required/);
  assert.match(editor, /overall_qc_interior_condition_required/);
  assert.match(frontend, /Ratings redisplayed from the workfile/);
  assert.match(frontend, /UAD 3\.6 associates no images with Section 15/);
});
