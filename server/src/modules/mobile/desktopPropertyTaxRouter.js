import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import {
  createAssignmentDocument,
  deleteAssignmentDocument,
  getAssignmentDocument,
  listAssignmentDocuments,
  MAX_ASSIGNMENT_DOCUMENT_BYTES,
  PROPERTY_TAX_DOCUMENT_UPLOAD_QUOTA,
  processAssignmentDocument,
} from "../../services/assignmentDocuments.js";
import { hasApplicationPermission } from "../../security/applicationAccess.js";
import { decideAssignmentAccess } from "../../security/assignmentAccess.js";
import { safeOperationalErrorCode } from "../../security/safeOperationalErrorCode.js";
import {
  getDesktopPropertyTaxEvidenceVersion,
  getDesktopPropertyTaxFile,
  saveDesktopPropertyTaxFile,
} from "./desktopPropertyTax.js";
import { savePropertyTaxInspectionSketch } from "./desktopSketches.js";
import { normalizeSketchReviewStatus } from "./sketches.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;
const WORKFLOW = "property_tax_protest";
const PROPERTY_TAX_FILE_CLIENT_ERRORS = new Set([
  "invalid_account_id",
  "invalid_property_tax_protest_actor",
  "invalid_property_tax_protest_client_operation_id",
  "invalid_property_tax_protest_file_id",
  "invalid_property_tax_protest_revision",
  "invalid_property_tax_protest_update",
  "invalid_property_tax_protest_workfile",
]);
const PROPERTY_TAX_DOCUMENT_CLIENT_ERRORS = new Set([
  "invalid_document_candidate",
  "invalid_document_id",
  "invalid_document_review_status",
  "invalid_document_type",
]);
const PROPERTY_TAX_SKETCH_CLIENT_ERRORS = new Set([
  "invalid_sketch_expected_revision",
  "invalid_sketch_operation_id",
  "invalid_client_sketch_id",
  "invalid_inspection_session_id",
  "invalid_manual_sketch",
  "invalid_mobile_photo_room_label",
  "invalid_mobile_photo_sketch_room",
  "invalid_sketch_alternate_standard",
  "invalid_sketch_area_classification",
  "invalid_sketch_area_id",
  "invalid_sketch_area_label",
  "invalid_sketch_area_notes",
  "invalid_sketch_area_position",
  "invalid_sketch_area",
  "invalid_sketch_areas",
  "invalid_sketch_base_revision",
  "invalid_sketch_deduction_bounds",
  "invalid_sketch_deduction_classification",
  "invalid_sketch_dimension_label",
  "invalid_sketch_dimension_labels",
  "invalid_sketch_dimension_offset",
  "invalid_sketch_dimension_segment",
  "invalid_sketch_document_size",
  "invalid_sketch_gla_classification",
  "invalid_sketch_gla_treatment",
  "invalid_sketch_level_label",
  "invalid_sketch_measurement_method",
  "invalid_sketch_measurement_standard",
  "invalid_sketch_parent_area_id",
  "invalid_sketch_parent_area",
  "invalid_sketch_review_notes",
  "invalid_sketch_review_status",
  "invalid_sketch_room_anchor",
  "invalid_sketch_room_area_id",
  "invalid_sketch_room_area",
  "invalid_sketch_room_id",
  "invalid_sketch_room_label",
  "invalid_sketch_room_position",
  "invalid_sketch_room_type",
  "invalid_sketch_room",
  "invalid_sketch_rooms",
  "duplicate_room_id",
  "duplicate_sketch_area_id",
  "duplicate_sketch_dimension_segment",
  "duplicate_sketch_room_id",
]);

