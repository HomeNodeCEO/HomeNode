import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalCustomAppraisalFileName,
  normalizeCustomAppraisalSaveReason,
  normalizeCustomAppraisalSectionKey,
  normalizeCustomAppraisalSectionRevision,
  normalizeCustomAppraisalSectionValue,
} from "../src/services/customAppraisalWorkfiles.js";

test("builds stable unique Custom Appraisal workfile names", () => {
  assert.equal(
    canonicalCustomAppraisalFileName(" FAS 2026 / 001 ", 42),
    "fas-2026-001-42.homenode-appraisal.json",
  );
  assert.notEqual(
    canonicalCustomAppraisalFileName("FAS 2026 / 001", 42),
    canonicalCustomAppraisalFileName("FAS 2026 / 001", 43),
  );
  assert.throws(
    () => canonicalCustomAppraisalFileName("FAS-1", 0),
    /invalid_assignment_file_id/,
  );
});

test("validates independently versioned workfile sections", () => {
  assert.equal(normalizeCustomAppraisalSectionKey(" Sales_Comparison "), "sales_comparison");
  assert.equal(normalizeCustomAppraisalSectionRevision("3"), 3);
  assert.deepEqual(normalizeCustomAppraisalSectionValue({ rows: [] }), { rows: [] });
  assert.equal(normalizeCustomAppraisalSaveReason("manual_save"), "manual_save");
  assert.throws(() => normalizeCustomAppraisalSectionKey("bad.section"), /invalid_custom_appraisal_section_key/);
  assert.throws(() => normalizeCustomAppraisalSectionRevision(-1), /invalid_custom_appraisal_section_revision/);
  assert.throws(() => normalizeCustomAppraisalSectionValue([]), /invalid_custom_appraisal_section_value/);
  assert.throws(() => normalizeCustomAppraisalSaveReason("silent"), /invalid_custom_appraisal_save_reason/);
});

test("rejects oversized workfile sections before a database write", () => {
  assert.throws(
    () => normalizeCustomAppraisalSectionValue({ payload: "x".repeat(900_000) }),
    /custom_appraisal_section_too_large/,
  );
});
