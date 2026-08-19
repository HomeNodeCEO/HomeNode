import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  UAD_REPEATABLE_ENTITY_GROUPS,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import { isVerifiedDwellingFrontAsset } from "../src/modules/uad/dwellingExteriorCatalog.js";

test("adds official URAR Section 8 after Sketch", () => {
  const sections = getUadEditorSections();
  assert.deepEqual(sections.map((section) => section.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  assert.equal(sections.find((section) => section.officialSectionNumber === 8)?.key, "dwelling_exterior");
  assert.ok(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "dwelling_exterior").length >= 65);
  assert.equal(getUadField("dwelling", "0300.0011")?.reportFieldId, "8.010");
  assert.equal(getUadField("dwelling", "3900.0097")?.reportFieldId, "8.055");
  assert.equal(new Set(UAD_PHASE_ONE_FIELDS.map((field) => field.key)).size, UAD_PHASE_ONE_FIELDS.length);
});

test("models Section 8 children under the dwelling entity", () => {
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.dwelling.minItems, 1);
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.dwelling_exterior_feature.parentEntityType, "dwelling");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.dwelling_noncontinuous_room.parentEntityType, "dwelling");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.dwelling_exterior_defect.parentEntityType, "dwelling");

  const featureId = "97daf607-bc80-4d6a-a2c7-c64c02b7a48f";
  const valid = validateUadSectionValues("dwelling_exterior", [
    { entity_id: featureId, context_key: "dwelling_exterior_feature", uid: "0300.0055", value: "Roof" },
    { entity_id: featureId, context_key: "dwelling_exterior_feature", uid: "0300.0049", value: true },
  ], { entityTypesById: new Map([[featureId, "dwelling_exterior_feature"]]) });
  assert.equal(valid.errors.length, 0);
  assert.throws(
    () => validateUadSectionValues("dwelling_exterior", [
      { entity_id: featureId, context_key: "dwelling_exterior_feature", uid: "0300.0055", value: "Roof" },
    ], { entityTypesById: new Map([[featureId, "dwelling_exterior_defect"]]) }),
    /invalid_uad_field_values/,
  );
});

test("enforces official conditional fields and bounded values", () => {
  const structureDesign = getUadField("dwelling", "0300.0032");
  assert.equal(uadFieldIsRequired(structureDesign, (key) => key === "subject:0100.0020" ? "Attached" : undefined), true);
  assert.equal(normalizeAndValidateUadValue(getUadField("dwelling", "0300.0063"), 0).error?.code, "integer");
  assert.equal(normalizeAndValidateUadValue(getUadField("dwelling", "0300.0011"), "1986").value, "1986");
  assert.equal(normalizeAndValidateUadValue(getUadField("dwelling", "0300.0011"), "86").error?.code, "year");
  assert.equal(normalizeAndValidateUadValue(getUadField("dwelling", "0300.0088"), ["ForcedWarmAir", "MiniSplit"]).error, null);
});

test("recognizes only verified, dwelling-linked UAD front photos", () => {
  const dwellingId = "49fd073f-4bd8-4f76-b609-8e75e5a071ac";
  const asset = {
    entity_id: dwellingId,
    section_number: 8,
    caption_type: "DwellingFront",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedDwellingFrontAsset(asset, dwellingId), true);
  assert.equal(isVerifiedDwellingFrontAsset({ ...asset, caption_type: "DwellingRear" }, dwellingId), false);
  assert.equal(isVerifiedDwellingFrontAsset({ ...asset, entity_id: null }, dwellingId), false);
  assert.equal(isVerifiedDwellingFrontAsset({ ...asset, content_type: "application/pdf" }, dwellingId), false);
});

test("seeds Section 8 reference fields, enumerations, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260821_uad_dwelling_exterior.sql"), "utf8");
  assert.match(sql, /DwellingExteriorDefectsExistIndicator/);
  assert.match(sql, /DwellingFront/);
  assert.match(sql, /UAD1048/);
  assert.match(sql, /UAD1687/);
  assert.match(sql, /HN-UAD-DWELLING-004/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 8 cross-record consistency", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  assert.match(source, /dwelling_front_photo_required/);
  assert.match(source, /dwelling_feature_required/);
  assert.match(source, /noncontinuous_room_required/);
  assert.match(source, /dwelling_defect_required/);
  assert.match(source, /heating_none_conflict/);
});
