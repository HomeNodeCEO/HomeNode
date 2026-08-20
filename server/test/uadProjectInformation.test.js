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
  uadFieldIsVisible,
  validateUadSectionValues,
} from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_PROJECT_AMENITY_TYPES,
  UAD_PROJECT_DATA_SOURCE_TYPES,
  UAD_PROJECT_INFORMATION_CAPTION_TYPES,
  UAD_PROJECT_INFORMATION_ENTITY_GROUPS,
  UAD_PROJECT_UTILITY_TYPES,
  isVerifiedProjectInformationAsset,
} from "../src/modules/uad/projectInformationCatalog.js";

test("adds conditional official URAR Section 18", () => {
  const sections = getUadEditorSections();
  const section = sections.find((item) => item.key === "project_information");
  assert.deepEqual(
    sections.map((item) => item.officialSectionNumber),
    [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26],
  );
  assert.equal(section?.title, "Project Information");
  assert.ok(section?.appliesWhen);
  assert.equal(UAD_PHASE_ONE_FIELDS.filter((field) => field.section === "project_information").length, 81);
});

test("uses official Section 3 classification to drive project-only and PUD fields", () => {
  const projectName = getUadField("project_information", "2500.0065");
  const monthlyFee = getUadField("project_association_dues", "2500.0007");
  assert.equal(projectName?.reportFieldId, "18.004");
  assert.equal(uadFieldIsVisible(projectName, (key) => key === "subject:2500.0168" ? "Condominium" : undefined), true);
  assert.equal(uadFieldIsRequired(projectName, (key) => key === "subject:2500.0168" ? "Condominium" : undefined), true);
  assert.equal(uadFieldIsVisible(projectName, () => undefined), false);
  assert.equal(uadFieldIsVisible(monthlyFee, (key) => key === "subject:0100.0026"), true);
  assert.equal(uadFieldIsRequired(monthlyFee, (key) => key === "subject:0100.0026"), true);
});

test("models official repeatable sources, utilities, amenities, incomplete components, and liens", () => {
  assert.equal(UAD_PROJECT_INFORMATION_ENTITY_GROUPS.project_data_source.minItems, 1);
  assert.equal(UAD_PROJECT_INFORMATION_ENTITY_GROUPS.project_utility.minItems, 1);
  assert.equal(UAD_PROJECT_INFORMATION_ENTITY_GROUPS.project_amenity.minItems, 1);
  assert.equal(UAD_PROJECT_INFORMATION_ENTITY_GROUPS.project_blanket_financing.maxItems, 4);
  assert.ok(UAD_PROJECT_DATA_SOURCE_TYPES.includes("CondominiumQuestionnaire"));
  assert.ok(UAD_PROJECT_DATA_SOURCE_TYPES.includes("HomeownersAssociation"));
  assert.deepEqual(UAD_PROJECT_UTILITY_TYPES, ["Electricity", "Gas", "None", "Other", "SanitarySewer", "Water"]);
  assert.ok(UAD_PROJECT_AMENITY_TYPES.includes("BoatSlip"));
  assert.ok(UAD_PROJECT_AMENITY_TYPES.includes("UnitStorage"));

  const entityId = "14f35f87-e06d-4aef-b150-256f407eec5d";
  const valid = validateUadSectionValues("project_information", [{
    context_key: "project_data_source",
    uid: "0700.0125",
    entity_id: entityId,
    value: "HomeownersAssociation",
  }], {
    entityTypesById: new Map([[entityId, "project_data_source"]]),
    entityDataById: new Map([[entityId, {}]]),
  });
  assert.equal(valid.errors.length, 0);
});

