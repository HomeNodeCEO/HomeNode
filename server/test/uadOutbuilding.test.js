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
  uadFieldIsVisible,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_OUTBUILDING_ROOM_TYPES,
  UAD_OUTBUILDING_TYPES,
  isVerifiedOutbuildingAsset,
} from "../src/modules/uad/outbuildingCatalog.js";

test("adds official always-displayed URAR Section 12", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "outbuilding");
  assert.deepEqual(sections.map((item) => item.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  assert.equal(section?.title, "Outbuilding");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "outbuilding").length, 34);
  assert.equal(getUadField("outbuilding", "0300.0025")?.reportFieldId, "12.001");
  assert.equal(getUadField("outbuilding_defect", "3900.0171")?.reportFieldId, "12.024");
});

test("uses the exact Appendix A-1 outbuilding and room enumerations", () => {
  assert.deepEqual(UAD_OUTBUILDING_TYPES, [
    "Barn", "Boathouse", "Bunkhouse", "EnclosedKennel", "Greenhouse", "GuestHouse",
    "IndoorRidingArena", "ManufacturedHome", "Office", "Other", "PoolHouse", "Shed",
    "Silo", "Stable", "StandaloneADU", "Studio", "Workshop",
  ]);
  assert.equal(UAD_OUTBUILDING_ROOM_TYPES.length, 19);
  assert.equal(normalizeAndValidateUadValue(getUadField("outbuilding", "0300.0025"), "Unsupported").error?.code, "enumeration");
  assert.deepEqual(
    normalizeAndValidateUadValue(getUadField("outbuilding", "0300.0060"), { amount: 240, unit: "SquareFeet" }).value,
    { amount: 240, unit: "SquareFeet" },
  );
  assert.equal(normalizeAndValidateUadValue(getUadField("outbuilding", "0300.0060"), { amount: 0, unit: "SquareFeet" }).error?.code, "measurement");
});

test("models rooms and defects under an outbuilding and units under either structure type", () => {
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.outbuilding.minItems, 0);
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.outbuilding_room.parentEntityType, "outbuilding");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.outbuilding_defect.parentEntityType, "outbuilding");
  assert.deepEqual(UAD_REPEATABLE_ENTITY_GROUPS.unit.parentEntityTypes, ["dwelling", "outbuilding"]);

  const roomId = "935bbac1-7c0d-42f7-9469-0f81b78496ba";
  const valid = validateUadSectionValues("outbuilding", [
    { entity_id: roomId, context_key: "outbuilding_room", uid: "0300.0018", value: "Workshop" },
  ], { entityTypesById: new Map([[roomId, "outbuilding_room"]]) });
  assert.equal(valid.errors.length, 0);
});

test("enforces real-property, living-unit, and Other conditional fields", () => {
  const units = getUadField("outbuilding", "0300.0063");
  const heating = getUadField("outbuilding", "0300.0023");
  const other = getUadField("outbuilding", "0300.0026");
  const real = (key) => ({
    "outbuilding:0300.0024": true,
    "outbuilding:0300.0063": 0,
    "outbuilding:0300.0025": "Other",
  })[key];
  assert.equal(uadFieldIsVisible(units, real), true);
  assert.equal(uadFieldIsRequired(units, real), true);
  assert.equal(uadFieldIsVisible(heating, real), true);
  assert.equal(uadFieldIsRequired(heating, real), true);
  assert.equal(uadFieldIsRequired(other, real), true);
});

test("recognizes only verified entity-linked Section 12 images", () => {
  const entityId = "e986172a-80fb-4f32-ad43-95c796b6308e";
  const asset = {
    entity_id: entityId,
    section_number: 12,
    caption_type: "OutbuildingFront",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedOutbuildingAsset(asset, "OutbuildingFront", entityId), true);
  assert.equal(isVerifiedOutbuildingAsset({ ...asset, section_number: 11 }, "OutbuildingFront", entityId), false);
  assert.equal(isVerifiedOutbuildingAsset({ ...asset, status: "pending" }, "OutbuildingFront", entityId), false);
  assert.equal(isVerifiedOutbuildingAsset({ ...asset, content_type: "application/pdf" }, "OutbuildingFront", entityId), false);
});

test("seeds Section 12 fields, enumerations, assets, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260825_uad_outbuilding.sql"), "utf8");
  assert.match(sql, /OutbuildingType/);
  assert.match(sql, /outbuilding_defect_asset/);
  assert.match(sql, /UAD1056/);
  assert.match(sql, /UAD1692/);
  assert.match(sql, /HN-UAD-OUTBUILDING-008/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 12 reconciliation and required exhibits", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  assert.match(source, /outbuilding_parent_conflict/);
  assert.match(source, /outbuilding_photo_required/);
  assert.match(source, /outbuilding_unit_count/);
  assert.match(source, /outbuilding_utility_none_conflict/);
  assert.match(source, /outbuilding_room_required/);
  assert.match(source, /outbuilding_defect_required/);
  assert.match(source, /outbuilding_defect_photo_required/);
  assert.match(source, /outbuilding_unit_must_be_adu/);
});
