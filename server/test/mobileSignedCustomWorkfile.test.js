import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCustomAppraisalInspectionWritable,
  lockCustomAppraisalInspectionWorkfile,
} from "../src/modules/mobile/signedCustomWorkfile.js";

function fakeClient(status) {
  const queries = [];
  return {
    queries,
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: status == null ? [] : [{ status }] };
    },
  };
}

test("non-Custom mobile sessions retain their existing write behavior", async () => {
  const client = fakeClient("signed");
  await assertCustomAppraisalInspectionWritable(client, { workflow_type: "uad_3_6" });
  await assertCustomAppraisalInspectionWritable(client, { workflow_type: "property_tax_protest" });
  assert.equal(client.queries.length, 0);
});

test("Custom mobile evidence writes lock the signing workfile and reject signed files", async () => {
  const client = fakeClient("signed");
  await assert.rejects(
    assertCustomAppraisalInspectionWritable(client, {
      workflow_type: "custom_appraisal", custom_assignment_file_id: 42,
    }),
    /custom_appraisal_workfile_signed/,
  );
  assert.equal(client.queries.length, 1);
  assert.match(client.queries[0].sql, /WHERE assignment_file_id = \$1 FOR UPDATE/);
  assert.deepEqual(client.queries[0].values, [42]);
});

test("draft Custom workfiles stay writable while missing links fail closed", async () => {
  assert.equal(await lockCustomAppraisalInspectionWorkfile(fakeClient("draft"), {
    workflow_type: "custom_appraisal", custom_assignment_file_id: 42,
  }), "draft");
  assert.equal(await lockCustomAppraisalInspectionWorkfile(fakeClient("signed"), {
    workflow_type: "custom_appraisal", custom_assignment_file_id: 42,
  }), "signed", "callers may recognize an exact idempotent replay without writing");
  await assert.rejects(
    assertCustomAppraisalInspectionWritable(fakeClient(null), {
      workflow_type: "custom_appraisal", custom_assignment_file_id: 42,
    }),
    /custom_appraisal_workfile_not_found/,
  );
  await assert.rejects(
    assertCustomAppraisalInspectionWritable(fakeClient("draft"), {
      workflow_type: "custom_appraisal", custom_assignment_file_id: null,
    }),
    /custom_appraisal_workfile_not_found/,
  );
});
