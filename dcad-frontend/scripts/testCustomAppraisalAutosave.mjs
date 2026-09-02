import assert from "node:assert/strict";
import test from "node:test";

import {
  customAppraisalDraftsMatch,
  isVisibleManualAssignmentSave,
  reconcileCustomAppraisalDraft,
  retainCurrentDraftWhenUnchanged,
} from "../src/lib/customAppraisalAutosave.ts";

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
