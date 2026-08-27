import assert from "node:assert/strict";
import test from "node:test";

import { selectAssignmentFile } from "../src/lib/assignmentFileSelection.ts";

const older = { id: 10, file_number: "A-10" };
const latest = { id: 20, file_number: "A-20" };

test("requested appraisal file wins over the latest file", () => {
  assert.equal(selectAssignmentFile([older, latest], latest, older.id), older);
});

test("missing requests fall back to the latest file", () => {
  assert.equal(selectAssignmentFile([older, latest], latest, 999), latest);
});

test("an account without appraisal files has no active file", () => {
  assert.equal(selectAssignmentFile([], null, null), null);
});
