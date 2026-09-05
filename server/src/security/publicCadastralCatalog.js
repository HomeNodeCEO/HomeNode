import {
  APPLICATION_WORKFLOWS,
  hasApplicationPermission,
} from "./applicationAccess.js";

export const PUBLIC_CADASTRAL_CATALOG_SCOPE = "public_cadastral_catalog";

const issuedPublicCadastralGrants = new WeakSet();

export function normalizePublicCadastralAccountId(value) {
  const accountId = String(value ?? "").trim();
  if (!accountId || accountId.length > 64 || /[\u0000-\u001f\u007f]/.test(accountId)) {
    throw new Error("invalid_account_id");
  }
  return accountId;
}

/**
 * Authorize an account as a public-record catalog object. This capability is
 * deliberately distinct from assignment access: it permits property discovery
 * while preventing a catalog read from inheriting tenant-owned overlays, MLS
 * activity, documents, or report state.
 */
export function authorizePublicCadastralCatalogRead(
  auth,
  accountIdValue,
  {
    workflows = APPLICATION_WORKFLOWS,
    permissionChecker = hasApplicationPermission,
  } = {},
) {
  const userId = String(auth?.userId || "").trim();
  if (!userId) throw new Error("public_cadastral_authentication_required");
  if (typeof permissionChecker !== "function") {
    throw new TypeError("public_cadastral_permission_policy_required");
  }
  const allowedWorkflows = Array.isArray(workflows)
    ? workflows.map((workflow) => String(workflow || "").trim()).filter(Boolean)
    : [];
  if (!allowedWorkflows.some((workflow) => permissionChecker(auth, workflow, "read"))) {
    throw new Error("public_cadastral_access_denied");
  }
  const grant = Object.freeze({
    accountId: normalizePublicCadastralAccountId(accountIdValue),
    actorUserId: userId,
    scope: PUBLIC_CADASTRAL_CATALOG_SCOPE,
  });
  issuedPublicCadastralGrants.add(grant);
  return grant;
}

export function assertPublicCadastralCatalogGrant(grant) {
  if (
    !grant
    || typeof grant !== "object"
    || !issuedPublicCadastralGrants.has(grant)
    || grant.scope !== PUBLIC_CADASTRAL_CATALOG_SCOPE
  ) {
    throw new Error("public_cadastral_scope_required");
  }
  return grant;
}
