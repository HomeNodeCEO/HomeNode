import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  UAD_PHASE_ONE_FIELDS,
  evaluateUadCondition,
  getUadEditorSections,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";

test("adds official UAD Site as Section 4 without colliding with Assignment or Subject contexts", () => {
  const sections = getUadEditorSections();
  assert.deepEqual(sections.map((section) => section.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.equal(sections[2].key, "site");
  assert.ok(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "site").length >= 50);
  assert.equal(new Set(UAD_PHASE_ONE_FIELDS.map((field) => field.key)).size, UAD_PHASE_ONE_FIELDS.length);
  assert.equal(getUadField("site", "1500.0093")?.reportFieldId, "4.000");
  assert.equal(getUadField("site_zoning", "1500.0125")?.reportFieldId, "4.008");
  assert.equal(getUadField("site_influence", "1500.0087")?.entityType, "site_influence");
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

test("R2 asset workflow bounds uploads and verifies the stored object before accepting it", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  assert.match(source, /50 \* 1024 \* 1024/);
  assert.match(source, /expected_byte_size/);
  assert.match(source, /storage\.inspectObject/);
  assert.match(source, /status = 'rejected'/);
});
