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
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import { isVerifiedUnitInteriorAsset } from "../src/modules/uad/unitInteriorCatalog.js";

test("adds official always-displayed URAR Section 10", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "unit_interior");
  assert.deepEqual(sections.map((item) => item.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(section?.key, "unit_interior");
  assert.equal(section?.title, "Unit Interior");
  assert.equal(section?.appliesWhen, undefined);
  assert.ok(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "unit_interior").length >= 70);
  assert.equal(getUadField("unit", "0700.0140")?.reportFieldId, "10.003");
  assert.equal(getUadField("unit_room", "0700.0035")?.reportFieldId, "10.033");
  assert.equal(getUadField("unit_interior_defect", "3900.0136")?.reportFieldId, "10.060");
  assert.equal(new Set(UAD_PHASE_ONE_FIELDS.map((field) => field.key)).size, UAD_PHASE_ONE_FIELDS.length);
});

test("models Section 10 levels, rooms, sources, features, and defects under each unit", () => {
  assert.deepEqual(UAD_REPEATABLE_ENTITY_GROUPS.unit.parentEntityTypes, ["dwelling", "outbuilding"]);
  for (const entityType of [
    "unit_area_data_source",
    "unit_adu_data_source",
    "unit_level",
    "unit_room",
    "unit_interior_feature",
    "unit_interior_defect",
  ]) {
    assert.equal(UAD_REPEATABLE_ENTITY_GROUPS[entityType].parentEntityType, "unit");
  }

  const roomId = "935bbac1-7c0d-42f7-9469-0f81b78496ba";
  const valid = validateUadSectionValues("unit_interior", [
    { entity_id: roomId, context_key: "unit_room", uid: "0700.0035", value: "Kitchen" },
  ], { entityTypesById: new Map([[roomId, "unit_room"]]) });
  assert.equal(valid.errors.length, 0);
  assert.throws(
    () => validateUadSectionValues("unit_interior", [
      { entity_id: roomId, context_key: "unit_room", uid: "0700.0035", value: "Kitchen" },
    ], { entityTypesById: new Map([[roomId, "unit_level"]]) }),
    /invalid_uad_field_values/,
  );
});

test("enforces Section 10 conditional and measurement types", () => {
  const belowGradeComparison = getUadField("unit", "0700.0064");
  assert.equal(uadFieldIsRequired(belowGradeComparison, (key) => ({
    "unit:0700.0143": { amount: 400, unit: "SquareFeet" },
    "unit:1800.0398": { amount: 0, unit: "SquareFeet" },
  })[key]), true);
  assert.equal(evaluateUadCondition(
    { key: "unit:0700.0143", greaterThan: 0 },
    (key) => key === "unit:0700.0143" ? { amount: 400, unit: "SquareFeet" } : undefined,
  ), true);
  assert.deepEqual(
    normalizeAndValidateUadValue(getUadField("unit", "0700.0140"), { amount: 2100, unit: "SquareFeet" }).value,
    { amount: 2100, unit: "SquareFeet" },
  );
  assert.equal(
    normalizeAndValidateUadValue(getUadField("unit", "0700.0140"), { amount: -1, unit: "SquareFeet" }).error?.code,
    "measurement",
  );
  assert.equal(normalizeAndValidateUadValue(getUadField("unit", "0700.0067"), "Q7").error?.code, "enumeration");
});

test("recognizes only verified entity-linked Section 10 images", () => {
  const entityId = "e986172a-80fb-4f32-ad43-95c796b6308e";
  const asset = {
    entity_id: entityId,
    section_number: 10,
    caption_type: "Kitchen",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedUnitInteriorAsset(asset, "Kitchen", entityId), true);
  assert.equal(isVerifiedUnitInteriorAsset({ ...asset, section_number: 9 }, "Kitchen", entityId), false);
  assert.equal(isVerifiedUnitInteriorAsset({ ...asset, status: "pending" }, "Kitchen", entityId), false);
  assert.equal(isVerifiedUnitInteriorAsset({ ...asset, entity_id: null }, "Kitchen", entityId), false);
  assert.equal(isVerifiedUnitInteriorAsset({ ...asset, content_type: "application/pdf" }, "Kitchen", entityId), false);
});

test("seeds Section 10 reference fields, enumerations, assets, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260823_uad_unit_interior.sql"), "utf8");
  assert.match(sql, /StandardAboveGradeFinishedArea/);
  assert.match(sql, /unit_room_asset/);
  assert.match(sql, /UAD1138/);
  assert.match(sql, /UAD1764/);
  assert.match(sql, /HN-UAD-UNIT-008/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix F-1 v1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 10 reconciliation and required exhibits", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  assert.match(source, /unit_interior_parent_conflict/);
  assert.match(source, /unit_area_source_required/);
  assert.match(source, /unit_level_count/);
  assert.match(source, /unit_area_reconciliation/);
  assert.match(source, /unit_room_count/);
  assert.match(source, /unit_room_photo_required/);
  assert.match(source, /unit_interior_feature_required/);
  assert.match(source, /unit_accessibility_none_conflict/);
  assert.match(source, /unit_interior_defect_photo_required/);
});
