import "dotenv/config";
import pg from "pg";

import { registerOriginalAppraisalReport } from "../src/services/appraisalHistory.js";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function expectedCount(name, { required = false } = {}) {
  const value = option(name);
  if (!value && !required) return null;
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return parsed;
}

const legalName = option("organization-legal-name");
const appraiserEmail = option("assigned-appraiser-email").toLowerCase();
const apply = process.argv.includes("--apply");
const expected = {
  assignment_files: expectedCount("expected-assignment-files", { required: apply }),
  uad_workfiles: expectedCount("expected-uad-workfiles", { required: apply }),
  custom_registry_gaps: expectedCount("expected-custom-registry-gaps", { required: apply }),
  uad_registry_gaps: expectedCount("expected-uad-registry-gaps", { required: apply }),
  history_gaps: expectedCount("expected-history-gaps", { required: apply }),
};

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!legalName) throw new Error("--organization-legal-name is required");
if (apply && !appraiserEmail) throw new Error("--assigned-appraiser-email is required with --apply");
if (apply && process.env.NODE_ENV === "production" && option("confirm-production") !== legalName) {
  throw new Error("--confirm-production must exactly match --organization-legal-name");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('legacy-appraisal-organization-migration'))");
  const organization = await client.query(
    `SELECT id, display_name
       FROM app_auth.organizations
      WHERE lower(legal_name) = lower($1) AND active = true
      FOR UPDATE`,
    [legalName],
  );
  if (organization.rowCount !== 1) throw new Error("active organization must resolve exactly once");
  const organizationId = organization.rows[0].id;

  let appraiserUserId = null;
  if (appraiserEmail) {
    const appraiser = await client.query(
      `SELECT users.id
         FROM app_auth.users users
         JOIN app_auth.organization_memberships membership
           ON membership.user_id = users.id
         JOIN app_auth.membership_roles role
           ON role.user_id = users.id
          AND role.organization_id = membership.organization_id
          AND role.role_code IN ('appraiser', 'supervisory_appraiser')
        WHERE lower(users.email) = $1
          AND membership.organization_id = $2
          AND users.active = true
          AND membership.status = 'active'
        GROUP BY users.id`,
      [appraiserEmail, organizationId],
    );
    if (appraiser.rowCount !== 1) {
      throw new Error("assigned appraiser must resolve exactly once with an appraiser role");
    }
    appraiserUserId = appraiser.rows[0].id;
  }

  const counts = await client.query(
    `SELECT
       (SELECT count(*)::int
          FROM app.assignment_files
         WHERE organization_id IS NULL) AS assignment_files,
       (SELECT count(*)::int
          FROM appraisal.uad_workfiles
         WHERE organization_id IS NULL) AS uad_workfiles,
       (SELECT count(*)::int
          FROM app.assignment_files assignment
          LEFT JOIN app.report_files report_file
            ON report_file.custom_assignment_file_id = assignment.id
         WHERE (assignment.organization_id IS NULL OR assignment.organization_id = $1)
           AND report_file.id IS NULL) AS custom_registry_gaps,
       (SELECT count(*)::int
          FROM appraisal.uad_workfiles workfile
          LEFT JOIN app.report_files report_file
            ON report_file.uad_workfile_id = workfile.id
         WHERE (workfile.organization_id IS NULL OR workfile.organization_id = $1)
           AND report_file.id IS NULL) AS uad_registry_gaps,
       (
         (SELECT count(*)::int
            FROM app.report_files report_file
            JOIN app.assignment_files assignment
              ON assignment.id = report_file.custom_assignment_file_id
           WHERE (assignment.organization_id IS NULL OR assignment.organization_id = $1)
             AND (report_file.appraisal_case_id IS NULL OR report_file.subject_snapshot_id IS NULL))
         +
         (SELECT count(*)::int
            FROM app.report_files report_file
            JOIN appraisal.uad_workfiles workfile
              ON workfile.id = report_file.uad_workfile_id
           WHERE (workfile.organization_id IS NULL OR workfile.organization_id = $1)
             AND (report_file.appraisal_case_id IS NULL OR report_file.subject_snapshot_id IS NULL))
         +
         (SELECT count(*)::int
            FROM app.assignment_files assignment
            LEFT JOIN app.report_files report_file
              ON report_file.custom_assignment_file_id = assignment.id
           WHERE (assignment.organization_id IS NULL OR assignment.organization_id = $1)
             AND report_file.id IS NULL)
         +
         (SELECT count(*)::int
            FROM appraisal.uad_workfiles workfile
            LEFT JOIN app.report_files report_file
              ON report_file.uad_workfile_id = workfile.id
           WHERE (workfile.organization_id IS NULL OR workfile.organization_id = $1)
             AND report_file.id IS NULL)
       ) AS history_gaps`,
    [organizationId],
  );
  const pendingBefore = Object.fromEntries(
    Object.entries(counts.rows[0]).map(([key, value]) => [key, Number(value)]),
  );
  if (apply) {
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (pendingBefore[key] !== expectedValue) {
        throw new Error(`${key.replaceAll("_", " ")} count changed after dry run`);
      }
    }
  }

  const applied = {
    assignment_files: 0,
    uad_workfiles: 0,
    report_files_updated: 0,
    appraisal_cases_updated: 0,
    custom_report_files_inserted: 0,
    uad_report_files_inserted: 0,
    histories_created: 0,
  };

  if (apply) {
    const customAssignments = await client.query(
      `UPDATE app.assignment_files
          SET organization_id = $1,
              assigned_appraiser_user_id = COALESCE(assigned_appraiser_user_id, $2),
              created_by_user_id = COALESCE(created_by_user_id, $2),
              updated_by_user_id = COALESCE(updated_by_user_id, $2)
        WHERE organization_id IS NULL`,
      [organizationId, appraiserUserId],
    );
    applied.assignment_files = customAssignments.rowCount;

    const uadWorkfiles = await client.query(
      `UPDATE appraisal.uad_workfiles
          SET organization_id = $1,
              assigned_appraiser_user_id = COALESCE(assigned_appraiser_user_id, $2),
              created_by_user_id = COALESCE(created_by_user_id, $2),
              updated_by_user_id = COALESCE(updated_by_user_id, $2)
        WHERE organization_id IS NULL`,
      [organizationId, appraiserUserId],
    );
    applied.uad_workfiles = uadWorkfiles.rowCount;

    const reportFiles = await client.query(
      `UPDATE app.report_files report_file
          SET organization_id = $1,
              created_by_user_id = COALESCE(report_file.created_by_user_id, $2)
         WHERE report_file.organization_id IS NULL
           AND (
             EXISTS (
               SELECT 1 FROM app.assignment_files assignment
                WHERE assignment.id = report_file.custom_assignment_file_id
                  AND assignment.organization_id = $1
             )
             OR EXISTS (
               SELECT 1 FROM appraisal.uad_workfiles workfile
                WHERE workfile.id = report_file.uad_workfile_id
                  AND workfile.organization_id = $1
             )
           )`,
      [organizationId, appraiserUserId],
    );
    applied.report_files_updated = reportFiles.rowCount;

    const appraisalCases = await client.query(
      `UPDATE app.appraisal_cases appraisal_case
          SET organization_id = $1,
              created_by_user_id = COALESCE(appraisal_case.created_by_user_id, $2)
         WHERE appraisal_case.organization_id IS NULL
           AND EXISTS (
             SELECT 1
               FROM app.report_files report_file
              WHERE report_file.appraisal_case_id = appraisal_case.id
                AND report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
                AND report_file.organization_id = $1
           )`,
      [organizationId, appraiserUserId],
    );
    applied.appraisal_cases_updated = appraisalCases.rowCount;

    const insertedCustom = await client.query(
      `INSERT INTO app.report_files (
         organization_id, account_id, workflow_type, file_number,
         custom_assignment_file_id, is_current, registry_revision,
         created_by_user_id, created_at, updated_at
       )
       SELECT assignment.organization_id, assignment.account_id, 'custom_appraisal',
              assignment.file_number, assignment.id, false, assignment.revision,
              COALESCE(assignment.created_by_user_id, $2),
              assignment.created_at, assignment.updated_at
         FROM app.assignment_files assignment
         LEFT JOIN app.report_files report_file
           ON report_file.custom_assignment_file_id = assignment.id
        WHERE assignment.organization_id = $1
          AND report_file.id IS NULL
       ON CONFLICT (custom_assignment_file_id)
         WHERE custom_assignment_file_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [organizationId, appraiserUserId],
    );
    applied.custom_report_files_inserted = insertedCustom.rowCount;

    const insertedUad = await client.query(
      `INSERT INTO app.report_files (
         organization_id, account_id, workflow_type, file_number,
         uad_workfile_id, is_current, registry_revision,
         created_by_user_id, created_at, updated_at
       )
       SELECT workfile.organization_id, workfile.account_id, 'uad_3_6',
              workfile.file_number, workfile.id, false, workfile.current_revision,
              COALESCE(workfile.created_by_user_id, $2),
              workfile.created_at, workfile.updated_at
         FROM appraisal.uad_workfiles workfile
         LEFT JOIN app.report_files report_file
           ON report_file.uad_workfile_id = workfile.id
        WHERE workfile.organization_id = $1
          AND report_file.id IS NULL
       ON CONFLICT (uad_workfile_id)
         WHERE uad_workfile_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [organizationId, appraiserUserId],
    );
    applied.uad_report_files_inserted = insertedUad.rowCount;

    const historyGaps = await client.query(
      `SELECT id, updated_at
         FROM app.report_files
        WHERE organization_id = $1
          AND workflow_type IN ('custom_appraisal', 'uad_3_6')
          AND (appraisal_case_id IS NULL OR subject_snapshot_id IS NULL)
        ORDER BY created_at, id`,
      [organizationId],
    );
    for (const reportFile of historyGaps.rows) {
      const result = await registerOriginalAppraisalReport(client, reportFile.id, {
        actorUserId: appraiserUserId,
        captureReason: "legacy_organization_migration",
      });
      if (result.created) applied.histories_created += 1;
      await client.query(
        "UPDATE app.report_files SET updated_at = $2 WHERE id = $1",
        [reportFile.id, reportFile.updated_at],
      );
    }

    await client.query(
      `WITH ranked AS (
         SELECT id,
                row_number() OVER (
                  PARTITION BY organization_id, account_id, workflow_type
                  ORDER BY updated_at DESC, created_at DESC, id DESC
                ) AS ordinal
           FROM app.report_files
          WHERE organization_id = $1
            AND workflow_type IN ('custom_appraisal', 'uad_3_6')
       )
       UPDATE app.report_files report_file
          SET is_current = (ranked.ordinal = 1)
         FROM ranked
        WHERE report_file.id = ranked.id
          AND report_file.is_current IS DISTINCT FROM (ranked.ordinal = 1)`,
      [organizationId],
    );

    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }

  console.log(JSON.stringify({
    mode: apply ? "applied" : "dry_run",
    organization_id: organizationId,
    organization_display_name: organization.rows[0].display_name,
    assigned_appraiser_user_id: appraiserUserId,
    pending_before: pendingBefore,
    applied,
  }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
