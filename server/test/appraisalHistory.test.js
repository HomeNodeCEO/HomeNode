import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  getPreviousAppraisalFileById,
  listPreviousAppraisalFiles,
  normalizeAppraisalHistoryPage,
  normalizeReplicationRequest,
  summarizeAppraisalHistoryRow,
} from "../src/services/appraisalHistory.js";

const HISTORY_FILE_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
];

test("appraisal-history pagination is bounded and cursor based", async () => {
  assert.deepEqual(normalizeAppraisalHistoryPage(), { limit: 25, cursor: null });
  assert.equal(normalizeAppraisalHistoryPage({ limit: "50" }).limit, 50);
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: "1.5" }, { cursor: "not-json" }]) {
    assert.throws(() => normalizeAppraisalHistoryPage(input), /invalid_appraisal_history_/);
  }

  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: HISTORY_FILE_IDS.map((id, index) => ({
          id,
          account_id: "subject-1",
          workflow_type: "custom_appraisal",
          file_number: `FILE-${index + 1}`,
          custom_assignment_file_id: index + 1,
          created_at: new Date(Date.UTC(2026, 8, 20 - index)).toISOString(),
          updated_at: new Date(Date.UTC(2026, 8, 21 - index)).toISOString(),
          subject_data: { account: { legal_description: `LOT ${index + 1}` } },
        })),
      };
    },
  };
  const first = await listPreviousAppraisalFiles(pool, "subject-1", null, { limit: 2 });
  assert.equal(calls.length, 1, "a history page must not run per-row live-data enrichment queries");
  assert.match(calls[0].sql, /LIMIT \$10/);
  assert.equal(calls[0].values[9], 3);
  assert.equal(calls[0].values[10], null);
  assert.equal(first.files.length, 2);
  assert.equal(first.page.has_more, true);
  assert.ok(first.page.next_cursor);

  const cursor = normalizeAppraisalHistoryPage({ cursor: first.page.next_cursor }).cursor;
  assert.deepEqual(cursor, {
    updatedAt: "2026-09-20T00:00:00.000Z",
    createdAt: "2026-09-19T00:00:00.000Z",
    id: HISTORY_FILE_IDS[1],
  });
});

test("replication enrichment reads its exact historical file in one bounded query", async () => {
  const calls = [];
  const targetId = HISTORY_FILE_IDS[2];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{
        id: targetId,
        account_id: "subject-1",
        workflow_type: "custom_appraisal",
        file_number: "HISTORICAL-TARGET",
        custom_assignment_file_id: 19,
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-02T00:00:00.000Z",
        subject_data: { account: { legal_description: "LOT 19" } },
      }] };
    },
  };
  const file = await getPreviousAppraisalFileById(pool, "subject-1", targetId);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /report_file\.id = \$11::uuid/);
  assert.equal(calls[0].values[9], 2);
  assert.equal(calls[0].values[10], targetId);
  assert.equal(file.id, targetId);
  assert.equal(file.file_number, "HISTORICAL-TARGET");
});

test("replication requests require an explicit same-assignment attestation", () => {
  assert.throws(
    () => normalizeReplicationRequest({
      mode: "same_assignment_alternate",
      target_workflow_type: "uad_3_6",
    }),
    /same_assignment_confirmation_required/,
  );
  assert.deepEqual(
    normalizeReplicationRequest({
      mode: "same_assignment_alternate",
      target_workflow_type: "uad_3_6",
      same_assignment_confirmed: true,
      effective_date: "2026-08-19",
      inspection_date: "2026-08-18",
      client_request_id: "b88045af-10b3-4da2-8b23-c20b394e454d",
    }),
    {
      mode: "same_assignment_alternate",
      targetWorkflow: "uad_3_6",
      fileNumber: null,
      effectiveDate: "2026-08-19",
      inspectionDate: "2026-08-18",
      sameAssignmentConfirmed: true,
      clientRequestId: "b88045af-10b3-4da2-8b23-c20b394e454d",
    },
  );
  assert.throws(
    () => normalizeReplicationRequest({
      mode: "new_assignment_template",
      target_workflow_type: "property_tax_protest",
    }),
    /invalid_appraisal_workflow/,
  );
  assert.throws(
    () => normalizeReplicationRequest({
      mode: "new_assignment_template",
      target_workflow_type: "custom_appraisal",
      effective_date: "2026-02-30",
    }),
    /invalid_effective_date/,
  );
  assert.throws(
    () => normalizeReplicationRequest({
      mode: "new_assignment_template",
      target_workflow_type: "custom_appraisal",
      client_request_id: "not-a-uuid",
    }),
    /invalid_client_request_id/,
  );
});

