import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizePublicCadastralCatalogRead,
  normalizePublicCadastralAccountId,
  PUBLIC_CADASTRAL_CATALOG_SCOPE,
} from "../src/security/publicCadastralCatalog.js";

const AUTH = Object.freeze({
  userId: "reader-1",
  organizations: [{ organizationId: "org-1", roles: ["appraiser"] }],
});

test("public cadastral grants bind a normalized account to an authenticated reader", () => {
  const permissionCalls = [];
  const grant = authorizePublicCadastralCatalogRead(AUTH, "  PUBLIC-123  ", {
    workflows: ["uad_3_6"],
    permissionChecker: (...args) => {
      permissionCalls.push(args);
      return true;
    },
  });

  assert.deepEqual(grant, {
    accountId: "PUBLIC-123",
    actorUserId: "reader-1",
    scope: PUBLIC_CADASTRAL_CATALOG_SCOPE,
  });
  assert.deepEqual(permissionCalls, [[AUTH, "uad_3_6", "read"]]);
  assert.equal(Object.isFrozen(grant), true);
});

test("public cadastral grants fail closed for anonymous or unauthorized identities", () => {
  assert.throws(
    () => authorizePublicCadastralCatalogRead(null, "PUBLIC-123"),
    /public_cadastral_authentication_required/,
  );
  assert.throws(
    () => authorizePublicCadastralCatalogRead(AUTH, "PUBLIC-123", {
      permissionChecker: () => false,
    }),
    /public_cadastral_access_denied/,
  );
});

test("public cadastral account identifiers reject empty, oversized, and control input", () => {
  for (const value of ["", " ", "x".repeat(65), "abc\u0000def"]) {
    assert.throws(
      () => normalizePublicCadastralAccountId(value),
      /invalid_account_id/,
    );
  }
});
