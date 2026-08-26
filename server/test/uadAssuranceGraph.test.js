import assert from "node:assert/strict";
import test from "node:test";

import {
  auditUadAssuranceGraph,
  summarizeUadAssuranceGraph,
} from "../src/modules/uad/uadAssuranceGraph.js";

test("assurance graph summaries expose counts without record identifiers", () => {
  const result = summarizeUadAssuranceGraph(
    { workfiles: "2", revisions: 7 },
    [
      { code: "revision_chain_incomplete", finding_count: "0" },
      { code: "artifact_revision_missing", finding_count: "1" },
    ],
  );
  assert.equal(result.ok, false);
  assert.equal(result.finding_count, 1);
  assert.deepEqual(result.nodes, { workfiles: 2, revisions: 7 });
  assert.equal(JSON.stringify(result).includes("workfile_id"), false);
});

test("assurance graph executes every invariant and passes a clean database", async () => {
  let queryCount = 0;
  const pool = {
    async query(sql) {
      queryCount += 1;
      if (String(sql).includes("AS workfiles")) {
        return { rows: [{ workfiles: 1, revisions: 4, entities: 9, field_values: 40 }] };
      }
      return { rows: [{ finding_count: 0 }] };
    },
  };
  const result = await auditUadAssuranceGraph(pool);
  assert.equal(result.ok, true);
  assert.equal(result.finding_count, 0);
  assert.ok(queryCount >= 10);
});
