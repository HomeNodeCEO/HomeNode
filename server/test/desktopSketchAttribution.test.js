import assert from "node:assert/strict";
import test from "node:test";

import {
  saveAssignmentInspectionSketch,
  savePropertyTaxInspectionSketch,
} from "../src/modules/mobile/desktopSketches.js";

const AREA_ID = "10000000-0000-4000-8000-000000000021";
const OPERATION_ID = "10000000-0000-4000-8000-000000000031";

function sketchInput() {
  return {
    expected_revision: 1,
    client_operation_id: OPERATION_ID,
    reviewer: "Forged Browser Reviewer",
    sketch: {
      review_status: "draft",
      areas: [{
        id: AREA_ID,
        label: "First floor",
        classification: "above_grade_finished",
        vertices: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 10 },
          { x: 0, y: 10 },
          { x: 0, y: 0 },
        ],
      }],
      rooms: [],
    },
  };
}

function databaseHarness({ workfileStatus = "draft", priorOperation = null, workflow = "custom_appraisal" } = {}) {
  const calls = [];
  const row = {
    id: "sketch-1",
    client_sketch_id: "10000000-0000-4000-8000-000000000041",
    inspection_session_id: "session-1",
    report_file_id: "report-1",
    workflow_type: "custom_appraisal",
    revision: 1,
    measurement_standard: "ansi_z765_2021",
    measurement_method: "exterior",
    review_status: "draft",
    document: {},
    summary: {},
    registry_revision: 7,
    session_revision: 4,
    updated_by_user_id: "prior-user",
    assignment_file_number: "2026-001",
    report_file_number: "2026-001",
    address: "100 Main St",
    city: "Dallas",
    state: "TX",
    postal_code: "75201",
    confirmed_by_user_id: null,
    confirmed_at: null,
    created_at: "2026-09-22T00:00:00.000Z",
    updated_at: "2026-09-22T00:00:00.000Z",
  };
  const client = {
    async query(sql, parameters = []) {
      const statement = String(sql);
      calls.push({ statement, parameters });
      if (statement.includes(workflow === "custom_appraisal"
        ? "FROM app.assignment_files assignment_file"
        : "FROM app.tax_protest_files protest")) {
        return { rows: [row] };
      }
      if (statement.includes("FROM app.inspection_sketch_operations")) {
        return { rows: priorOperation ? [priorOperation] : [] };
      }
      if (statement.includes("FROM app.custom_appraisal_workfiles")) {
        return { rows: [{ status: workfileStatus }] };
      }
      if (statement.startsWith("UPDATE app.inspection_sketches")) {
        return {
          rows: [{
            ...row,
            measurement_standard: parameters[1],
            measurement_method: parameters[2],
            review_status: parameters[3],
            document: JSON.parse(parameters[4]),
            summary: JSON.parse(parameters[5]),
            revision: 2,
            updated_by_user_id: parameters[6],
          }],
        };
      }
      if (statement.startsWith("UPDATE app.report_files")) {
        return { rows: [{ registry_revision: 8 }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() { return client; },
    },
  };
}

function callContaining(calls, fragment) {
  const call = calls.find(({ statement }) => statement.includes(fragment));
  assert.ok(call, `expected query containing ${fragment}`);
  return call;
}

test("desktop sketch audit metadata ignores a browser reviewer and stores the session actor", async () => {
  const harness = databaseHarness();
  const auth = {
    userId: "authenticated-user-id",
    displayName: "Authenticated Appraiser",
    email: "appraiser@example.com",
  };
  const result = await saveAssignmentInspectionSketch(
    harness.pool,
    "ACCOUNT-1",
    19,
    sketchInput(),
    auth,
    false,
  );

  assert.equal(result.sketch.revision, 2);
  const sketchEvent = callContaining(harness.calls, "INSERT INTO app.inspection_sketch_events");
  const sessionEvent = callContaining(harness.calls, "INSERT INTO app.inspection_session_events");
  const reportEvent = callContaining(harness.calls, "INSERT INTO app.report_file_events");
  const operation = callContaining(harness.calls, "INSERT INTO app.inspection_sketch_operations");
  assert.equal(sketchEvent.parameters[3], auth.userId);
  assert.equal(sessionEvent.parameters[1], auth.userId);
  assert.equal(reportEvent.parameters[1], auth.userId);
  assert.equal(operation.parameters[5], auth.userId);
  for (const metadata of [
    JSON.parse(sketchEvent.parameters[8]),
    JSON.parse(sessionEvent.parameters[4]),
    JSON.parse(reportEvent.parameters[4]),
  ]) {
    assert.equal(metadata.reviewer, auth.displayName);
  }
  assert.doesNotMatch(JSON.stringify(harness.calls), /Forged Browser Reviewer/);
});

test("desktop sketch storage fails before database access without an authenticated actor", async () => {
  let connectCalls = 0;
  const pool = {
    async connect() {
      connectCalls += 1;
      throw new Error("unexpected_database_access");
    },
  };
  await assert.rejects(
    saveAssignmentInspectionSketch(pool, "ACCOUNT-1", 19, sketchInput(), null, false),
    /authentication_required/,
  );
  assert.equal(connectCalls, 0);
});

test("signed Custom workfiles reject new desktop sketch revisions before evidence writes", async () => {
  const harness = databaseHarness({ workfileStatus: "signed" });
  await assert.rejects(
    saveAssignmentInspectionSketch(
      harness.pool, "ACCOUNT-1", 19, sketchInput(), { userId: "appraiser-1" }, false,
    ),
    /custom_appraisal_workfile_signed/,
  );
  const workfileLock = callContaining(harness.calls, "FROM app.custom_appraisal_workfiles");
  assert.match(workfileLock.statement, /FOR UPDATE/);
  assert.deepEqual(workfileLock.parameters, [19]);
  assert.equal(harness.calls.some(({ statement }) => statement.startsWith("UPDATE app.inspection_sketches")), false);
  assert.equal(harness.calls.some(({ statement }) => statement.startsWith("UPDATE app.inspection_photos")), false);
});

test("exact desktop sketch operation replays remain read-only after signing", async () => {
  const auth = { userId: "appraiser-1" };
  const input = sketchInput();
  const draft = databaseHarness();
  await saveAssignmentInspectionSketch(draft.pool, "ACCOUNT-1", 19, input, auth, false);
  const requestHash = callContaining(draft.calls, "INSERT INTO app.inspection_sketch_operations").parameters[2];
  const replayHarness = databaseHarness({
    workfileStatus: "signed",
    priorOperation: { request_sha256: requestHash, result: { sketch: { revision: 2 }, report_registry_revision: 8 } },
  });
  const replay = await saveAssignmentInspectionSketch(
    replayHarness.pool, "ACCOUNT-1", 19, input, auth, false,
  );
  assert.deepEqual(replay, { sketch: { revision: 2 }, report_registry_revision: 8 });
  assert.equal(replayHarness.calls.some(({ statement }) => statement.includes("FROM app.custom_appraisal_workfiles")), false);
  assert.equal(replayHarness.calls.some(({ statement }) => statement.startsWith("UPDATE ")), false);
});

test("Property Tax desktop sketch revisions remain independent of Custom signing", async () => {
  const harness = databaseHarness({ workflow: "property_tax_protest", workfileStatus: "signed" });
  const result = await savePropertyTaxInspectionSketch(
    harness.pool, "ACCOUNT-1", 19, sketchInput(), { userId: "appraiser-1" }, false,
  );
  assert.equal(result.sketch.revision, 2);
  assert.equal(harness.calls.some(({ statement }) => statement.includes("FROM app.custom_appraisal_workfiles")), false);
});
