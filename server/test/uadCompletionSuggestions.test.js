import assert from "node:assert/strict";
import test from "node:test";

import { buildCanonicalAppraisalCompletion } from "../src/services/appraisalCompletionAdapter.js";
import {
  UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION,
  buildUadCompletionSuggestions,
  loadUadCompletionSuggestions,
} from "../src/modules/uad/completionSuggestions.js";
import { applyUadCompletionSuggestions, buildUadCompletionApplyPlan } from "../src/modules/uad/completionApply.js";
import { customAppraisalReportFixture } from "./fixtures/customAppraisalReportFixture.js";

const CASE_ID = "9be0a6ef-71a8-4503-bb4a-d1c6efb83fe7";
const SNAPSHOT_ID = "1d6aad8b-f9b0-46d4-b1e7-9d024d37df04";
const CUSTOM_REPORT_ID = "95401bd2-05e2-45ca-80bf-ce7b03608264";
const UAD_REPORT_ID = "0f349b77-c91c-4ca7-829c-5edbe71b5a60";
const UAD_WORKFILE_ID = "57f26fb0-0ed7-42dc-a7dd-54a87f2b7ab5";

function fixtureParts() {
  const { snapshot, property } = customAppraisalReportFixture();
  const customSections = structuredClone(snapshot.sections);
  const first = customSections.sales_comparison.value.comparables[0];
  first.sale.distanceMiles = 0.42;
  first.sale.cad_year_built = 1975;
  first.sale.cad_living_area_sqft = 1735;
  first.sale.cad_bedroom_count = 3;
  first.sale.cad_baths_full = 2;
  first.sale.cad_baths_half = 1;
  first.sale.comparableSiteSize = 7600;
  first.sale.attachment_type = "detached";
  first.sale.days_on_market = 12;
  first.sale.source = "NTREIS MLS";
  first.adjustments.concessions = 2500;
  first.adjustments.roomCount = 5000;
  first.adjustments.siteSize = 1200;
  first.adjustments.age = -800;
  first.adjustments.quality = -2500;
  const assignment = snapshot.evidence.property_report_data.assignment.assignment_details;
  assignment.neighborhood_demand_supply = "In Balance";
  assignment.neighborhood_marketing_time = "Under 3 Months";

  const sourceReportFile = {
    id: CUSTOM_REPORT_ID,
    account_id: property.account.account_id,
    workflow_type: "custom_appraisal",
    file_number: property.assignment.file_number,
    appraisal_case_id: CASE_ID,
    subject_snapshot_id: SNAPSHOT_ID,
    custom_assignment_file_id: property.assignment.id,
    source_status: "draft",
  };
  const targetReportFile = {
    id: UAD_REPORT_ID,
    account_id: property.account.account_id,
    workflow_type: "uad_3_6",
    file_number: "HN-UAD-2026-000125",
    appraisal_case_id: CASE_ID,
    subject_snapshot_id: SNAPSHOT_ID,
    uad_workfile_id: UAD_WORKFILE_ID,
  };
  const subjectSnapshot = {
    id: SNAPSHOT_ID,
    appraisal_case_id: CASE_ID,
    snapshot_version: 2,
    verification_status: "confirmed",
    effective_date: "2026-08-18",
    inspection_date: "2026-08-17",
    subject_data: { custom_signed_snapshot: snapshot },
  };
  return {
    customSections,
    sourceReportFile,
    targetReportFile,
    subjectSnapshot,
  };
}

function canonicalCompletion() {
  const input = fixtureParts();
  return buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  });
}

function fieldByKey(suggestions, key) {
  return [
    ...suggestions.suggestions.assignment_fields,
    ...suggestions.suggestions.subject_entity_fields,
    ...suggestions.suggestions.highest_best_use_fields,
    ...suggestions.suggestions.market_fields,
    ...suggestions.suggestions.sales_comparison_fields,
  ].find((item) => item.field_key === key);
}

test("maps exact assignment, subject, and highest-and-best-use facts for review", () => {
  const completion = canonicalCompletion();
  const suggestions = buildUadCompletionSuggestions(completion);

  assert.equal(completion.assignment.assignment_types[0], "purchase_transaction");
  assert.equal(fieldByKey(suggestions, "assignment:1000.0034").value, "Purchase");
  assert.equal(fieldByKey(suggestions, "appraiser_inspection:2400.0080").value, "2026-08-17");
  assert.equal(fieldByKey(suggestions, "unit:0700.0070").value, "OwnerOccupied");
  assert.deepEqual(fieldByKey(suggestions, "unit:0700.0140").value, { amount: 1762, unit: "SquareFeet" });
  assert.equal(fieldByKey(suggestions, "unit:0700.0118").value, 3);
  assert.equal(fieldByKey(suggestions, "unit:0700.0119").value, 2);
  assert.equal(fieldByKey(suggestions, "unit:0700.0120").value, 0);
  assert.deepEqual(fieldByKey(suggestions, "site_parcel:1500.0022").value, { amount: 8050, unit: "SquareFeet" });
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0011").value, "1978");
  assert.equal(fieldByKey(suggestions, "dwelling:0300.0039").value, 31);
  assert.equal(fieldByKey(suggestions, "highest_best_use:3100.0007").value, true);
  assert.match(fieldByKey(suggestions, "highest_best_use_commentary:3100.0010").value, /single-family residential use/);
  assert.deepEqual(fieldByKey(suggestions, "unit:0700.0140").target_entity, {
    entity_type: "unit",
    entity_identifier: "unit-1",
  });
});

