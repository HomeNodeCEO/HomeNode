import { randomUUID } from "node:crypto";

import { allocateReportFileNumber } from "../modules/mobile/fileNumbers.js";
import { createUadWorkfileWithClient } from "../modules/uad/workfiles.js";
import {
  canonicalCustomAppraisalFileName,
} from "./customAppraisalWorkfiles.js";
import {
  captureAppraisalSubjectSnapshot,
  listPreviousAppraisalFiles,
  normalizeAppraisalReportFileId,
  normalizeReplicationRequest,
  registerOriginalAppraisalReport,
  summarizeAppraisalHistoryRow,
} from "./appraisalHistory.js";
import { normalizeAssignmentFileNumber } from "./assignmentFiles.js";

function replicationRequestMatches(row, {
  accountId,
  sourceReportFileId,
  request,
  actorUserId,
  organizationId,
}) {
  const attestation = row.attestation && typeof row.attestation === "object"
    ? row.attestation
    : {};
  return row.account_id === accountId
    && row.source_report_file_id === sourceReportFileId
    && row.workflow_type === request.targetWorkflow
    && row.recorded_replication_mode === request.mode
    && (organizationId == null || row.organization_id === organizationId)
    && String(row.created_by_user_id || "") === String(actorUserId || "")
    && (attestation.requested_file_number ?? null) === request.fileNumber
    && (attestation.effective_date ?? null) === request.effectiveDate
    && (attestation.inspection_date ?? null) === request.inspectionDate
    && attestation.same_assignment_confirmed === request.sameAssignmentConfirmed;
}

function fallbackReplicationTarget(row) {
  return summarizeAppraisalHistoryRow({
    ...row,
    replication_mode: row.recorded_replication_mode || row.replication_mode,
    effective_date: row.effective_date || row.attestation?.effective_date || null,
    inspection_date: row.inspection_date || row.attestation?.inspection_date || null,
    photo_count: row.photo_count || 0,
    has_confirmed_sketch: row.has_confirmed_sketch || false,
  });
}

function baseReplicationFileNumber(sourceFileNumber, targetWorkflow) {
  const suffix = targetWorkflow === "custom_appraisal" ? "CUSTOM" : "UAD";
  const base = String(sourceFileNumber || "APPRAISAL")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 88) || "APPRAISAL";
  return `${base}-${suffix}`.slice(0, 100);
}

function storedIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  const normalized = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(normalized) ? normalized.slice(0, 10) : normalized;
}

export function assertSameAssignmentReplicationDates(sourceCase = {}, request = {}) {
  const checks = [
    ["effective", storedIsoDate(sourceCase.effective_date), request.effectiveDate],
    ["inspection", storedIsoDate(sourceCase.inspection_date), request.inspectionDate],
  ];
  for (const [field, sourceDate, requestedDate] of checks) {
    if (requestedDate && sourceDate !== requestedDate) {
      throw new Error(`same_assignment_${field}_date_conflict`);
    }
  }
}

async function availableFileNumber(client, {
  accountId,
  organizationId,
  workflowType,
  requested,
  sourceFileNumber,
}) {
  if (requested) return { fileNumber: normalizeAssignmentFileNumber(requested), sequenceNumber: null };
  if (organizationId) {
    const allocation = await allocateReportFileNumber(client, {
      organizationId,
      workflowType,
    });
    return { fileNumber: allocation.fileNumber, sequenceNumber: allocation.sequenceNumber };
  }
  const base = baseReplicationFileNumber(sourceFileNumber, workflowType);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0
      ? base
      : `${base.slice(0, 96 - String(suffix).length)}-${suffix}`;
    const existing = await client.query(
      `SELECT 1
         FROM app.report_files
        WHERE account_id = $1
          AND workflow_type = $2
          AND lower(file_number) = lower($3)
        LIMIT 1`,
      [accountId, workflowType, candidate],
    );
    if (!existing.rows.length) return { fileNumber: candidate, sequenceNumber: null };
  }
  throw new Error("replication_file_number_unavailable");
}

