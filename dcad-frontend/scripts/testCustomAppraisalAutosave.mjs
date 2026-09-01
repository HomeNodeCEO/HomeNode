import assert from "node:assert/strict";
import test from "node:test";

import {
  customAppraisalDraftsMatch,
  reconcileCustomAppraisalDraft,
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
