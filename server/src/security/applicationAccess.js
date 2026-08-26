const WORKFLOW_PERMISSIONS = Object.freeze({
  custom_appraisal: Object.freeze({
    read: new Set(["appraiser", "supervisory_appraiser", "reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin"]),
    write: new Set(["appraiser", "supervisory_appraiser", "office_assistant", "organization_admin", "homenode_admin"]),
    sign: new Set(["appraiser", "supervisory_appraiser"]),
  }),
  uad_3_6: Object.freeze({
    read: new Set(["appraiser", "supervisory_appraiser", "reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin"]),
    write: new Set(["appraiser", "supervisory_appraiser", "organization_admin", "homenode_admin"]),
    sign: new Set(["appraiser", "supervisory_appraiser"]),
  }),
  property_tax_protest: Object.freeze({
    read: new Set(["appraiser", "supervisory_appraiser", "reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin"]),
    write: new Set(["appraiser", "supervisory_appraiser", "office_assistant", "organization_admin", "homenode_admin"]),
    sign: new Set(["appraiser", "supervisory_appraiser"]),
  }),
});

function memberships(auth) {
  return Array.isArray(auth?.organizations) ? auth.organizations : [];
}

export function hasApplicationPermission(auth, workflow, permission, organizationId = null) {
  const allowed = WORKFLOW_PERMISSIONS[workflow]?.[permission];
  if (!allowed || !String(auth?.userId || "").trim()) return false;
  return memberships(auth).some((membership) => {
    if (organizationId && membership?.organizationId !== organizationId) return false;
    return Array.isArray(membership?.roles)
      && membership.roles.some((role) => allowed.has(role));
  });
}

export function buildApplicationSession(auth) {
  if (!String(auth?.userId || "").trim()) throw new Error("authentication_required");
  return Object.freeze({
    user_id: auth.userId,
    email: auth.email || null,
    display_name: auth.displayName || null,
    organizations: memberships(auth).map((membership) => Object.freeze({
      organization_id: membership.organizationId,
      display_name: membership.displayName || null,
      roles: Object.freeze([...(membership.roles || [])]),
      permissions: Object.freeze(Object.fromEntries(
        Object.keys(WORKFLOW_PERMISSIONS).map((workflow) => [workflow, Object.freeze({
          read: hasApplicationPermission(auth, workflow, "read", membership.organizationId),
          write: hasApplicationPermission(auth, workflow, "write", membership.organizationId),
          sign: hasApplicationPermission(auth, workflow, "sign", membership.organizationId),
        })]),
      )),
    })),
  });
}

export function createOptionalApplicationAuthenticator(authenticate) {
  if (typeof authenticate !== "function") throw new Error("application_authenticator_required");
  return function optionalApplicationAuthenticator(req, res, next) {
    if (!/^Bearer\s+/i.test(String(req.get?.("authorization") || ""))) return next();
    return authenticate(req, res, next);
  };
}

export const APPLICATION_WORKFLOWS = Object.freeze(Object.keys(WORKFLOW_PERMISSIONS));
