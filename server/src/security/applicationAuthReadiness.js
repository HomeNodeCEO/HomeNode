const ADMIN_ROLES = new Set(["organization_admin", "homenode_admin"]);

const IDENTITY_SQL = `SELECT
  (SELECT count(*)::int FROM app_auth.organizations WHERE active = true) AS active_organizations,
  (SELECT count(*)::int FROM app_auth.users WHERE active = true) AS active_users,
  (SELECT count(*)::int FROM app_auth.organization_memberships WHERE status = 'active') AS active_memberships,
  (SELECT count(*)::int FROM app_auth.oidc_identities) AS oidc_identities,
  (SELECT count(*)::int FROM app_auth.web_sessions WHERE revoked_at IS NULL AND expires_at > now()) AS active_web_sessions`;

const OWNERSHIP_SQL = `SELECT
  (SELECT count(*)::int FROM app.assignment_files WHERE organization_id IS NULL) AS custom_assignment_files_unassigned,
  (SELECT count(*)::int FROM app.report_files WHERE workflow_type = 'custom_appraisal' AND organization_id IS NULL) AS custom_report_files_unassigned,
  (SELECT count(*)::int FROM appraisal.uad_workfiles WHERE organization_id IS NULL) AS uad_workfiles_unassigned,
  (SELECT count(*)::int FROM app.report_files WHERE workflow_type = 'uad_3_6' AND organization_id IS NULL) AS uad_report_files_unassigned,
  (SELECT count(*)::int FROM app.report_files WHERE workflow_type = 'property_tax_protest' AND organization_id IS NULL) AS property_tax_report_files_unassigned,
  (SELECT count(*)::int FROM app.appraisal_cases WHERE organization_id IS NULL) AS appraisal_cases_unassigned,
  (SELECT count(*)::int FROM app.assignment_files
    WHERE organization_id IS NOT NULL AND assigned_appraiser_user_id IS NULL) AS custom_assignment_files_missing_appraiser,
  (SELECT count(*)::int FROM appraisal.uad_workfiles
    WHERE organization_id IS NOT NULL AND assigned_appraiser_user_id IS NULL) AS uad_workfiles_missing_appraiser,
  (SELECT count(*)::int FROM app.tax_protest_files
    WHERE organization_id IS NOT NULL AND assigned_appraiser_user_id IS NULL) AS property_tax_files_missing_appraiser,
  (SELECT count(*)::int
     FROM app.assignment_files assignment
    WHERE assignment.organization_id IS NOT NULL
      AND assignment.assigned_appraiser_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM app_auth.appraiser_profiles profile
          JOIN app_auth.appraiser_licenses license ON license.user_id = profile.user_id
         WHERE profile.user_id = assignment.assigned_appraiser_user_id
           AND profile.profile_status = 'active'
           AND license.status = 'active'
           AND license.expires_on >= current_date
      )) AS custom_assignment_files_invalid_appraiser_credentials,
  (SELECT count(*)::int
     FROM appraisal.uad_workfiles workfile
    WHERE workfile.organization_id IS NOT NULL
      AND workfile.assigned_appraiser_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM app_auth.appraiser_profiles profile
          JOIN app_auth.appraiser_licenses license ON license.user_id = profile.user_id
         WHERE profile.user_id = workfile.assigned_appraiser_user_id
           AND profile.profile_status = 'active'
           AND license.status = 'active'
           AND license.expires_on >= current_date
      )) AS uad_workfiles_invalid_appraiser_credentials,
  (SELECT count(*)::int
     FROM app.tax_protest_files protest
    WHERE protest.organization_id IS NOT NULL
      AND protest.assigned_appraiser_user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
          FROM app_auth.appraiser_profiles profile
          JOIN app_auth.appraiser_licenses license ON license.user_id = profile.user_id
         WHERE profile.user_id = protest.assigned_appraiser_user_id
           AND profile.profile_status = 'active'
           AND license.status = 'active'
           AND license.expires_on >= current_date
      )) AS property_tax_files_invalid_appraiser_credentials,
  (SELECT count(*)::int
     FROM app.assignment_documents document
     LEFT JOIN app.assignment_files assignment ON assignment.id = document.assignment_file_id
    WHERE document.assignment_file_id IS NULL OR assignment.organization_id IS NULL) AS documents_without_owned_assignment`;

