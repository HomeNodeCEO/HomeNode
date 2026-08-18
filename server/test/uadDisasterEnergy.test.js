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
  uadFieldIsRequired,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";

test("adds official URAR Sections 5 and 6 after Site", () => {
  const sections = getUadEditorSections();
  assert.deepEqual(sections.map((section) => section.officialSectionNumber), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(sections.slice(3, 5).map((section) => section.key), ["disaster_mitigation", "energy_green"]);
  assert.equal(getUadField("disaster_mitigation", "3700.0002")?.reportFieldId, "5.000");
  assert.equal(getUadField("disaster_mitigation_commentary", "3700.0004")?.reportFieldId, "5.001");
  assert.equal(getUadField("energy_green_commentary", "2600.0040")?.reportFieldId, "6.016");
  assert.equal(new Set(UAD_PHASE_ONE_FIELDS.map((field) => field.key)).size, UAD_PHASE_ONE_FIELDS.length);
});

test("models mitigation features as an exclusive multi-selection with conditional commentary", () => {
  const mitigation = getUadField("disaster_mitigation", "3700.0002");
  assert.deepEqual(normalizeAndValidateUadValue(mitigation, ["FortifiedRoof", "StormShelter"]).value, ["FortifiedRoof", "StormShelter"]);
  assert.equal(normalizeAndValidateUadValue(mitigation, ["UnsupportedFeature"]).error?.code, "enumeration");

  const commentary = getUadField("disaster_mitigation_commentary", "3700.0004");
  const values = new Map([["disaster_mitigation:3700.0002", ["FortifiedRoof"]]]);
  assert.equal(uadFieldIsRequired(commentary, (key) => values.get(key)), true);
  values.set("disaster_mitigation:3700.0002", ["None"]);
  assert.equal(uadFieldIsRequired(commentary, (key) => values.get(key)), false);
});

test("validates energy detail values against their repeatable entity contexts", () => {
  const renewableId = "97daf607-bc80-4d6a-a2c7-c64c02b7a48f";
  const valid = validateUadSectionValues("energy_green", [
    { entity_id: renewableId, context_key: "renewable_energy_component", uid: "2600.0019", value: "Solar" },
  ], { entityTypesById: new Map([[renewableId, "renewable_energy_component"]]) });
  assert.equal(valid.errors.length, 0);
  assert.throws(
    () => validateUadSectionValues("energy_green", [
      { entity_id: renewableId, context_key: "renewable_energy_component", uid: "2600.0019", value: "Solar" },
    ], { entityTypesById: new Map([[renewableId, "green_building_certification"]]) }),
    /invalid_uad_field_values/,
  );

  const awardedYear = getUadField("green_building_certification", "2600.0007");
  assert.equal(normalizeAndValidateUadValue(awardedYear, "2025").value, "2025");
  assert.equal(normalizeAndValidateUadValue(awardedYear, "25").error?.code, "year");
});

test("seeds the Section 5 and 6 reference catalog and official Appendix H rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260819_uad_disaster_energy.sql"), "utf8");
  assert.match(sql, /'renewable_energy_component'/);
  assert.match(sql, /'green_building_certification'/);
  assert.match(sql, /'green_efficiency_rating'/);
  assert.match(sql, /UAD1616/);
  assert.match(sql, /UAD1684/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /Appendix H-1 v1\.5/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server cross-record validation protects None and known-feature consistency", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  assert.match(source, /mitigation_none_conflict/);
  assert.match(source, /energy_detail_required/);
  assert.match(source, /energy_detail_conflict/);
});
