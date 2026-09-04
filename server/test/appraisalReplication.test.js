import assert from "node:assert/strict";
import test from "node:test";

import { replicateAppraisalFile } from "../src/services/appraisalReplication.js";

const IDS = Object.freeze({
  source: "11111111-1111-4111-8111-111111111111",
  target: "22222222-2222-4222-8222-222222222222",
  organization: "33333333-3333-4333-8333-333333333333",
  actor: "44444444-4444-4444-8444-444444444444",
  appraisalCase: "55555555-5555-4555-8555-555555555555",
  snapshot: "66666666-6666-4666-8666-666666666666",
  workfile: "77777777-7777-4777-8777-777777777777",
  request: "88888888-8888-4888-8888-888888888888",
});

function existingReplicationRow(overrides = {}) {
  return {
    id: IDS.target,
    organization_id: IDS.organization,
    account_id: "subject-1",
    workflow_type: "uad_3_6",
    file_number: "HN-UAD-2026-000001",
    sequence_number: 1,
    creation_request_id: IDS.request,
    previous_report_file_id: IDS.source,
    custom_assignment_file_id: null,
    uad_workfile_id: IDS.workfile,
    is_current: true,
    registry_revision: 1,
    created_by_user_id: IDS.actor,
    created_at: "2026-09-04T12:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
    appraisal_case_id: IDS.appraisalCase,
    subject_snapshot_id: IDS.snapshot,
    source_report_file_id: IDS.source,
    source_file_number: "SOURCE-1",
    recorded_replication_mode: "new_assignment_template",
    change_review_required: true,
    attestation: {
      same_assignment_confirmed: false,
      requested_file_number: null,
      effective_date: "2026-09-03",
      inspection_date: "2026-09-02",
    },
    uad_status: "draft",
    uad_revision: 1,
    effective_date: "2026-09-03",
    inspection_date: "2026-09-02",
    ...overrides,
  };
}

function retryPool(row) {
  const queries = [];
  let released = false;
  const client = {
    async query(sql, parameters = []) {
      queries.push({ sql, parameters });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("WHERE target.creation_request_id = $1")) return { rows: [row] };
      throw new Error(`unexpected_query:${sql}`);
    },
    release() {
      released = true;
    },
  };
  return {
    queries,
    get released() { return released; },
    async connect() { return client; },
    async query() { throw new Error("history_temporarily_unavailable"); },
  };
}

function replicationInput(overrides = {}) {
  return {
    mode: "new_assignment_template",
    target_workflow_type: "uad_3_6",
    effective_date: "2026-09-03",
    inspection_date: "2026-09-02",
    client_request_id: IDS.request,
    ...overrides,
  };
}

test("a committed replication retry returns the original file when history enrichment is unavailable", async () => {
  const pool = retryPool(existingReplicationRow());
  const logEvents = [];
  const result = await replicateAppraisalFile(pool, {
    accountId: "subject-1",
    sourceReportFileId: IDS.source,
    input: replicationInput(),
    actorUserId: IDS.actor,
    organizationId: IDS.organization,
    logger: { error: (event) => logEvents.push(event) },
  });

  assert.equal(result.report_file.id, IDS.target);
  assert.equal(result.report_file.target_id, IDS.workfile);
  assert.equal(result.report_file.view_url, `/uad-3.6/subject-1?workfileId=${IDS.workfile}`);
  assert.equal(result.change_review_required, true);
  assert.equal(pool.queries.some(({ sql }) => sql.startsWith("INSERT")), false);
  assert.equal(pool.queries.at(-1).sql, "COMMIT");
  assert.equal(pool.released, true);
  assert.deepEqual(logEvents, ["[appraisal-replication] response_enrichment_failed"]);
});

test("reusing a replication request id with a changed payload rolls back", async () => {
  const pool = retryPool(existingReplicationRow());
  await assert.rejects(
    () => replicateAppraisalFile(pool, {
      accountId: "subject-1",
      sourceReportFileId: IDS.source,
      input: replicationInput({ inspection_date: "2026-09-01" }),
      actorUserId: IDS.actor,
      organizationId: IDS.organization,
      logger: { error: () => {} },
    }),
    /replication_request_conflict/,
  );
  assert.equal(pool.queries.at(-1).sql, "ROLLBACK");
  assert.equal(pool.released, true);
});

test("an invalid replication request id is rejected before a database connection", async () => {
  let connected = false;
  await assert.rejects(
    () => replicateAppraisalFile({
      async connect() {
        connected = true;
        throw new Error("unexpected_connect");
      },
    }, {
      accountId: "subject-1",
      sourceReportFileId: IDS.source,
      input: replicationInput({ client_request_id: "invalid" }),
    }),
    /invalid_client_request_id/,
  );
  assert.equal(connected, false);
});