const CONSISTENCY_SQL = `SELECT
  (SELECT count(*)::int
     FROM app.report_files report_file
     JOIN app.assignment_files assignment ON assignment.id = report_file.custom_assignment_file_id
    WHERE report_file.workflow_type = 'custom_appraisal'
      AND report_file.organization_id IS DISTINCT FROM assignment.organization_id) AS custom_registry_mismatches,
  (SELECT count(*)::int
     FROM app.report_files report_file
     JOIN appraisal.uad_workfiles workfile ON workfile.id = report_file.uad_workfile_id
    WHERE report_file.workflow_type = 'uad_3_6'
      AND report_file.organization_id IS DISTINCT FROM workfile.organization_id) AS uad_registry_mismatches,
  (SELECT count(*)::int
     FROM app.report_files report_file
     JOIN app.tax_protest_files protest ON protest.id = report_file.tax_protest_file_id
    WHERE report_file.workflow_type = 'property_tax_protest'
      AND report_file.organization_id IS DISTINCT FROM protest.organization_id) AS property_tax_registry_mismatches,
  (SELECT count(*)::int
     FROM app.report_files report_file
     JOIN app.appraisal_cases appraisal_case ON appraisal_case.id = report_file.appraisal_case_id
    WHERE report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
      AND report_file.organization_id IS DISTINCT FROM appraisal_case.organization_id) AS appraisal_case_registry_mismatches`;

const REGISTRY_SQL = `SELECT
  (SELECT count(*)::int
     FROM app.assignment_files assignment
     LEFT JOIN app.report_files report_file ON report_file.custom_assignment_file_id = assignment.id
    WHERE report_file.id IS NULL) AS custom_targets_without_registry,
  (SELECT count(*)::int
     FROM appraisal.uad_workfiles workfile
     LEFT JOIN app.report_files report_file ON report_file.uad_workfile_id = workfile.id
    WHERE report_file.id IS NULL) AS uad_targets_without_registry,
  (SELECT count(*)::int
     FROM app.report_files
    WHERE workflow_type IN ('custom_appraisal', 'uad_3_6')
      AND appraisal_case_id IS NULL) AS appraisal_reports_missing_case,
  (SELECT count(*)::int
     FROM app.report_files
    WHERE workflow_type IN ('custom_appraisal', 'uad_3_6')
      AND subject_snapshot_id IS NULL) AS appraisal_reports_missing_snapshot`;

const ORGANIZATIONS_SQL = `SELECT
  organization.id AS organization_id,
  organization.legal_name,
  organization.display_name,
  organization.active,
  (SELECT count(*)::int FROM app_auth.organization_memberships
    WHERE organization_id = organization.id AND status = 'active') AS active_memberships,
  (SELECT count(*)::int FROM app_auth.oidc_identities identity
    JOIN app_auth.organization_memberships membership ON membership.user_id = identity.user_id
   WHERE membership.organization_id = organization.id AND membership.status = 'active') AS mapped_identities,
  (SELECT count(DISTINCT profile.user_id)::int
     FROM app_auth.appraiser_profiles profile
     JOIN app_auth.organization_memberships membership ON membership.user_id = profile.user_id
     JOIN app_auth.membership_roles role
       ON role.user_id = membership.user_id
      AND role.organization_id = membership.organization_id
      AND role.role_code IN ('appraiser', 'supervisory_appraiser')
    WHERE membership.organization_id = organization.id
      AND membership.status = 'active'
      AND profile.profile_status = 'active') AS active_appraiser_profiles,
  (SELECT count(DISTINCT license.user_id)::int
     FROM app_auth.appraiser_licenses license
     JOIN app_auth.organization_memberships membership ON membership.user_id = license.user_id
     JOIN app_auth.membership_roles role
       ON role.user_id = membership.user_id
      AND role.organization_id = membership.organization_id
      AND role.role_code IN ('appraiser', 'supervisory_appraiser')
    WHERE membership.organization_id = organization.id
      AND membership.status = 'active'
      AND license.status = 'active'
      AND license.expires_on >= current_date) AS valid_appraiser_licenses,
  (SELECT count(*)::int FROM app.assignment_files
    WHERE organization_id = organization.id) AS custom_assignment_files,
  (SELECT count(*)::int FROM app.assignment_files
    WHERE organization_id = organization.id AND assigned_appraiser_user_id IS NULL) AS custom_assignment_files_missing_appraiser,
  (SELECT count(*)::int FROM appraisal.uad_workfiles
    WHERE organization_id = organization.id) AS uad_workfiles,
  (SELECT count(*)::int FROM appraisal.uad_workfiles
    WHERE organization_id = organization.id AND assigned_appraiser_user_id IS NULL) AS uad_workfiles_missing_appraiser,
  (SELECT count(*)::int FROM app.tax_protest_files
    WHERE organization_id = organization.id) AS property_tax_files,
  (SELECT count(*)::int FROM app.tax_protest_files
    WHERE organization_id = organization.id AND assigned_appraiser_user_id IS NULL) AS property_tax_files_missing_appraiser
FROM app_auth.organizations organization
WHERE organization.id = ANY($1::uuid[])
ORDER BY organization.legal_name`;

