import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import {
  createReportFile,
  listReportFiles,
} from "../mobile/reportFiles.js";

export function desktopReportFileErrorStatus(error) {
  const message = String(error?.message || "");
  if (message.endsWith("_not_found")) return 404;
  if (message.endsWith("_access_denied")) return 403;
  if (message.endsWith("_conflict") || error?.code === "23505") return 409;
  if (message.startsWith("invalid_") || message.endsWith("_required")) return 400;
  return 500;
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
      const status = desktopReportFileErrorStatus(error);
      if (status === 500) logger.error?.("desktop report file list failed", error);
      return res.status(status).json({
        error: status === 500 ? "report_file_list_failed" : String(error.message),
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
      const status = desktopReportFileErrorStatus(error);
      if (status === 500) logger.error?.("desktop report file create failed", error);
      return res.status(status).json({
        error: status === 500 ? "report_file_create_failed" : String(error.message),
      });
    }
  });

  return router;
}
