import assert from "node:assert/strict";
import test from "node:test";

import { buildCanonicalAppraisalCompletion } from "../src/services/appraisalCompletionAdapter.js";
import {
  UAD_COMPLETION_SUGGESTION_ADAPTER_VERSION,
  buildUadCompletionSuggestions,
  loadUadCompletionSuggestions,
} from "../src/modules/uad/completionSuggestions.js";
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
    ...suggestions.suggestions.market_fields,
    ...suggestions.suggestions.sales_comparison_fields,
  ].find((item) => item.field_key === key);
}

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
