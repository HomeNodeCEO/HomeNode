import assert from "node:assert/strict";
import test from "node:test";

import {
  APPRAISAL_COMPLETION_ADAPTER_VERSION,
  buildCanonicalAppraisalCompletion,
  loadSharedAppraisalCompletion,
  normalizeAppraisalCompletionReportFileId,
} from "../src/services/appraisalCompletionAdapter.js";
import { customAppraisalReportFixture } from "./fixtures/customAppraisalReportFixture.js";

const CASE_ID = "9be0a6ef-71a8-4503-bb4a-d1c6efb83fe7";
const SNAPSHOT_ID = "1d6aad8b-f9b0-46d4-b1e7-9d024d37df04";
const CUSTOM_REPORT_ID = "95401bd2-05e2-45ca-80bf-ce7b03608264";
const UAD_REPORT_ID = "0f349b77-c91c-4ca7-829c-5edbe71b5a60";

function fixtureInput(targetWorkflow = "custom_appraisal") {
  const { snapshot, property } = customAppraisalReportFixture();
  property.account.state = "TX";
  const sourceReportFile = {
    id: CUSTOM_REPORT_ID,
    account_id: property.account.account_id,
    workflow_type: "custom_appraisal",
    file_number: property.assignment.file_number,
    appraisal_case_id: CASE_ID,
    subject_snapshot_id: SNAPSHOT_ID,
    custom_assignment_file_id: property.assignment.id,
    source_status: "signed",
  };
  const targetReportFile = targetWorkflow === "custom_appraisal"
    ? sourceReportFile
    : {
      id: UAD_REPORT_ID,
      account_id: property.account.account_id,
      workflow_type: "uad_3_6",
      file_number: "HN-UAD-2026-000125",
      appraisal_case_id: CASE_ID,
      subject_snapshot_id: SNAPSHOT_ID,
      uad_workfile_id: "57f26fb0-0ed7-42dc-a7dd-54a87f2b7ab5",
    };
  return {
    targetReportFile,
    sourceReportFile,
    subjectSnapshot: {
      id: SNAPSHOT_ID,
      appraisal_case_id: CASE_ID,
      snapshot_version: 2,
      verification_status: "confirmed",
      effective_date: "2026-08-18",
      inspection_date: "2026-08-17",
      subject_data: {
        custom_signed_snapshot: snapshot,
      },
    },
    customSections: snapshot.sections,
    generatedAt: "2026-08-20T12:00:00.000Z",
  };
}

test("builds a workflow-neutral completion document from the assignment snapshot", () => {
  const completion = buildCanonicalAppraisalCompletion(fixtureInput());

  assert.equal(completion.adapter_version, APPRAISAL_COMPLETION_ADAPTER_VERSION);
  assert.equal(completion.target.workflow_type, "custom_appraisal");
  assert.equal(completion.assignment_scope.subject_snapshot_id, SNAPSHOT_ID);
  assert.equal(completion.subject.identity.account_id, "26272500060150000");
  assert.equal(completion.subject.identity.state, "TX");
  assert.equal(completion.subject.identity.neighborhood_name, "Holiday Park North 6");
  assert.equal(completion.subject.characteristics.gross_living_area_sqft, 1762);
  assert.equal(completion.subject.characteristics.architectural_style, "Traditional");
  assert.deepEqual(completion.subject.characteristics.site, {
    total_area_sqft: 8050,
    dimensions: { frontage_ft: 70, depth_ft: 115 },
    zoning_classifications: ["PD-SF"],
    zoning_descriptions: [],
    land_line_count: 1,
  });
  assert.deepEqual(completion.subject.characteristics.vehicle_storage, [{
    description: "Attached Garage",
    area_sqft: 440,
    parking_spaces: null,
  }]);
  assert.deepEqual(completion.subject.characteristics.additional_improvements, [{
    description: "Attached Garage",
    construction: "Frame",
    area_sqft: 440,
    year_built: 1978,
    value: 12000,
    parking_spaces: null,
  }]);
  assert.equal(completion.subject.characteristics.condition_rating, "C4-C3");
  assert.equal(completion.analyses.neighborhood.boundary.north, "Arapaho Road");
  assert.equal(completion.analyses.market_conditions.status, "complete");
  assert.equal(completion.analyses.comparable_sales.primary_comparables.length, 6);
  assert.equal(completion.analyses.comparable_sales.adjustments.cost_to_cure_total, 5000);
  assert.deepEqual(completion.analyses.comparable_sales.adjustments.cost_to_cure_items, [{
    description: "Repair damaged flooring",
    cost: 5000,
  }]);
  assert.equal(completion.analyses.approaches.sales_comparison.indicated_value, 302000);
  assert.equal(completion.analyses.final_reconciliation.final_value, 305000);
  assert.equal(completion.readiness.status, "complete");
  assert.match(completion.provenance.source_digest_sha256, /^[a-f0-9]{64}$/);
});

