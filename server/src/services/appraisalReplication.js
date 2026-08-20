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
} from "./appraisalHistory.js";
import { normalizeAssignmentFileNumber } from "./assignmentFiles.js";

function baseReplicationFileNumber(sourceFileNumber, targetWorkflow) {
  const suffix = targetWorkflow === "custom_appraisal" ? "CUSTOM" : "UAD";
  const base = String(sourceFileNumber || "APPRAISAL")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 88) || "APPRAISAL";
  return `${base}-${suffix}`.slice(0, 100);
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
  fileNumber,
  sourceReportFile,
  mode,
}) {
  const assignmentDetails = {};
  const inserted = await client.query(
    `INSERT INTO app.assignment_files (
       account_id, file_number, assignment_details, inherited_from_file_id, reviewer
     ) VALUES ($1, $2, $3::jsonb, $4, 'HomeNode replication')
     RETURNING id`,
    [
      accountId,
      fileNumber,
      JSON.stringify(assignmentDetails),
      mode === "same_assignment_alternate"
        ? sourceReportFile.custom_assignment_file_id || null
        : null,
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
}) {
  const workfile = await createUadWorkfileWithClient(client, accountId, {
    organization_id: organizationId || null,
    file_number: fileNumber,
    assignment_purpose: sourceReportFile.assignment_purpose || "Mortgage finance appraisal",
  });
  return { uadWorkfileId: workfile.id, fileNumber: workfile.file_number };
}

export async function replicateAppraisalFile(pool, {
  accountId: accountIdValue,
  sourceReportFileId: sourceReportFileIdValue,
  input = {},
}) {
  const accountId = String(accountIdValue || "").trim();
  if (!accountId || accountId.length > 100) throw new Error("invalid_account_id");
  const sourceReportFileId = normalizeAppraisalReportFileId(sourceReportFileIdValue);
  const request = normalizeReplicationRequest(input);
  const client = await pool.connect();
  let targetReportFileId;
  try {
    await client.query("BEGIN");
    const sourceResult = await client.query(
      `SELECT report_file.*, uad_workfile.assignment_purpose
         FROM app.report_files report_file
         LEFT JOIN appraisal.uad_workfiles uad_workfile
           ON uad_workfile.id = report_file.uad_workfile_id
        WHERE report_file.id = $1
          AND report_file.account_id = $2
          AND report_file.workflow_type IN ('custom_appraisal', 'uad_3_6')
        FOR UPDATE OF report_file`,
      [sourceReportFileId, accountId],
    );
    if (!sourceResult.rows.length) throw new Error("appraisal_report_file_not_found");
    const source = sourceResult.rows[0];
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
      if (
        request.effectiveDate
        && sourceCase.effective_date
        && String(sourceCase.effective_date).slice(0, 10) !== request.effectiveDate
      ) {
        throw new Error("same_assignment_effective_date_conflict");
      }
      if (
        request.inspectionDate
        && sourceCase.inspection_date
        && String(sourceCase.inspection_date).slice(0, 10) !== request.inspectionDate
      ) {
        throw new Error("same_assignment_inspection_date_conflict");
      }
    }
    const sourceSnapshot = await captureAppraisalSubjectSnapshot(client, source.id, {
      effectiveDate: request.effectiveDate,
      inspectionDate: request.inspectionDate,
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
        fileNumber: fileAllocation.fileNumber,
        sourceReportFile: source,
        mode: request.mode,
      })
      : await insertUadTarget(client, {
        accountId,
        organizationId: source.organization_id,
        fileNumber: fileAllocation.fileNumber,
        sourceReportFile: source,
      });

    await client.query(
      `UPDATE app.report_files
          SET is_current = false, updated_at = now()
        WHERE account_id = $1
          AND workflow_type = $2
          AND is_current = true`,
      [accountId, request.targetWorkflow],
    );
    targetReportFileId = randomUUID();
    await client.query(
      `INSERT INTO app.report_files (
         id, organization_id, account_id, workflow_type, file_number, sequence_number,
         previous_report_file_id, custom_assignment_file_id, uad_workfile_id,
         is_current, registry_revision, replication_mode
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, 1, $10)`,
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
         change_review_required, attestation
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
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
          effective_date: request.effectiveDate,
          inspection_date: request.inspectionDate,
          mutable_subject_data_copied_to_target: false,
          source_snapshot_available_for_review: true,
        }),
      ],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, event_type, next_registry_revision, metadata
       ) VALUES ($1, 'report_file.replicated', 1, $2::jsonb)`,
      [targetReportFileId, JSON.stringify({
        source_report_file_id: source.id,
        source_snapshot_id: sourceSnapshot.id,
        replication_mode: request.mode,
        appraisal_case_id: targetCaseId,
        subject_snapshot_id: targetSnapshotId,
      })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const history = await listPreviousAppraisalFiles(pool, accountId);
  const targetFile = history.files.find((file) => file.id === targetReportFileId);
  if (!targetFile) throw new Error("replicated_report_file_not_found");
  return {
    source_report_file_id: sourceReportFileId,
    report_file: targetFile,
    change_review_required: request.mode === "new_assignment_template",
  };
}