test("includes assignment and subject facts in completion provenance", () => {
  const before = canonicalCompletion();
  const input = fixtureParts();
  input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_report_data.assignment.assignment_details.occupancy = "tenant";
  const after = buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  });
  assert.notEqual(before.provenance.source_digest_sha256, after.provenance.source_digest_sha256);
});

test("maps canonical market evidence to review-only official UAD fields", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());

  assert.equal(suggestions.adapter_version, UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION);
  assert.equal(suggestions.apply_mode, "review_only");
  assert.equal(suggestions.requires_appraiser_confirmation, true);
  assert.match(fieldByKey(suggestions, "market:3000.0008").value, /North: Arapaho Road/);
  assert.equal(fieldByKey(suggestions, "market:3000.0009").value, 12);
  assert.equal(fieldByKey(suggestions, "market_total_sales:3000.0026").value, 143);
  assert.equal(fieldByKey(suggestions, "market_total_sales:3000.0029").value, 306000);
  assert.equal(fieldByKey(suggestions, "market:3000.0033").value, "InBalance");
  assert.equal(fieldByKey(suggestions, "market:3000.0031").value, "UnderThreeMonths");
  assert.equal(
    suggestions.suggestions.market_entities[0].values["market_price_trend_source:3000.0051"],
    "HomeNode Appraiser Defined Area",
  );
  assert.equal(
    fieldByKey(suggestions, "market:3000.0008").source_digest_sha256,
    suggestions.source_completion.source_digest_sha256,
  );
});

test("maps only unambiguous comparable facts, ratings, and typed adjustments", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const comparable = suggestions.suggestions.sales_comparable_entities[0];

  assert.equal(fieldByKey(suggestions, "sales_comparison_scope:1000.0032").value, true);
  assert.equal(fieldByKey(suggestions, "sales_comparison_summary:1300.0006").value, 302000);
  assert.equal(comparable.values["sales_comparable_address:1800.0001"], "3209 Innsbrook Dr");
  assert.deepEqual(
    comparable.values["sales_comparable_proximity:1800.0065"],
    { amount: 0.42, unit: "Miles" },
  );
  assert.equal(comparable.values["sales_comparable_listing:1800.0075"], "SettledSale");
  assert.equal(comparable.values["sales_comparable_sale:1800.0272"], 300000);
  assert.equal(comparable.values["sales_comparable_property:1800.0195"], "Detached");
  assert.equal(comparable.values["sales_comparable_property:1800.0197"], "Q4");
  assert.equal(comparable.values["sales_comparable_property:1800.0196"], undefined);
  assert.equal(comparable.values["sales_comparable_adjustment_concessions:1800.0317"], -2500);
  assert.equal(comparable.values["sales_comparable_adjustment_site_size:1800.0317"], 1200);
  assert.equal(comparable.values["sales_comparable_adjustment_year_built:1800.0317"], -800);
  assert.equal(comparable.values["sales_comparable_adjustment_overall_quality:1800.0317"], -2500);

  const dwelling = comparable.related_entities.find((item) => item.entity_type === "sales_comparable_dwelling");
  const unit = dwelling.related_entities.find((item) => item.entity_type === "sales_comparable_unit");
  assert.equal(dwelling.values["sales_comparable_dwelling:1800.0128"], "1975");
  assert.equal(unit.values["sales_comparable_unit:1800.0330"], 3);
  assert.deepEqual(
    unit.values["sales_comparable_unit:1800.0390"],
    { amount: 1735, unit: "SquareFeet" },
  );
  assert.equal(
    suggestions.omissions.some((item) => item.code === "condition_range_requires_appraiser_reconciliation"),
    true,
  );
  assert.equal(
    suggestions.omissions.some((item) => item.code === "combined_room_count_adjustment_requires_split"),
    true,
  );
});

