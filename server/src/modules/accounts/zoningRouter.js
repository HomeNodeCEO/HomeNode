import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  getPropertyZoningEvidence,
  getZoningDocumentContent,
  getZoningDocumentDescriptionSuggestion,
  savePropertyZoningVerification,
} from "../../services/zoningEvidence.js";

export function createZoningRouter({
  pool,
  ensureAvailable,
  requireWorkflowAccess,
  requireAssignmentAccess,
  authenticationRequired,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  getEvidence = getPropertyZoningEvidence,
  getDocumentContent = getZoningDocumentContent,
  getDescriptionSuggestion = getZoningDocumentDescriptionSuggestion,
  saveVerification = savePropertyZoningVerification,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("zoning_pool_required");
  }
  const dependencies = [
    ensureAvailable,
    requireWorkflowAccess,
    requireAssignmentAccess,
    resolveAccountId,
    normalizeFileId,
    getEvidence,
    getDocumentContent,
    getDescriptionSuggestion,
    saveVerification,
  ];
  if (dependencies.some((dependency) => typeof dependency !== "function")
      || typeof authenticationRequired !== "boolean") {
    throw new TypeError("zoning_dependency_required");
  }

  const router = express.Router();

  /** Load official zoning evidence and the subject jurisdiction's review contact. */
  router.get("/api/accounts/:id/zoning-evidence", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      await ensureAvailable();
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.query.assignment_file_id);
      const evidence = await getEvidence(pool, { accountId, assignmentFileId });
      return res.json({ ok: true, account_id: accountId, evidence });
    } catch (error) {
      const message = error?.message || "zoning_evidence_lookup_failed";
      return res.status(message === "account_not_found" ? 404 : 500).json({ error: message });
    }
  });

  /** Stream the immutable cached PDF inline; old versions remain auditable. */
  router.get("/api/zoning-source-documents/:id/content", async (req, res) => {
    const documentId = Number(req.params.id);
    if (!Number.isInteger(documentId) || documentId < 1) {
      return res.status(400).json({ error: "invalid_zoning_document_id" });
    }
    try {
      await ensureAvailable();
      const document = await getDocumentContent(pool, documentId);
      if (!document) return res.status(404).json({ error: "zoning_document_not_found" });
      res.set({
        "Content-Type": document.content_type || "application/pdf",
        "Content-Disposition": `inline; filename="zoning-evidence-${document.id}.pdf"`,
        ETag: `"${document.checksum_sha256}"`,
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      return res.send(document.content);
    } catch (error) {
      logger.error?.("zoning document stream failed", error);
      return res.status(500).json({ error: "zoning_document_stream_failed" });
    }
  });

  /** Suggest the verbatim district wording beside a confirmed zoning code. */
  router.get("/api/zoning-source-documents/:id/description-suggestion", async (req, res) => {
    try {
      await ensureAvailable();
      const result = await getDescriptionSuggestion(pool, {
        documentId: req.params.id,
        zoningCode: String(req.query.zoning_code || "").trim(),
      });
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error?.message || "zoning_description_suggestion_failed";
      const status = message === "zoning_document_not_found"
        ? 404
        : message === "invalid_zoning_document_id" ? 400 : 500;
      return res.status(status).json({ error: message });
    }
  });

  /** Save an appraiser-confirmed zoning result with its source and reviewer. */
  router.put("/api/accounts/:id/zoning-verification", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "write")) return;
    try {
      await ensureAvailable();
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      if (!assignmentFileId) {
        return res.status(400).json({ error: "assignment_file_required" });
      }
      if (!await requireAssignmentAccess(req, res, accountId, assignmentFileId, "write")) {
        return;
      }
      const verification = await saveVerification(pool, {
        accountId,
        assignmentFileId,
        input: req.body,
      });
      return res.json({ ok: true, account_id: accountId, verification });
    } catch (error) {
      const message = error?.message || "zoning_verification_failed";
      const clientErrors = new Set([
        "invalid_zoning_jurisdiction",
        "zoning_code_required",
        "zoning_description_required",
        "zoning_reviewer_required",
        "invalid_zoning_source_type",
        "invalid_zoning_source_document",
      ]);
      return res.status(clientErrors.has(message) ? 400 : 500).json({ error: message });
    }
  });

  return router;
}
