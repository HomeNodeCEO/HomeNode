import "dotenv/config";
import pg from "pg";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const legalName = option("organization-legal-name");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  const organization = legalName
    ? await pool.query(
      `SELECT id, legal_name, display_name, active
         FROM app_auth.organizations
        WHERE lower(legal_name) = lower($1)`,
      [legalName],
    )
    : { rows: [] };
  if (legalName && organization.rowCount > 1) throw new Error("organization legal name is ambiguous");
  const organizationId = organization.rows[0]?.id || null;

  const [identity, ownership, consistency, registry, selected] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT count(*)::int FROM app_auth.organizations WHERE active = true) AS active_organizations,
         (SELECT count(*)::int FROM app_auth.users WHERE active = true) AS active_users,
         (SELECT count(*)::int FROM app_auth.organization_memberships WHERE status = 'active') AS active_memberships,
         (SELECT count(*)::int FROM app_auth.oidc_identities) AS oidc_identities,
         (SELECT count(*)::int FROM app_auth.web_sessions WHERE revoked_at IS NULL AND expires_at > now()) AS active_web_sessions`,
    ),
    pool.query(
      `SELECT
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
           WHERE document.assignment_file_id IS NULL OR assignment.organization_id IS NULL) AS documents_without_owned_assignment`,
    ),
    pool.query(
      `SELECT
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
             AND report_file.organization_id IS DISTINCT FROM appraisal_case.organization_id) AS appraisal_case_registry_mismatches`,
    ),
    pool.query(
      `SELECT
         (SELECT count(*)::int
            FROM app.assignment_files assignment
            LEFT JOIN app.report_files report_file
              ON report_file.custom_assignment_file_id = assignment.id
           WHERE report_file.id IS NULL) AS custom_targets_without_registry,
         (SELECT count(*)::int
            FROM appraisal.uad_workfiles workfile
            LEFT JOIN app.report_files report_file
              ON report_file.uad_workfile_id = workfile.id
           WHERE report_file.id IS NULL) AS uad_targets_without_registry,
         (SELECT count(*)::int
            FROM app.report_files
           WHERE workflow_type IN ('custom_appraisal', 'uad_3_6')
             AND appraisal_case_id IS NULL) AS appraisal_reports_missing_case,
         (SELECT count(*)::int
            FROM app.report_files
           WHERE workflow_type IN ('custom_appraisal', 'uad_3_6')
             AND subject_snapshot_id IS NULL) AS appraisal_reports_missing_snapshot`,
    ),
    organizationId
      ? pool.query(
        `SELECT
           (SELECT count(*)::int FROM app_auth.organization_memberships
             WHERE organization_id = $1 AND status = 'active') AS active_memberships,
           (SELECT count(*)::int FROM app_auth.oidc_identities identity
             JOIN app_auth.organization_memberships membership ON membership.user_id = identity.user_id
            WHERE membership.organization_id = $1 AND membership.status = 'active') AS mapped_identities,
           (SELECT count(DISTINCT profile.user_id)::int
              FROM app_auth.appraiser_profiles profile
              JOIN app_auth.organization_memberships membership ON membership.user_id = profile.user_id
              JOIN app_auth.membership_roles role
                ON role.user_id = membership.user_id
               AND role.organization_id = membership.organization_id
               AND role.role_code IN ('appraiser', 'supervisory_appraiser')
             WHERE membership.organization_id = $1
               AND membership.status = 'active'
               AND profile.profile_status = 'active') AS active_appraiser_profiles,
           (SELECT count(DISTINCT license.user_id)::int
              FROM app_auth.appraiser_licenses license
              JOIN app_auth.organization_memberships membership ON membership.user_id = license.user_id
              JOIN app_auth.membership_roles role
                ON role.user_id = membership.user_id
               AND role.organization_id = membership.organization_id
               AND role.role_code IN ('appraiser', 'supervisory_appraiser')
             WHERE membership.organization_id = $1
               AND membership.status = 'active'
               AND license.status = 'active'
               AND license.expires_on >= current_date) AS valid_appraiser_licenses,
           (SELECT count(*)::int FROM app.assignment_files WHERE organization_id = $1) AS custom_assignment_files,
           (SELECT count(*)::int FROM app.assignment_files
             WHERE organization_id = $1 AND assigned_appraiser_user_id IS NULL) AS custom_assignment_files_missing_appraiser,
           (SELECT count(*)::int FROM appraisal.uad_workfiles WHERE organization_id = $1) AS uad_workfiles,
           (SELECT count(*)::int FROM appraisal.uad_workfiles
             WHERE organization_id = $1 AND assigned_appraiser_user_id IS NULL) AS uad_workfiles_missing_appraiser,
           (SELECT count(*)::int FROM app.tax_protest_files WHERE organization_id = $1) AS property_tax_files,
           (SELECT count(*)::int FROM app.tax_protest_files
             WHERE organization_id = $1 AND assigned_appraiser_user_id IS NULL) AS property_tax_files_missing_appraiser`,
        [organizationId],
      )
      : { rows: [{}] },
  ]);

  const selectedOrganization = organization.rows[0] || null;
  const selectedCounts = selected.rows[0];
  console.log(JSON.stringify({
    checked_at: new Date().toISOString(),
    selected_organization: selectedOrganization
      ? {
        id: selectedOrganization.id,
        legal_name: selectedOrganization.legal_name,
        display_name: selectedOrganization.display_name,
        active: selectedOrganization.active,
        ...selectedCounts,
      }
      : null,
    identity: identity.rows[0],
    ownership: ownership.rows[0],
    consistency: consistency.rows[0],
    registry: registry.rows[0],
    activation_ready: Boolean(
      selectedOrganization?.active
      && Number(selectedCounts.active_memberships) > 0
      && Number(selectedCounts.mapped_identities) > 0
      && Number(selectedCounts.active_appraiser_profiles) > 0
      && Number(selectedCounts.valid_appraiser_licenses) > 0
      && Object.values(ownership.rows[0]).every((count) => Number(count) === 0)
      && Object.values(consistency.rows[0]).every((count) => Number(count) === 0)
      && Object.values(registry.rows[0]).every((count) => Number(count) === 0)
    ),
  }));
} finally {
  await pool.end();
}