function countRecord(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value) || 0]));
}

function positiveCountBlockers(record, group) {
  return Object.entries(record)
    .filter(([, count]) => Number(count) > 0)
    .map(([code, count]) => Object.freeze({ code, count: Number(count), group }));
}

function organizationBlockers(organization) {
  const blockers = [];
  const add = (condition, code) => {
    if (condition) blockers.push(Object.freeze({
      code,
      count: 1,
      group: "organization",
      organization_id: organization.organization_id,
    }));
  };
  add(!organization.active, "organization_inactive");
  add(organization.active_memberships === 0, "organization_active_membership_missing");
  add(organization.mapped_identities === 0, "organization_oidc_identity_missing");
  add(organization.active_appraiser_profiles === 0, "organization_appraiser_profile_missing");
  add(organization.valid_appraiser_licenses === 0, "organization_valid_appraiser_license_missing");
  return blockers;
}

function adminOrganizationIds(auth) {
  return [...new Set((Array.isArray(auth?.organizations) ? auth.organizations : [])
    .filter((membership) => Array.isArray(membership?.roles)
      && membership.roles.some((role) => ADMIN_ROLES.has(role)))
    .map((membership) => String(membership?.organizationId || "").trim())
    .filter(Boolean))];
}

export async function loadApplicationAuthRolloutReadiness(pool, { organizationIds = [] } = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("database_pool_required");
  const ids = [...new Set(organizationIds.map((value) => String(value || "").trim()).filter(Boolean))];
  const [identityResult, ownershipResult, consistencyResult, registryResult, organizationResult] = await Promise.all([
    pool.query(IDENTITY_SQL),
    pool.query(OWNERSHIP_SQL),
    pool.query(CONSISTENCY_SQL),
    pool.query(REGISTRY_SQL),
    ids.length ? pool.query(ORGANIZATIONS_SQL, [ids]) : Promise.resolve({ rows: [] }),
  ]);

  const identity = countRecord(identityResult.rows[0]);
  const ownership = countRecord(ownershipResult.rows[0]);
  const consistency = countRecord(consistencyResult.rows[0]);
  const registry = countRecord(registryResult.rows[0]);
  const organizations = organizationResult.rows.map((row) => Object.freeze({
    organization_id: row.organization_id,
    legal_name: row.legal_name || null,
    display_name: row.display_name || null,
    active: Boolean(row.active),
    ...countRecord({
      active_memberships: row.active_memberships,
      mapped_identities: row.mapped_identities,
      active_appraiser_profiles: row.active_appraiser_profiles,
      valid_appraiser_licenses: row.valid_appraiser_licenses,
      custom_assignment_files: row.custom_assignment_files,
      custom_assignment_files_missing_appraiser: row.custom_assignment_files_missing_appraiser,
      uad_workfiles: row.uad_workfiles,
      uad_workfiles_missing_appraiser: row.uad_workfiles_missing_appraiser,
      property_tax_files: row.property_tax_files,
      property_tax_files_missing_appraiser: row.property_tax_files_missing_appraiser,
    }),
  }));

  const returnedIds = new Set(organizations.map((organization) => organization.organization_id));
  const missingOrganizations = ids
    .filter((organizationId) => !returnedIds.has(organizationId))
    .map((organizationId) => Object.freeze({
      code: "organization_not_found",
      count: 1,
      group: "organization",
      organization_id: organizationId,
    }));
  const blockers = Object.freeze([
    ...positiveCountBlockers(ownership, "ownership"),
    ...positiveCountBlockers(consistency, "consistency"),
    ...positiveCountBlockers(registry, "registry"),
    ...organizations.flatMap(organizationBlockers),
    ...missingOrganizations,
  ]);

  return Object.freeze({
    checked_at: new Date().toISOString(),
    activation_ready: ids.length > 0 && blockers.length === 0,
    blockers,
    organizations: Object.freeze(organizations),
    identity: Object.freeze(identity),
    ownership: Object.freeze(ownership),
    consistency: Object.freeze(consistency),
    registry: Object.freeze(registry),
  });
}

export async function getApplicationAuthReadiness(pool, auth) {
  const organizationIds = adminOrganizationIds(auth);
  if (!organizationIds.length) {
    const error = new Error("auth_readiness_access_denied");
    error.code = "auth_readiness_access_denied";
    throw error;
  }
  return loadApplicationAuthRolloutReadiness(pool, { organizationIds });
}

export const APPLICATION_AUTH_READINESS_ADMIN_ROLES = Object.freeze([...ADMIN_ROLES]);