test("history summaries keep assignment-scoped condition, measurements, parcels, and lineage", () => {
  const summary = summarizeAppraisalHistoryRow({
    id: "95401bd2-05e2-45ca-80bf-ce7b03608264",
    account_id: "subject-1",
    appraisal_case_id: "9be0a6ef-71a8-4503-bb4a-d1c6efb83fe7",
    subject_snapshot_id: "1d6aad8b-f9b0-46d4-b1e7-9d024d37df04",
    snapshot_version: 3,
    verification_status: "confirmed",
    workflow_type: "custom_appraisal",
    file_number: "HN-CA-2026-000001",
    custom_assignment_file_id: 17,
    custom_status: "signed",
    custom_revision: 4,
    is_current: false,
    effective_date: "2026-08-01",
    inspection_date: "2026-07-30",
    replication_mode: "new_assignment_template",
    source_report_file_id: "f68229c5-044f-4c41-9857-d1caad15ff8d",
    source_file_number: "HN-UAD-2026-000001",
    change_review_required: true,
    photo_count: 12,
    has_confirmed_sketch: true,
    registry_revision: 4,
    subject_data: {
      account: { legal_description: "LOT 1 BLOCK A" },
      assignment_details: { subject_condition_rating: "C3" },
      property_characteristics: {
        main_improvement: { living_area_sqft: 2480 },
        land_detail: [{ area_sqft: 43560 }, { area_sqft: 21780 }],
      },
    },
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-08-02T00:00:00.000Z",
  });

  assert.equal(summary.status, "signed");
  assert.equal(summary.summary.condition_rating, "C3");
  assert.equal(summary.summary.gross_living_area_sqft, 2480);
  assert.equal(summary.summary.site_area_sqft, 65340);
  assert.equal(summary.summary.site_area_acres, 1.5);
  assert.equal(summary.summary.parcel_count, 2);
  assert.deepEqual(summary.summary.legal_descriptions, ["LOT 1 BLOCK A"]);
  assert.equal(summary.summary.photo_count, 12);
  assert.equal(summary.replication.change_review_required, true);
  assert.equal(summary.view_url, "/report/subject-1?assignmentFileId=17");
});

test("history summaries read UAD condition and quality from the captured report snapshot", () => {
  const summary = summarizeAppraisalHistoryRow({
    id: "0f349b77-c91c-4ca7-829c-5edbe71b5a60",
    account_id: "subject-2",
    workflow_type: "uad_3_6",
    file_number: "HN-UAD-2026-000002",
    uad_workfile_id: "57f26fb0-0ed7-42dc-a7dd-54a87f2b7ab5",
    uad_status: "ready",
    uad_revision: 8,
    registry_revision: 8,
    replication_mode: "original",
    is_current: true,
    subject_data: {
      uad_field_values: [
        { field_context: "subject", uid: "1600.0006", value: "C4" },
        { field_context: "subject", uid: "1600.0007", value: "Q4" },
        { field_context: "site_parcel", uid: "1500.0022", value: { amount: 1, unit: "Acres" } },
        { field_context: "site_parcel", uid: "1500.0022", value: { amount: 21780, unit: "SquareFeet" } },
      ],
      uad_entities: [
        { entity_type: "site_parcel" },
        { entity_type: "site_parcel" },
      ],
      uad_subject_snapshot: {
        account: { legal_description: "TRACT A AND TRACT B" },
        primary_improvements: { living_area_sqft: 2100 },
      },
    },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
  });
  assert.equal(summary.summary.condition_rating, "C4");
  assert.equal(summary.summary.quality_rating, "Q4");
  assert.equal(summary.summary.parcel_count, 2);
  assert.equal(summary.summary.site_area_acres, 1.5);
  assert.equal(summary.replication, null);
  assert.match(summary.view_url, /workfileId=57f26fb0/);
});

test("the appraisal-history migration is additive and preserves report-specific targets", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const migration = fs.readFileSync(
    path.resolve(directory, "../migrations/20260920_appraisal_history_replication.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app\.appraisal_cases/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app\.appraisal_subject_snapshots/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS app\.appraisal_file_replications/);
  assert.match(migration, /same_assignment_alternate/);
  assert.match(migration, /new_assignment_template/);
  assert.doesNotMatch(migration, /DROP\s+(?:DATABASE|SCHEMA|TABLE|COLUMN)/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM/i);
});