async function insertCustomTarget(client, {
  accountId,
  organizationId,
  fileNumber,
  sourceReportFile,
  mode,
  assignedAppraiserUserId,
  actorUserId,
}) {
  const assignmentDetails = {};
  const inserted = await client.query(
    `INSERT INTO app.assignment_files (
       account_id, file_number, assignment_details, inherited_from_file_id, reviewer,
       organization_id, assigned_appraiser_user_id, created_by_user_id, updated_by_user_id
     ) VALUES ($1, $2, $3::jsonb, $4, 'HomeNode replication', $5, $6, $7, $7)
     RETURNING id`,
    [
      accountId,
      fileNumber,
      JSON.stringify(assignmentDetails),
      mode === "same_assignment_alternate"
        ? sourceReportFile.custom_assignment_file_id || null
        : null,
      organizationId,
      assignedAppraiserUserId,
      actorUserId,
    ],
  );
  const assignmentFileId = Number(inserted.rows[0].id);
  await client.query(
    `INSERT INTO app.assignment_file_history (
       assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
     ) VALUES ($1, $2, $3, $4::jsonb, 'HomeNode replication', 1)`,
    [assignmentFileId, accountId, fileNumber, JSON.stringify(assignmentDetails)],
  );
  await client.query(
    `INSERT INTO app.custom_appraisal_workfiles (
       assignment_file_id, canonical_file_name
     ) VALUES ($1, $2)`,
    [assignmentFileId, canonicalCustomAppraisalFileName(fileNumber, assignmentFileId)],
  );
  return { customAssignmentFileId: assignmentFileId, fileNumber };
}

async function insertUadTarget(client, {
  accountId,
  organizationId,
  fileNumber,
  sourceReportFile,
  assignedAppraiserUserId,
  actorUserId,
}) {
  const workfile = await createUadWorkfileWithClient(client, accountId, {
    organization_id: organizationId || null,
    assigned_appraiser_user_id: assignedAppraiserUserId || actorUserId || null,
    actor_user_id: actorUserId || null,
    file_number: fileNumber,
    assignment_purpose: sourceReportFile.assignment_purpose || "Mortgage finance appraisal",
  });
  return { uadWorkfileId: workfile.id, fileNumber: workfile.file_number };
}

