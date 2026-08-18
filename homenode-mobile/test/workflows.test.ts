import assert from "node:assert/strict";
import test from "node:test";

import { WORKFLOWS, workflowTitle } from "../src/domain/workflows";

test("routes the three independent HomeNode report types", () => {
  assert.deepEqual(WORKFLOWS.map((workflow) => workflow.type), [
    "custom_appraisal",
    "uad_3_6",
    "property_tax_protest",
  ]);
  assert.equal(workflowTitle("uad_3_6"), "UAD 3.6 Appraisal");
});
