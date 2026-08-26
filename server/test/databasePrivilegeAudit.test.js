import assert from "node:assert/strict";
import test from "node:test";

import { summarizeDatabasePrivilegeAudit } from "../src/security/databasePrivilegeAudit.js";

test("database privilege audit accepts a non-owning runtime login", () => {
  const result = summarizeDatabasePrivilegeAudit({
    is_superuser: false,
    can_create_roles: false,
    can_create_databases: false,
    can_replicate: false,
    can_bypass_row_security: false,
    owned_schema_count: 0,
    creatable_schema_count: 0,
  });
  assert.equal(result.least_privilege, true);
  assert.equal(Object.values(result.checks).every(Boolean), true);
});

test("database privilege audit reports ownership and elevated capabilities", () => {
  const result = summarizeDatabasePrivilegeAudit({
    is_superuser: false,
    can_create_roles: true,
    owned_schema_count: "2",
    creatable_schema_count: "3",
  });
  assert.equal(result.least_privilege, false);
  assert.equal(result.checks.cannot_create_roles, false);
  assert.equal(result.checks.owns_no_application_schemas, false);
  assert.equal(result.checks.cannot_create_in_application_schemas, false);
});
