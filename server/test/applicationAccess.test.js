import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApplicationSession,
  createOptionalApplicationAuthenticator,
  hasApplicationPermission,
  hasApplicationRole,
} from "../src/security/applicationAccess.js";

const auth = Object.freeze({
  userId: "user-1",
  email: "appraiser@example.com",
  displayName: "Appraiser One",
  organizations: [{
    organizationId: "org-1",
    displayName: "Freeman Appraisal Services LLC",
    roles: ["appraiser"],
  }],
});

test("unified workflow permissions are organization scoped", () => {
  assert.equal(hasApplicationPermission(auth, "custom_appraisal", "write", "org-1"), true);
  assert.equal(hasApplicationPermission(auth, "property_tax_protest", "read", "org-1"), true);
  assert.equal(hasApplicationPermission(auth, "custom_appraisal", "write", "org-2"), false);
  assert.equal(hasApplicationPermission(auth, "custom_appraisal", "unknown", "org-1"), false);
});

test("application roles are derived only from authenticated organization memberships", () => {
  const administrator = {
    ...auth,
    organizations: [{ organizationId: "org-1", roles: ["homenode_admin"] }],
  };
  assert.equal(hasApplicationRole(administrator, "homenode_admin"), true);
  assert.equal(hasApplicationRole(administrator, "homenode_admin", "org-1"), true);
  assert.equal(hasApplicationRole(administrator, "homenode_admin", "org-2"), false);
  assert.equal(hasApplicationRole({ ...administrator, userId: "" }, "homenode_admin"), false);
  assert.equal(hasApplicationRole({ ...administrator, homenode_admin: true }, "organization_admin"), false);
});

test("office assistants cannot sign and read-only users cannot write", () => {
  const assistant = { ...auth, organizations: [{ organizationId: "org-1", roles: ["office_assistant"] }] };
  const reader = { ...auth, organizations: [{ organizationId: "org-1", roles: ["read_only"] }] };
  assert.equal(hasApplicationPermission(assistant, "custom_appraisal", "write", "org-1"), true);
  assert.equal(hasApplicationPermission(assistant, "custom_appraisal", "sign", "org-1"), false);
  assert.equal(hasApplicationPermission(reader, "custom_appraisal", "read", "org-1"), true);
  assert.equal(hasApplicationPermission(reader, "custom_appraisal", "write", "org-1"), false);
});

test("Property Tax permissions remain explicit for every application role", () => {
  const expected = {
    appraiser: { read: true, write: true, sign: true },
    supervisory_appraiser: { read: true, write: true, sign: true },
    reviewer: { read: true, write: false, sign: false },
    office_assistant: { read: true, write: true, sign: false },
    read_only: { read: true, write: false, sign: false },
    organization_admin: { read: true, write: true, sign: false },
    homenode_admin: { read: true, write: true, sign: false },
  };
  for (const [role, permissions] of Object.entries(expected)) {
    const identity = { ...auth, organizations: [{ organizationId: "org-1", roles: [role] }] };
    for (const [permission, allowed] of Object.entries(permissions)) {
      assert.equal(
        hasApplicationPermission(identity, "property_tax_protest", permission, "org-1"),
        allowed,
        `${role} property_tax_protest/${permission}`,
      );
    }
  }
  assert.equal(hasApplicationPermission({ userId: "user-1", organizations: [] }, "property_tax_protest", "read"), false);
  assert.equal(hasApplicationPermission({ organizations: auth.organizations }, "property_tax_protest", "read"), false);
});

test("session response publishes effective permissions without identity-provider claims", () => {
  const session = buildApplicationSession(auth);
  assert.equal(session.user_id, "user-1");
  assert.equal(session.organizations[0].permissions.uad_3_6.sign, true);
  assert.equal("subject" in session, false);
});

test("optional authentication only invokes the verifier for bearer requests", () => {
  let calls = 0;
  const middleware = createOptionalApplicationAuthenticator((_req, _res, next) => {
    calls += 1;
    next();
  });
  let nextCalls = 0;
  middleware({ get: () => "" }, {}, () => { nextCalls += 1; });
  middleware({ get: () => "Bearer token" }, {}, () => { nextCalls += 1; });
  assert.equal(calls, 1);
  assert.equal(nextCalls, 2);
});
