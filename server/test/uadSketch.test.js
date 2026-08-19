import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  getUadEditorSections,
  getUadField,
  uadFieldIsRequired,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import { isVerifiedSketchReportAsset } from "../src/modules/uad/sketchCatalog.js";
import { normalizeUadSketchInput } from "../src/modules/uad/sketches.js";

test("adds official URAR Section 7 after Energy Efficient and Green Features", () => {
  const sections = getUadEditorSections();
  assert.deepEqual(sections.map((section) => section.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  assert.equal(sections.find((section) => section.officialSectionNumber === 7)?.key, "sketch");
  assert.equal(getUadField("sketch", "3300.0002")?.reportFieldId, "7.000");
  assert.equal(getUadField("sketch", "3300.0007")?.reportFieldId, "7.001");
  assert.equal(getUadField("sketch_commentary", "3300.0010")?.reportFieldId, "7.003");
});

test("enforces the official Section 7 conditional requirements", () => {
  const standard = getUadField("sketch", "3300.0007");
  const otherStandard = getUadField("sketch", "3300.0008");
  const commentary = getUadField("sketch_commentary", "3300.0010");
  const values = new Map([["sketch:3300.0002", true]]);
  assert.equal(uadFieldIsRequired(standard, (key) => values.get(key)), true);
  assert.equal(uadFieldIsRequired(commentary, (key) => values.get(key)), false);
  values.set("sketch:3300.0007", "Other");
  assert.equal(uadFieldIsRequired(otherStandard, (key) => values.get(key)), true);
  values.set("sketch:3300.0002", false);
  assert.equal(uadFieldIsRequired(commentary, (key) => values.get(key)), true);

  const validated = validateUadSectionValues("sketch", [
    { context_key: "sketch", uid: "3300.0002", value: true },
    { context_key: "sketch", uid: "3300.0007", value: "AmericanNationalStandardsInstitute" },
  ]);
  assert.equal(validated.errors.length, 0);
});

test("counts only verified UAD-compatible Section 7 report images", () => {
  const valid = {
    section_number: 7,
    status: "verified",
    caption_type: "SubjectPropertyImprovementSketch",
    content_type: "image/png",
  };
  assert.equal(isVerifiedSketchReportAsset(valid), true);
  assert.equal(isVerifiedSketchReportAsset({ ...valid, caption_type: "MeasurementSource" }), false);
  assert.equal(isVerifiedSketchReportAsset({ ...valid, content_type: "application/pdf" }), false);
  assert.equal(isVerifiedSketchReportAsset({ ...valid, status: "pending_upload" }), false);
});

test("normalizes bounded structured sketch payloads for web and mobile clients", () => {
  const normalized = normalizeUadSketchInput({
    schema_version: "1.0",
    source: "mobile",
    geometry: { levels: [{ id: "level-1" }] },
    measurements: { unit: "Feet" },
    calculated_areas: { gross_living_area: 2100 },
    area_overrides: {},
  });
  assert.equal(normalized.source, "mobile");
  assert.equal(normalized.calculatedAreas.gross_living_area, 2100);
  assert.throws(() => normalizeUadSketchInput({ source: "unknown" }), /invalid_uad_sketch_source/);
  assert.throws(() => normalizeUadSketchInput({ geometry: [] }), /invalid_uad_sketch_geometry/);
});

test("seeds official Section 7 reference data and cross-record rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260820_uad_sketch.sql"), "utf8");
  assert.match(sql, /SketchExistsIndicator/);
  assert.match(sql, /SubjectPropertyImprovementSketch/);
  assert.match(sql, /UAD1676/);
  assert.match(sql, /UAD1677/);
  assert.match(sql, /UAD1678/);
  assert.match(sql, /HN-UAD-SKETCH-001/);
  assert.match(sql, /Appendix F-1 v1\.4/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation and asset removal protect the Section 7 report state", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  assert.match(editor, /sketch_asset_required/);
  assert.match(editor, /sketch_asset_conflict/);
  assert.match(assets, /status = 'deleted'/);
  assert.match(assets, /invalid_uad_sketch_report_content_type/);
});
