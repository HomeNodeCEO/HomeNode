const WORKFLOW_ROLES = Object.freeze({
  custom_appraisal: Object.freeze({
    read: new Set(["appraiser", "supervisory_appraiser", "reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin"]),
    write: new Set(["appraiser", "supervisory_appraiser", "office_assistant", "organization_admin", "homenode_admin"]),
    organizationWideRead: new Set(["supervisory_appraiser", "reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin"]),
    organizationWideWrite: new Set(["supervisory_appraiser", "office_assistant", "organization_admin", "homenode_admin"]),
  }),
  uad_3_6: Object.freeze({
    read: new Set(["appraiser", "supervisory_appraiser", "reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin"]),
    write: new Set(["appraiser", "supervisory_appraiser", "organization_admin", "homenode_admin"]),
    organizationWideRead: new Set(["reviewer", "office_assistant", "read_only", "organization_admin", "homenode_admin"]),
    organizationWideWrite: new Set(["organization_admin", "homenode_admin"]),
  }),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function memberships(auth) {
  return Array.isArray(auth?.organizations) ? auth.organizations : [];
}

function includesAny(roles, allowed) {
  return Array.isArray(roles) && roles.some((role) => allowed.has(role));
}

function organization(auth, organizationId) {
  return memberships(auth).find((membership) => membership?.organizationId === organizationId) || null;
}

export function buildAppraisalHistoryAccessScope(auth) {
  const userId = String(auth?.userId || "").trim();
  if (!userId) throw new Error("authentication_required");
  const organizationIds = [];
  const customOrganizationWideReadIds = [];
  const uadOrganizationWideReadIds = [];
  let platformAdministrator = false;
  for (const membership of memberships(auth)) {
    const organizationId = String(membership?.organizationId || "").trim();
    const roles = membership?.roles || [];
    if (!organizationId) continue;
    if (roles.includes("homenode_admin")) platformAdministrator = true;
    if (includesAny(roles, WORKFLOW_ROLES.custom_appraisal.read)
        || includesAny(roles, WORKFLOW_ROLES.uad_3_6.read)) {
      organizationIds.push(organizationId);
    }
    if (includesAny(roles, WORKFLOW_ROLES.custom_appraisal.organizationWideRead)) {
      customOrganizationWideReadIds.push(organizationId);
    }
    if (includesAny(roles, WORKFLOW_ROLES.uad_3_6.organizationWideRead)) {
      uadOrganizationWideReadIds.push(organizationId);
    }
  }
  if (!platformAdministrator && !organizationIds.length) throw new Error("application_access_denied");
  return Object.freeze({
    userId,
    platformAdministrator,
    organizationIds: Object.freeze([...new Set(organizationIds)]),
    customOrganizationWideReadIds: Object.freeze([...new Set(customOrganizationWideReadIds)]),
    uadOrganizationWideReadIds: Object.freeze([...new Set(uadOrganizationWideReadIds)]),
  });
}

export function decideAppraisalReportAccess(auth, report, permission) {
  const userId = String(auth?.userId || "").trim();
  if (!userId || !report?.organization_id) return false;
  if (memberships(auth).some((membership) => membership?.roles?.includes("homenode_admin"))) {
    return permission === "read" || permission === "write";
  }
  const membership = organization(auth, report.organization_id);
  const rules = WORKFLOW_ROLES[report.workflow_type];
  if (!membership || !rules || !["read", "write"].includes(permission)) return false;
  const roles = membership.roles || [];
  if (!includesAny(roles, rules[permission])) return false;
  const assigned = report.assigned_appraiser_user_id === userId
    || report.supervisory_appraiser_user_id === userId;
  return assigned || includesAny(roles, permission === "read"
    ? rules.organizationWideRead
    : rules.organizationWideWrite);
}

export async function authorizeAppraisalReportFile(pool, auth, {
  accountId,
  reportFileId,
  permission,
}) {
  const normalizedReportFileId = String(reportFileId || "").trim().toLowerCase();
  const normalizedAccountId = String(accountId || "").trim();
  if (!UUID_PATTERN.test(normalizedReportFileId)) throw new Error("invalid_appraisal_report_file_id");
  if (!normalizedAccountId || normalizedAccountId.length > 100) throw new Error("invalid_account_id");
  const { rows } = await pool.query(
    `SELECT report_file.id, report_file.account_id, report_file.organization_id,
            report_file.workflow_type,
            COALESCE(assignment.assigned_appraiser_user_id, workfile.assigned_appraiser_user_id) AS assigned_appraiser_user_id,
            COALESCE(assignment.supervisory_appraiser_user_id, workfile.supervisory_appraiser_user_id) AS supervisory_appraiser_user_id
       FROM app.report_files report_file
       LEFT JOIN app.assignment_files assignment ON assignment.id = report_file.custom_assignment_file_id
       LEFT JOIN appraisal.uad_workfiles workfile ON workfile.id = report_file.uad_workfile_id
      WHERE report_file.id = $1 AND report_file.account_id = $2
        AND report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')`,
    [normalizedReportFileId, normalizedAccountId],
  );
  if (!rows.length) throw new Error("appraisal_report_file_not_found");
  if (!decideAppraisalReportAccess(auth, rows[0], permission)) {
    throw new Error("appraisal_report_file_access_denied");
  }
  return rows[0];
}
