import assert from "node:assert/strict";
import test from "node:test";

import { decideAssignmentAccess } from "../src/security/assignmentAccess.js";

const assignment = {
  organization_id: "org-1",
  assigned_appraiser_user_id: "appraiser-1",
};
const actor = (userId, roles, organizationId = "org-1") => ({
  userId,
  organizations: [{ organizationId, roles }],
});

test("assigned appraisers can read, write, and sign only their organization assignment", () => {
  const appraiser = actor("appraiser-1", ["appraiser"]);
  assert.equal(decideAssignmentAccess(appraiser, assignment, "read"), true);
  assert.equal(decideAssignmentAccess(appraiser, assignment, "write"), true);
  assert.equal(decideAssignmentAccess(appraiser, assignment, "sign"), true);
  assert.equal(decideAssignmentAccess(actor("appraiser-2", ["appraiser"]), assignment, "read"), false);
  assert.equal(decideAssignmentAccess(actor("appraiser-1", ["appraiser"], "org-2"), assignment, "read"), false);
});

test("office staff may maintain files but cannot sign", () => {
  const assistant = actor("assistant-1", ["office_assistant"]);
  assert.equal(decideAssignmentAccess(assistant, assignment, "read"), true);
  assert.equal(decideAssignmentAccess(assistant, assignment, "write"), true);
  assert.equal(decideAssignmentAccess(assistant, assignment, "sign"), false);
});

test("reviewers and read-only users cannot write", () => {
  for (const role of ["reviewer", "read_only"]) {
    const user = actor(`${role}-1`, [role]);
    assert.equal(decideAssignmentAccess(user, assignment, "read"), true);
    assert.equal(decideAssignmentAccess(user, assignment, "write"), false);
    assert.equal(decideAssignmentAccess(user, assignment, "sign"), false);
  }
});

test("unassigned legacy files fail closed for authenticated users", () => {
  assert.equal(decideAssignmentAccess(actor("admin-1", ["organization_admin"]), {
    ...assignment,
    organization_id: null,
  }, "read"), false);
});

test("administrators cannot sign unless separately assigned as a licensed signing role", () => {
  assert.equal(decideAssignmentAccess(actor("admin-1", ["organization_admin"]), assignment, "sign"), false);
  assert.equal(decideAssignmentAccess(actor("platform-1", ["homenode_admin"]), assignment, "sign"), false);
  assert.equal(decideAssignmentAccess(actor("supervisor-1", ["supervisory_appraiser"]), {
    ...assignment,
    supervisory_appraiser_user_id: "supervisor-1",
  }, "sign"), true);
});
