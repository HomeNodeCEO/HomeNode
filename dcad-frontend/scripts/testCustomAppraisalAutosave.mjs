import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captureAssignmentSaveSelection,
  customAppraisalDraftsMatch,
  isVisibleManualAssignmentSave,
  reconcileCustomAppraisalDraft,
  retainCurrentDraftWhenUnchanged,
} from "../src/lib/customAppraisalAutosave.ts";

const assignmentFilesHookSource = await readFile(
  new URL("../src/hooks/useAssignmentFiles.ts", import.meta.url),
  "utf8",
);
const propertyReportSource = await readFile(
  new URL("../src/pages/PropertyReport.tsx", import.meta.url),
  "utf8",
);

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
    /useLayoutEffect\(\(\) => \{\s*selectionGenerationRef\.current \+= 1;\s*\}, \[accountId, enabled, requestedAssignmentFileId\]\);/u,
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
