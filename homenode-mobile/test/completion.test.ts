import assert from "node:assert/strict";
import test from "node:test";

import { localInspectionCompletionReadiness } from "../src/completion/model";

test("local inspection completion blocks unsent device work", () => {
  const blocked = localInspectionCompletionReadiness({
    pendingOperations: 2,
    conflicts: 1,
    pendingPhotos: 3,
    pendingSketches: 1,
  });
  assert.equal(blocked.ready, false);
  assert.deepEqual(blocked.blockers, [
    "pending_operations",
    "conflicts",
    "pending_photos",
    "pending_sketches",
  ]);
});

test("local inspection completion is ready only after every queue clears", () => {
  const ready = localInspectionCompletionReadiness({
    pendingOperations: 0,
    conflicts: 0,
    pendingPhotos: 0,
    pendingSketches: 0,
  });
  assert.equal(ready.ready, true);
  assert.ok(ready.checks.every((item) => item.passed));
});
