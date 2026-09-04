import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createApplicationAccessGuards } from "../src/security/applicationAccessGuards.js";

function createRequest({ mobileAuth = null, editorKey = undefined } = {}) {
  return {
    mobileAuth,
    get(name) {
      return String(name).toLowerCase() === "x-homenode-editor-key"
        ? editorKey
        : undefined;
    },
  };
}

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    payload: null,
    set(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

function createGuards(overrides = {}) {
  return createApplicationAccessGuards({
    pool: { query: async () => ({ rows: [] }) },
    authenticationRequired: true,
    environment: {},
    permissionChecker: () => false,
    roleChecker: () => false,
    editorKeyChecker: () => false,
    assignmentAuthorizer: async () => {},
    propertyTaxAuthorizer: async () => {},
    ...overrides,
  });
}

test("platform operations require an authenticated HomeNode administrator", () => {
  const observed = [];
  const guards = createGuards({
    roleChecker: (auth, role) => {
      observed.push([auth.userId, role]);
      return auth.userId === "platform-admin" && role === "homenode_admin";
    },
  });

  assert.equal(guards.requirePlatformAdministrator(
    createRequest({ mobileAuth: { userId: "platform-admin" } }),
    createResponse(),
  ), true);

  const memberResponse = createResponse();
  assert.equal(guards.requirePlatformAdministrator(
    createRequest({ mobileAuth: { userId: "organization-admin" } }),
    memberResponse,
  ), false);
  assert.equal(memberResponse.statusCode, 403);
  assert.deepEqual(memberResponse.payload, { error: "application_access_denied" });
  assert.equal(memberResponse.headers["cache-control"], "no-store");

  const anonymousResponse = createResponse();
  assert.equal(guards.requirePlatformAdministrator(createRequest(), anonymousResponse), false);
  assert.equal(anonymousResponse.statusCode, 401);
  assert.deepEqual(anonymousResponse.payload, { error: "authentication_required" });
  assert.equal(anonymousResponse.headers["cache-control"], "no-store");
  assert.deepEqual(observed, [
    ["platform-admin", "homenode_admin"],
    ["organization-admin", "homenode_admin"],
  ]);
});

test("editor access accepts either authenticated writable workflow", () => {
  const checked = [];
  const guards = createGuards({
    permissionChecker: (_auth, workflow, permission) => {
      checked.push([workflow, permission]);
      return workflow === "property_tax_protest";
    },
  });
  const response = createResponse();

  assert.equal(
    guards.requireEditor(createRequest({ mobileAuth: { userId: "user-1" } }), response),
    true,
  );
  assert.deepEqual(checked, [
    ["custom_appraisal", "write"],
    ["property_tax_protest", "write"],
  ]);
  assert.equal(response.statusCode, null);
});

test("editor access returns bounded authenticated and anonymous denials", () => {
  const authenticatedResponse = createResponse();
  const enforcedGuards = createGuards();
  assert.equal(
    enforcedGuards.requireEditor(
      createRequest({ mobileAuth: { userId: "read-only" } }),
      authenticatedResponse,
    ),
    false,
  );
  assert.equal(authenticatedResponse.statusCode, 403);
  assert.deepEqual(authenticatedResponse.payload, { error: "application_access_denied" });
  assert.equal(authenticatedResponse.headers["cache-control"], "no-store");

  const anonymousResponse = createResponse();
  assert.equal(enforcedGuards.requireEditor(createRequest(), anonymousResponse), false);
  assert.equal(anonymousResponse.statusCode, 401);
  assert.deepEqual(anonymousResponse.payload, { error: "authentication_required" });
  assert.equal(anonymousResponse.headers["cache-control"], "no-store");
});

test("temporary rollout editor access preserves the established editor-key contract", () => {
  const missingKeyGuards = createGuards({
    authenticationRequired: false,
    environment: {},
  });
  const missingResponse = createResponse();
  assert.equal(missingKeyGuards.requireEditor(createRequest(), missingResponse), false);
  assert.equal(missingResponse.statusCode, 503);
  assert.deepEqual(missingResponse.payload, { error: "editor_not_configured" });

  const observedKeys = [];
  const configuredGuards = createGuards({
    authenticationRequired: false,
    environment: { HOMENODE_EDITOR_KEY: "configured-key" },
    editorKeyChecker: (provided, configured) => {
      observedKeys.push([provided, configured]);
      return provided === "accepted-key";
    },
  });
  const deniedResponse = createResponse();
  assert.equal(
    configuredGuards.requireEditor(
      createRequest({ editorKey: "rejected-key" }),
      deniedResponse,
    ),
    false,
  );
  assert.equal(deniedResponse.statusCode, 401);
  assert.deepEqual(deniedResponse.payload, { error: "invalid_editor_key" });

  assert.equal(
    configuredGuards.requireEditor(
      createRequest({ editorKey: "accepted-key" }),
      createResponse(),
    ),
    true,
  );
  assert.deepEqual(observedKeys, [
    ["rejected-key", "configured-key"],
    ["accepted-key", "configured-key"],
  ]);
});

test("workflow access enforces authenticated permissions and no-store denials", () => {
  const observed = [];
  const guards = createGuards({
    permissionChecker: (_auth, workflow, permission) => {
      observed.push([workflow, permission]);
      return permission === "read";
    },
  });
  assert.equal(
    guards.requireWorkflowAccess(
      createRequest({ mobileAuth: { userId: "user-1" } }),
      createResponse(),
      "custom_appraisal",
      "read",
    ),
    true,
  );
  const deniedResponse = createResponse();
  assert.equal(
    guards.requireWorkflowAccess(
      createRequest({ mobileAuth: { userId: "user-1" } }),
      deniedResponse,
      "custom_appraisal",
      "write",
    ),
    false,
  );
  assert.equal(deniedResponse.statusCode, 403);
  assert.deepEqual(deniedResponse.payload, { error: "application_access_denied" });
  assert.equal(deniedResponse.headers["cache-control"], "no-store");
  assert.deepEqual(observed, [
    ["custom_appraisal", "read"],
    ["custom_appraisal", "write"],
  ]);
});

test("workflow access preserves enforced anonymous denial and temporary rollout access", () => {
  const enforcedResponse = createResponse();
  assert.equal(
    createGuards().requireWorkflowAccess(
      createRequest(),
      enforcedResponse,
      "property_tax_protest",
      "read",
    ),
    false,
  );
  assert.equal(enforcedResponse.statusCode, 401);
  assert.deepEqual(enforcedResponse.payload, { error: "authentication_required" });
  assert.equal(enforcedResponse.headers["cache-control"], "no-store");

  let editorChecks = 0;
  const rolloutGuards = createGuards({
    authenticationRequired: false,
    environment: { HOMENODE_EDITOR_KEY: "configured-key" },
    editorKeyChecker: () => {
      editorChecks += 1;
      return false;
    },
  });
  assert.equal(
    rolloutGuards.requireWorkflowAccess(
      createRequest({ editorKey: "wrong-key" }),
      createResponse(),
      "custom_appraisal",
      "read",
    ),
    true,
  );
  assert.equal(editorChecks, 1);
});

test("property discovery requires an authenticated application read role", () => {
  const checked = [];
  const guards = createGuards({
    permissionChecker: (auth, workflow, permission) => {
      checked.push([auth.userId, workflow, permission]);
      return auth.userId === "reader" && workflow === "uad_3_6" && permission === "read";
    },
  });
  assert.equal(guards.requireApplicationReader(
    createRequest({ mobileAuth: { userId: "reader" } }),
    createResponse(),
  ), true);

  const deniedResponse = createResponse();
  assert.equal(guards.requireApplicationReader(
    createRequest({ mobileAuth: { userId: "roleless" } }),
    deniedResponse,
  ), false);
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(deniedResponse.headers["cache-control"], "no-store");
  assert.deepEqual(deniedResponse.payload, { error: "application_access_denied" });

  const anonymousResponse = createResponse();
  assert.equal(guards.requireApplicationReader(createRequest(), anonymousResponse), false);
  assert.equal(anonymousResponse.statusCode, 401);
  assert.equal(anonymousResponse.headers["cache-control"], "no-store");
  assert.deepEqual(anonymousResponse.payload, { error: "authentication_required" });

  assert.equal(createGuards({ authenticationRequired: false }).requireApplicationReader(
    createRequest(),
    createResponse(),
  ), true);
  assert.deepEqual(checked, [
    ["reader", "custom_appraisal", "read"],
    ["reader", "uad_3_6", "read"],
    ["roleless", "custom_appraisal", "read"],
    ["roleless", "uad_3_6", "read"],
    ["roleless", "property_tax_protest", "read"],
  ]);
});

test("assignment access bypasses only rollout mode and forwards enforced scope", async () => {
  let authorizerCalls = 0;
  const rolloutGuards = createGuards({
    authenticationRequired: false,
    assignmentAuthorizer: async () => {
      authorizerCalls += 1;
    },
  });
  assert.equal(
    await rolloutGuards.requireCustomAssignmentAccess(
      createRequest(),
      createResponse(),
      "account-1",
      "file-1",
      "read",
    ),
    true,
  );
  assert.equal(authorizerCalls, 0);

  const observed = [];
  const pool = { query: async () => ({ rows: [] }) };
  const enforcedGuards = createGuards({
    pool,
    assignmentAuthorizer: async (...values) => observed.push(values),
  });
  const auth = { userId: "user-1" };
  assert.equal(
    await enforcedGuards.requireCustomAssignmentAccess(
      createRequest({ mobileAuth: auth }),
      createResponse(),
      "account-1",
      "file-1",
      "write",
    ),
    true,
  );
  assert.deepEqual(observed, [[
    pool,
    auth,
    {
      accountId: "account-1",
      assignmentFileId: "file-1",
      permission: "write",
    },
  ]]);
});

test("assignment access maps missing, denied, and anonymous cases without diagnostics", async () => {
  for (const [message, statusCode, errorCode] of [
    ["assignment_file_not_found", 404, "assignment_file_not_found"],
    ["postgresql://secret@internal", 403, "assignment_file_access_denied"],
  ]) {
    const guards = createGuards({
      assignmentAuthorizer: async () => {
        throw new Error(message);
      },
    });
    const response = createResponse();
    assert.equal(
      await guards.requireCustomAssignmentAccess(
        createRequest({ mobileAuth: { userId: "user-1" } }),
        response,
        "account-1",
        "file-1",
        "read",
      ),
      false,
    );
    assert.equal(response.statusCode, statusCode);
    assert.deepEqual(response.payload, { error: errorCode });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.doesNotMatch(JSON.stringify(response.payload), /postgres|secret|internal/i);
  }

  const anonymousResponse = createResponse();
  assert.equal(
    await createGuards().requireCustomAssignmentAccess(
      createRequest(),
      anonymousResponse,
      "account-1",
      "file-1",
      "read",
    ),
    false,
  );
  assert.equal(anonymousResponse.statusCode, 401);
  assert.deepEqual(anonymousResponse.payload, { error: "authentication_required" });
  assert.equal(anonymousResponse.headers["cache-control"], "no-store");
});

test("custom account scope requires a valid assignment before data access", async () => {
  let authorizerCalls = 0;
  const guards = createGuards({
    permissionChecker: () => true,
    assignmentAuthorizer: async () => { authorizerCalls += 1; },
  });
  for (const [value, error] of [
    [undefined, "assignment_file_required"],
    ["not-a-file", "invalid_assignment_file_id"],
  ]) {
    const response = createResponse();
    assert.equal(await guards.requireCustomAccountScope(
      createRequest({ mobileAuth: { userId: "user-1" } }),
      response,
      "account-1",
      value,
      "read",
    ), false);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.payload, { error });
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal(authorizerCalls, 0);
});

test("custom account scope binds workflow permission to the normalized assignment", async () => {
  const calls = [];
  const guards = createGuards({
    permissionChecker: (_auth, workflow, permission) => {
      calls.push(["workflow", workflow, permission]);
      return true;
    },
    assignmentAuthorizer: async (_pool, _auth, input) => calls.push(["assignment", input]),
  });
  assert.equal(await guards.requireCustomAccountScope(
    createRequest({ mobileAuth: { userId: "user-1" } }),
    createResponse(),
    "account-1",
    "42",
    "read",
  ), true);
  assert.deepEqual(calls, [
    ["workflow", "custom_appraisal", "read"],
    ["assignment", {
      accountId: "account-1",
      assignmentFileId: 42,
      permission: "read",
    }],
  ]);
});

test("property tax account scope requires a valid exact protest file", async () => {
  let authorizerCalls = 0;
  const guards = createGuards({
    permissionChecker: () => true,
    propertyTaxAuthorizer: async () => { authorizerCalls += 1; },
  });
  for (const [value, error] of [
    [undefined, "property_tax_protest_file_required"],
    ["not-a-file", "invalid_property_tax_protest_file_id"],
  ]) {
    const response = createResponse();
    assert.equal(await guards.requirePropertyTaxAccountScope(
      createRequest({ mobileAuth: { userId: "user-1" } }),
      response,
      "account-1",
      value,
      "read",
    ), false);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.payload, { error });
    assert.equal(response.headers["cache-control"], "no-store");
  }
  assert.equal(authorizerCalls, 0);
});

