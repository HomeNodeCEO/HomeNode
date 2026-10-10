import assert from "node:assert/strict";
import test from "node:test";

import {
  createAddressReportFile,
  manualSubjectAccountId,
} from "../src/modules/mobile/reportFiles.js";

const requestId = "a511e97b-3c1a-4810-9c9f-f42cce7ab92d";

test("address-only subjects use a stable account key outside county account space", () => {
  assert.equal(manualSubjectAccountId(requestId), "HNMANUAL_A511E97B3C1A48109C9FF42CCE7AB92D");
  assert.throws(() => manualSubjectAccountId("bad-id"), /invalid_client_request_id/);
});

test("invalid address-only requests stop before a database connection", async () => {
  const pool = { connect: () => { throw new Error("unexpected_database_connection"); } };
  const input = { workflow_type: "custom_appraisal", client_request_id: requestId };
  await assert.rejects(
    createAddressReportFile(pool, {}, { ...input, subject: { address: "Smith, John" } }),
    /invalid_subject_address/,
  );
  await assert.rejects(
    createAddressReportFile(pool, {}, { ...input, subject: { address: "123 Main St", city: "X".repeat(101) } }),
    /invalid_subject_address/,
  );
  await assert.rejects(
    createAddressReportFile(pool, {}, { ...input, workflow_type: "property_tax_protest", subject: { address: "123 Main St" } }),
    /invalid_workflow_type/,
  );
});
