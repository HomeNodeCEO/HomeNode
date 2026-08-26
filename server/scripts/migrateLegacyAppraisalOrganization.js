import "dotenv/config";
import pg from "pg";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const legalName = option("organization-legal-name");
const appraiserEmail = option("assigned-appraiser-email").toLowerCase();
const apply = process.argv.includes("--apply");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!legalName) throw new Error("--organization-legal-name is required");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const organization = await client.query(
    `SELECT id, display_name FROM app_auth.organizations
      WHERE lower(legal_name) = lower($1) AND active = true FOR UPDATE`,
    [legalName],
  );
  if (organization.rowCount !== 1) throw new Error("active organization must resolve exactly once");
  let appraiserUserId = null;
  if (appraiserEmail) {
    const appraiser = await client.query(
      `SELECT users.id
         FROM app_auth.users users
         JOIN app_auth.organization_memberships membership ON membership.user_id = users.id
        WHERE lower(users.email) = $1 AND membership.organization_id = $2
          AND users.active = true AND membership.status = 'active'`,
      [appraiserEmail, organization.rows[0].id],
    );
    if (appraiser.rowCount !== 1) throw new Error("assigned appraiser must resolve exactly once");
    appraiserUserId = appraiser.rows[0].id;
  }
  const counts = await client.query(
    `SELECT
       (SELECT count(*)::int FROM app.assignment_files WHERE organization_id IS NULL) AS assignment_files,
       (SELECT count(*)::int FROM app.report_files
         WHERE workflow_type = 'custom_appraisal' AND organization_id IS NULL) AS report_files`,
  );
  if (apply) {
    await client.query(
      `UPDATE app.assignment_files
          SET organization_id = $1,
              assigned_appraiser_user_id = COALESCE(assigned_appraiser_user_id, $2),
              updated_at = now()
        WHERE organization_id IS NULL`,
      [organization.rows[0].id, appraiserUserId],
    );
    await client.query(
      `UPDATE app.report_files report_file
          SET organization_id = $1,
              created_by_user_id = COALESCE(report_file.created_by_user_id, $2),
              updated_at = now()
         FROM app.assignment_files assignment
        WHERE report_file.custom_assignment_file_id = assignment.id
          AND report_file.workflow_type = 'custom_appraisal'
          AND report_file.organization_id IS NULL`,
      [organization.rows[0].id, appraiserUserId],
    );
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  console.log(JSON.stringify({
    mode: apply ? "applied" : "dry_run",
    organization_id: organization.rows[0].id,
    organization_display_name: organization.rows[0].display_name,
    assigned_appraiser_user_id: appraiserUserId,
    pending_before: counts.rows[0],
  }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
