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
import {
  UAD_SUBJECT_AMENITY_CATEGORY_LIMITS,
  UAD_SUBJECT_AMENITY_TYPES,
  isVerifiedSubjectPropertyAmenitiesAsset,
} from "../src/modules/uad/subjectPropertyAmenitiesCatalog.js";

test("adds official always-displayed URAR Section 14", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "subject_property_amenities");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  assert.equal(section?.title, "Subject Property Amenities");
  assert.equal(section?.appliesWhen, undefined);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "subject_property_amenities").length, 41);
  assert.equal(getUadField("subject_property_amenities", "0200.0015")?.reportFieldId, "14.000");
  assert.equal(getUadField("subject_property_amenity_defect", "3900.0142")?.reportFieldId, "14.010");
});

test("uses exact Appendix A-1 category-specific amenity enumerations", () => {
  assert.deepEqual(UAD_SUBJECT_AMENITY_TYPES.OutdoorAccessories, [
    "Fence", "IrrigationSystem", "OutdoorFireplace", "OutdoorKitchen",
    "OutdoorRidingRing", "SportsCourt",
  ]);
  assert.deepEqual(UAD_SUBJECT_AMENITY_TYPES.WaterFeatures, [
    "IngroundPool", "IngroundSpa", "OutdoorShower", "Sauna",
  ]);
  assert.deepEqual(UAD_SUBJECT_AMENITY_TYPES.Miscellaneous, [
    "Airstrip", "ClubMembership", "Other", "SharedLaundryFacilities",
  ]);
  assert.equal(
    normalizeAndValidateUadValue(
      getUadField("amenity_outdoor_living", "0200.0023"),
      "AboveGroundPool",
    ).error?.code,
    "enumeration",
  );
  assert.equal(
    normalizeAndValidateUadValue(
      getUadField("amenity_outdoor_living", "0200.0025"),
      { amount: 1_000_000, unit: "SquareFeet" },
    ).error?.code,
    "measurement",
  );
});

test("models category-specific amenity groups and linked defects", () => {
  const section = getUadEditorSections().find((item) => item.key === "subject_property_amenities");
  const categoryGroups = section.groups.filter((group) => group.entityType === "amenity");
  assert.equal(categoryGroups.length, 5);
  assert.deepEqual(UAD_SUBJECT_AMENITY_CATEGORY_LIMITS, {
    OutdoorAccessories: 6,
    OutdoorLiving: 6,
    WaterFeatures: 4,
    WholeHome: 8,
    Miscellaneous: 8,
  });
  assert.equal(categoryGroups.find((group) => group.name === "Water features")?.maxItems, 4);
  assert.deepEqual(
    categoryGroups.find((group) => group.name === "Outdoor living")?.createData,
    { amenity_category: "OutdoorLiving" },
  );
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.amenity_defect.parentEntityType, "amenity");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.amenity_defect.maxItems, 6);
});

test("applies official material, area, count, and Other-description conditions", () => {
  const livingMaterial = getUadField("amenity_outdoor_living", "0200.0021");
  const livingArea = getUadField("amenity_outdoor_living", "0200.0025");
  const wholeHomeCount = getUadField("amenity_whole_home", "0200.0036");
  const miscellaneousOther = getUadField("amenity_miscellaneous", "0200.0047");
  const deck = (key) => ({ "amenity_outdoor_living:0200.0023": "Deck" })[key];
  const portico = (key) => ({ "amenity_outdoor_living:0200.0023": "Portico" })[key];
  const fireplace = (key) => ({ "amenity_whole_home:0200.0039": "IndoorFireplace" })[key];
  const other = (key) => ({ "amenity_miscellaneous:0200.0046": "Other" })[key];

  assert.equal(uadFieldIsRequired(livingMaterial, deck), true);
  assert.equal(uadFieldIsRequired(livingArea, deck), true);
  assert.equal(uadFieldIsRequired(livingMaterial, portico), false);
  assert.equal(uadFieldIsRequired(livingArea, portico), true);
  assert.equal(uadFieldIsRequired(wholeHomeCount, fireplace), true);
  assert.equal(uadFieldIsRequired(miscellaneousOther, other), true);
});

test("validates amenity fields only against the record's official category", () => {
  const amenityId = "ac097954-76c5-4d05-94e3-43fdfe2ea5e8";
  const options = {
    entityTypesById: new Map([[amenityId, "amenity"]]),
    entityDataById: new Map([[amenityId, { amenity_category: "OutdoorLiving" }]]),
  };
  const valid = validateUadSectionValues("subject_property_amenities", [
    { entity_id: amenityId, context_key: "amenity_outdoor_living", uid: "0200.0017", value: "OutdoorLiving" },
    { entity_id: amenityId, context_key: "amenity_outdoor_living", uid: "0200.0023", value: "Deck" },
  ], options);
  assert.equal(valid.errors.length, 0);
  assert.throws(() => validateUadSectionValues("subject_property_amenities", [
    { entity_id: amenityId, context_key: "amenity_water_features", uid: "0200.0032", value: "IngroundPool" },
  ], options), /invalid_uad_field_values/);
});

test("recognizes only verified entity-linked Section 14 images", () => {
  const entityId = "bb17e117-6637-44c4-a342-9e04add98bf1";
  const asset = {
    entity_id: entityId,
    section_number: 14,
    caption_type: "SubjectPropertyAmenityDefect",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedSubjectPropertyAmenitiesAsset(asset, "SubjectPropertyAmenityDefect", entityId), true);
  assert.equal(isVerifiedSubjectPropertyAmenitiesAsset({ ...asset, section_number: 13 }, "SubjectPropertyAmenityDefect", entityId), false);
  assert.equal(isVerifiedSubjectPropertyAmenitiesAsset({ ...asset, status: "pending" }, "SubjectPropertyAmenityDefect", entityId), false);
  assert.equal(isVerifiedSubjectPropertyAmenitiesAsset({ ...asset, content_type: "application/pdf" }, "SubjectPropertyAmenityDefect", entityId), false);
});

test("seeds Section 14 fields, enumerations, assets, and rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260827_uad_subject_property_amenities.sql"), "utf8");
  assert.match(sql, /PropertyAmenityExistsIndicator/);
  assert.match(sql, /amenity_defect/);
  assert.match(sql, /UAD1045/);
  assert.match(sql, /UAD1685/);
  assert.match(sql, /UAD1739/);
  assert.match(sql, /HN-UAD-SUBJECT-AMENITIES-008/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server validation protects Section 14 relationships and photo requirements", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  assert.match(editor, /subject_amenity_required/);
  assert.match(editor, /subject_amenity_none_conflict/);
  assert.match(editor, /subject_amenity_category_limit/);
  assert.match(editor, /subject_amenity_defect_parent_conflict/);
  assert.match(editor, /subject_amenity_defect_photo_required/);
  assert.match(editor, /subject_amenity_manufactured_attachment_required/);
  assert.match(assets, /invalid_uad_subject_property_amenities_asset_limit/);
  assert.match(assets, /SubjectPropertyAmenityDefect/);
});
