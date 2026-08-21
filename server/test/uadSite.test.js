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
import { validateCompleteSection } from "../src/modules/uad/editor.js";
import { isVerifiedSiteAsset } from "../src/modules/uad/siteCatalog.js";

const value = (entityId, contextKey, uid, fieldValue) => ({
  field: getUadField(contextKey, uid),
  entityId,
  value: fieldValue,
});

test("adds official UAD Site as Section 4 without colliding with Assignment or Subject contexts", () => {
  const sections = getUadEditorSections();
  assert.deepEqual(sections.map((section) => section.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 29]);
  assert.equal(sections[2].key, "site");
  assert.ok(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "site").length >= 50);
  assert.equal(new Set(UAD_PHASE_ONE_FIELDS.map((field) => field.key)).size, UAD_PHASE_ONE_FIELDS.length);
  assert.equal(getUadField("site", "1500.0093")?.reportFieldId, "4.000");
  assert.equal(getUadField("site_zoning", "1500.0125")?.reportFieldId, "4.008");
  assert.equal(getUadField("site_influence", "1500.0087")?.entityType, "site_influence");
  assert.equal(getUadField("site_influence", "1500.0075")?.entityType, "site_body_of_water");
  assert.equal(getUadField("site_influence", "1500.0082")?.entityType, "site_waterfront_feature");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.site_body_of_water.parentEntityType, "site_influence");
  assert.equal(UAD_REPEATABLE_ENTITY_GROUPS.site_waterfront_feature.parentEntityType, "site_body_of_water");
});

test("captures subject private water frontage for the Section 22D redisplay", () => {
  const influence = { id: "9f20a2c0-ceaf-4205-9d6c-1028bf25fce7", entity_type: "site_influence", parent_entity_id: null, ordinal: 1, data: {} };
  const body = { id: "0bc0df8b-e870-4a4c-8b06-87e180628fd3", entity_type: "site_body_of_water", parent_entity_id: influence.id, ordinal: 1, data: {} };
  const feature = { id: "e406271d-f4b6-4615-a087-326ce4c8a9dd", entity_type: "site_waterfront_feature", parent_entity_id: body.id, ordinal: 1, data: {} };
  const values = [
    value(influence.id, "site_influence", "1500.0087", "BodyOfWater"),
    value(influence.id, "site_influence", "1500.0091", { amount: 120, unit: "Feet" }),
    value(body.id, "site_influence", "1500.0073", "Lake"),
    value(body.id, "site_influence", "1500.0075", true),
    value(body.id, "site_influence", "1500.0197", "DeepWater"),
    value(body.id, "site_influence", "1500.0079", "Deeded"),
    value(feature.id, "site_influence", "1500.0082", "Dock"),
  ];
  const photo = {
    section_number: 4,
    caption_type: "WaterFrontage",
    content_type: "image/jpeg",
    status: "verified",
  };
  const codes = validateCompleteSection("site", [], values, [influence, body, feature], [photo]).map((error) => error.code);
  assert.equal(codes.includes("site_water_frontage_total_length_required"), false);
  assert.equal(codes.includes("site_water_frontage_photo_required"), false);
  assert.equal(isVerifiedSiteAsset(photo, "WaterFrontage"), true);

  const incompleteCodes = validateCompleteSection(
    "site",
    [],
    values.filter((item) => item.field.uid !== "1500.0091"),
    [influence, body, feature],
  ).map((error) => error.code);
  assert.equal(incompleteCodes.includes("site_water_frontage_total_length_required"), true);
  assert.equal(incompleteCodes.includes("site_water_frontage_photo_required"), true);
});

test("evaluates conditional and cross-section Site requirements", () => {
  const values = new Map([
    ["subject:0100.0047", false],
    ["site:1500.0094", 2],
  ]);
  assert.equal(evaluateUadCondition({ key: "site:1500.0094", greaterThan: 1 }, (key) => values.get(key)), true);
  assert.equal(
    uadFieldIsRequired(getUadField("site", "1500.0093"), (key) => values.get(key)),
    true,
  );
});

test("validates UAD measurements and requires repeatable fields to target the correct entity type", () => {
  const siteSize = getUadField("site", "1500.0093");
  assert.deepEqual(
    normalizeAndValidateUadValue(siteSize, { amount: 0.25, unit: "Acres" }).value,
    { amount: 0.25, unit: "Acres" },
  );
  assert.equal(normalizeAndValidateUadValue(siteSize, { amount: 0, unit: "Acres" }).error?.code, "measurement");
  assert.equal(normalizeAndValidateUadValue(siteSize, { amount: 100, unit: "Unsupported" }).error?.code, "measurement");

  const entityId = "c164248f-645d-48aa-a389-dc668e6c5dc9";
  const valid = validateUadSectionValues("site", [
    { entity_id: entityId, context_key: "site_parcel", uid: "1500.0027", value: "12345678901234567" },
  ], { entityTypesById: new Map([[entityId, "site_parcel"]]) });
  assert.equal(valid.errors.length, 0);
  assert.throws(
    () => validateUadSectionValues("site", [
      { entity_id: entityId, context_key: "site_parcel", uid: "1500.0027", value: "12345678901234567" },
    ], { entityTypesById: new Map([[entityId, "site_view"]]) }),
    /invalid_uad_field_values/,
  );
});

test("Site migration expands repeatable entities and seeds cross-record compliance rules", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260818_uad_site.sql"), "utf8");
  assert.match(sql, /'site_parcel'/);
  assert.match(sql, /'site_influence'/);
  assert.match(sql, /HN-UAD-SITE-001/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("Section 22D migration also supplies the missing subject waterfront catalog and rules", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260907_uad_sales_comparison_water_frontage.sql"), "utf8");
  assert.match(sql, /'site_body_of_water'/);
  assert.match(sql, /'site_waterfront_feature'/);
  for (const ruleId of ["UAD1278", "UAD1333", "UAD1335", "UAD1336", "UAD1337", "UAD1338", "UAD1339", "UAD1340"]) {
    assert.match(sql, new RegExp(ruleId));
  }
});

test("R2 asset workflow bounds uploads and verifies the stored object before accepting it", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  assert.match(source, /50 \* 1024 \* 1024/);
  assert.match(source, /expected_byte_size/);
  assert.match(source, /storage\.inspectObject/);
  assert.match(source, /status = 'rejected'/);
});
