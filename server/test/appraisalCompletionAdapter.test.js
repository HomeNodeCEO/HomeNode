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
  assert.equal(completion.subject.characteristics.gross_living_area_sqft, 1762);
  assert.equal(completion.subject.characteristics.condition_rating, "C4-C3");
  assert.equal(completion.analyses.neighborhood.boundary.north, "Arapaho Road");
  assert.equal(completion.analyses.market_conditions.status, "complete");
  assert.equal(completion.analyses.comparable_sales.primary_comparables.length, 6);
  assert.equal(completion.analyses.approaches.sales_comparison.indicated_value, 302000);
  assert.equal(completion.analyses.final_reconciliation.final_value, 305000);
  assert.equal(completion.readiness.status, "complete");
  assert.match(completion.provenance.source_digest_sha256, /^[a-f0-9]{64}$/);
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
