import { randomUUID } from "node:crypto";

import { createUadWorkfileWithClient } from "../uad/workfiles.js";
import { allocateReportFileNumber, normalizeWorkflowType } from "./fileNumbers.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECENT_FILE_DAYS = 30;
const WRITE_ROLES = new Set(["appraiser", "supervisory_appraiser", "organization_admin", "homenode_admin"]);

function normalizeUuid(value, code) {
  const uuid = String(value || "").trim();
  if (!UUID_PATTERN.test(uuid)) throw new Error(code);
  return uuid.toLowerCase();
}

export function normalizeAccountId(value) {
  const accountId = String(value || "").trim();
  if (!accountId || accountId.length > 100) throw new Error("invalid_account_id");
  return accountId;
}

function organizationAccess(auth, organizationId) {
  return auth.organizations.find((item) => item.organizationId === organizationId) || null;
}

function normalizeOrganization(auth, value, { write = false } = {}) {
  const organizationId = normalizeUuid(value, "invalid_organization_id");
  const access = organizationAccess(auth, organizationId);
  if (!access) throw new Error("organization_access_denied");
  if (write && !access.roles.some((role) => WRITE_ROLES.has(role))) {
    throw new Error("organization_write_access_denied");
  }
  return organizationId;
}

function reportFileResponse(row) {
  const targetId = row.custom_assignment_file_id
    ?? row.uad_workfile_id
    ?? row.tax_protest_file_id;
  return {
    id: row.id,
    organization_id: row.organization_id || null,
    account_id: row.account_id,
    property: {
      address: row.address || null,
      city: row.city || null,
      postal_code: row.postal_code || null,
    },
    workflow_type: row.workflow_type,
    file_number: row.file_number,
    sequence_number: row.sequence_number == null ? null : Number(row.sequence_number),
    target_id: targetId == null ? null : String(targetId),
    previous_report_file_id: row.previous_report_file_id || null,
    is_current: Boolean(row.is_current),
    registry_revision: Number(row.registry_revision),
    ready_for_inspection: Boolean(row.organization_id),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function sessionResponse(row) {
  return {
    id: row.id,
    report_file_id: row.report_file_id,
    organization_id: row.organization_id,
    appraiser_user_id: row.appraiser_user_id,
    mobile_device_id: row.mobile_device_id || null,
    status: row.status,
    revision: Number(row.revision),
    base_report_revision: Number(row.base_report_revision),
    started_at: row.started_at,
    last_synced_at: row.last_synced_at,
    review_required_at: row.review_required_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listReportFiles(pool, auth, {
  accountId: accountIdValue,
  workflowType: workflowTypeValue,
  recentDays = RECENT_FILE_DAYS,
}) {
  const accountId = normalizeAccountId(accountIdValue);
  const workflowType = workflowTypeValue ? normalizeWorkflowType(workflowTypeValue) : null;
  const organizationIds = auth.organizations.map((item) => item.organizationId);
  const boundedRecentDays = Math.max(1, Math.min(365, Number(recentDays) || RECENT_FILE_DAYS));
  const { rows } = await pool.query(
    `SELECT report_file.*, account.address, account.city, account.postal_code,
            report_file.created_at >= now() - ($4::integer * interval '1 day') AS is_recent
       FROM app.report_files report_file
       JOIN core.accounts account ON account.account_id = report_file.account_id
      WHERE report_file.account_id = $1
        AND ($2::text IS NULL OR report_file.workflow_type = $2)
        AND (
          report_file.organization_id = ANY($3::uuid[])
          OR (report_file.organization_id IS NULL AND report_file.workflow_type = 'custom_appraisal')
        )
      ORDER BY report_file.is_current DESC, report_file.updated_at DESC, report_file.id`,
    [accountId, workflowType, organizationIds, boundedRecentDays],
  );
  const files = rows.map((row) => ({ ...reportFileResponse(row), is_recent: Boolean(row.is_recent) }));
  const recommended = files.find((file) => file.is_current && file.is_recent && file.ready_for_inspection)
    || files.find((file) => file.is_current && file.ready_for_inspection)
    || null;
  return Object.freeze({
    accountId,
    workflowType,
    files,
    recommended,
    recentlyCreated: files.some((file) => file.is_recent),
    requiresCreation: files.length === 0,
  });
}

async function insertCanonicalTarget(client, {
  workflowType,
  organizationId,
  accountId,
  fileNumber,
  previous,
  userId,
}) {
  if (workflowType === "custom_appraisal") {
    let inheritedFromFileId = previous?.custom_assignment_file_id || null;
    let assignmentDetails = {};
    if (inheritedFromFileId) {
      const source = await client.query(
        `SELECT assignment_details
           FROM app.assignment_files
          WHERE id = $1 AND account_id = $2`,
        [inheritedFromFileId, accountId],
      );
      if (!source.rows.length) throw new Error("previous_report_file_not_found");
      assignmentDetails = source.rows[0].assignment_details || {};
    }
    const { rows } = await client.query(
      `INSERT INTO app.assignment_files (
         account_id, file_number, assignment_details, inherited_from_file_id, reviewer
       ) VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id`,
      [accountId, fileNumber, JSON.stringify(assignmentDetails), inheritedFromFileId, "HomeNode mobile"],
    );
    await client.query(
      `INSERT INTO app.assignment_file_history (
         assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
       ) VALUES ($1, $2, $3, $4::jsonb, 'HomeNode mobile', 1)`,
      [rows[0].id, accountId, fileNumber, JSON.stringify(assignmentDetails)],
    );
    return { customAssignmentFileId: rows[0].id };
  }
  if (workflowType === "uad_3_6") {
    const workfile = await createUadWorkfileWithClient(client, accountId, {
      organization_id: organizationId,
      assigned_appraiser_user_id: userId,
      file_number: fileNumber,
    });
    return { uadWorkfileId: workfile.id };
  }
  const id = randomUUID();
  await client.query(
    `INSERT INTO app.tax_protest_files (
       id, organization_id, account_id, file_number, previous_file_id,
       assigned_appraiser_user_id, created_by_user_id, updated_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $6, $6)`,
    [id, organizationId, accountId, fileNumber, previous?.tax_protest_file_id || null, userId],
  );
  await client.query(
    `INSERT INTO app.tax_protest_file_history (
       tax_protest_file_id, revision, workfile_data, status, changed_by_user_id, change_summary
     ) VALUES ($1, 1, '{}'::jsonb, 'draft', $2, 'Initial HomeNode mobile file')`,
    [id, userId],
  );
  return { taxProtestFileId: id };
}

export async function createReportFile(pool, auth, input = {}) {
  const organizationId = normalizeOrganization(auth, input.organization_id, { write: true });
  const accountId = normalizeAccountId(input.account_id);
  const workflowType = normalizeWorkflowType(input.workflow_type);
  const creationRequestId = normalizeUuid(input.client_request_id, "invalid_client_request_id");
  const explicitPreviousId = input.previous_report_file_id == null
    ? null
    : normalizeUuid(input.previous_report_file_id, "invalid_previous_report_file_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [organizationId, `${accountId}:${workflowType}`],
    );
    const retried = await client.query(
      `SELECT report_file.*, account.address, account.city, account.postal_code
         FROM app.report_files report_file
         JOIN core.accounts account ON account.account_id = report_file.account_id
        WHERE report_file.organization_id = $1 AND report_file.creation_request_id = $2`,
      [organizationId, creationRequestId],
    );
    if (retried.rows.length) {
      if (
        retried.rows[0].account_id !== accountId
        || retried.rows[0].workflow_type !== workflowType
      ) {
        throw new Error("creation_request_conflict");
      }
      await client.query("COMMIT");
      return { reportFile: reportFileResponse(retried.rows[0]), created: false };
    }
    const account = await client.query("SELECT account_id FROM core.accounts WHERE account_id = $1", [accountId]);
    if (!account.rows.length) throw new Error("account_not_found");
    const previousResult = await client.query(
      `SELECT * FROM app.report_files
        WHERE (organization_id = $1 OR (organization_id IS NULL AND workflow_type = 'custom_appraisal'))
          AND account_id = $2 AND workflow_type = $3
          AND ($4::uuid IS NULL OR id = $4)
        ORDER BY (organization_id = $1) DESC, is_current DESC, updated_at DESC, id
        LIMIT 1
        FOR UPDATE`,
      [organizationId, accountId, workflowType, explicitPreviousId],
    );
    if (explicitPreviousId && !previousResult.rows.length) throw new Error("previous_report_file_not_found");
    const previous = previousResult.rows[0] || null;
    const allocation = await allocateReportFileNumber(client, { organizationId, workflowType });
    const target = await insertCanonicalTarget(client, {
      workflowType,
      organizationId,
      accountId,
      fileNumber: allocation.fileNumber,
      previous,
      userId: auth.userId,
    });
    if (previous) {
      await client.query(
        "UPDATE app.report_files SET is_current = false, updated_at = now() WHERE id = $1",
        [previous.id],
      );
    }
    const id = randomUUID();
    const inserted = await client.query(
      `INSERT INTO app.report_files (
         id, organization_id, account_id, workflow_type, file_number, sequence_number,
         creation_request_id, previous_report_file_id, custom_assignment_file_id,
         uad_workfile_id, tax_protest_file_id, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        id,
        organizationId,
        accountId,
        workflowType,
        allocation.fileNumber,
        allocation.sequenceNumber,
        creationRequestId,
        previous?.id || null,
        target.customAssignmentFileId || null,
        target.uadWorkfileId || null,
        target.taxProtestFileId || null,
        auth.userId,
      ],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, actor_user_id, event_type, next_registry_revision, metadata
       ) VALUES ($1, $2, 'report_file.created', 1, $3::jsonb)`,
      [id, auth.userId, JSON.stringify({ workflow_type: workflowType, file_number: allocation.fileNumber })],
    );
    const property = await client.query(
      "SELECT address, city, postal_code FROM core.accounts WHERE account_id = $1",
      [accountId],
    );
    await client.query("COMMIT");
    return {
      reportFile: reportFileResponse({ ...inserted.rows[0], ...property.rows[0] }),
      created: true,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function createInspectionSession(pool, auth, input = {}) {
  const reportFileId = normalizeUuid(input.report_file_id, "invalid_report_file_id");
  const mobileDeviceId = input.mobile_device_id == null
    ? null
    : normalizeUuid(input.mobile_device_id, "invalid_mobile_device_id");
  const organizationIds = auth.organizations.map((item) => item.organizationId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await client.query(
      `SELECT * FROM app.report_files
        WHERE id = $1 AND organization_id = ANY($2::uuid[])
        FOR SHARE`,
      [reportFileId, organizationIds],
    );
    if (!report.rows.length) throw new Error("report_file_not_found");
    normalizeOrganization(auth, report.rows[0].organization_id, { write: true });
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [reportFileId, auth.userId],
    );
    if (mobileDeviceId) {
      const device = await client.query(
        `SELECT id FROM app.mobile_devices
          WHERE id = $1 AND organization_id = $2 AND user_id = $3 AND status = 'active'`,
        [mobileDeviceId, report.rows[0].organization_id, auth.userId],
      );
      if (!device.rows.length) throw new Error("mobile_device_not_found");
    }
    const existing = await client.query(
      `SELECT * FROM app.inspection_sessions
        WHERE report_file_id = $1 AND appraiser_user_id = $2 AND status <> 'completed'
        ORDER BY updated_at DESC, id LIMIT 1 FOR UPDATE`,
      [reportFileId, auth.userId],
    );
    if (existing.rows.length) {
      await client.query("COMMIT");
      return { session: sessionResponse(existing.rows[0]), created: false };
    }
    const inserted = await client.query(
      `INSERT INTO app.inspection_sessions (
         report_file_id, organization_id, appraiser_user_id, mobile_device_id,
         base_report_revision
       ) VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [reportFileId, report.rows[0].organization_id, auth.userId, mobileDeviceId, report.rows[0].registry_revision],
    );
    await client.query(
      `INSERT INTO app.inspection_session_events (
         inspection_session_id, actor_user_id, event_type, next_revision, metadata
       ) VALUES ($1, $2, 'inspection_session.created', 1, '{}'::jsonb)`,
      [inserted.rows[0].id, auth.userId],
    );
    await client.query("COMMIT");
    return { session: sessionResponse(inserted.rows[0]), created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getInspectionSession(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const organizationIds = auth.organizations.map((item) => item.organizationId);
  const { rows } = await pool.query(
    `SELECT session.*
       FROM app.inspection_sessions session
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3`,
    [sessionId, organizationIds, auth.userId],
  );
  return rows[0] ? sessionResponse(rows[0]) : null;
}
