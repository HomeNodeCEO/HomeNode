import { normalizeUadWorkfileId } from "./workfiles.js";

const READ_ROLES = new Set([
  "appraiser",
  "supervisory_appraiser",
  "reviewer",
  "office_assistant",
  "read_only",
  "organization_admin",
  "homenode_admin",
]);
const WRITE_ROLES = new Set([
  "appraiser",
  "supervisory_appraiser",
  "organization_admin",
  "homenode_admin",
]);
const ORGANIZATION_WIDE_READ_ROLES = new Set([
  "reviewer",
  "office_assistant",
  "read_only",
  "organization_admin",
  "homenode_admin",
]);
const ORGANIZATION_WIDE_WRITE_ROLES = new Set([
  "organization_admin",
  "homenode_admin",
]);

function organizations(auth) {
  return Array.isArray(auth?.organizations) ? auth.organizations : [];
}

function rolesFor(auth, organizationId) {
  const membership = organizations(auth).find((organization) =>
    organization.organizationId === organizationId);
  return new Set(Array.isArray(membership?.roles) ? membership.roles : []);
}

function hasAnyRole(roles, allowed) {
  return [...roles].some((role) => allowed.has(role));
}

export function isHomeNodeAdministrator(auth) {
  return organizations(auth).some((organization) =>
    Array.isArray(organization.roles) && organization.roles.includes("homenode_admin"));
}

export function buildUadAccessScope(auth) {
  const userId = String(auth?.userId || "").trim();
  if (!userId) throw new Error("uad_authentication_required");
  const readableOrganizationIds = [];
  const organizationWideReadIds = [];
  for (const organization of organizations(auth)) {
    const organizationId = String(organization?.organizationId || "").trim();
    const roles = new Set(Array.isArray(organization?.roles) ? organization.roles : []);
    if (!organizationId || !hasAnyRole(roles, READ_ROLES)) continue;
    readableOrganizationIds.push(organizationId);
    if (hasAnyRole(roles, ORGANIZATION_WIDE_READ_ROLES)) {
      organizationWideReadIds.push(organizationId);
    }
  }
  if (!readableOrganizationIds.length) throw new Error("uad_access_denied");
  return Object.freeze({
    userId,
    platformAdministrator: isHomeNodeAdministrator(auth),
    readableOrganizationIds: Object.freeze(readableOrganizationIds),
    organizationWideReadIds: Object.freeze(organizationWideReadIds),
  });
}

export function authorizeUadCreation(auth, input = {}) {
  const userId = String(auth?.userId || "").trim();
  if (!userId) throw new Error("uad_authentication_required");
  const organizationId = String(input.organization_id || "").trim();
  if (!organizationId) throw new Error("uad_organization_required");
  const roles = rolesFor(auth, organizationId);
  if (!hasAnyRole(roles, WRITE_ROLES)) throw new Error("uad_create_access_denied");

  const assignedAppraiserUserId = String(input.assigned_appraiser_user_id || userId).trim();
  if (assignedAppraiserUserId !== userId && !hasAnyRole(roles, ORGANIZATION_WIDE_WRITE_ROLES)) {
    throw new Error("uad_assignment_access_denied");
  }

  return Object.freeze({
    ...input,
    organization_id: organizationId,
    assigned_appraiser_user_id: assignedAppraiserUserId,
    actor_user_id: userId,
  });
}

export async function verifyUadAssigneeMembership(pool, input) {
  if (!input?.assigned_appraiser_user_id || !input?.organization_id) {
    throw new Error("uad_assignment_access_denied");
  }
  if (input.assigned_appraiser_user_id === input.actor_user_id) return input;
  const { rows } = await pool.query(
    `SELECT 1
       FROM app_auth.organization_memberships AS membership
       JOIN app_auth.membership_roles AS role
         ON role.organization_id = membership.organization_id
        AND role.user_id = membership.user_id
      WHERE membership.organization_id = $1
        AND membership.user_id = $2
        AND membership.status = 'active'
        AND role.role_code IN ('appraiser', 'supervisory_appraiser')
      LIMIT 1`,
    [input.organization_id, input.assigned_appraiser_user_id],
  );
  if (!rows.length) throw new Error("uad_assignment_access_denied");
  return input;
}

export async function authorizeUadWorkfileAccess(pool, auth, workfileIdValue, { write = false } = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const userId = String(auth?.userId || "").trim();
  if (!userId) throw new Error("uad_authentication_required");
  const { rows } = await pool.query(
    `SELECT id, organization_id, assigned_appraiser_user_id, supervisory_appraiser_user_id
       FROM appraisal.uad_workfiles
      WHERE id = $1`,
    [workfileId],
  );
  if (!rows.length) throw new Error("uad_workfile_not_found");
  const workfile = rows[0];
  if (isHomeNodeAdministrator(auth)) return workfile;
  if (!workfile.organization_id) throw new Error("uad_workfile_access_denied");

  const roles = rolesFor(auth, workfile.organization_id);
  const roleSet = write ? WRITE_ROLES : READ_ROLES;
  if (!hasAnyRole(roles, roleSet)) throw new Error("uad_workfile_access_denied");

  const assigned = workfile.assigned_appraiser_user_id === userId
    || workfile.supervisory_appraiser_user_id === userId;
  const organizationWide = hasAnyRole(
    roles,
    write ? ORGANIZATION_WIDE_WRITE_ROLES : ORGANIZATION_WIDE_READ_ROLES,
  );
  if (!assigned && !organizationWide) throw new Error("uad_workfile_access_denied");
  return workfile;
}

export function authorizeUadAppraiserConfirmation(auth, workfile) {
  const userId = String(auth?.userId || "").trim();
  const organizationId = String(workfile?.organization_id || "").trim();
  if (!userId || !organizationId) throw new Error("uad_appraiser_confirmation_access_denied");
  const roles = rolesFor(auth, organizationId);
  const assignedAppraiser = workfile.assigned_appraiser_user_id === userId
    && roles.has("appraiser");
  const assignedSupervisor = workfile.supervisory_appraiser_user_id === userId
    && roles.has("supervisory_appraiser");
  if (!assignedAppraiser && !assignedSupervisor) {
    throw new Error("uad_appraiser_confirmation_access_denied");
  }
  return Object.freeze({
    actorUserId: userId,
    signerRole: assignedAppraiser ? "appraiser" : "supervisory_appraiser",
  });
}

export function createUadWorkfileAuthorizer({ pool }) {
  return async function uadWorkfileAuthorizer(req, res, next) {
    try {
      req.uadAuthorizedWorkfile = await authorizeUadWorkfileAccess(
        pool,
        req.mobileAuth,
        req.params.workfileId,
        {
          write: !["GET", "HEAD", "OPTIONS"].includes(req.method),
        },
      );
      return next();
    } catch (error) {
      const message = String(error?.message || "");
      if (message === "invalid_uad_workfile_id") {
        return res.status(400).json({ error: message });
      }
      if (message === "uad_workfile_not_found") {
        return res.status(404).json({ error: message });
      }
      if (message === "uad_authentication_required") {
        return res.status(401).json({ error: message });
      }
      return res.status(403).json({ error: "uad_workfile_access_denied" });
    }
  };
}