export async function replicateAppraisalFile(pool, {
  accountId: accountIdValue,
  sourceReportFileId: sourceReportFileIdValue,
  input = {},
  actorUserId = null,
  organizationId = null,
  logger = console,
}) {
  const accountId = String(accountIdValue || "").trim();
  if (!accountId || accountId.length > 100) throw new Error("invalid_account_id");
  const sourceReportFileId = normalizeAppraisalReportFileId(sourceReportFileIdValue);
  const request = normalizeReplicationRequest(input);
  const client = await pool.connect();
  let targetReportFileId;
  let committedTarget;
  try {
    await client.query("BEGIN");
    let replayed = false;
    if (request.clientRequestId) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('appraisal_replication'), hashtext($1))",
        [request.clientRequestId],
      );
      const existingResult = await client.query(
        `SELECT target.*, replication.source_report_file_id,
                replication.replication_mode AS recorded_replication_mode,
                replication.change_review_required, replication.attestation,
                source.file_number AS source_file_number,
                case_record.effective_date, case_record.inspection_date,
                custom_workfile.status AS custom_status,
                custom_assignment.revision AS custom_revision,
                uad_workfile.status AS uad_status,
                uad_workfile.current_revision AS uad_revision
           FROM app.report_files target
           LEFT JOIN app.appraisal_file_replications replication
             ON replication.target_report_file_id = target.id
           LEFT JOIN app.report_files source ON source.id = replication.source_report_file_id
           LEFT JOIN app.appraisal_cases case_record ON case_record.id = target.appraisal_case_id
           LEFT JOIN app.custom_appraisal_workfiles custom_workfile
             ON custom_workfile.assignment_file_id = target.custom_assignment_file_id
           LEFT JOIN app.assignment_files custom_assignment
             ON custom_assignment.id = target.custom_assignment_file_id
           LEFT JOIN appraisal.uad_workfiles uad_workfile
             ON uad_workfile.id = target.uad_workfile_id
          WHERE target.creation_request_id = $1
          FOR UPDATE OF target`,
        [request.clientRequestId],
      );
      if (existingResult.rows.length) {
        if (
          existingResult.rows.length !== 1
          || !replicationRequestMatches(existingResult.rows[0], {
            accountId,
            sourceReportFileId,
            request,
            actorUserId,
            organizationId,
          })
        ) {
          throw new Error("replication_request_conflict");
        }
        targetReportFileId = existingResult.rows[0].id;
        committedTarget = fallbackReplicationTarget(existingResult.rows[0]);
        replayed = true;
      }
    }

    if (!replayed) {
    const sourceResult = await client.query(
      `SELECT report_file.*, uad_workfile.assignment_purpose,
              COALESCE(assignment.assigned_appraiser_user_id, uad_workfile.assigned_appraiser_user_id) AS assigned_appraiser_user_id,
              COALESCE(assignment.supervisory_appraiser_user_id, uad_workfile.supervisory_appraiser_user_id) AS supervisory_appraiser_user_id
         FROM app.report_files report_file
         LEFT JOIN app.assignment_files assignment
           ON assignment.id = report_file.custom_assignment_file_id
         LEFT JOIN appraisal.uad_workfiles uad_workfile
           ON uad_workfile.id = report_file.uad_workfile_id
        WHERE report_file.id = $1
          AND report_file.account_id = $2
          AND report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
          AND ($3::uuid IS NULL OR report_file.organization_id = $3)
        FOR UPDATE OF report_file`,
      [sourceReportFileId, accountId, organizationId],
    );
    if (!sourceResult.rows.length) throw new Error("appraisal_report_file_not_found");
    const source = sourceResult.rows[0];
    const targetAssignedAppraiserUserId = source.assigned_appraiser_user_id || actorUserId || null;
    if (
      request.mode === "same_assignment_alternate"
      && source.workflow_type === request.targetWorkflow
    ) {
      throw new Error("same_assignment_requires_alternate_workflow");
    }

    const registeredSource = await registerOriginalAppraisalReport(client, source.id, {
      captureReason: "replication_source_registration",
    });
    const caseResult = await client.query(
      `SELECT effective_date, inspection_date
         FROM app.appraisal_cases
        WHERE id = $1
        FOR UPDATE`,
      [registeredSource.appraisalCaseId],
    );
    const sourceCase = caseResult.rows[0];
    if (request.mode === "same_assignment_alternate") {
      assertSameAssignmentReplicationDates(sourceCase, request);
    }
    const sourceSnapshot = await captureAppraisalSubjectSnapshot(client, source.id, {
      captureReason: "replication_source_capture",
    });

    const fileAllocation = await availableFileNumber(client, {
      accountId,
      organizationId: source.organization_id,
      workflowType: request.targetWorkflow,
      requested: request.fileNumber,
      sourceFileNumber: source.file_number,
    });
    const target = request.targetWorkflow === "custom_appraisal"
      ? await insertCustomTarget(client, {
        accountId,
        organizationId: source.organization_id,
        fileNumber: fileAllocation.fileNumber,
        sourceReportFile: source,
        mode: request.mode,
        assignedAppraiserUserId: targetAssignedAppraiserUserId,
        actorUserId,
      })
      : await insertUadTarget(client, {
        accountId,
        organizationId: source.organization_id,
        fileNumber: fileAllocation.fileNumber,
        sourceReportFile: source,
        assignedAppraiserUserId: targetAssignedAppraiserUserId,
        actorUserId,
      });

    await client.query(
      `UPDATE app.report_files
          SET is_current = false, updated_at = now()
        WHERE account_id = $1
          AND workflow_type = $2
          AND organization_id IS NOT DISTINCT FROM $3::uuid
          AND is_current = true`,
      [accountId, request.targetWorkflow, source.organization_id || null],
    );
    targetReportFileId = randomUUID();
    const insertedReportFile = await client.query(
      `INSERT INTO app.report_files (
         id, organization_id, account_id, workflow_type, file_number, sequence_number,
         previous_report_file_id, custom_assignment_file_id, uad_workfile_id,
         is_current, registry_revision, replication_mode, created_by_user_id, creation_request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, 1, $10, $11, $12)
       RETURNING *`,
      [
        targetReportFileId,
        source.organization_id || null,
        accountId,
        request.targetWorkflow,
        target.fileNumber,
        fileAllocation.sequenceNumber,
        source.id,
        target.customAssignmentFileId || null,
        target.uadWorkfileId || null,
        request.mode,
        actorUserId,
        request.clientRequestId,
      ],
    );

    let targetCaseId;
    let targetSnapshotId;
    if (request.mode === "same_assignment_alternate") {
      targetCaseId = sourceSnapshot.appraisalCaseId;
      targetSnapshotId = sourceSnapshot.id;
      await client.query(
        `UPDATE app.report_files
            SET appraisal_case_id = $2, subject_snapshot_id = $3
          WHERE id = $1`,
        [targetReportFileId, targetCaseId, targetSnapshotId],
      );
    } else {
      const registered = await registerOriginalAppraisalReport(client, targetReportFileId, {
        effectiveDate: request.effectiveDate,
        inspectionDate: request.inspectionDate,
        captureReason: "new_assignment_current_source_capture",
      });
      targetCaseId = registered.appraisalCaseId;
      targetSnapshotId = registered.snapshotId;
    }

    await client.query(
      `INSERT INTO app.appraisal_file_replications (
         source_report_file_id, target_report_file_id, source_snapshot_id,
         replication_mode, source_workflow_type, target_workflow_type,
         change_review_required, attestation, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        source.id,
        targetReportFileId,
        sourceSnapshot.id,
        request.mode,
        source.workflow_type,
        request.targetWorkflow,
        request.mode === "new_assignment_template",
        JSON.stringify({
          same_assignment_confirmed: request.sameAssignmentConfirmed,
          requested_file_number: request.fileNumber,
          effective_date: request.effectiveDate,
          inspection_date: request.inspectionDate,
          mutable_subject_data_copied_to_target: false,
          source_snapshot_available_for_review: true,
        }),
        actorUserId,
      ],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, actor_user_id, event_type, next_registry_revision, metadata
       ) VALUES ($1, $2, 'report_file.replicated', 1, $3::jsonb)`,
      [targetReportFileId, actorUserId, JSON.stringify({
        source_report_file_id: source.id,
        source_snapshot_id: sourceSnapshot.id,
        replication_mode: request.mode,
        appraisal_case_id: targetCaseId,
        subject_snapshot_id: targetSnapshotId,
      })],
    );
    committedTarget = fallbackReplicationTarget({
      ...insertedReportFile.rows[0],
      appraisal_case_id: targetCaseId,
      subject_snapshot_id: targetSnapshotId,
      recorded_replication_mode: request.mode,
      source_report_file_id: source.id,
      source_file_number: source.file_number,
      change_review_required: request.mode === "new_assignment_template",
      attestation: {
        same_assignment_confirmed: request.sameAssignmentConfirmed,
        requested_file_number: request.fileNumber,
        effective_date: request.effectiveDate,
        inspection_date: request.inspectionDate,
      },
    });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  let targetFile = null;
  let enrichmentFailed = false;
  try {
    const history = await listPreviousAppraisalFiles(pool, accountId, sourceOrganizationScope(organizationId));
    targetFile = history.files.find((file) => file.id === targetReportFileId) || null;
  } catch {
    enrichmentFailed = true;
  }
  if (!targetFile) {
    logger.error?.(enrichmentFailed
      ? "[appraisal-replication] response_enrichment_failed"
      : "[appraisal-replication] response_enrichment_unavailable");
    targetFile = committedTarget;
  }
  if (!targetFile) throw new Error("replicated_report_file_not_found");
  return {
    source_report_file_id: sourceReportFileId,
    report_file: targetFile,
    change_review_required: request.mode === "new_assignment_template",
  };
}

function sourceOrganizationScope(organizationId) {
  if (!organizationId) return null;
  return {
    userId: null,
    platformAdministrator: false,
    organizationIds: [organizationId],
    customOrganizationWideReadIds: [organizationId],
    uadOrganizationWideReadIds: [organizationId],
  };
}
