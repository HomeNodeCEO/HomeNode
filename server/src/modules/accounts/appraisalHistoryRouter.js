import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { loadSharedAppraisalCompletion } from "../../services/appraisalCompletionAdapter.js";
import { listPreviousAppraisalFiles } from "../../services/appraisalHistory.js";
import { replicateAppraisalFile } from "../../services/appraisalReplication.js";
import { hasApplicationPermission } from "../../security/applicationAccess.js";
import {
  authorizeAppraisalReportFile,
  buildAppraisalHistoryAccessScope,
} from "../../security/appraisalHistoryAccess.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;

export function createAppraisalHistoryRouter({
  pool,
  requireWorkflowAccess,
  requireEditor,
  authenticationRequired,
  resolveAccountId = resolveCanonicalAccountId,
  buildAccessScope = buildAppraisalHistoryAccessScope,
  authorizeReportFile = authorizeAppraisalReportFile,
  hasPermission = hasApplicationPermission,
  listHistory = listPreviousAppraisalFiles,
  loadCompletion = loadSharedAppraisalCompletion,
  replicateFile = replicateAppraisalFile,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("appraisal_history_pool_required");
  }
  if (typeof requireWorkflowAccess !== "function") {
    throw new TypeError("appraisal_history_workflow_policy_required");
  }
  if (typeof requireEditor !== "function") {
    throw new TypeError("appraisal_history_editor_policy_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("appraisal_history_authentication_mode_required");
  }
  if (typeof resolveAccountId !== "function") {
    throw new TypeError("appraisal_history_resolver_required");
  }
  if (typeof buildAccessScope !== "function" || typeof authorizeReportFile !== "function") {
    throw new TypeError("appraisal_history_access_policy_required");
  }
  if (typeof hasPermission !== "function") {
    throw new TypeError("appraisal_history_permission_policy_required");
  }
  if (
    typeof listHistory !== "function"
    || typeof loadCompletion !== "function"
    || typeof replicateFile !== "function"
  ) {
    throw new TypeError("appraisal_history_service_required");
  }

  const router = express.Router();

  // Saved snapshots remain private even when their contents are immutable.
  // Apply before guards so routed successes, denials, and errors share the policy.
  router.use("/api/accounts/:id/appraisal-history", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  /** List Custom and UAD appraisal history without treating prior observations as current facts. */
  router.get("/api/accounts/:id/appraisal-history", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return undefined;
    const requestedId = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    try {
      const canonicalId = await resolveAccountId(pool, requestedId);
      const schema = await pool.query(
        "SELECT to_regclass('app.appraisal_cases') AS table_name",
      );
      if (!schema.rows[0]?.table_name) {
        return res.status(503).json({ error: "appraisal_history_schema_unavailable" });
      }
      const accessScope = buildAccessScope(req.mobileAuth);
      return res.json(await listHistory(pool, canonicalId, accessScope));
    } catch (error) {
      if (String(error?.message || "").startsWith("invalid_")) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("appraisal history list failed", error);
      return res.status(500).json({ error: "appraisal_history_list_failed" });
    }
  });

  /** Load the workflow-neutral completion document anchored to one immutable subject snapshot. */
  router.get("/api/accounts/:id/appraisal-history/:reportFileId/completion", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return undefined;
    const requestedId = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    try {
      const canonicalId = await resolveAccountId(pool, requestedId);
      await authorizeReportFile(pool, req.mobileAuth, {
        accountId: canonicalId,
        reportFileId: req.params.reportFileId,
        permission: "read",
      });
      const completion = await loadCompletion(pool, {
        accountId: canonicalId,
        reportFileId: req.params.reportFileId,
      });
      return res.json({ ok: true, account_id: canonicalId, completion });
    } catch (error) {
      const message = String(error?.message || "");
      if (message === "appraisal_report_file_access_denied") {
        return res.status(403).json({ error: message });
      }
      if (message.endsWith("_not_found")) return res.status(404).json({ error: message });
      if (message.startsWith("invalid_")) return res.status(400).json({ error: message });
      if (
        message === "appraisal_subject_snapshot_required"
        || message === "shared_appraisal_completion_source_not_found"
      ) {
        return res.status(409).json({ error: message });
      }
      logger.error?.("shared appraisal completion load failed", error);
      return res.status(500).json({ error: "shared_appraisal_completion_load_failed" });
    }
  });

  /** Create either an alternate report for the same assignment or a clean new appraisal template. */
  router.post("/api/accounts/:id/appraisal-history/:reportFileId/replicate", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
    try {
      const canonicalId = await resolveAccountId(pool, requestedId);
      const sourceAccess = await authorizeReportFile(pool, req.mobileAuth, {
        accountId: canonicalId,
        reportFileId: req.params.reportFileId,
        permission: "write",
      });
      const targetWorkflow = String(req.body?.target_workflow_type || "").trim();
      if (
        ["custom_appraisal", "uad_3_6"].includes(targetWorkflow)
        && !hasPermission(
          req.mobileAuth,
          targetWorkflow,
          "write",
          sourceAccess.organization_id,
        )
      ) {
        return res.status(403).json({ error: "appraisal_replication_access_denied" });
      }
      const result = await replicateFile(pool, {
        accountId: canonicalId,
        sourceReportFileId: req.params.reportFileId,
        input: req.body || {},
        actorUserId: req.mobileAuth?.userId || null,
        organizationId: sourceAccess?.organization_id || null,
      });
      return res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const message = String(error?.message || "");
      if (message === "appraisal_report_file_access_denied") {
        return res.status(403).json({ error: message });
      }
      if (message.endsWith("_not_found")) return res.status(404).json({ error: message });
      if (
        message.startsWith("invalid_")
        || message === "same_assignment_confirmation_required"
        || message === "same_assignment_requires_alternate_workflow"
      ) {
        return res.status(400).json({ error: message });
      }
      if (message.endsWith("_conflict") || error?.code === "23505") {
        return res.status(409).json({ error: message || "appraisal_replication_conflict" });
      }
      logger.error?.("appraisal file replication failed", error);
      return res.status(500).json({ error: "appraisal_file_replication_failed" });
    }
  });

  return router;
}