test("omits a market count that exceeds the official UAD field bound", () => {
  const input = fixtureParts();
  input.customSections.market_conditions.value.response.analyses[0].population.eligible_sale_count = 1_200;
  const completion = buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  });
  const suggestions = buildUadCompletionSuggestions(completion);

  assert.equal(fieldByKey(suggestions, "market_total_sales:3000.0026"), undefined);
  assert.equal(
    suggestions.omissions.some((item) => item.code === "market_sale_count_outside_uad_bounds"),
    true,
  );
});

test("requires a UAD target and complete snapshot provenance", () => {
  const completion = canonicalCompletion();
  completion.target.workflow_type = "custom_appraisal";
  assert.throws(
    () => buildUadCompletionSuggestions(completion),
    /uad_completion_target_required/,
  );
  completion.target.workflow_type = "uad_3_6";
  delete completion.provenance.source_digest_sha256;
  assert.throws(
    () => buildUadCompletionSuggestions(completion),
    /invalid_appraisal_completion_provenance/,
  );
});

test("loads the exact UAD report file and same-snapshot Custom source", async () => {
  const input = fixtureParts();
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("WHERE uad_workfile_id = $1")) {
        return { rows: [{ id: UAD_REPORT_ID, account_id: "26272500060150000" }] };
      }
      if (sql.includes("report_file.id = $1")) return { rows: [input.targetReportFile] };
      if (sql.includes("FROM app.appraisal_subject_snapshots")) return { rows: [input.subjectSnapshot] };
      if (sql.includes("report_file.workflow_type = 'custom_appraisal'")) {
        return { rows: [input.sourceReportFile] };
      }
      if (sql.includes("FROM app.custom_appraisal_workfile_sections")) {
        return {
          rows: Object.entries(input.customSections).map(([sectionKey, section]) => ({
            section_key: sectionKey,
            section_value: section.value,
            revision: section.revision,
          })),
        };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const suggestions = await loadUadCompletionSuggestions(pool, UAD_WORKFILE_ID);
  assert.equal(suggestions.source_completion.target_report_file_id, UAD_REPORT_ID);
  assert.equal(suggestions.suggestions.sales_comparable_entities.length, 6);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].params, [UAD_WORKFILE_ID]);
});

test("reports a missing UAD report registration without synthesizing an assignment", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    loadUadCompletionSuggestions(pool, UAD_WORKFILE_ID),
    /uad_completion_report_file_not_registered/,
  );
});


function applyInput(suggestions, selectedSuggestionIds) {
  return {
    selected_suggestion_ids: selectedSuggestionIds,
    expected_source_digest_sha256: suggestions.source_completion.source_digest_sha256,
    expected_adapter_version: suggestions.adapter_version,
    expected_revision: 4,
    preserve_existing: true,
    confirmed: true,
  };
}

test("validates every generated suggestion against the official UAD catalog", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const all = [
    ...suggestions.suggestions.assignment_fields,
    ...suggestions.suggestions.subject_entity_fields,
    ...suggestions.suggestions.highest_best_use_fields,
    ...suggestions.suggestions.market_fields,
    ...suggestions.suggestions.sales_comparison_fields,
    ...suggestions.suggestions.market_entities,
    ...suggestions.suggestions.sales_comparable_entities,
  ];
  const plan = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, all.map((item) => item.suggestion_id)),
    {
      existingEntities: [
        { id: "dwelling-id", entity_type: "dwelling", entity_identifier: "dwelling-1", data: {} },
        { id: "unit-id", entity_type: "unit", entity_identifier: "unit-1", data: {} },
        { id: "parcel-id", entity_type: "site_parcel", entity_identifier: "site-parcel-1", data: {} },
      ],
    },
  );

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.fields.length, suggestions.counts.field_suggestions);
  assert.equal(plan.entities.length, suggestions.counts.entity_suggestions);
  assert.equal(plan.entities.some((item) => item.children.length > 0), true);
});

test("preserves existing UAD values and populated entity groups", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const root = suggestions.suggestions.market_fields[0];
  const comparable = suggestions.suggestions.sales_comparable_entities[0];
  const [context, uid] = root.field_key.split(":");
  const plan = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [root.suggestion_id, comparable.suggestion_id]),
    {
      existingValues: [{ entity_id: null, field_context: context, uad_uid: uid }],
      existingEntities: [{ id: "existing-comparable", entity_type: "sales_comparable", data: {} }],
    },
  );

  assert.equal(plan.fields.length, 0);
  assert.equal(plan.entities.length, 0);
  assert.deepEqual(plan.conflicts.map((item) => item.reason), [
    "existing_value_preserved",
    "entity_type_already_populated",
  ]);
});

