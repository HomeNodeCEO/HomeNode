const ORGANIZATION_WIDE_READ = new Set([
  "supervisory_appraiser", "reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin",
]);
const ORGANIZATION_WIDE_WRITE = new Set([
  "supervisory_appraiser", "office_assistant", "organization_admin", "homenode_admin",
]);
const ORGANIZATION_WIDE_SIGN = new Set([
  "supervisory_appraiser", "organization_admin", "homenode_admin",
]);

function membership(auth, organizationId) {
  return (Array.isArray(auth?.organizations) ? auth.organizations : [])
    .find((entry) => entry?.organizationId === organizationId);
}

function includesAny(roles, allowed) {
  return Array.isArray(roles) && roles.some((role) => allowed.has(role));
}

export function decideAssignmentAccess(auth, assignment, permission) {
  const userId = String(auth?.userId || "").trim();
  if (!userId || !assignment?.organization_id) return false;
  const organization = membership(auth, assignment.organization_id);
  if (!organization) return false;
  const roles = organization.roles || [];
  if (roles.includes("homenode_admin")) return true;
  const assigned = assignment.assigned_appraiser_user_id === userId;
  if (permission === "read") return assigned || includesAny(roles, ORGANIZATION_WIDE_READ);
  if (permission === "write") {
    return (assigned && roles.includes("appraiser")) || includesAny(roles, ORGANIZATION_WIDE_WRITE);
  }
  if (permission === "sign") {
    return (assigned && roles.includes("appraiser")) || includesAny(roles, ORGANIZATION_WIDE_SIGN);
  }
  return false;
}

export async function authorizeCustomAssignmentFile(pool, auth, input) {
  const { rows } = await pool.query(
    `SELECT id, account_id, organization_id, assigned_appraiser_user_id
       FROM app.assignment_files
      WHERE id = $1 AND account_id = $2`,
    [input.assignmentFileId, input.accountId],
  );
  if (!rows.length) throw new Error("assignment_file_not_found");
  if (!decideAssignmentAccess(auth, rows[0], input.permission)) {
    throw new Error("assignment_file_access_denied");
  }
  return rows[0];
}