test("enforces Section 18 enumerations, numeric bounds, and YYYY-MM dates", () => {
  const projectExpiration = getUadField("project_property", "2500.0023");
  const lienPriority = getUadField("project_blanket_financing", "2500.0039");
  const totalUnits = getUadField("project_information", "2500.0060");
  assert.equal(normalizeAndValidateUadValue(projectExpiration, "2045-12").error, null);
  assert.equal(normalizeAndValidateUadValue(projectExpiration, "12/2045").error?.code, "month");
  assert.equal(normalizeAndValidateUadValue(projectExpiration, "2045-13").error?.code, "month");
  assert.equal(normalizeAndValidateUadValue(lienPriority, "FirstLien").error, null);
  assert.equal(normalizeAndValidateUadValue(lienPriority, "PrimaryLien").error?.code, "enumeration");
  assert.equal(normalizeAndValidateUadValue(totalUnits, 1).error, null);
  assert.equal(normalizeAndValidateUadValue(totalUnits, 0).error?.code, "integer");
});

test("recognizes only verified Section 18 project images", () => {
  assert.deepEqual(UAD_PROJECT_INFORMATION_CAPTION_TYPES, ["ProjectAmenity", "ProjectDeficiency", "ProjectExhibit"]);
  const asset = {
    section_number: 18,
    entity_id: null,
    caption_type: "ProjectDeficiency",
    content_type: "image/jpeg",
    status: "verified",
  };
  assert.equal(isVerifiedProjectInformationAsset(asset), true);
  assert.equal(isVerifiedProjectInformationAsset(asset, "ProjectDeficiency", null), true);
  assert.equal(isVerifiedProjectInformationAsset({ ...asset, section_number: 17 }), false);
  assert.equal(isVerifiedProjectInformationAsset({ ...asset, content_type: "application/pdf" }), false);
  assert.equal(isVerifiedProjectInformationAsset({ ...asset, status: "pending_upload" }), false);
});

test("seeds the full Section 18 reference catalog and current rules additively", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const sql = fs.readFileSync(path.resolve(directory, "../migrations/20260831_uad_project_information.sql"), "utf8");
  assert.match(sql, /PropertyInProjectIndicator/);
  assert.match(sql, /ProjectDwellingUnitCount/);
  assert.match(sql, /ProjectBlanketFinancingIndicator/);
  assert.match(sql, /ProjectAmenity/);
  assert.match(sql, /18\.096\.2/);
  for (const ruleId of [
    "UAD1568", "UAD1570", "UAD1573", "UAD1575", "UAD1579", "UAD1580", "UAD1582",
    "UAD1585", "UAD1586", "UAD1589", "UAD1590", "UAD1593", "UAD1596", "UAD1597",
    "UAD1600", "UAD1602", "UAD1603", "UAD1606", "UAD1607", "UAD1610", "UAD1613",
    "UAD1614", "UAD1615", "UAD1727", "UAD1741",
  ]) assert.match(sql, new RegExp(ruleId));
  assert.match(sql, /HN-UAD-PROJECT-004/);
  assert.match(sql, /'18\.037','redisplay','Second Lien'/);
  assert.doesNotMatch(sql, /'repeat'/);
  assert.doesNotMatch(sql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)/i);
});

test("server and frontend enforce the Section 18 workflow without changing legacy forms", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const editor = fs.readFileSync(path.resolve(directory, "../src/modules/uad/editor.js"), "utf8");
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const frontend = fs.readFileSync(path.resolve(directory, "../../dcad-frontend/src/features/uad/components/UadWorkfileEditor.tsx"), "utf8");
  assert.match(editor, /project_classification_conflict/);
  assert.match(editor, /project_unit_count_conflict/);
  assert.match(editor, /project_lien_priority_order/);
  assert.match(editor, /project_deficiency_asset_required/);
  assert.match(assets, /invalid_uad_project_information_content_type/);
  assert.match(assets, /invalid_uad_project_information_asset_entity/);
  assert.match(frontend, /Project information exhibits/);
  assert.match(frontend, /project-amenity-/);
  assert.doesNotMatch(frontend, /PropertyReport/);
});