test("targets the seeded subject entity and preserves an existing entity value", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const gla = fieldByKey(suggestions, "unit:0700.0140");
  const entities = [{ id: "unit-id", entity_type: "unit", entity_identifier: "unit-1", data: {} }];

  const available = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [gla.suggestion_id]),
    { existingEntities: entities },
  );
  assert.equal(available.fields[0].entityId, "unit-id");
  assert.deepEqual(available.fields[0].value, { amount: 1762, unit: "SquareFeet" });

  const preserved = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [gla.suggestion_id]),
    {
      existingEntities: entities,
      existingValues: [{ entity_id: "unit-id", field_context: "unit", uad_uid: "0700.0140" }],
    },
  );
  assert.equal(preserved.fields.length, 0);
  assert.equal(preserved.conflicts[0].reason, "existing_value_preserved");

  const missing = buildUadCompletionApplyPlan(
    suggestions,
    applyInput(suggestions, [gla.suggestion_id]),
  );
  assert.equal(missing.conflicts[0].reason, "target_entity_not_found");
});

test("requires explicit confirmation, preservation, revision, and exact provenance", () => {
  const suggestions = buildUadCompletionSuggestions(canonicalCompletion());
  const selected = [suggestions.suggestions.market_fields[0].suggestion_id];
  const valid = applyInput(suggestions, selected);

  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, confirmed: false }),
    /uad_completion_confirmation_required/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, preserve_existing: false }),
    /uad_completion_preserve_existing_required/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, expected_revision: 0 }),
    /invalid_uad_completion_revision/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, expected_source_digest_sha256: "0".repeat(64) }),
    /uad_completion_source_changed/,
  );
  assert.throws(
    () => buildUadCompletionApplyPlan(suggestions, { ...valid, selected_suggestion_ids: ["field:unknown:0000"] }),
    /uad_completion_selection_changed/,
  );
});


test("applies reviewed root and seeded-subject fields in one revision and one audit transaction", async () => {
  const input = fixtureParts();
  const suggestions = buildUadCompletionSuggestions(buildCanonicalAppraisalCompletion({
    ...input,
    generatedAt: "2026-08-20T12:00:00.000Z",
  }));
  const selected = suggestions.suggestions.market_fields[0];
  const selectedGla = fieldByKey(suggestions, "unit:0700.0140");
  const insertedRows = [];
  let revisionInserts = 0;
  let auditInserts = 0;
  let releases = 0;
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (sql.includes("SELECT id, current_revision, specification_release_key")) {
        return { rows: [{ id: UAD_WORKFILE_ID, current_revision: 4, specification_release_key: "uad-3.6-2026-01-26" }] };
      }
      if (sql.includes("WHERE uad_workfile_id = $1")) {
        return { rows: [{ id: UAD_REPORT_ID, account_id: "26272500060150000" }] };
      }
      if (sql.includes("report_file.id = $1")) return { rows: [input.targetReportFile] };
      if (sql.includes("FROM app.appraisal_subject_snapshots")) return { rows: [input.subjectSnapshot] };
      if (sql.includes("report_file.workflow_type = 'custom_appraisal'")) return { rows: [input.sourceReportFile] };
      if (sql.includes("FROM app.custom_appraisal_workfile_sections")) {
        return {
          rows: Object.entries(input.customSections).map(([sectionKey, section]) => ({
            section_key: sectionKey, section_value: section.value, revision: section.revision,
          })),
        };
      }
      if (sql.includes("SELECT * FROM appraisal.uad_field_values")) return { rows: insertedRows };
      if (sql.includes("SELECT *") && sql.includes("FROM appraisal.uad_entities")) {
        return {
          rows: [{ id: "unit-id", entity_type: "unit", entity_identifier: "unit-1", data: {} }],
        };
      }
      if (sql.includes("INSERT INTO appraisal.uad_field_values")) {
        insertedRows.push({
          id: params[0], workfile_id: params[1], entity_id: params[2], field_context: params[3],
          uad_uid: params[4], report_field_id: params[5], value: JSON.parse(params[6]),
          source_type: "homenode", source_reference: params[7], is_appraiser_confirmed: true,
        });
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO appraisal.uad_revisions")) { revisionInserts += 1; return { rows: [] }; }
      if (sql.includes("INSERT INTO appraisal.uad_audit_events")) { auditInserts += 1; return { rows: [] }; }
      if (sql.includes("UPDATE appraisal.uad_workfiles")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() { releases += 1; },
  };
  const pool = { connect: async () => client };
  const result = await applyUadCompletionSuggestions(
    pool,
    UAD_WORKFILE_ID,
    applyInput(suggestions, [selected.suggestion_id, selectedGla.suggestion_id]),
  );

  assert.equal(result.current_revision, 5);
  assert.equal(result.applied_suggestion_count, 2);
  assert.equal(insertedRows.length, 2);
  assert.equal(insertedRows.find((row) => row.uad_uid === "0700.0140").entity_id, "unit-id");
  assert.equal(revisionInserts, 1);
  assert.equal(auditInserts, 1);
  assert.equal(releases, 1);
});
