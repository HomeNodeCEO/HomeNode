import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CUSTOM_APPRAISAL_AUTOSAVE_RETRY_MS,
  captureAssignmentSaveSelection,
  customAppraisalDraftsMatch,
  isVisibleManualAssignmentSave,
  reconcileCustomAppraisalDraft,
  retainCurrentDraftWhenUnchanged,
  salesComparisonAutosaveDelay,
  salesComparisonAutosaveRetryDelay,
  salesComparisonDraftFingerprint,
} from "../src/lib/customAppraisalAutosave.ts";

const assignmentFilesHookSource = await readFile(
  new URL("../src/hooks/useAssignmentFiles.ts", import.meta.url),
  "utf8",
);
const propertyReportSource = await readFile(
  new URL("../src/pages/PropertyReport.tsx", import.meta.url),
  "utf8",
);
const salesComparisonSource = await readFile(
  new URL("../src/pages/ComparableSalesAnalysis.tsx", import.meta.url),
  "utf8",
);

test("sales comparison stops showing Loading after a successful DB-backed subject load", () => {
  assert.match(salesComparisonSource, /setLoading\(false\);\s*return;\s*\} catch \{\s*\/\/ Fall through to scraper detail/u);
});

test("sales comparison dedupes only unchanged content, not timestamps", () => {
  const first = { assignmentFileId: 42, savedAt: "first", salesNotes: "Initial" };
  assert.equal(
    salesComparisonDraftFingerprint(first),
    salesComparisonDraftFingerprint({ ...first, savedAt: "later" }),
  );
  assert.notEqual(
    salesComparisonDraftFingerprint(first),
    salesComparisonDraftFingerprint({ ...first, salesNotes: "Edited" }),
  );
});

test("sales comparison autosave has bounded idle wait and a nonzero failure retry", () => {
  assert.equal(salesComparisonAutosaveDelay(1_000, 1_000), 10_000);
  assert.equal(salesComparisonAutosaveDelay(1_000, 51_000), 5_000);
  assert.equal(salesComparisonAutosaveDelay(1_000, 60_000), 0);
  assert.ok(CUSTOM_APPRAISAL_AUTOSAVE_RETRY_MS >= 30_000);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(salesComparisonAutosaveRetryDelay), [
    30_000, 60_000, 120_000, 240_000, 480_000, 480_000,
  ]);
});

test("save results apply only to the same assignment selection generation", () => {
  const generationRef = { current: 4 };
  const fileRef = { current: { id: 101 } };
  const selectionIsCurrent = captureAssignmentSaveSelection(generationRef, fileRef, 101);
  assert.equal(selectionIsCurrent(), true);
  fileRef.current = { id: 202 };
  assert.equal(selectionIsCurrent(), false);
  generationRef.current += 1;
  fileRef.current = { id: 101 };
  assert.equal(selectionIsCurrent(), false);
});

test("assignment selection changes invalidate every asynchronous save completion path", () => {
  assert.match(
    assignmentFilesHookSource,
    /useLayoutEffect\(\(\) => \{\s*selectionGenerationRef\.current \+= 1;\s*setActiveAssignmentFile\(null\);\s*setAssignmentFileNumber\(""\);\s*\}, \[accountId, enabled, requestedAssignmentFileId\]\);/u,
  );
  assert.equal(propertyReportSource.match(/selectionIsCurrent\(\)/gu)?.length, 5);
  assert.match(propertyReportSource, /if \(!selectionIsCurrent\(\)\) return true;/u);
  assert.match(propertyReportSource, /if \(selectionIsCurrent\(\)\) void saveAssignmentDetailsRef\.current/u);
});

test("unrelated server changes are retained while local edits are rebased", () => {
  const result = reconcileCustomAppraisalDraft(
    { occupancy: "owner", hoa: false, notes: "" },
    { occupancy: "tenant", hoa: false, notes: "" },
    { occupancy: "owner", hoa: true, notes: "" },
  );

  assert.deepEqual(result.rebased, {
    occupancy: "tenant",
    hoa: true,
    notes: "",
  });
  assert.deepEqual(result.localChangedKeys, ["occupancy"]);
  assert.deepEqual(result.conflictKeys, []);
});

test("the same field changed differently requires an appraiser decision", () => {
  const result = reconcileCustomAppraisalDraft(
    { occupancy: "owner", notes: "" },
    { occupancy: "tenant", notes: "local" },
    { occupancy: "vacant", notes: "" },
  );

  assert.deepEqual(result.rebased, {
    occupancy: "tenant",
    notes: "local",
  });
  assert.deepEqual(result.conflictKeys, ["occupancy"]);
  assert.deepEqual(result.localChangedKeys, ["occupancy", "notes"]);
});

test("structurally equal drafts do not remain dirty", () => {
  assert.equal(
    customAppraisalDraftsMatch(
      { assignment_types: ["purchase_transaction"], pud: false },
      { assignment_types: ["purchase_transaction"], pud: false },
    ),
    true,
  );
});

test("background autosave does not activate manual save-button feedback", () => {
  assert.equal(isVisibleManualAssignmentSave("autosave"), false);
  assert.equal(isVisibleManualAssignmentSave("manual_save"), true);
});

test("automatic hydration reuses an unchanged draft instead of queuing another save", () => {
  const current = { census_tract: "182.06", neighborhood_sale_count: 127 };
  assert.equal(
    retainCurrentDraftWhenUnchanged(current, {
      census_tract: "182.06",
      neighborhood_sale_count: 127,
    }),
    current,
  );
  assert.notEqual(
    retainCurrentDraftWhenUnchanged(current, {
      census_tract: "182.06",
      neighborhood_sale_count: 128,
    }),
    current,
  );
});
