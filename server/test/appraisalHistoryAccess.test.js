import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeAppraisalReportFile,
  buildAppraisalHistoryAccessScope,
  decideAppraisalReportAccess,
} from "../src/security/appraisalHistoryAccess.js";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "20000000-0000-4000-8000-000000000001";
const USER_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "40000000-0000-4000-8000-000000000001";
const REPORT_FILE_ID = "50000000-0000-4000-8000-000000000001";

function auth(role = "appraiser", organizationId = ORGANIZATION_ID) {
  return {
    userId: USER_ID,
    organizations: [{ organizationId, roles: [role] }],
  };
}

function report(overrides = {}) {
  return {
    id: REPORT_FILE_ID,
    account_id: "ACCOUNT-1",
    organization_id: ORGANIZATION_ID,
    workflow_type: "custom_appraisal",
    assigned_appraiser_user_id: USER_ID,
    supervisory_appraiser_user_id: null,
    ...overrides,
  };
}

test("history scopes keep appraisers assigned-only and organization readers workflow-aware", () => {
  const appraiser = buildAppraisalHistoryAccessScope(auth());
  assert.deepEqual(appraiser.organizationIds, [ORGANIZATION_ID]);
  assert.deepEqual(appraiser.customOrganizationWideReadIds, []);
  assert.deepEqual(appraiser.uadOrganizationWideReadIds, []);

  const assistant = buildAppraisalHistoryAccessScope(auth("office_assistant"));
  assert.deepEqual(assistant.customOrganizationWideReadIds, [ORGANIZATION_ID]);
  assert.deepEqual(assistant.uadOrganizationWideReadIds, [ORGANIZATION_ID]);
});

test("history decisions prevent cross-organization and unassigned access", () => {
  assert.equal(decideAppraisalReportAccess(auth(), report(), "read"), true);
  assert.equal(decideAppraisalReportAccess(auth(), report({ assigned_appraiser_user_id: OTHER_USER_ID }), "read"), false);
  assert.equal(decideAppraisalReportAccess(auth("reviewer"), report({ assigned_appraiser_user_id: OTHER_USER_ID }), "read"), true);
  assert.equal(decideAppraisalReportAccess(auth("reviewer"), report(), "write"), false);
  assert.equal(decideAppraisalReportAccess(auth("organization_admin"), report(), "write"), true);
  assert.equal(decideAppraisalReportAccess(auth("organization_admin", OTHER_ORGANIZATION_ID), report(), "read"), false);
  assert.equal(decideAppraisalReportAccess(auth("homenode_admin"), report({ organization_id: OTHER_ORGANIZATION_ID }), "write"), true);
  assert.equal(decideAppraisalReportAccess(auth("homenode_admin"), report({ organization_id: null }), "read"), false);
});

test("report authorization fails closed before returning canonical identifiers", async () => {
  const pool = {
    async query(_sql, values) {
      assert.deepEqual(values, [REPORT_FILE_ID, "ACCOUNT-1"]);
      return { rows: [report()] };
    },
  };
  assert.equal((await authorizeAppraisalReportFile(pool, auth(), {
    accountId: "ACCOUNT-1",
    reportFileId: REPORT_FILE_ID,
    permission: "read",
  })).id, REPORT_FILE_ID);
  await assert.rejects(
    () => authorizeAppraisalReportFile(pool, auth("appraiser", OTHER_ORGANIZATION_ID), {
      accountId: "ACCOUNT-1",
      reportFileId: REPORT_FILE_ID,
      permission: "read",
    }),
    /appraisal_report_file_access_denied/,
  );
  await assert.rejects(
    () => authorizeAppraisalReportFile(pool, auth(), {
      accountId: "ACCOUNT-1",
      reportFileId: "not-a-uuid",
      permission: "read",
    }),
    /invalid_appraisal_report_file_id/,
  );
});
