import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  UAD_REPEATABLE_ENTITY_GROUPS,
  evaluateUadCondition,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  uadFieldIsVisible,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import { isVerifiedManufacturedHomeAsset } from "../src/modules/uad/manufacturedHomeCatalog.js";

test("adds official URAR Section 9 as a manufactured-dwelling-only section", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "manufactured_home");
  assert.deepEqual(sections.map((item) => item.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 29]);
  assert.equal(section?.key, "manufactured_home");
  assert.equal(section?.appliesToEntityType, "dwelling");
  assert.equal(evaluateUadCondition(section?.appliesWhen, (key) => key === "dwelling:0300.0034" ? "Manufactured" : undefined), true);
  assert.equal(evaluateUadCondition(section?.appliesWhen, (key) => key === "dwelling:0300.0034" ? "SiteBuilt" : undefined), false);
  assert.ok(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "manufactured_home").length >= 30);
  assert.equal(getUadField("manufactured_home", "0500.0017")?.reportFieldId, "9.000");
  assert.equal(getUadField("manufactured_home", "0500.0042")?.reportFieldId, "9.026");
  assert.equal(new Set(UAD_PHASE_ONE_FIELDS.map((field) => field.key)).size, UAD_PHASE_ONE_FIELDS.length);
});

test("models Section 9 repeatable records under the manufactured dwelling", () => {
  for (const entityType of [
    "manufactured_home_skirting_material",
    "manufactured_home_modification",
    "manufactured_home_hud_label",
    "manufactured_home_financing_program",
  ]) {
    assert.equal(UAD_REPEATABLE_ENTITY_GROUPS[entityType].parentEntityType, "dwelling");
  }

  const labelId = "935bbac1-7c0d-42f7-9469-0f81b78496ba";
  const valid = validateUadSectionValues("manufactured_home", [
    { entity_id: labelId, context_key: "manufactured_home_hud_label", uid: "0500.0037", value: "TEX1234567" },
  ], { entityTypesById: new Map([[labelId, "manufactured_home_hud_label"]]) });
  assert.equal(valid.errors.length, 0);
  assert.throws(
    () => validateUadSectionValues("manufactured_home", [
      { entity_id: labelId, context_key: "manufactured_home_hud_label", uid: "0500.0037", value: "TEX1234567" },
    ], { entityTypesById: new Map([[labelId, "manufactured_home_modification"]]) }),
    /invalid_uad_field_values/,
  );
});

test("enforces Section 9 visibility, conditional values, and UAD types", () => {
  const manufacturer = getUadField("manufactured_home", "0500.0017");
  const manufactureDate = getUadField("manufactured_home", "0500.0016");
  const otherProgram = getUadField("manufactured_home_financing_program", "0500.0006");
  assert.equal(uadFieldIsVisible(manufacturer, (key) => key === "dwelling:0300.0034" ? "Manufactured" : undefined), true);
  assert.equal(uadFieldIsVisible(manufacturer, (key) => key === "dwelling:0300.0034" ? "SiteBuilt" : undefined), false);
  assert.equal(uadFieldIsRequired(manufactureDate, (key) => ({
    "dwelling:0300.0034": "Manufactured",
    "manufactured_home:0500.0010": true,
  })[key]), true);
  assert.equal(uadFieldIsRequired(otherProgram, (key) => key === "manufactured_home_financing_program:0500.0005" ? "Other" : undefined), true);
  assert.equal(normalizeAndValidateUadValue(getUadField("manufactured_home", "0500.0011"), "2024").value, "2024");
  assert.equal(normalizeAndValidateUadValue(manufactureDate, "2024-05-20").value, "2024-05-20");
  assert.equal(normalizeAndValidateUadValue(manufactureDate, "05/20/2024").error?.code, "date");
  assert.equal(normalizeAndValidateUadValue(getUadField("manufactured_home", "0500.0044"), "DoubleWide").error?.code, "enumeration");
});

test("recognizes only verified, entity-linked Section 9 images", () => {
  const entityId = "e986172a-80fb-4f32-ad43-95c796b6308e";
  const asset = {
    entity_id: entityId,
    section_number: 9,
    caption_type: "ManufacturedHomeHUDCertificationLabel",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedManufacturedHomeAsset(asset, "ManufacturedHomeHUDCertificationLabel", entityId), true);
  assert.equal(isVerifiedManufacturedHomeAsset({ ...asset, section_number: 8 }, "ManufacturedHomeHUDCertificationLabel", entityId), false);
  assert.equal(isVerifiedManufacturedHomeAsset({ ...asset, status: "pending" }, "ManufacturedHomeHUDCertificationLabel", entityId), false);
  assert.equal(isVerifiedManufacturedHomeAsset({ ...asset, entity_id: null }, "ManufacturedHomeHUDCertificationLabel", entityId), false);
  assert.equal(isVerifiedManufacturedHomeAsset({ ...asset, content_type: "application/pdf" }, "ManufacturedHomeHUDCertificationLabel", entityId), false);
});

test("seeds Section 9 reference fields, enumerations, assets, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260822_uad_manufactured_home.sql"), "utf8");
  assert.match(sql, /ManufacturedHomeManufacturerName/);
  assert.match(sql, /ManufacturedHomeHUDCertificationLabel/);
  assert.match(sql, /ManufacturedHomeFinancingProgramEligibilityCertification/);
  assert.match(sql, /UAD1100/);
  assert.match(sql, /UAD1284/);
  assert.match(sql, /HN-UAD-MH-006/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 9 cross-record and exhibit consistency", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  assert.match(source, /manufactured_home_parent_conflict/);
  assert.match(source, /manufactured_home_skirting_required/);
  assert.match(source, /manufactured_home_modification_required/);
  assert.match(source, /manufactured_home_hud_label_asset_required/);
  assert.match(source, /manufactured_home_data_plate_asset_required/);
  assert.match(source, /manufactured_home_program_asset_required/);
  assert.match(source, /manufactured_home_year_mismatch/);
});
