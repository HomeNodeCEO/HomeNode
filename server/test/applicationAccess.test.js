import assert from "node:assert/strict";
import test from "node:test";

import {
  buildApplicationSession,
  createOptionalApplicationAuthenticator,
  hasApplicationPermission,
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

test("office assistants cannot sign and read-only users cannot write", () => {
  const assistant = { ...auth, organizations: [{ organizationId: "org-1", roles: ["office_assistant"] }] };
  const reader = { ...auth, organizations: [{ organizationId: "org-1", roles: ["read_only"] }] };
  assert.equal(hasApplicationPermission(assistant, "custom_appraisal", "write", "org-1"), true);
  assert.equal(hasApplicationPermission(assistant, "custom_appraisal", "sign", "org-1"), false);
  assert.equal(hasApplicationPermission(reader, "custom_appraisal", "read", "org-1"), true);
  assert.equal(hasApplicationPermission(reader, "custom_appraisal", "write", "org-1"), false);
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