test("property tax account scope binds workflow permission to the normalized file", async () => {
  const calls = [];
  const pool = { query: async () => ({ rows: [] }) };
  const auth = { userId: "user-1" };
  const guards = createGuards({
    pool,
    permissionChecker: (_auth, workflow, permission) => {
      calls.push(["workflow", workflow, permission]);
      return true;
    },
    propertyTaxAuthorizer: async (...values) => calls.push(["file", ...values]),
  });
  assert.equal(await guards.requirePropertyTaxAccountScope(
    createRequest({ mobileAuth: auth }),
    createResponse(),
    "account-1",
    "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    "read",
  ), true);
  assert.deepEqual(calls, [
    ["workflow", "property_tax_protest", "read"],
    ["file", pool, auth, {
      accountId: "account-1",
      propertyTaxFileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      permission: "read",
    }],
  ]);
});

test("property tax account scope maps missing and denied files without diagnostics", async () => {
  for (const [message, statusCode, errorCode] of [
    ["property_tax_protest_file_not_found", 404, "property_tax_protest_file_not_found"],
    ["postgresql://secret@internal", 403, "property_tax_protest_file_access_denied"],
  ]) {
    const guards = createGuards({
      permissionChecker: () => true,
      propertyTaxAuthorizer: async () => { throw new Error(message); },
    });
    const response = createResponse();
    assert.equal(await guards.requirePropertyTaxAccountScope(
      createRequest({ mobileAuth: { userId: "user-1" } }),
      response,
      "account-1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "read",
    ), false);
    assert.equal(response.statusCode, statusCode);
    assert.deepEqual(response.payload, { error: errorCode });
    assert.equal(response.headers["cache-control"], "no-store");
    assert.doesNotMatch(JSON.stringify(response.payload), /postgres|secret|internal/i);
  }
});

test("access guards reject incomplete application composition", () => {
  assert.throws(
    () => createApplicationAccessGuards(),
    /application_access_guards_pool_required/,
  );
  assert.throws(
    () => createApplicationAccessGuards({ pool: { query() {} } }),
    /application_access_guards_authentication_mode_required/,
  );
});

test("the entrypoint composes shared guards once and removes inline copies", () => {
  const entrypoint = readFileSync(
    new URL("../src/oldServer.js", import.meta.url),
    "utf8",
  );
  assert.match(
    entrypoint,
    /createApplicationAccessGuards\(\{\s*pool,\s*authenticationRequired: applicationAuthenticationRequired,/,
  );
  assert.match(
    entrypoint,
    /requireEditor,[\s\S]*?requirePlatformAdministrator,[\s\S]*?requireCustomAssignmentAccess,[\s\S]*?requirePropertyTaxAccountScope,[\s\S]*?requireWorkflowAccess,[\s\S]*?requireApplicationReader,/,
  );
  assert.doesNotMatch(entrypoint, /function require(?:Editor|WorkflowAccess|CustomAssignmentAccess)/);
});
