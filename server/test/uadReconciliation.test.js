import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  calculateReconciliationRepairTotal,
  validateCompleteSection,
} from "../src/modules/uad/editor.js";
import { getUadField, getUadEditorSections } from "../src/modules/uad/fieldCatalog.js";
import {
  UAD_RECONCILIATION_COST_EXCLUSION_REASONS,
  UAD_RECONCILIATION_INCOME_EXCLUSION_REASONS,
  UAD_RECONCILIATION_VALUE_CONDITIONS,
  isVerifiedReconciliationAsset,
} from "../src/modules/uad/reconciliationCatalog.js";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

function row(context, uid, value, entityId = null) {
  return { entity_id: entityId, field_context: context, uad_uid: uid, value };
}

function validStandardSfrRows() {
  return [
    row("sales_comparison_scope", "1000.0032", true),
    row("sales_comparison_summary", "1300.0006", 302000),
    row("scope_of_work", "1000.0030", false),
    row("income_approach_exclusion", "1300.0004", ["NotNecessaryForCredibleResults"]),
    row("scope_of_work", "1000.0027", false),
    row("cost_approach_exclusion", "1300.0002", ["NotNecessaryForCredibleResults"]),
    row("reconciliation", "1300.0017", 305000),
    row("reconciliation", "1300.0010", ["AsIs"]),
    row("reconciliation", "1300.0013", 45),
    row("reconciliation", "1300.0012", "2026-08-18"),
    row("reconciliation", "1300.0019", false),
    row("reconciliation", "1300.0021", "The Sales Comparison Approach receives primary weight."),
    row("subject", "0300.0010", false),
  ];
}

test("registers the official Section 26 fields, options, and repeatable client condition", () => {
  const section = getUadEditorSections().find((item) => item.key === "reconciliation");
  assert.equal(section.officialSectionNumber, 26);
  assert.deepEqual(getUadField("reconciliation", "1300.0010").options, UAD_RECONCILIATION_VALUE_CONDITIONS);
  assert.deepEqual(getUadField("income_approach_exclusion", "1300.0004").options, UAD_RECONCILIATION_INCOME_EXCLUSION_REASONS);
  assert.deepEqual(getUadField("cost_approach_exclusion", "1300.0002").options, UAD_RECONCILIATION_COST_EXCLUSION_REASONS);
  assert.equal(getUadField("additional_requested_conditional_valuation", "1300.0027").entityType, "additional_requested_conditional_valuation");
  assert.equal(getUadField("income_approach_summary", "1200.0004").readOnly, true);
  assert.equal(getUadField("cost_approach_summary", "1300.0001").readOnly, true);
  assert.deepEqual(getUadField("defect_summary", "3900.0001").options, ["None", "TotalCost", "Itemized"]);
  assert.equal(getUadField("site_defect", "3900.0126").entityType, "site_defect");
  assert.equal(isVerifiedReconciliationAsset({ section_number: 26, status: "verified", caption_type: "ReconciliationExhibit" }), true);
  assert.equal(isVerifiedReconciliationAsset({ section_number: 26, status: "pending", caption_type: "ReconciliationExhibit" }), false);
});

test("accepts a complete standard single-family reconciliation", () => {
  assert.deepEqual(validateCompleteSection("reconciliation", validStandardSfrRows(), [], []), []);
});

test("requires exactly one supported exposure-time form", () => {
  const both = [
    ...validStandardSfrRows(),
    row("reconciliation", "1300.0015", 30),
    row("reconciliation", "1300.0014", 60),
  ];
  assert.equal(
    validateCompleteSection("reconciliation", both, [], []).some((error) => error.code === "exposure_time_mutually_exclusive"),
    true,
  );

  const range = validStandardSfrRows().filter((item) => item.uad_uid !== "1300.0013");
  range.push(row("reconciliation", "1300.0015", 60), row("reconciliation", "1300.0014", 30));
  assert.equal(
    validateCompleteSection("reconciliation", range, [], []).some((error) => error.code === "exposure_time_range_order"),
    true,
  );
});

test("rejects As Is when another value condition or an actionable defect exists", () => {
  const multiple = validStandardSfrRows().map((item) => (
    item.uad_uid === "1300.0010" ? { ...item, value: ["AsIs", "SubjectToRepair"] } : item
  ));
  assert.equal(
    validateCompleteSection("reconciliation", multiple, [], []).some((error) => error.code === "as_is_condition_exclusive"),
    true,
  );

  const defectId = "eaa53002-cf3a-4bb8-a14a-6eab70458628";
  const withDefect = [
    ...validStandardSfrRows(),
    row("site_defect", "3900.0128", "Repair", defectId),
  ];
  const entities = [{ id: defectId, entity_type: "site_defect", ordinal: 1, label: "Foundation crack", data: {} }];
  assert.equal(
    validateCompleteSection("reconciliation", withDefect, [], entities).some((error) => error.code === "as_is_defect_action_conflict"),
    true,
  );

  const amenityDefectId = "8f6d43c6-e801-4f87-9db4-f0ba5d33b65d";
  const withAmenityDefect = [
    ...validStandardSfrRows(),
    row("subject_property_amenity_defect", "3900.0142", "Inspection", amenityDefectId),
  ];
  const amenityEntities = [{ id: amenityDefectId, entity_type: "amenity_defect", ordinal: 1, label: "Pool defect", data: {} }];
  assert.equal(
    validateCompleteSection("reconciliation", withAmenityDefect, [], amenityEntities).some((error) => error.code === "as_is_defect_action_conflict"),
    true,
  );
});