function propertyTaxErrorMessage(error) {
  try {
    const message = error?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

function logPropertyTaxFailure(logger, level, label, error) {
  try { logger[level]?.(label, safeOperationalErrorCode(error)); } catch { /* Preserve the fixed response. */ }
}

export function createDesktopPropertyTaxRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  requireWorkflowAccess,
  requireEditor,
  authenticationRequired,
  ensureDocuments,
  documentStorage = null,
  documentOcrProvider = null,
  resolveAccountId = resolveCanonicalAccountId,
  hasPermission = hasApplicationPermission,
  decideAccess = decideAssignmentAccess,
  getFile = getDesktopPropertyTaxFile,
  getEvidenceVersion = getDesktopPropertyTaxEvidenceVersion,
  saveFile = saveDesktopPropertyTaxFile,
  saveSketch = savePropertyTaxInspectionSketch,
  createDocument = createAssignmentDocument,
  deleteDocument = deleteAssignmentDocument,
  getDocument = getAssignmentDocument,
  listDocuments = listAssignmentDocuments,
  processDocument = processAssignmentDocument,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("desktop_property_tax_pool_required");
  }
  if (!accountQualityReady || typeof accountQualityReady.then !== "function") {
    throw new TypeError("desktop_property_tax_account_readiness_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("desktop_property_tax_enrichment_readiness_required");
  }
  if (typeof requireWorkflowAccess !== "function" || typeof requireEditor !== "function") {
    throw new TypeError("desktop_property_tax_workflow_policy_required");
  }
  if (typeof ensureDocuments !== "function") {
    throw new TypeError("desktop_property_tax_document_readiness_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("desktop_property_tax_authentication_mode_required");
  }
  if (typeof resolveAccountId !== "function") {
    throw new TypeError("desktop_property_tax_resolver_required");
  }
  if (typeof hasPermission !== "function" || typeof decideAccess !== "function") {
    throw new TypeError("desktop_property_tax_access_policy_required");
  }
  if (
    typeof getFile !== "function"
    || typeof getEvidenceVersion !== "function"
    || typeof saveFile !== "function"
    || typeof saveSketch !== "function"
    || typeof createDocument !== "function"
    || typeof deleteDocument !== "function"
    || typeof getDocument !== "function"
    || typeof listDocuments !== "function"
    || typeof processDocument !== "function"
  ) {
    throw new TypeError("desktop_property_tax_service_required");
  }

  const router = express.Router();

  // Workfiles and evidence remain private even when their source bytes are immutable.
  // Apply before guards so success, denial, and error responses share the policy.
  router.use("/api/accounts/:id/property-tax-protest", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  function organizationIdsForRead(req) {
    if (!req.mobileAuth) return [];
    return (req.mobileAuth.organizations || [])
      .filter((organization) => hasPermission(
        req.mobileAuth,
        WORKFLOW,
        "read",
        organization.organizationId,
      ))
      .map((organization) => organization.organizationId);
  }

  function requestedAccountId(req, res) {
    const value = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(value)) {
      res.status(400).json({ error: "invalid_account_id" });
      return null;
    }
    return value;
  }

  function decodedDocumentHeader(req, name, fallback = "") {
    const value = String(req.get(name) || fallback).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  async function propertyTaxDocumentScope(req, requestedId, permission) {
    await ensureDocuments();
    const accountId = await resolveAccountId(pool, requestedId);
    // Exact-file routes must distinguish an absent file (404) from a known file
    // outside the authenticated assignment boundary (403). The subsequent
    // assignment decision is authoritative; list/latest reads remain scoped in SQL.
    const file = await getFile(
      pool,
      accountId,
      req.params.fileId,
      { organizationIds: null },
    );
    if (!file) throw new Error("property_tax_protest_file_not_found");
    if (!decideAccess(req.mobileAuth, file, permission)) {
      throw new Error("property_tax_protest_access_denied");
    }
    return { accountId, file };
  }

  async function requirePropertyTaxDocument(file, documentIdValue) {
    const documentId = Number(documentIdValue);
    if (!Number.isSafeInteger(documentId) || documentId < 1) {
      throw new Error("invalid_document_id");
    }
    const { rows } = await pool.query(
      `SELECT id FROM app.assignment_documents
        WHERE id = $1 AND tax_protest_file_id = $2 AND report_file_id = $3`,
      [documentId, file.tax_protest_file_id, file.report_file_id],
    );
    if (!rows[0]) throw new Error("document_not_found");
    return documentId;
  }

  function propertyTaxDocumentError(res, error, fallback) {
    const message = propertyTaxErrorMessage(error);
    if (
      message === "account_not_found"
      || message === "property_tax_protest_file_not_found"
      || message === "document_not_found"
    ) {
      return res.set("cache-control", "no-store").status(404).json({ error: message });
    }
    if (message === "property_tax_protest_access_denied") {
      return res.set("cache-control", "no-store").status(403).json({ error: message });
    }
    if (
      PROPERTY_TAX_FILE_CLIENT_ERRORS.has(message)
      || PROPERTY_TAX_DOCUMENT_CLIENT_ERRORS.has(message)
      || new Set([
        "document_content_required",
        "document_too_large",
        "document_not_pdf",
      ]).has(message)
    ) {
      return res.set("cache-control", "no-store").status(400).json({ error: message });
    }
    if (message === "assignment_document_storage_not_configured") {
      return res.set("cache-control", "no-store").status(503).json({ error: message });
    }
    if (new Set([
      "assignment_document_processing_capacity_exceeded",
      "assignment_document_storage_quota_exceeded",
      "document_processing_in_progress",
      "document_retry_not_due",
      "document_not_processable",
    ]).has(message)) {
      return res.set("cache-control", "no-store").status(409).json({ error: message });
    }
    logPropertyTaxFailure(logger, "error", fallback, error);
    return res.set("cache-control", "no-store").status(500).json({ error: fallback });
  }

  async function authorizePropertyTaxDocumentUpload(req, res, next) {
    if (!requireWorkflowAccess(req, res, WORKFLOW, "write")) return undefined;
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    if (!requireEditor(req, res)) return undefined;
    try {
      res.locals.propertyTaxDocumentUpload = await propertyTaxDocumentScope(
        req,
        requestedId,
        "write",
      );
      return next();
    } catch (error) {
      return propertyTaxDocumentError(res, error, "property_tax_document_upload_failed");
    }
  }

  /** Load the current canonical Property Tax Protest file and accepted inspection evidence. */
  router.get("/api/accounts/:id/property-tax-protest", async (req, res) => {
    if (!requireWorkflowAccess(req, res, WORKFLOW, "read")) return undefined;
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    try {
      await Promise.all([accountQualityReady, propertyEnrichmentReady]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const exactFileId = req.query.file_id || null;
      const file = await getFile(
        pool,
        canonicalId,
        exactFileId,
        { organizationIds: exactFileId ? null : organizationIdsForRead(req) },
      );
      if (exactFileId && !file) {
        return res.status(404).json({ error: "property_tax_protest_file_not_found" });
      }
      if (file && !decideAccess(req.mobileAuth, file, "read")) {
        return res.status(403).json({ error: "property_tax_protest_access_denied" });
      }
      return res.json({ account_id: canonicalId, file });
    } catch (error) {
      const message = propertyTaxErrorMessage(error);
      if (PROPERTY_TAX_FILE_CLIENT_ERRORS.has(message)) {
        return res.status(400).json({ error: message });
      }
      logPropertyTaxFailure(logger, "error", "property tax protest load failed", error);
      return res.status(500).json({ error: "property_tax_protest_load_failed" });
    }
  });

  /** Lightweight verified-photo and committed-sketch token for one protest file. */
  router.get("/api/accounts/:id/property-tax-protest/:fileId/evidence/version", async (req, res) => {
    if (!requireWorkflowAccess(req, res, WORKFLOW, "read")) return undefined;
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    try {
      const canonicalId = await resolveAccountId(pool, requestedId);
      const file = await getEvidenceVersion(
        pool,
        canonicalId,
        req.params.fileId,
        { organizationIds: null },
      );
      if (!file) {
        return res.status(404).json({ error: "property_tax_protest_file_not_found" });
      }
      if (!decideAccess(req.mobileAuth, file, "read")) {
        return res.status(403).json({ error: "property_tax_protest_access_denied" });
      }
      return res.set("cache-control", "no-store").json({ account_id: canonicalId, file });
    } catch (error) {
      const message = propertyTaxErrorMessage(error);
      if (PROPERTY_TAX_FILE_CLIENT_ERRORS.has(message)) {
        return res.status(400).json({ error: message });
      }
      logPropertyTaxFailure(logger, "error", "property tax protest evidence version failed", error);
      return res.status(500).json({ error: "property_tax_protest_evidence_version_failed" });
    }
  });

  /** Save a reviewed desktop protest revision without replacing prior history. */
  router.patch("/api/accounts/:id/property-tax-protest/:fileId", async (req, res) => {
    if (!requireWorkflowAccess(req, res, WORKFLOW, "write")) return undefined;
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    if (!requireEditor(req, res)) return undefined;
    try {
      await Promise.all([accountQualityReady, propertyEnrichmentReady]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const existingFile = await getFile(pool, canonicalId, req.params.fileId);
      if (!existingFile || !decideAccess(req.mobileAuth, existingFile, "write")) {
        return res.status(existingFile ? 403 : 404).json({
          error: existingFile
            ? "property_tax_protest_access_denied"
            : "property_tax_protest_file_not_found",
        });
      }
      const file = await saveFile(
        pool,
        canonicalId,
        req.params.fileId,
        req.body || {},
        {
          actorUserId: req.mobileAuth?.userId || null,
          actorLabel: req.mobileAuth?.displayName || req.mobileAuth?.email || null,
          actorAuth: req.mobileAuth || null,
          authorizationRequired: true,
        },
      );
      return res.json({ ok: true, file });
    } catch (error) {
      const message = propertyTaxErrorMessage(error);
      if (message === "property_tax_protest_revision_conflict") {
        return res.status(409).json({
          error: message,
          current_revision: error.currentRevision,
        });
      }
      if (message === "property_tax_protest_save_operation_conflict") {
        return res.status(409).json({ error: message });
      }
      if (message === "property_tax_comparable_reverification_required") {
        return res.status(409).json({ error: message });
      }
      if (message === "property_tax_comparable_housing_type_conflict") {
        return res.status(409).json({ error: message });
      }
      if (message === "property_tax_protest_file_not_found") {
        return res.status(404).json({ error: message });
      }
      if (message === "property_tax_protest_access_denied") {
        return res.status(403).json({ error: message });
      }
      if (message === "property_tax_comparable_attestation_required") {
        return res.status(403).json({ error: message });
      }
      if (PROPERTY_TAX_FILE_CLIENT_ERRORS.has(message)) {
        return res.status(400).json({ error: message });
      }
      logPropertyTaxFailure(logger, "error", "property tax protest save failed", error);
      return res.status(500).json({ error: "property_tax_protest_save_failed" });
    }
  });

  /** Revise the Property Tax Protest sketch through the authenticated desktop workflow. */
  router.patch("/api/accounts/:id/property-tax-protest/:fileId/sketch", async (req, res) => {
    if (!requireWorkflowAccess(req, res, WORKFLOW, "write")) return undefined;
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    if (!requireEditor(req, res)) return undefined;
    if (!String(req.mobileAuth?.userId || "").trim()) {
      return res.status(401).json({ error: "authentication_required" });
    }
    try {
      await Promise.all([accountQualityReady, propertyEnrichmentReady]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const existingFile = await getFile(pool, canonicalId, req.params.fileId);
      const reviewStatus = normalizeSketchReviewStatus(req.body?.sketch?.review_status);
      const permission = reviewStatus === "appraiser_confirmed"
        ? "sign"
        : "write";
      if (!existingFile || !decideAccess(req.mobileAuth, existingFile, permission)) {
        return res.status(existingFile ? 403 : 404).json({
          error: existingFile
            ? "property_tax_protest_access_denied"
            : "property_tax_protest_file_not_found",
        });
      }
      const result = await saveSketch(
        pool,
        canonicalId,
        req.params.fileId,
        req.body || {},
        req.mobileAuth,
        decideAccess(req.mobileAuth, existingFile, "sign"),
      );
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = propertyTaxErrorMessage(error);
      if (message === "property_tax_protest_sketch_not_found") {
        return res.status(404).json({ error: message });
      }
      if (message === "sketch_revision_conflict") {
        return res.status(409).json({
          error: message,
          current_revision: error.currentRevision,
        });
      }
      if (message === "inspection_sketch_confirmation_access_denied") {
        return res.status(403).json({ error: message });
      }
      if (message === "authentication_required") {
        return res.status(401).json({ error: message });
      }
      if (
        PROPERTY_TAX_FILE_CLIENT_ERRORS.has(message)
        || PROPERTY_TAX_SKETCH_CLIENT_ERRORS.has(message)
        || message === "sketch_not_ready_for_confirmation"
        || message === "sketch_operation_conflict"
      ) {
        return res.status(message === "sketch_operation_conflict" ? 409 : 400)
          .json({ error: message });
      }
      logPropertyTaxFailure(logger, "error", "property tax protest sketch review failed", error);
      return res.status(500).json({ error: "property_tax_protest_sketch_update_failed" });
    }
  });

  /** List PDFs belonging only to one canonical Property Tax Protest file. */
  router.get("/api/accounts/:id/property-tax-protest/:fileId/documents", async (req, res) => {
    if (!requireWorkflowAccess(req, res, WORKFLOW, "read")) return undefined;
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    try {
      const { accountId, file } = await propertyTaxDocumentScope(req, requestedId, "read");
      const documents = await listDocuments(pool, {
        accountId,
        taxProtestFileId: file.tax_protest_file_id,
        reportFileId: file.report_file_id,
        includePropertyEvidence: false,
      });
      return res.set("cache-control", "no-store").json({
        ok: true,
        account_id: accountId,
        documents,
      });
    } catch (error) {
      return propertyTaxDocumentError(res, error, "property_tax_documents_lookup_failed");
    }
  });

  /** Upload and extract one district-evidence or MLS PDF for a protest file. */
  router.post(
    "/api/accounts/:id/property-tax-protest/:fileId/documents",
    // Reject unowned files before buffering up to 25 MiB of evidence.
    authorizePropertyTaxDocumentUpload,
    express.raw({
      type: ["application/pdf", "application/octet-stream"],
      limit: MAX_ASSIGNMENT_DOCUMENT_BYTES,
      inflate: false,
    }),
    async (req, res) => {
      try {
        const { accountId, file } = res.locals.propertyTaxDocumentUpload;
        const document = await createDocument(pool, {
          organizationId: file.organization_id,
          accountId,
          taxProtestFileId: file.tax_protest_file_id,
          reportFileId: file.report_file_id,
          documentType: decodedDocumentHeader(req, "x-document-type", "district_evidence"),
          title: decodedDocumentHeader(req, "x-document-title", "Property Tax evidence.pdf"),
          fileName: decodedDocumentHeader(
            req,
            "x-document-file-name",
            "property-tax-evidence.pdf",
          ),
          contentType: req.get("content-type"),
          content: req.body,
          uploadedBy: req.mobileAuth?.userId || null,
          storage: documentStorage,
          uploadQuota: PROPERTY_TAX_DOCUMENT_UPLOAD_QUOTA,
        });
        if (document.processing_status === "uploaded") {
          void processDocument(pool, document.id, {
            storage: documentStorage,
            ocrProvider: documentOcrProvider,
          }).catch((processingError) => {
            if (propertyTaxErrorMessage(processingError) !== "document_processing_in_progress") {
              logPropertyTaxFailure(
                logger,
                "warn",
                "[property tax documents] background extraction failed",
                processingError,
              );
            }
          });
        }
        return res.set("cache-control", "no-store").status(201).json({
          ok: true,
          account_id: accountId,
          document,
        });
      } catch (error) {
        return propertyTaxDocumentError(res, error, "property_tax_document_upload_failed");
      }
    },
  );

  /** Load one file-scoped document plus its page-cited extraction candidates. */
  router.get(
    "/api/accounts/:id/property-tax-protest/:fileId/documents/:documentId",
    async (req, res) => {
      if (!requireWorkflowAccess(req, res, WORKFLOW, "read")) return undefined;
      const requestedId = requestedAccountId(req, res);
      if (!requestedId) return undefined;
      try {
        const { file } = await propertyTaxDocumentScope(req, requestedId, "read");
        const documentId = await requirePropertyTaxDocument(file, req.params.documentId);
        const document = await getDocument(pool, documentId);
        if (!document) throw new Error("document_not_found");
        return res.set("cache-control", "no-store").json({ ok: true, document });
      } catch (error) {
        return propertyTaxDocumentError(res, error, "property_tax_document_lookup_failed");
      }
    },
  );

  /** Stream immutable uploaded source bytes inline for the embedded PDF viewer. */
  router.get(
    "/api/accounts/:id/property-tax-protest/:fileId/documents/:documentId/content",
    async (req, res) => {
      if (!requireWorkflowAccess(req, res, WORKFLOW, "read")) return undefined;
      const requestedId = requestedAccountId(req, res);
      if (!requestedId) return undefined;
      try {
        const { file } = await propertyTaxDocumentScope(req, requestedId, "read");
        const documentId = await requirePropertyTaxDocument(file, req.params.documentId);
        const document = await getDocument(pool, documentId, {
          includeContent: true,
          storage: documentStorage,
        });
        if (!document) throw new Error("document_not_found");
        const fileName = String(document.file_name || `document-${document.id}.pdf`)
          .replace(/[\r\n"]/g, "_");
        return res.set({
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${fileName}"`,
          ETag: `"${document.checksum_sha256}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        }).send(document.content);
      } catch (error) {
        return propertyTaxDocumentError(res, error, "property_tax_document_stream_failed");
      }
    },
  );

  /** Remove a PDF only after verifying both canonical Property Tax file identities. */
  router.delete(
    "/api/accounts/:id/property-tax-protest/:fileId/documents/:documentId",
    async (req, res) => {
      if (!requireWorkflowAccess(req, res, WORKFLOW, "write")) return undefined;
      const requestedId = requestedAccountId(req, res);
      if (!requestedId) return undefined;
      if (!requireEditor(req, res)) return undefined;
      try {
        const { file } = await propertyTaxDocumentScope(req, requestedId, "write");
        const documentId = await requirePropertyTaxDocument(file, req.params.documentId);
        const result = await deleteDocument(pool, documentStorage, documentId);
        return res.set("cache-control", "no-store").json({ ok: true, ...result });
      } catch (error) {
        return propertyTaxDocumentError(res, error, "property_tax_document_delete_failed");
      }
    },
  );

  /** Retry extraction without permitting a document from another workflow or file. */
  router.post(
    "/api/accounts/:id/property-tax-protest/:fileId/documents/:documentId/reprocess",
    async (req, res) => {
      if (!requireWorkflowAccess(req, res, WORKFLOW, "write")) return undefined;
      const requestedId = requestedAccountId(req, res);
      if (!requestedId) return undefined;
      if (!requireEditor(req, res)) return undefined;
      try {
        const { file } = await propertyTaxDocumentScope(req, requestedId, "write");
        const documentId = await requirePropertyTaxDocument(file, req.params.documentId);
        const document = await processDocument(pool, documentId, {
          force: true,
          storage: documentStorage,
          ocrProvider: documentOcrProvider,
        });
        return res.set("cache-control", "no-store").json({ ok: true, document });
      } catch (error) {
        return propertyTaxDocumentError(res, error, "property_tax_document_reprocess_failed");
      }
    },
  );

  return router;
}
