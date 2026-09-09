import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import { getCustomAppraisalReportPdf } from "../../services/customAppraisalReportPdf.js";
import { loadCustomNeighborhoodAcceptance } from "../../services/neighborhoodAssessment/customAcceptanceRead.js";
import {
  getCustomAppraisalWorkfile,
  getCustomAppraisalWorkfileDownload,
  getCustomAppraisalWorkfileReadiness,
} from "../../services/customAppraisalWorkfiles.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;
const CUSTOM_APPRAISAL_WORKFLOW = "custom_appraisal";

function requestedAccountId(req, res) {
  const value = String(req.params.id || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    res.status(400).json({ error: "invalid_account_id" });
    return null;
  }
  return value;
}

export function createAssignmentWorkfileReadRouter({
  pool,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  requireAssignmentAccess,
  objectStorage,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  getWorkfile = getCustomAppraisalWorkfile,
  getReadiness = getCustomAppraisalWorkfileReadiness,
  getDownload = getCustomAppraisalWorkfileDownload,
  getReportPdf = getCustomAppraisalReportPdf,
  getNeighborhood = loadCustomNeighborhoodAcceptance,
  getSigningSecret = () => process.env.APP_SIGNING_SECRET,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("assignment_workfile_read_pool_required");
  }
  if (typeof ensureCustomAppraisalWorkfilesAvailable !== "function") {
    throw new TypeError("assignment_workfile_read_schema_readiness_required");
  }
  if (
    typeof requireWorkflowAccess !== "function"
    || typeof requireAssignmentAccess !== "function"
  ) {
    throw new TypeError("assignment_workfile_read_access_policy_required");
  }
  if (
    typeof resolveAccountId !== "function"
    || typeof normalizeFileId !== "function"
    || typeof getWorkfile !== "function"
    || typeof getReadiness !== "function"
    || typeof getDownload !== "function"
    || typeof getReportPdf !== "function"
    || typeof getNeighborhood !== "function"
    || typeof getSigningSecret !== "function"
  ) {
    throw new TypeError("assignment_workfile_read_dependency_required");
  }

  const router = express.Router();

  // Signed bytes are immutable, but permission to retrieve them is revocable.
  // Scope this policy to workfiles so unrelated public routes retain their cache policy.
  router.use("/api/accounts/:id/assignment-files/:fileId/workfile", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  /** Reopen the exact accepted editor group without modifying signed/download responses. */
  router.get("/api/accounts/:id/assignment-files/:fileId/workfile/neighborhood", async (req, res) => {
    if (!req.mobileAuth?.userId) return res.status(401).json({ error: "authentication_required" });
    if (!requireWorkflowAccess(req, res, CUSTOM_APPRAISAL_WORKFLOW, "read")) return undefined;
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    try {
      const assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
      await ensureCustomAppraisalWorkfilesAvailable();
      const canonicalId = await resolveAccountId(pool, accountId);
      if (!await requireAssignmentAccess(req, res, canonicalId, assignmentFileId, "read")) return undefined;
      const neighborhood = await getNeighborhood(pool, { accountId: canonicalId, assignmentFileId, auth: req.mobileAuth });
      return res.json({ ok: true, account_id: canonicalId, neighborhood });
    } catch (error) {
      const message = String(error?.message || "");
      if (message === "assignment_file_not_found") return res.status(404).json({ error: message });
      if (message === "assignment_file_access_denied") return res.status(403).json({ error: message });
      if (message === "authentication_required") return res.status(401).json({ error: message });
      if (["invalid_account_id", "invalid_assignment_file_id", "invalid_custom_neighborhood_read_input"].includes(message)) {
        return res.status(400).json({ error: message });
      }
      if (message === "custom_neighborhood_signed_snapshot_required") return res.status(409).json({ error: message });
      // Corrupt/stale groups must not masquerade as an empty file or fall back to
      // a different analysis. Do not expose stored evidence in error responses.
      if (message.startsWith("custom_neighborhood_acceptance_") || message.startsWith("neighborhood_application_")
        || message.startsWith("invalid_neighborhood_assessment:") || message.startsWith("neighborhood_jsonb_storage_")
        || error instanceof SyntaxError || message === "custom_neighborhood_saved_group_unavailable") {
        logger.error?.("custom neighborhood accepted group unavailable", error);
        return res.status(409).json({ error: "custom_neighborhood_saved_group_unavailable" });
      }
      if (error?.code === "42P01") return res.status(503).json({ error: "custom_neighborhood_storage_unavailable" });
      logger.error?.("custom neighborhood accepted group load failed", error);
      return res.status(500).json({ error: "custom_neighborhood_load_failed" });
    }
  });

  /** Load all database-backed sections for one Custom Appraisal file. */
  router.get("/api/accounts/:id/assignment-files/:fileId/workfile", async (req, res) => {
    if (!requireWorkflowAccess(req, res, CUSTOM_APPRAISAL_WORKFLOW, "read")) return undefined;
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    try {
      const assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
      await ensureCustomAppraisalWorkfilesAvailable();
      const canonicalId = await resolveAccountId(pool, accountId);
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "read",
      )) return undefined;
      const workfile = await getWorkfile(pool, {
        accountId: canonicalId,
        assignmentFileId,
      });
      return res.json({ ok: true, account_id: canonicalId, workfile });
    } catch (error) {
      if (error?.message === "assignment_file_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if (String(error?.message || "").startsWith("invalid_")) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("custom appraisal workfile load failed", error);
      return res.status(500).json({ error: "custom_appraisal_workfile_load_failed" });
    }
  });

  /** Run the authoritative finalization E&O checks without changing the file. */
  router.get("/api/accounts/:id/assignment-files/:fileId/workfile/readiness", async (req, res) => {
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    if (!requireWorkflowAccess(req, res, CUSTOM_APPRAISAL_WORKFLOW, "read")) return undefined;
    try {
      const assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
      await ensureCustomAppraisalWorkfilesAvailable();
      const canonicalId = await resolveAccountId(pool, accountId);
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "read",
      )) return undefined;
      const readiness = await getReadiness(pool, {
        accountId: canonicalId,
        assignmentFileId,
      });
      return res.json({ ok: true, account_id: canonicalId, readiness });
    } catch (error) {
      if (error?.message === "assignment_file_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if (String(error?.message || "").startsWith("invalid_")) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("custom appraisal workfile readiness failed", error);
      return res.status(500).json({ error: "custom_appraisal_workfile_readiness_failed" });
    }
  });

  /** Download the live draft or immutable signed snapshot under its unique name. */
  router.get("/api/accounts/:id/assignment-files/:fileId/workfile/download", async (req, res) => {
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    if (!requireWorkflowAccess(req, res, CUSTOM_APPRAISAL_WORKFLOW, "read")) return undefined;
    try {
      const assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
      await ensureCustomAppraisalWorkfilesAvailable();
      const canonicalId = await resolveAccountId(pool, accountId);
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "read",
      )) return undefined;
      const download = await getDownload(pool, {
        accountId: canonicalId,
        assignmentFileId,
        signingSecret: getSigningSecret(),
      });
      const fileName = String(download.canonical_file_name).replace(/[\r\n"]/g, "_");
      const serialized = `${JSON.stringify(download.snapshot, null, 2)}\n`;
      res.set({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-HomeNode-Immutable": String(download.immutable),
      });
      if (download.checksum_sha256) res.set("ETag", `"${download.checksum_sha256}"`);
      return res.send(serialized);
    } catch (error) {
      if (error?.message === "assignment_file_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if (error?.message === "custom_appraisal_signing_secret_not_configured") {
        return res.status(503).json({ error: error.message });
      }
      logger.error?.("custom appraisal workfile download failed", error);
      return res.status(500).json({ error: "custom_appraisal_workfile_download_failed" });
    }
  });

  /** Generate a fixed-layout draft PDF or return the immutable signed PDF artifact. */
  router.get("/api/accounts/:id/assignment-files/:fileId/workfile/report.pdf", async (req, res) => {
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    if (!requireWorkflowAccess(req, res, CUSTOM_APPRAISAL_WORKFLOW, "read")) return undefined;
    try {
      const assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
      await ensureCustomAppraisalWorkfilesAvailable();
      const canonicalId = await resolveAccountId(pool, accountId);
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "read",
      )) return undefined;
      const download = await getDownload(pool, {
        accountId: canonicalId,
        assignmentFileId,
        signingSecret: getSigningSecret(),
      });
      const report = await getReportPdf(pool, {
        accountId: canonicalId,
        assignmentFileId,
        download,
        objectStorage,
      });
      const fileName = String(report.canonical_file_name).replace(/[\r\n"]/g, "_");
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(report.content.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-HomeNode-Immutable": String(report.immutable),
        "X-HomeNode-Report-Pages": String(report.page_count),
        "ETag": `"${report.content_sha256}"`,
      });
      return res.send(report.content);
    } catch (error) {
      if (error?.message === "assignment_file_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if (error?.message === "custom_appraisal_signing_secret_not_configured") {
        return res.status(503).json({ error: error.message });
      }
      logger.error?.("custom appraisal report PDF failed", error);
      return res.status(500).json({ error: "custom_appraisal_report_pdf_failed" });
    }
  });

  return router;
}
