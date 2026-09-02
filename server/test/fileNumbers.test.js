import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateReportFileNumber,
  formatDailyAssignmentFileNumber,
  formatReportFileNumber,
  reportFilePrefix,
} from "../src/modules/mobile/fileNumbers.js";

test("maps every report workflow to its product classification", () => {
  assert.equal(reportFilePrefix("custom_appraisal"), "CA");
  assert.equal(reportFilePrefix("uad_3_6"), "3.6");
  assert.equal(reportFilePrefix("property_tax_protest"), "PT");
  assert.throws(() => reportFilePrefix("unknown"), /invalid_workflow_type/);
});

test("prefixes the existing daily file-number body without changing its sequence", () => {
  const input = { assignmentDate: "2026-09-02", sequenceNumber: 1 };

  assert.equal(
    formatDailyAssignmentFileNumber({ ...input, workflowType: "custom_appraisal" }),
    "CA-2026-245-01",
  );
  assert.equal(
    formatDailyAssignmentFileNumber({ ...input, workflowType: "uad_3_6" }),
    "3.6-2026-245-01",
  );
  assert.equal(
    formatDailyAssignmentFileNumber({ ...input, workflowType: "property_tax_protest" }),
    "PT-2026-245-01",
  );
});

test("keeps the yearly formatter classified for compatibility callers", () => {
  assert.equal(formatReportFileNumber({
    workflowType: "custom_appraisal",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "CA-2026-000001");
  assert.equal(formatReportFileNumber({
    workflowType: "uad_3_6",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "3.6-2026-000001");
  assert.equal(formatReportFileNumber({
    workflowType: "property_tax_protest",
    calendarYear: 2026,
    sequenceNumber: 1,
  }), "PT-2026-000001");
});

test("allocates from the shared daily counter and applies the requested workflow prefix", async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ sequence_number: 4 }] };
    },
  };

  const allocation = await allocateReportFileNumber(client, {
    organizationId: "10000000-0000-4000-8000-000000000001",
    workflowType: "property_tax_protest",
    assignmentDate: "2026-09-02",
  });

  assert.equal(allocation.fileNumber, "PT-2026-245-04");
  assert.equal(allocation.sequenceNumber, 4);
  assert.match(calls[0].sql, /report_file_daily_counters/);
  assert.deepEqual(calls[0].values, [
    "10000000-0000-4000-8000-000000000001",
    "2026-09-02",
  ]);
});
