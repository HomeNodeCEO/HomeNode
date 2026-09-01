import assert from "node:assert/strict";
import test from "node:test";

import { listReportFiles } from "../src/modules/mobile/reportFiles.js";

const organizationId = "11111111-1111-4111-8111-111111111111";

function row(overrides) {
  return {
    id: overrides.id,
    organization_id: organizationId,
    account_id: "10909-SNOWMASS",
    address: "10909 Snowmass Lane",
    city: "Garland",
    postal_code: "75044",
    workflow_type: overrides.workflow_type,
    file_number: overrides.file_number,
    sequence_number: 1,
    custom_assignment_file_id: null,
    uad_workfile_id: null,
    tax_protest_file_id: null,
    previous_report_file_id: null,
    is_current: true,
    registry_revision: 1,
    created_at: "2026-08-20T11:42:00.000Z",
    updated_at: "2026-08-20T11:42:00.000Z",
    activity_updated_at: overrides.activity_updated_at,
    is_recent: true,
    ...overrides,
  };
}

test("report-file discovery returns canonical activity time for every appraisal workflow", async () => {
  const queryCalls = [];
  const pool = {
    async query(sql, params) {
      queryCalls.push({ sql, params });
      return {
        rows: [
          row({
            id: "21111111-1111-4111-8111-111111111111",
            workflow_type: "custom_appraisal",
            file_number: "CA-2026-0001",
            custom_assignment_file_id: 101,
            activity_updated_at: "2026-09-01T14:01:00.000Z",
          }),
          row({
            id: "31111111-1111-4111-8111-111111111111",
            workflow_type: "uad_3_6",
            file_number: "UAD-2026-0001",
            uad_workfile_id: "41111111-1111-4111-8111-111111111111",
            activity_updated_at: "2026-09-01T14:02:00.000Z",
          }),
          row({
            id: "51111111-1111-4111-8111-111111111111",
            workflow_type: "property_tax_protest",
            file_number: "PTP-2026-0001",
            tax_protest_file_id: "61111111-1111-4111-8111-111111111111",
            activity_updated_at: "2026-09-01T14:03:00.000Z",
          }),
        ],
      };
    },
  };
  const auth = {
    userId: "71111111-1111-4111-8111-111111111111",
    organizations: [{ organizationId, roles: ["appraiser"] }],
  };

  const result = await listReportFiles(pool, auth, {
    accountId: "10909-SNOWMASS",
    recentDays: 365,
  });

  assert.deepEqual(
    result.files.map((file) => [file.workflow_type, file.updated_at]),
    [
      ["custom_appraisal", "2026-09-01T14:01:00.000Z"],
      ["uad_3_6", "2026-09-01T14:02:00.000Z"],
      ["property_tax_protest", "2026-09-01T14:03:00.000Z"],
    ],
  );
  assert.equal(queryCalls.length, 1);
  assert.deepEqual(queryCalls[0].params, ["10909-SNOWMASS", null, [organizationId], 365]);
  assert.match(queryCalls[0].sql, /GREATEST\([\s\S]*report_file\.updated_at[\s\S]*custom_assignment\.updated_at[\s\S]*custom_workfile\.updated_at[\s\S]*uad_workfile\.updated_at[\s\S]*tax_protest\.updated_at[\s\S]*\) AS activity_updated_at/);
  assert.match(queryCalls[0].sql, /ORDER BY report_file\.is_current DESC, activity_updated_at DESC/);
});

test("report-file discovery falls back to the registry clock for legacy callers", async () => {
  const pool = {
    async query() {
      return {
        rows: [row({
          id: "81111111-1111-4111-8111-111111111111",
          workflow_type: "custom_appraisal",
          file_number: "CA-2026-0002",
          custom_assignment_file_id: 102,
          activity_updated_at: null,
        })],
      };
    },
  };
  const auth = { organizations: [{ organizationId, roles: ["appraiser"] }] };

  const result = await listReportFiles(pool, auth, { accountId: "10909-SNOWMASS" });

  assert.equal(result.files[0].updated_at, "2026-08-20T11:42:00.000Z");
});
