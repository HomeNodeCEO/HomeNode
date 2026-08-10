import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAssignmentFileId,
  normalizeAssignmentFileNumber,
} from "../src/services/assignmentFiles.js";

test("normalizes assignment file numbers without restricting common appraisal formats", () => {
  assert.equal(normalizeAssignmentFileNumber("  FAS-2026 / 001  "), "FAS-2026 / 001");
  assert.throws(() => normalizeAssignmentFileNumber(""), /invalid_file_number/);
  assert.throws(() => normalizeAssignmentFileNumber("bad\nnumber"), /invalid_file_number/);
});

test("normalizes optional assignment file identifiers", () => {
  assert.equal(normalizeAssignmentFileId("42"), 42);
  assert.equal(normalizeAssignmentFileId(""), null);
  assert.throws(() => normalizeAssignmentFileId("nope"), /invalid_assignment_file_id/);
  assert.throws(
    () => normalizeAssignmentFileId(null, { required: true }),
    /invalid_assignment_file_id/,
  );
});