test("requires market value conditions to resolve their matching defect actions", () => {
  const defectId = "0d49f6e5-43ee-46d0-aaed-1aa7b02f6c45";
  const entities = [{ id: defectId, entity_type: "site_defect", ordinal: 1, label: "Foundation crack", data: {} }];
  const rows = validStandardSfrRows().map((item) => (
    item.uad_uid === "1300.0010" ? { ...item, value: ["SubjectToInspection"] } : item
  ));
  rows.push(
    row("site_defect", "3900.0128", "Repair", defectId),
    row("defect_summary", "3900.0001", "None"),
  );
  const codes = validateCompleteSection("reconciliation", rows, [], entities).map((error) => error.code);
  assert.equal(codes.includes("defect_action_value_condition_mismatch"), true);
  assert.equal(codes.includes("value_condition_defect_action_required"), true);
});

test("calculates itemized repair cost and validates the official reporting methods", () => {
  const defectId = "4b03d4e5-d18a-4e87-a87f-bb50d7c95bce";
  const entities = [{ id: defectId, entity_type: "site_defect", ordinal: 1, label: "Foundation crack", data: {} }];
  const rows = validStandardSfrRows().map((item) => (
    item.uad_uid === "1300.0010" ? { ...item, value: ["SubjectToRepair"] } : item
  ));
  rows.push(
    row("site_defect", "3900.0128", "Repair", defectId),
    row("site_defect", "3900.0126", 1250, defectId),
    row("defect_summary", "3900.0001", "Itemized"),
    row("reconciliation", "1300.0034", "C4"),
  );

  const calculated = calculateReconciliationRepairTotal(rows, [], entities);
  assert.equal(calculated[0].field.key, "defect_summary:3900.0002");
  assert.equal(calculated[0].value, 1250);
  assert.deepEqual(validateCompleteSection("reconciliation", rows, [], entities), []);

  const missingMethod = rows.filter((item) => item.uad_uid !== "3900.0001");
  assert.equal(
    validateCompleteSection("reconciliation", missingMethod, [], entities).some((error) => error.code === "repair_cost_method_required"),
    true,
  );

  const noneWithItemizedCost = rows.map((item) => (
    item.uad_uid === "3900.0001" ? { ...item, value: "None" } : item
  ));
  assert.equal(
    validateCompleteSection("reconciliation", noneWithItemizedCost, [], entities).some((error) => error.code === "itemized_repair_cost_conflict"),
    true,
  );
});

test("keeps client requested conditions consistent with their indicator and duration", () => {
  const conditionId = "b5ad36c0-91e1-4782-8462-0cfde0d5b782";
  const rows = validStandardSfrRows().map((item) => (
    item.uad_uid === "1300.0019" ? { ...item, value: true } : item
  ));
  const entities = [{
    id: conditionId,
    entity_type: "additional_requested_conditional_valuation",
    ordinal: 1,
    label: "Client requested condition 1",
    data: {},
  }];
  rows.push(
    row("additional_requested_conditional_valuation", "1300.0022", ["SubjectToRepair"], conditionId),
    row("additional_requested_conditional_valuation", "1300.0026", "ReasonableExposureTime", conditionId),
    row("additional_requested_conditional_valuation", "1300.0023", 30, conditionId),
    row("additional_requested_conditional_valuation", "1300.0027", 310000, conditionId),
    row("reconciliation", "1300.0029", "Requested alternate repair condition."),
  );
  assert.deepEqual(validateCompleteSection("reconciliation", rows, [], entities), []);

  const noDuration = rows.filter((item) => item.uad_uid !== "1300.0023");
  assert.equal(
    validateCompleteSection("reconciliation", noDuration, [], entities).some((error) => error.code === "exposure_time_required"),
    true,
  );
});

test("registers the additive Section 26 migration and local cross-field rules", () => {
  const sql = fs.readFileSync(path.join(TEST_DIRECTORY, "../migrations/20260921_uad_reconciliation.sql"), "utf8");
  const previousSql = fs.readFileSync(path.join(TEST_DIRECTORY, "../migrations/20260919_uad_sales_comparison_reconciliation.sql"), "utf8");
  const entityTypes = (migration) => new Set(
    [...migration.split("WITH catalog")[0].matchAll(/'([a-z][a-z0-9_]+)'/g)].map((match) => match[1]),
  );
  const previousEntityTypes = entityTypes(previousSql);
  const reconciliationEntityTypes = entityTypes(sql);
  assert.match(sql, /additional_requested_conditional_valuation/);
  assert.match(sql, /1300\.0017/);
  assert.match(sql, /1300\.0034/);
  assert.match(sql, /3900\.0001/);
  assert.match(sql, /3900\.0002/);
  assert.match(sql, /Appendix A-1 URAR Delivery Specification 1\.4/);
  assert.match(sql, /HN-UAD-RECONCILIATION-005/);
  assert.equal(
    [...previousEntityTypes].every((entityType) => reconciliationEntityTypes.has(entityType)),
    true,
    "Section 26 migration must preserve every previously allowed UAD entity type",
  );
});
