import "dotenv/config";
import pg from "pg";
import { loadApplicationAuthRolloutReadiness } from "../src/security/applicationAuthReadiness.js";

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
      `SELECT id
         FROM app_auth.organizations
        WHERE lower(legal_name) = lower($1)`,
      [legalName],
    )
    : { rows: [], rowCount: 0 };
  if (legalName && organization.rowCount > 1) throw new Error("organization legal name is ambiguous");

  const audit = await loadApplicationAuthRolloutReadiness(pool, {
    organizationIds: organization.rows[0]?.id ? [organization.rows[0].id] : [],
  });
  const selected = audit.organizations[0] || null;
  console.log(JSON.stringify({
    checked_at: audit.checked_at,
    selected_organization: selected
      ? {
        id: selected.organization_id,
        legal_name: selected.legal_name,
        display_name: selected.display_name,
        active: selected.active,
        active_memberships: selected.active_memberships,
        mapped_identities: selected.mapped_identities,
        active_appraiser_profiles: selected.active_appraiser_profiles,
        valid_appraiser_licenses: selected.valid_appraiser_licenses,
        custom_assignment_files: selected.custom_assignment_files,
        custom_assignment_files_missing_appraiser: selected.custom_assignment_files_missing_appraiser,
        uad_workfiles: selected.uad_workfiles,
        uad_workfiles_missing_appraiser: selected.uad_workfiles_missing_appraiser,
        property_tax_files: selected.property_tax_files,
        property_tax_files_missing_appraiser: selected.property_tax_files_missing_appraiser,
      }
      : null,
    identity: audit.identity,
    ownership: audit.ownership,
    consistency: audit.consistency,
    registry: audit.registry,
    blockers: audit.blockers,
    activation_ready: audit.activation_ready,
  }));
} finally {
  await pool.end();
}
