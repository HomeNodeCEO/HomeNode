import assert from "node:assert/strict";
import test from "node:test";

import { selectAssignmentFile } from "../src/lib/assignmentFileSelection.ts";

const older = { id: 10, file_number: "A-10" };
const latest = { id: 20, file_number: "A-20" };

test("requested appraisal file wins over the latest file", () => {
  assert.equal(selectAssignmentFile([older, latest], latest, older.id), older);
});

test("an explicit unavailable appraisal file never falls back to another file", () => {
  assert.equal(selectAssignmentFile([older, latest], latest, 999), null);
});

test("only an absent request permits the latest appraisal file", () => {
  assert.equal(selectAssignmentFile([older, latest], latest), latest);
  for (const id of [null, 0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(selectAssignmentFile([older, latest], latest, id), null);
  }
});

test("an account without appraisal files has no active file", () => {
  assert.equal(selectAssignmentFile([], null, null), null);
});
