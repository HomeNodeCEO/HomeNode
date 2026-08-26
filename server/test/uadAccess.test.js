import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeUadCreation,
  authorizeUadWorkfileAccess,
  buildUadAccessScope,
  verifyUadAssigneeMembership,
} from "../src/modules/uad/access.js";

const WORKFILE_ID = "c164248f-645d-48aa-a389-dc668e6c5dc9";
const USER_ID = "711c54f2-d7a4-4418-ab65-0d9f7e0d43a1";
const OTHER_USER_ID = "dcf6d104-8e22-4fb0-aa61-f325b3cb6a75";
const ORGANIZATION_ID = "f62aa408-18eb-4ee1-bdae-167b8ff92a0c";
const OTHER_ORGANIZATION_ID = "b5250368-e8f1-4d47-9f62-a8a7cb2ea383";

function auth(role = "appraiser", organizationId = ORGANIZATION_ID) {
  return {
    userId: USER_ID,
    organizations: [{ organizationId, roles: [role] }],
  };
}

function pool(workfile = {}) {
  return {
    async query() {
      return {
        rows: [{
          id: WORKFILE_ID,
          organization_id: ORGANIZATION_ID,
          assigned_appraiser_user_id: USER_ID,
          supervisory_appraiser_user_id: null,
          ...workfile,
        }],
      };
    },
  };
}

test("builds an organization-scoped UAD workfile listing filter", () => {
  const scope = buildUadAccessScope(auth("appraiser"));
  assert.equal(scope.userId, USER_ID);
  assert.deepEqual(scope.readableOrganizationIds, [ORGANIZATION_ID]);
  assert.deepEqual(scope.organizationWideReadIds, []);

  const reviewerScope = buildUadAccessScope(auth("reviewer"));
  assert.deepEqual(reviewerScope.organizationWideReadIds, [ORGANIZATION_ID]);
  assert.throws(() => buildUadAccessScope({ userId: USER_ID, organizations: [] }), /uad_access_denied/);
});

test("creation is organization-scoped and prevents actor or assignee impersonation", () => {
  const authorized = authorizeUadCreation(auth(), {
    organization_id: ORGANIZATION_ID,
    actor_user_id: OTHER_USER_ID,
  });
  assert.equal(authorized.actor_user_id, USER_ID);
  assert.equal(authorized.assigned_appraiser_user_id, USER_ID);
  assert.throws(
    () => authorizeUadCreation(auth(), {
      organization_id: ORGANIZATION_ID,
      assigned_appraiser_user_id: OTHER_USER_ID,
    }),
    /uad_assignment_access_denied/,
  );
  assert.throws(
    () => authorizeUadCreation(auth(), { organization_id: OTHER_ORGANIZATION_ID }),
    /uad_create_access_denied/,
  );
  const administrator = authorizeUadCreation(auth("organization_admin"), {
    organization_id: ORGANIZATION_ID,
    assigned_appraiser_user_id: OTHER_USER_ID,
  });
  assert.equal(administrator.assigned_appraiser_user_id, OTHER_USER_ID);
  assert.equal(administrator.actor_user_id, USER_ID);
});

test("organization administrators can assign only active appraisers in their organization", async () => {
  const requested = authorizeUadCreation(auth("organization_admin"), {
    organization_id: ORGANIZATION_ID,
    assigned_appraiser_user_id: OTHER_USER_ID,
  });
  const allowedPool = { query: async () => ({ rows: [{ exists: 1 }] }) };
  assert.equal((await verifyUadAssigneeMembership(allowedPool, requested)), requested);

  const deniedPool = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    () => verifyUadAssigneeMembership(deniedPool, requested),
    /uad_assignment_access_denied/,
  );
});

test("assigned appraisers can read and write only their own organization workfiles", async () => {
  assert.equal((await authorizeUadWorkfileAccess(pool(), auth(), WORKFILE_ID)).id, WORKFILE_ID);
  assert.equal((await authorizeUadWorkfileAccess(pool(), auth(), WORKFILE_ID, { write: true })).id, WORKFILE_ID);
  await assert.rejects(
    () => authorizeUadWorkfileAccess(
      pool({ assigned_appraiser_user_id: OTHER_USER_ID }),
      auth(),
      WORKFILE_ID,
    ),
    /uad_workfile_access_denied/,
  );
  await assert.rejects(
    () => authorizeUadWorkfileAccess(pool(), auth("appraiser", OTHER_ORGANIZATION_ID), WORKFILE_ID),
    /uad_workfile_access_denied/,
  );
});

test("reviewers are read-only while organization and HomeNode administrators retain scoped authority", async () => {
  const anotherAssignee = pool({ assigned_appraiser_user_id: OTHER_USER_ID });
  assert.equal((await authorizeUadWorkfileAccess(anotherAssignee, auth("reviewer"), WORKFILE_ID)).id, WORKFILE_ID);
  await assert.rejects(
    () => authorizeUadWorkfileAccess(anotherAssignee, auth("reviewer"), WORKFILE_ID, { write: true }),
    /uad_workfile_access_denied/,
  );
  assert.equal((await authorizeUadWorkfileAccess(
    anotherAssignee,
    auth("organization_admin"),
    WORKFILE_ID,
    { write: true },
  )).id, WORKFILE_ID);
  assert.equal((await authorizeUadWorkfileAccess(
    pool({ organization_id: OTHER_ORGANIZATION_ID, assigned_appraiser_user_id: OTHER_USER_ID }),
    auth("homenode_admin"),
    WORKFILE_ID,
    { write: true },
  )).id, WORKFILE_ID);
});

test("office assistants and read-only users can inspect organization UAD files but cannot edit them", async () => {
  const anotherAssignee = pool({ assigned_appraiser_user_id: OTHER_USER_ID });
  for (const role of ["office_assistant", "read_only"]) {
    const scope = buildUadAccessScope(auth(role));
    assert.deepEqual(scope.organizationWideReadIds, [ORGANIZATION_ID]);
    assert.equal((await authorizeUadWorkfileAccess(anotherAssignee, auth(role), WORKFILE_ID)).id, WORKFILE_ID);
    await assert.rejects(
      () => authorizeUadWorkfileAccess(anotherAssignee, auth(role), WORKFILE_ID, { write: true }),
      /uad_workfile_access_denied/,
    );
  }
});

test("legacy organization-less workfiles fail closed in authenticated mode", async () => {
  await assert.rejects(
    () => authorizeUadWorkfileAccess(pool({ organization_id: null }), auth(), WORKFILE_ID),
    /uad_workfile_access_denied/,
  );
});
