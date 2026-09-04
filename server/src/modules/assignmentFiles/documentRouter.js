import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  confirmAssignmentDocumentCandidates,
  confirmAssignmentDocumentDespiteSubjectMismatch,
  createAssignmentDocument,
  deleteAssignmentDocument,
  getAssignmentDocument,
  listAssignmentDocuments,
  MAX_ASSIGNMENT_DOCUMENT_BYTES,
  processAssignmentDocument,
  reviewAssignmentDocumentCandidate,
} from "../../services/assignmentDocuments.js";
import { decideAssignmentAccess } from "../../security/assignmentAccess.js";

function decodedDocumentHeader(req, name, fallback = "") {
  const value = String(req.get(name) || fallback);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function createAssignmentDocumentRouter({
  pool,
  objectStorage,
  ensureAvailable,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess,
  authenticationRequired,
  ocrProvider,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  decideAccess = decideAssignmentAccess,
  listDocuments = listAssignmentDocuments,
  createDocument = createAssignmentDocument,
  getDocument = getAssignmentDocument,
  deleteDocument = deleteAssignmentDocument,
  processDocument = processAssignmentDocument,
  confirmDespiteMismatch = confirmAssignmentDocumentDespiteSubjectMismatch,
  confirmCandidates = confirmAssignmentDocumentCandidates,
  reviewCandidate = reviewAssignmentDocumentCandidate,
  maxDocumentBytes = MAX_ASSIGNMENT_DOCUMENT_BYTES,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("assignment_document_router_pool_required");
  }
  if (!objectStorage || typeof objectStorage !== "object") {
    throw new TypeError("assignment_document_router_storage_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("assignment_document_router_authentication_mode_required");
  }
  if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes < 1) {
    throw new TypeError("assignment_document_router_limit_required");
  }
  const dependencies = [
    ensureAvailable,
    requireWorkflowAccess,
    requireEditor,
    requireAssignmentAccess,
    resolveAccountId,
    normalizeFileId,
    decideAccess,
    listDocuments,
    createDocument,
    getDocument,
    deleteDocument,
    processDocument,
    confirmDespiteMismatch,
    confirmCandidates,
    reviewCandidate,
  ];
  if (dependencies.some((dependency) => typeof dependency !== "function")) {
    throw new TypeError("assignment_document_router_dependency_required");
  }

  const router = express.Router();

  async function requireDocumentAccess(req, res, documentIdValue, permission) {
    if (!authenticationRequired) return true;
    if (!req.mobileAuth) {
      res.set("cache-control", "no-store").status(401).json({ error: "authentication_required" });
      return false;
    }
    const documentId = Number(documentIdValue);
    if (!Number.isSafeInteger(documentId) || documentId < 1) {
      res.status(400).json({ error: "invalid_document_id" });
      return false;
    }
    const { rows } = await pool.query(
      `SELECT document.id, document.assignment_file_id,
              assignment.account_id, assignment.organization_id,
              assignment.assigned_appraiser_user_id, assignment.supervisory_appraiser_user_id
         FROM app.assignment_documents document
         LEFT JOIN app.assignment_files assignment ON assignment.id = document.assignment_file_id
        WHERE document.id = $1`,
      [documentId],
    );
    if (!rows.length) {
      res.status(404).json({ error: "document_not_found" });
      return false;
    }
    if (!rows[0].assignment_file_id
        || !decideAccess(req.mobileAuth, rows[0], permission)) {
      res.set("cache-control", "no-store")
        .status(403)
        .json({ error: "assignment_document_access_denied" });
      return false;
    }
    return true;
  }

  function authenticatedReviewer(req) {
    if (!req.mobileAuth) return req.body?.reviewer;
    return req.mobileAuth.displayName || req.mobileAuth.email || req.mobileAuth.userId;
  }

  /** List assignment PDFs and their machine-review status for a property file. */
  router.get("/api/accounts/:id/documents", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return;
    try {
      await ensureAvailable();
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.query.assignment_file_id);
      if (authenticationRequired && req.mobileAuth && !assignmentFileId) {
        return res.status(400).json({ error: "assignment_file_required" });
      }
      if (assignmentFileId
          && !await requireAssignmentAccess(req, res, accountId, assignmentFileId, "read")) return;
      const documents = await listDocuments(pool, {
        accountId,
        assignmentFileId,
        includePropertyEvidence: !(authenticationRequired && req.mobileAuth),
      });
      return res.json({ ok: true, account_id: accountId, documents });
    } catch (error) {
      const message = error?.message || "assignment_documents_lookup_failed";
      return res.status(message === "account_not_found" ? 404 : 500).json({ error: message });
    }
  });

  /** Upload PDF bytes and schedule durable asynchronous extraction. */
  router.post(
    "/api/accounts/:id/documents",
    express.raw({
      type: ["application/pdf", "application/octet-stream"],
      limit: maxDocumentBytes,
    }),
    async (req, res) => {
      const requestedId = String(req.params.id || "").trim();
      if (!requireEditor(req, res)) return;
      try {
        await ensureAvailable();
        const accountId = await resolveAccountId(pool, requestedId);
        const assignmentFileId = normalizeFileId(req.get("x-assignment-file-id"));
        if (authenticationRequired && req.mobileAuth && !assignmentFileId) {
          return res.status(400).json({ error: "assignment_file_required" });
        }
        let documentOrganizationId = null;
        if (assignmentFileId) {
          const { rows } = await pool.query(
            "SELECT organization_id FROM app.assignment_files WHERE id = $1 AND account_id = $2",
            [assignmentFileId, accountId],
          );
          if (!rows.length) return res.status(400).json({ error: "invalid_assignment_file" });
          if (!await requireAssignmentAccess(
            req,
            res,
            accountId,
            assignmentFileId,
            "write",
          )) return;
          documentOrganizationId = rows[0].organization_id || null;
        }
        const document = await createDocument(pool, {
          organizationId: documentOrganizationId,
          accountId,
          assignmentFileId,
          documentType: decodedDocumentHeader(req, "x-document-type", "other"),
          title: decodedDocumentHeader(req, "x-document-title"),
          fileName: decodedDocumentHeader(req, "x-document-file-name", "document.pdf"),
          contentType: req.get("content-type"),
          content: req.body,
          uploadedBy: decodedDocumentHeader(req, "x-document-uploaded-by"),
          storage: objectStorage,
        });
        if (document.processing_status === "uploaded") {
          void processDocument(pool, document.id, { storage: objectStorage }).catch((error) => {
            if (error?.message !== "document_processing_in_progress") {
              logger.warn?.("[documents] background extraction failed", error?.message || error);
            }
          });
        }
        return res.status(201).json({ ok: true, account_id: accountId, document });
      } catch (error) {
        const message = error?.message || "assignment_document_upload_failed";
        const clientErrors = new Set([
          "document_content_required",
          "document_too_large",
          "document_not_pdf",
          "invalid_document_type",
        ]);
        return res.status(clientErrors.has(message) ? 400 : 500).json({ error: message });
      }
    },
  );

  /** Load a document plus page-cited field candidates. */
  router.get("/api/documents/:id", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return;
    try {
      await ensureAvailable();
      if (!await requireDocumentAccess(req, res, req.params.id, "read")) return;
      const document = await getDocument(pool, req.params.id);
      if (!document) return res.status(404).json({ error: "document_not_found" });
      return res.json({ ok: true, document });
    } catch (error) {
      logger.error?.("assignment document lookup failed", error);
      return res.status(500).json({ error: "assignment_document_lookup_failed" });
    }
  });

  /** Stream immutable uploaded source bytes inline for the embedded PDF viewer. */
  router.get("/api/documents/:id/content", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return;
    try {
      await ensureAvailable();
      if (!await requireDocumentAccess(req, res, req.params.id, "read")) return;
      const document = await getDocument(pool, req.params.id, {
        includeContent: true,
        storage: objectStorage,
      });
      if (!document) return res.status(404).json({ error: "document_not_found" });
      const fileName = String(document.file_name || `document-${document.id}.pdf`)
        .replace(/[\r\n"]/g, "_");
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"`,
        ETag: `"${document.checksum_sha256}"`,
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      return res.send(document.content);
    } catch (error) {
      logger.error?.("assignment document stream failed", error);
      return res.status(500).json({ error: "assignment_document_stream_failed" });
    }
  });

  /** Permanently remove an assignment PDF and its extracted private evidence. */
  router.delete("/api/documents/:id", async (req, res) => {
    if (!requireEditor(req, res)) return;
    try {
      await ensureAvailable();
      if (!await requireDocumentAccess(req, res, req.params.id, "write")) return;
      const result = await deleteDocument(pool, objectStorage, req.params.id);
      res.set("cache-control", "no-store");
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error?.message || "assignment_document_delete_failed";
      if (message === "document_not_found") return res.status(404).json({ error: message });
      if (message === "invalid_document_id") return res.status(400).json({ error: message });
      if (message === "assignment_document_storage_not_configured") {
        return res.status(503).json({ error: message });
      }
      logger.error?.("assignment document delete failed", error);
      return res.status(500).json({ error: "assignment_document_delete_failed" });
    }
  });

  /** Retry text extraction after a worker interruption or parser improvement. */
  router.post("/api/documents/:id/reprocess", async (req, res) => {
    if (!requireEditor(req, res)) return;
    try {
      await ensureAvailable();
      if (!await requireDocumentAccess(req, res, req.params.id, "write")) return;
      const document = await processDocument(pool, req.params.id, {
        force: true,
        storage: objectStorage,
        ocrProvider,
      });
      return res.json({ ok: true, document });
    } catch (error) {
      const message = error?.message || "assignment_document_reprocess_failed";
      const clientErrors = new Set([
        "invalid_document_id",
        "document_processing_in_progress",
        "document_retry_not_due",
        "document_not_processable",
      ]);
      return res.status(
        message === "document_not_found" ? 404 : clientErrors.has(message) ? 409 : 500,
      ).json({ error: message });
    }
  });

  /** Record a subject mismatch override and confirm visible engagement suggestions. */
  router.post("/api/documents/:id/subject-address-override", async (req, res) => {
    if (!requireEditor(req, res)) return;
    try {
      await ensureAvailable();
      if (!await requireDocumentAccess(req, res, req.params.id, "sign")) return;
      const result = await confirmDespiteMismatch(pool, {
        documentId: req.params.id,
        reviewer: authenticatedReviewer(req),
        actorUserId: req.mobileAuth?.userId || null,
        reportSubjectAddress: req.body?.report_subject_address,
        candidateValues: req.body?.candidate_values,
      });
      const document = await getDocument(pool, result.document_id);
      return res.json({
        ok: true,
        document,
        override: result.subject_address_override,
        assignment_application: result.assignment_application,
      });
    } catch (error) {
      const message = error?.message || "document_subject_address_override_failed";
      const clientErrors = new Set([
        "invalid_document_id",
        "document_reviewer_required",
        "report_subject_address_required",
        "engagement_letter_required",
        "document_subject_address_candidate_required",
      ]);
      return res.status(
        message === "document_not_found" ? 404 : clientErrors.has(message) ? 400 : 500,
      ).json({ error: message });
    }
  });

  /** Confirm every visible machine suggestion in one audited document review. */
  router.post("/api/documents/:id/confirm-all", async (req, res) => {
    if (!requireEditor(req, res)) return;
    try {
      await ensureAvailable();
      if (!await requireDocumentAccess(req, res, req.params.id, "write")) return;
      const result = await confirmCandidates(pool, {
        documentId: req.params.id,
        reviewer: req.body?.reviewer,
        reportSubjectAddress: req.body?.report_subject_address,
        candidateValues: req.body?.candidate_values,
      });
      const document = await getDocument(pool, result.document_id);
      return res.json({
        ok: true,
        document,
        assignment_application: result.assignment_application,
      });
    } catch (error) {
      const message = error?.message || "document_candidates_confirm_all_failed";
      const clientErrors = new Set([
        "invalid_document_id",
        "document_reviewer_required",
        "report_subject_address_required",
      ]);
      if (message === "document_not_found") return res.status(404).json({ error: message });
      if (message === "document_subject_address_mismatch") {
        return res.status(409).json({ error: message });
      }
      return res.status(clientErrors.has(message) ? 400 : 500).json({ error: message });
    }
  });

  /** Confirm or reject one machine suggestion without mutating the source PDF. */
  router.patch("/api/documents/:documentId/candidates/:candidateId", async (req, res) => {
    if (!requireEditor(req, res)) return;
    try {
      await ensureAvailable();
      if (!await requireDocumentAccess(req, res, req.params.documentId, "write")) return;
      const candidate = await reviewCandidate(pool, {
        documentId: req.params.documentId,
        candidateId: req.params.candidateId,
        reviewStatus: req.body?.review_status,
        confirmedValue: req.body?.confirmed_value,
        reviewer: req.body?.reviewer,
      });
      return res.json({ ok: true, candidate });
    } catch (error) {
      const message = error?.message || "document_candidate_review_failed";
      const clientErrors = new Set([
        "invalid_document_candidate",
        "invalid_document_review_status",
        "document_reviewer_required",
        "document_candidate_not_found",
      ]);
      return res.status(clientErrors.has(message) ? 400 : 500).json({ error: message });
    }
  });

  return router;
}