test("carries assignment-scoped project, HOA, condition, and conformity evidence", () => {
  const input = fixtureInput("uad_3_6");
  const details = input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence
    .property_report_data.assignment.assignment_details;
  details.pud = true;
  details.hoa_dues_amount = 1200;
  details.hoa_frequency = "per_year";
  details.hoa_explanation = "Mandatory dues cover common-area maintenance.";
  details.subject_condition_rating = "C4";
  details.subject_quality_rating = "Q4";
  details.subject_condition_notes = "Typical wear and average-quality finishes.";
  details.significant_physical_deficiencies = false;
  details.subject_conforms_to_neighborhood = false;
  details.subject_nonconformity_type = "under_improvement";
  details.subject_nonconformity_explanation = "The subject is smaller than the predominant housing stock.";

  const completion = buildCanonicalAppraisalCompletion(input);

  assert.deepEqual(completion.assignment.project, {
    pud: true,
    hoa_dues_amount: 1200,
    hoa_frequency: "per_year",
    hoa_explanation: "Mandatory dues cover common-area maintenance.",
  });
  assert.equal(completion.subject.characteristics.condition_rating, "C4");
  assert.equal(completion.subject.characteristics.quality_rating, "Q4");
  assert.equal(completion.subject.characteristics.condition_notes, "Typical wear and average-quality finishes.");
  assert.equal(completion.subject.characteristics.significant_physical_deficiencies, false);
  assert.equal(completion.subject.characteristics.conforms_to_neighborhood, false);
  assert.equal(completion.subject.characteristics.nonconformity_type, "under_improvement");
  assert.match(completion.subject.characteristics.nonconformity_explanation, /smaller than/);
});

test("carries the frozen assignment location context even when it is stored outside the property report payload", () => {
  const input = fixtureInput("uad_3_6");
  input.subjectSnapshot.subject_data.custom_signed_snapshot.evidence.property_context = {
    confidence: "high",
    automatic_assessment: {
      computed_at: "2026-08-17T15:30:00.000Z",
      spatial_context: {
        parcel_available: true,
        adjacent_influences: [{
          category: "commercial",
          relationship: "rear",
          site_address: "100 Retail Road",
        }],
      },
    },
  };

  const completion = buildCanonicalAppraisalCompletion(input);

  assert.equal(completion.analyses.location_influences.status, "available");
  assert.equal(
    completion.analyses.location_influences.assessment.automatic_assessment
      .spatial_context.adjacent_influences[0].site_address,
    "100 Retail Road",
  );
});

test("shares one Custom analysis with a UAD file only inside the same case and snapshot", () => {
  const completion = buildCanonicalAppraisalCompletion(fixtureInput("uad_3_6"));

  assert.equal(completion.target.workflow_type, "uad_3_6");
  assert.equal(completion.target.report_file_id, UAD_REPORT_ID);
  assert.equal(completion.source.workflow_type, "custom_appraisal");
  assert.equal(completion.source.report_file_id, CUSTOM_REPORT_ID);
  assert.equal(completion.assignment_scope.appraisal_case_id, CASE_ID);
});

test("refuses a source from a different immutable subject snapshot", () => {
  const input = fixtureInput("uad_3_6");
  input.sourceReportFile.subject_snapshot_id = "33333333-3333-4333-8333-333333333333";
  assert.throws(
    () => buildCanonicalAppraisalCompletion(input),
    /appraisal_completion_snapshot_mismatch/,
  );
});

test("rejects unsupported target workflows", () => {
  const input = fixtureInput();
  input.targetReportFile = {
    ...input.targetReportFile,
    workflow_type: "property_tax_protest",
  };
  assert.throws(() => buildCanonicalAppraisalCompletion(input), /target_workflow_unsupported/);
});

test("the completion digest is stable across request times", () => {
  const first = buildCanonicalAppraisalCompletion(fixtureInput());
  const laterInput = fixtureInput();
  laterInput.generatedAt = "2026-08-21T12:00:00.000Z";
  const second = buildCanonicalAppraisalCompletion(laterInput);
  assert.notEqual(first.generated_at, second.generated_at);
  assert.equal(
    first.provenance.source_digest_sha256,
    second.provenance.source_digest_sha256,
  );
});

test("normalizes only UUID report-file identifiers", () => {
  assert.equal(
    normalizeAppraisalCompletionReportFileId(CUSTOM_REPORT_ID.toUpperCase()),
    CUSTOM_REPORT_ID,
  );
  assert.throws(
    () => normalizeAppraisalCompletionReportFileId("125"),
    /invalid_appraisal_report_file_id/,
  );
});

test("loads a Custom completion source for a same-snapshot UAD target", async () => {
  const input = fixtureInput("uad_3_6");
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("report_file.id = $1")) return { rows: [input.targetReportFile] };
      if (sql.includes("FROM app.appraisal_subject_snapshots")) {
        return { rows: [input.subjectSnapshot] };
      }
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

  const completion = await loadSharedAppraisalCompletion(pool, {
    accountId: "26272500060150000",
    reportFileId: UAD_REPORT_ID,
  });

  assert.equal(completion.target.workflow_type, "uad_3_6");
  assert.equal(completion.source.report_file_id, CUSTOM_REPORT_ID);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].params, [125]);
});

test("reports a bounded missing-source state for a UAD-only assignment", async () => {
  const input = fixtureInput("uad_3_6");
  const pool = {
    async query(sql) {
      if (sql.includes("report_file.id = $1")) return { rows: [input.targetReportFile] };
      if (sql.includes("FROM app.appraisal_subject_snapshots")) {
        return { rows: [input.subjectSnapshot] };
      }
      if (sql.includes("report_file.workflow_type = 'custom_appraisal'")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  await assert.rejects(
    loadSharedAppraisalCompletion(pool, {
      accountId: "26272500060150000",
      reportFileId: UAD_REPORT_ID,
    }),
    /shared_appraisal_completion_source_not_found/,
  );
});
