import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { safeOperationalErrorCode } from "../../security/safeOperationalErrorCode.js";
import {
  createReportFile,
  listReportFiles,
} from "../mobile/reportFiles.js";

const REPORT_FILE_NOT_FOUND = new Set([
  "account_not_found",
  "previous_report_file_not_found",
  "report_file_not_found",
  "mobile_device_not_found",
  "subject_account_not_found",
  "custom_appraisal_file_not_found",
  "uad_workfile_not_found",
  "appraisal_report_file_not_found",
]);
const REPORT_FILE_ACCESS_DENIED = new Set([
  "organization_access_denied",
  "organization_write_access_denied",
]);
const REPORT_FILE_CONFLICT = new Set(["creation_request_conflict"]);
const REPORT_FILE_BAD_REQUEST = new Set([
  "invalid_account_id",
  "invalid_workflow_type",
  "invalid_organization_id",
  "invalid_client_request_id",
  "invalid_previous_report_file_id",
  "invalid_effective_date",
  "invalid_assignment_date",
  "invalid_calendar_year",
  "invalid_sequence_number",
  "invalid_file_number",
  "invalid_uad_file_number",
  "invalid_uad_workfile_id",
  "invalid_appraisal_workflow",
  "organization_required",
  "uad_account_scope_required",
  "same_assignment_confirmation_required",
]);

function reportFileErrorMessage(error) {
  try {
    const message = error?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

function desktopReportFileErrorDetails(error) {
  const message = reportFileErrorMessage(error);
  if (REPORT_FILE_NOT_FOUND.has(message)) return { status: 404, message };
  if (REPORT_FILE_ACCESS_DENIED.has(message)) return { status: 403, message };
  if (REPORT_FILE_CONFLICT.has(message)) return { status: 409, message };
  if (safeOperationalErrorCode(error) === "23505") {
    return { status: 409, message: "creation_request_conflict" };
  }
  if (REPORT_FILE_BAD_REQUEST.has(message)) return { status: 400, message };
  return { status: 500, message: "" };
}

function logUnexpectedReportFileFailure(logger, label, error) {
  try { logger.error?.(label, safeOperationalErrorCode(error)); } catch { /* Preserve the fixed response. */ }
}

export function desktopReportFileErrorStatus(error) {
  return desktopReportFileErrorDetails(error).status;
}

export function createDesktopReportFilesRouter({
  pool,
  requireWorkflowAccess,
  resolveAccountId = resolveCanonicalAccountId,
  listFiles = listReportFiles,
  createFile = createReportFile,
  logger = console,
} = {}) {
  if (
    !pool
    || typeof pool.query !== "function"
    || typeof pool.connect !== "function"
  ) {
    throw new TypeError("desktop_report_files_pool_required");
  }
  if (typeof requireWorkflowAccess !== "function") {
    throw new TypeError("desktop_report_files_workflow_policy_required");
  }
  if (typeof resolveAccountId !== "function") {
    throw new TypeError("desktop_report_files_resolver_required");
  }
  if (typeof listFiles !== "function") {
    throw new TypeError("desktop_report_files_list_service_required");
  }
  if (typeof createFile !== "function") {
    throw new TypeError("desktop_report_files_create_service_required");
  }

  const router = express.Router();

  /** List one workflow's resumable report files before opening its editor. */
  router.get("/api/accounts/:id/report-files", async (req, res) => {
    const workflowType = String(req.query.workflow_type || "").trim();
    if (!requireWorkflowAccess(req, res, workflowType, "read")) return undefined;
    if (!req.mobileAuth) {
      return res.status(401).json({ error: "authentication_required" });
    }
    try {
      const canonicalId = await resolveAccountId(pool, req.params.id);
      const result = await listFiles(pool, req.mobileAuth, {
        accountId: canonicalId,
        workflowType,
        recentDays: 365,
      });
      return res.json({
        account_id: result.accountId,
        workflow_type: result.workflowType,
        files: result.files,
        recommended_file: result.recommended,
        requires_creation: result.requiresCreation,
      });
    } catch (error) {
      const { status, message } = desktopReportFileErrorDetails(error);
      if (status === 500) logUnexpectedReportFileFailure(logger, "desktop report file list failed", error);
      return res.status(status).json({
        error: status === 500 ? "report_file_list_failed" : message,
      });
    }
  });

  /** Atomically create the canonical assignment before navigating to its editor. */
  router.post("/api/accounts/:id/report-files", async (req, res) => {
    const workflowType = String(req.body?.workflow_type || "").trim();
    if (!requireWorkflowAccess(req, res, workflowType, "write")) return undefined;
    if (!req.mobileAuth) {
      return res.status(401).json({ error: "authentication_required" });
    }
    try {
      const canonicalId = await resolveAccountId(pool, req.params.id);
      const result = await createFile(pool, req.mobileAuth, {
        ...req.body,
        account_id: canonicalId,
        workflow_type: workflowType,
      });
      return res.status(result.created ? 201 : 200).json({
        report_file: result.reportFile,
        created: result.created,
      });
    } catch (error) {
      const { status, message } = desktopReportFileErrorDetails(error);
      if (status === 500) logUnexpectedReportFileFailure(logger, "desktop report file create failed", error);
      return res.status(status).json({
        error: status === 500 ? "report_file_create_failed" : message,
      });
    }
  });

  return router;
}
