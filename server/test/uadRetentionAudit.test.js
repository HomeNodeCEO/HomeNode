import assert from "node:assert/strict";
import test from "node:test";

import { auditUadRetention } from "../src/modules/uad/uadRetentionAudit.js";

test("reports aggregate retention candidates without deleting or identifying workfiles", async () => {
  const queries = [];
  const rows = [
    { total: "10", finalized: "4", review_candidates: "1" },
    { total: "20", verified: "12", review_candidates: "2" },
    { total: "8", ready: "5", review_candidates: "1" },
    { total: "3", raw_response_count: "3", raw_response_review_candidates: "0" },
  ];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [rows[queries.length - 1]] };
    },
  };

  const audit = await auditUadRetention(pool, { reviewDays: 1 });
  assert.equal(audit.mode, "review_only");
  assert.equal(audit.automatic_deletion, false);
  assert.equal(audit.review_threshold_days, 365);
  assert.equal(audit.aggregates.workfiles.total, 10);
  assert.equal(audit.aggregates.assets.review_candidates, 2);
  assert.equal(audit.aggregates.compliance_exchanges.raw_response_count, 3);
  assert.equal(queries.length, 4);
  for (const query of queries) {
    assert.match(query.sql, /^SELECT/i);
    assert.doesNotMatch(query.sql, /\b(?:DELETE|UPDATE|INSERT|TRUNCATE|DROP)\b/i);
    assert.deepEqual(query.params, [365]);
  }
  assert.doesNotMatch(JSON.stringify(audit), /workfile_id|object_key|response_payload/);
});

test("caps the review horizon at ten years", async () => {
  const pool = { async query() { return { rows: [{}] }; } };
  const audit = await auditUadRetention(pool, { reviewDays: 99_999 });
  assert.equal(audit.review_threshold_days, 3650);
});
