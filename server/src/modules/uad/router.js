import express from "express";
import { isIP } from "node:net";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

import {
  createUadAssetUpload,
  deleteUadAsset,
  listUadAssets,
  verifyUadAssetUpload,
} from "./assets.js";
import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";
import { applyUadCompletionSuggestions } from "./completionApply.js";
import { getUadCertificationReadiness, signUadWorkfile } from "./certifications.js";
import { getUadComplianceStatus, runUadCompliance } from "./uadComplianceService.js";
import { getUadEditor, saveUadSection } from "./editor.js";
import {
  applyConfirmedUadDocumentCandidate,
  synchronizeUadPurchaseContract,
} from "./documentEvidence.js";
import { createUadEntity, deleteUadEntity } from "./entities.js";
import { generateUadXmlArtifact, getLatestUadXmlArtifact } from "./uadArtifacts.js";
import { generateUadPdfArtifact, getLatestUadPdfArtifact } from "./uadPdfArtifacts.js";
import {
  generateUadSubmissionPackage,
  getLatestUadSubmissionPackage,
} from "./uadPackageArtifacts.js";
import { getUadXmlMappingSummary } from "./uadXml.js";
import { createCachedUadReadinessLoader } from "./uadOperationalReadiness.js";
import { getUadSharedData } from "./sharedData.js";
import {
  editUadSketch,
  getUadMobileEvidenceVersion,
  importUadMobilePhoto,
  importUadMobileSketch,
  listUadMobileEvidence,
} from "./mobileEvidence.js";
import { listUadSketches, saveUadSketch } from "./sketches.js";
import { getLatestUadValidation, runLocalUadValidation } from "./validation.js";
import {
  createUadWorkfile,
  getUadSubjectSummary,
  getUadWorkfile,
  listUadWorkfiles,
} from "./workfiles.js";
import {
  createGuidedDeliveryAttempt,
  listDeliveryAttempts,
  recordGuidedDeliveryResult,
} from "../delivery/deliveryAttempts.js";
import { listDeliveryPlatforms, resolveDeliveryDestination } from "../delivery/platformCatalog.js";
import { createMobileAuthenticator } from "../mobile/auth.js";
import {
  authorizeUadAppraiserConfirmation,
  authorizeUadCreation,
  buildUadAccessScope,
  createUadWorkfileAuthorizer,
  verifyUadAssigneeMembership,
} from "./access.js";
import {
  assignmentDocumentNeedsExtractionUpgrade,
  confirmAssignmentDocumentCandidates,
  confirmAssignmentDocumentDespiteSubjectMismatch,
  createAssignmentDocument,
  deleteAssignmentDocument,
  ensureAssignmentDocumentsSchema,
  getAssignmentDocument,
  listAssignmentDocuments,
  loadAssignmentDocumentContent,
  MAX_ASSIGNMENT_DOCUMENT_BYTES,
  processAssignmentDocument,
  reviewAssignmentDocumentCandidate,
} from "../../services/assignmentDocuments.js";

function errorStatus(error) {
  const message = String(error?.message || "");
  if (message === "delivery_attempt_not_found_or_completed") return 409;
  if (message.includes("not_found")) return 404;
  if (message === "uad_authentication_required") return 401;
  if (message === "uad_organization_required") return 400;
  if (message.includes("source_changed") || message.includes("adapter_changed") || message.includes("stale_revision") || message.includes("selection_changed")) return 409;
  if (message.endsWith("_conflict")) return 409;
  if (message.endsWith("_status_locked")) return 409;
  if (message.endsWith("_access_denied")) return 403;
  if (message.startsWith("uad_signature_") && (message.endsWith("_required") || message.endsWith("_stale") || message.endsWith("_mismatch"))) return 409;
  if (message.startsWith("uad_signature_") && (message.endsWith("_incomplete") || message.endsWith("_verified") || message.endsWith("_date"))) return 400;
  if (message.startsWith("uad_xml_local_validation_")) return 409;
  if (message.startsWith("uad_xml_")) return 422;
  if (message.startsWith("uad_pdf_local_validation_")) return 409;
  if (message.startsWith("uad_pdf_")) return 422;
  if (message.startsWith("uad_package_") && (
    message.endsWith("_required") || message.endsWith("_stale") || message.endsWith("_changed")
  )) return 409;
  if (message.startsWith("uad_package_")) return 422;
  if ([
    "uad_artifact_capacity_exceeded",
    "uad_artifact_queue_timeout",
    "uad_artifact_executor_shutting_down",
  ].includes(message)) return 503;
  if (message.startsWith("uad_object_") && message.endsWith("_timeout")) return 504;
  if (message.startsWith("uad_object_") && (
    message.endsWith("_network_error") || message.includes("_failed:")
  )) return 502;
  if (message === "uad_object_download_too_large") return 422;
  if (message === "uad_compliance_authentication_required") return 401;
  if (
    message === "uad_compliance_disabled"
    || (message.includes("uad_compliance_") && message.endsWith("_not_configured"))
  ) return 503;
  if (message === "uad_compliance_timeout") return 504;
  if ([
    "uad_compliance_network_error",
    "uad_compliance_token_response_invalid",
    "uad_compliance_response_invalid",
    "uad_compliance_response_too_large",
  ].includes(message) || message.startsWith("uad_compliance_token_failed:")) return 502;
  if (message.startsWith("uad_compliance_") && (
    message.endsWith("_required") || message.endsWith("_stale") || message.endsWith("_changed")
  )) return 409;
  if (message.startsWith("uad_compliance_")) return 422;
  if (message === "delivery_idempotency_key_conflict") return 409;
  if (message.startsWith("delivery_") && message.includes("not_found")) return 404;
  if ([
    "delivery_organization_required",
    "delivery_signed_revision_required",
    "delivery_submission_package_required",
    "delivery_submission_package_not_ready",
    "delivery_submission_package_stale",
  ].includes(message)) return 409;
  if (message.startsWith("delivery_") && (
    message.endsWith("_required") || message.endsWith("_invalid") || message.endsWith("_mismatch")
  )) return 400;
  if (message.startsWith("delivery_")) return 422;
  if (message.startsWith("uad_completion_")) return 400;
  if (message.startsWith("uad_document_") && message.endsWith("_requires_manual_entry")) return 422;
  if (message === "uad_document_candidate_confirmation_required") return 409;
  if (message.startsWith("document_") || message.startsWith("assignment_document_")) return 400;
  if (message.includes("not_configured")) return 503;
  if (message.startsWith("invalid_")) return 400;
  if (["uad_parent_entity_required", "uad_entity_minimum_required"].includes(message)) return 400;
  if (error?.code === "23505") return 409;
  if (error?.code === "23503") return 400;
  return 500;
}

function sendError(res, error) {
  const status = errorStatus(error);
  const code = status === 500 ? "uad_request_failed" : String(error?.message || "uad_request_failed").split(":")[0];
  if (status === 500) console.error("[uad] request failed", error);
  res.status(status).json({ error: code, ...(error?.details ? { details: error.details } : {}) });
}

export function uadBodyParserErrorHandler(error, _req, res, next) {
  res.set("cache-control", "no-store");
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json_body" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "request_body_too_large" });
  }
  if (error?.type === "encoding.unsupported" || error?.type === "charset.unsupported") {
    return res.status(415).json({ error: "unsupported_request_encoding" });
  }
  if (error?.status === 400 && error?.expose === true) {
    return res.status(400).json({ error: "invalid_request_body" });
  }
  return next(error);
}

function workfileCreationInput(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  delete input.actor_user_id;
  return input;
}

function rateLimitClientAddress(req, trustedHeader) {
  const forwarded = trustedHeader ? String(req.get(trustedHeader) || "").trim() : "";
  return isIP(forwarded) ? forwarded : req.ip;
}

export function createUadRouter({
  pool,
  storage,
  verifier,
  compliance = { enabled: false, providers: {} },
  documentOcrProvider = null,
  applyCompletionSuggestions = applyUadCompletionSuggestions,
  enabled = false,
  authenticationRequired = false,
  security = {},
}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set("cache-control", "no-store");
    next();
  });
  router.use(rateLimit({
    windowMs: security.rateLimitWindowMs,
    limit: security.rateLimitMax,
    skip: () => !security.rateLimitEnabled,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(
      rateLimitClientAddress(req, security.rateLimitClientIpHeader),
    ),
    handler: (_req, res) => res.status(429).json({ error: "rate_limit_exceeded" }),
  }));
  router.use(express.json({ limit: "1mb" }));
  router.use(uadBodyParserErrorHandler);
  router.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
    const contentType = String(req.get("content-type") || "").trim();
    const hasBody = contentType
      || Number(req.get("content-length") || 0) > 0
      || Boolean(req.get("transfer-encoding"));
    const documentUpload = req.method === "POST"
      && /\/workfiles\/[^/]+\/documents$/.test(req.path)
      && (req.is("application/pdf") || req.is("application/octet-stream"));
    if (hasBody && !req.is("application/json") && !documentUpload) {
      return res.status(415).json({ error: "unsupported_media_type" });
    }
    return next();
  });
  const authenticateSigner = verifier?.verify
    ? createMobileAuthenticator({ pool, verifier })
    : (_req, res) => res.status(503).json({ error: "mobile_oidc_not_configured" });
  const loadOperationalReadiness = createCachedUadReadinessLoader(pool, {
    enabled,
    storage,
    verifier,
    compliance,
    security: {
      strict: Boolean(security.strict),
      authenticationRequired: Boolean(authenticationRequired),
      corsRestricted: Boolean(security.corsRestricted),
      rateLimitEnabled: Boolean(security.rateLimitEnabled),
    },
  });
  const authenticateIfNeeded = (req, res, next) => (
    req.mobileAuth ? next() : authenticateSigner(req, res, next)
  );

  router.get("/capabilities", (_req, res) => {
    res.json({
      enabled,
      specification_release_key: CURRENT_UAD_RELEASE_KEY,
      initial_property_type: "traditional_single_family",
      object_storage: {
        provider: storage.provider,
        configured: storage.configured,
        isolated: Boolean(storage.isolated),
      },
      mobile_evidence: {
        verified_photo_review_import: true,
        appraiser_confirmed_sketch_import: true,
        canonical_asset_copy: true,
        retained_source_unchanged: true,
      },
      sketch_editor: {
        shared_across_report_types: true,
        optimistic_revisions: true,
        immutable_revision_history: true,
        regenerated_verified_exhibits: true,
        uploaded_source_retained: true,
      },
      xml: getUadXmlMappingSummary(),
      delivery_package: {
        profile: "UAD 3.6 URAR Delivery Specification 1.4",
        requires_signed_revision: true,
        includes_external_images: true,
      },
      compliance: {
        enabled: compliance.enabled,
        providers: compliance.providers,
      },
      authentication: {
        protocol: "oidc",
        required: Boolean(authenticationRequired),
        configured: Boolean(verifier?.configured),
      },
      security: {
        strict: Boolean(security.strict),
        cors_restricted: Boolean(security.corsRestricted),
        rate_limit_enabled: Boolean(security.rateLimitEnabled),
      },
    });
  });

  router.get("/readiness", async (_req, res) => {
    const readiness = await loadOperationalReadiness();
    res.set("cache-control", "no-store");
    return res.status(readiness.ok ? 200 : 503).json(readiness);
  });

  router.get("/delivery/platforms", (_req, res) => {
    res.json({
      delivery_mode: "guided_manual",
      platforms: listDeliveryPlatforms(),
    });
  });

  router.use((req, res, next) => {
    if (enabled) return next();
    return res.status(503).json({ error: "uad_workspace_disabled" });
  });
  router.use((req, res, next) => {
    if (!authenticationRequired) return next();
    return authenticateIfNeeded(req, res, next);
  });

  router.get("/accounts/:accountId/workfiles", async (req, res) => {
    try {
      const accessScope = authenticationRequired ? buildUadAccessScope(req.mobileAuth) : null;
      const workfiles = await listUadWorkfiles(pool, req.params.accountId, accessScope);
      res.json({ account_id: req.params.accountId, workfiles });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/accounts/:accountId/subject-summary", async (req, res) => {
    try {
      // The summary is public cadastral source data used before a first UAD
      // workfile exists, but only identities with an authorized UAD role may
      // enumerate it. Tenant-owned workfiles remain separately object-scoped.
      if (authenticationRequired) buildUadAccessScope(req.mobileAuth);
      const subject = await getUadSubjectSummary(pool, req.params.accountId);
      res.json({ subject });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/accounts/:accountId/workfiles", async (req, res) => {
    try {
      const requestedInput = workfileCreationInput(req.body);
      let input = authenticationRequired
        ? authorizeUadCreation(req.mobileAuth, requestedInput)
        : requestedInput;
      if (authenticationRequired) input = await verifyUadAssigneeMembership(pool, input);
      const workfile = await createUadWorkfile(pool, req.params.accountId, input);
      res.status(201).json({ workfile });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.use(
    "/workfiles/:workfileId",
    createUadWorkfileAuthorizer({ pool, authenticationRequired }),
  );

  router.post("/delivery/resolve", (req, res) => {
    try {
      res.json({ destination: resolveDeliveryDestination(req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId", async (req, res) => {
    try {
      const workfile = await getUadWorkfile(pool, req.params.workfileId);
      if (!workfile) return res.status(404).json({ error: "uad_workfile_not_found" });
      return res.json({ workfile });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/editor", async (req, res) => {
    try {
      const editor = await getUadEditor(pool, req.params.workfileId);
      res.json(editor);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/validation", async (req, res) => {
    try {
      res.json({ validation: await getLatestUadValidation(pool, req.params.workfileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/validation", async (req, res) => {
    try {
      res.json({ validation: await runLocalUadValidation(pool, req.params.workfileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/certification-readiness", authenticateIfNeeded, async (req, res) => {
    try {
      const readiness = await getUadCertificationReadiness(pool, req.params.workfileId);
      const currentSigner = readiness.signers.find((signer) => signer.user_id === req.mobileAuth.userId);
      if (!currentSigner) {
        return res.status(403).json({ error: "uad_signature_access_denied" });
      }
      return res.json({ readiness: { ...readiness, current_signer: currentSigner } });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/signatures", authenticateIfNeeded, async (req, res) => {
    try {
      const result = await signUadWorkfile(
        pool,
        req.params.workfileId,
        req.mobileAuth,
        req.body || {},
      );
      return res.status(201).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/artifacts/xml", async (req, res) => {
    try {
      res.json(await getLatestUadXmlArtifact(pool, storage, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/artifacts/xml", async (req, res) => {
    try {
      const result = await generateUadXmlArtifact(pool, storage, req.params.workfileId);
      res.status(result.artifact?.generation_status === "ready" ? 201 : 200).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/artifacts/pdf", async (req, res) => {
    try {
      res.json(await getLatestUadPdfArtifact(pool, storage, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/artifacts/pdf", async (req, res) => {
    try {
      const result = await generateUadPdfArtifact(pool, storage, req.params.workfileId);
      res.status(201).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/artifacts/submission-package", async (req, res) => {
    try {
      res.json(await getLatestUadSubmissionPackage(pool, storage, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/artifacts/submission-package", async (req, res) => {
    try {
      res.status(201).json(await generateUadSubmissionPackage(pool, storage, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  async function uadDocumentScope(workfileId) {
    await ensureAssignmentDocumentsSchema(pool);
    const { rows } = await pool.query(
      `SELECT workfile.id AS uad_workfile_id, workfile.account_id, workfile.organization_id,
              report_file.id AS report_file_id
         FROM appraisal.uad_workfiles workfile
         LEFT JOIN app.report_files report_file ON report_file.uad_workfile_id = workfile.id
        WHERE workfile.id = $1`,
      [workfileId],
    );
    if (!rows[0]) throw new Error("uad_workfile_not_found");
    return rows[0];
  }

  async function requireUadDocument(workfileId, documentId) {
    const { rows } = await pool.query(
      `SELECT id FROM app.assignment_documents
        WHERE id = $1 AND uad_workfile_id = $2`,
      [documentId, workfileId],
    );
    if (!rows[0]) throw new Error("document_not_found");
  }

  router.get("/workfiles/:workfileId/documents", async (req, res) => {
    try {
      const scope = await uadDocumentScope(req.params.workfileId);
      const documents = await listAssignmentDocuments(pool, {
        accountId: scope.account_id,
        uadWorkfileId: scope.uad_workfile_id,
        includePropertyEvidence: false,
      });
      return res.json({ documents });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post(
    "/workfiles/:workfileId/documents",
    express.raw({
      type: ["application/pdf", "application/octet-stream"],
      limit: MAX_ASSIGNMENT_DOCUMENT_BYTES,
    }),
    async (req, res) => {
      try {
        const scope = await uadDocumentScope(req.params.workfileId);
        const decodeHeader = (name, fallback = "") => {
          const source = String(req.get(name) || fallback).trim();
          try { return decodeURIComponent(source); } catch { return source; }
        };
        const document = await createAssignmentDocument(pool, {
          organizationId: scope.organization_id,
          accountId: scope.account_id,
          uadWorkfileId: scope.uad_workfile_id,
          reportFileId: scope.report_file_id,
          documentType: decodeHeader("x-document-type", "other"),
          title: decodeHeader("x-document-title", "document.pdf"),
          fileName: decodeHeader("x-document-file-name", "document.pdf"),
          contentType: req.get("content-type"),
          content: req.body,
          uploadedBy: decodeHeader("x-document-uploaded-by"),
          storage,
        });
        if (document.processing_status === "uploaded") {
          const actorUserId = req.mobileAuth?.userId || null;
          void processAssignmentDocument(pool, document.id, {
            storage,
            ocrProvider: documentOcrProvider,
          }).then(async (processedDocument) => {
            if (processedDocument.document_type === "purchase_contract") {
              await synchronizeUadPurchaseContract(
                pool,
                scope.uad_workfile_id,
                processedDocument.id,
                actorUserId,
              );
            }
          }).catch((error) => {
            if (error?.message !== "document_processing_in_progress") {
              console.warn("[uad documents] background extraction failed", error?.message || error);
            }
          });
        }
        return res.status(201).json({ document });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  router.get("/workfiles/:workfileId/documents/:documentId", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      let document = await getAssignmentDocument(pool, req.params.documentId);
      if (assignmentDocumentNeedsExtractionUpgrade(document)) {
        try {
          document = await processAssignmentDocument(pool, req.params.documentId, {
            force: true,
            storage,
            ocrProvider: documentOcrProvider,
          });
          try {
            await synchronizeUadPurchaseContract(
              pool,
              req.params.workfileId,
              req.params.documentId,
              req.mobileAuth?.userId || null,
            );
          } catch (synchronizationError) {
            console.warn(
              "[uad documents] upgraded contract classification could not be synchronized",
              synchronizationError?.message || synchronizationError,
            );
          }
        } catch (extractionError) {
          if (extractionError?.message !== "document_processing_in_progress") {
            console.warn(
              "[uad documents] legacy contract extraction upgrade failed",
              extractionError?.message || extractionError,
            );
          }
          document = await getAssignmentDocument(pool, req.params.documentId);
        }
      }
      return res.json({ document });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete("/workfiles/:workfileId/documents/:documentId", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      return res.json(await deleteAssignmentDocument(pool, storage, req.params.documentId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/documents/:documentId/content", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      const document = await loadAssignmentDocumentContent(pool, req.params.documentId, { storage });
      if (!document) throw new Error("document_not_found");
      const fileName = String(document.file_name || `document-${document.id}.pdf`).replace(/[\r\n"]/g, "_");
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"`,
        ETag: `"${document.checksum_sha256}"`,
        "Cache-Control": "private, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      });
      return res.send(document.content);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/documents/:documentId/reprocess", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      const document = await processAssignmentDocument(pool, req.params.documentId, {
        force: true,
        storage,
        ocrProvider: documentOcrProvider,
      });
      if (document.document_type === "purchase_contract") {
        await synchronizeUadPurchaseContract(
          pool,
          req.params.workfileId,
          document.id,
          req.mobileAuth?.userId || null,
        );
      }
      return res.json({ document });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/documents/:documentId/synchronize-purchase-contract", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      return res.json(await synchronizeUadPurchaseContract(
        pool,
        req.params.workfileId,
        req.params.documentId,
        req.mobileAuth?.userId || null,
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/documents/:documentId/subject-address-override", async (req, res) => {
    try {
      if (authenticationRequired) {
        authorizeUadAppraiserConfirmation(req.mobileAuth, req.uadAuthorizedWorkfile);
      }
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      await confirmAssignmentDocumentDespiteSubjectMismatch(pool, {
        documentId: req.params.documentId,
        reviewer: authenticationRequired
          ? req.mobileAuth?.displayName || req.mobileAuth?.email || req.mobileAuth?.userId
          : req.body?.reviewer,
        actorUserId: req.mobileAuth?.userId || null,
        reportSubjectAddress: req.body?.report_subject_address,
        candidateValues: req.body?.candidate_values,
      });
      return res.json({ document: await getAssignmentDocument(pool, req.params.documentId) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch("/workfiles/:workfileId/documents/:documentId/candidates/:candidateId", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      const candidate = await reviewAssignmentDocumentCandidate(pool, {
        documentId: req.params.documentId,
        candidateId: req.params.candidateId,
        reviewStatus: req.body?.review_status,
        confirmedValue: req.body?.confirmed_value,
        reviewer: req.body?.reviewer,
      });
      return res.json({ candidate });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/documents/:documentId/candidates/confirm-all-purchase-contract", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      const document = await getAssignmentDocument(pool, req.params.documentId);
      if (document.document_type !== "purchase_contract") {
        throw new Error("document_purchase_contract_required");
      }
      await confirmAssignmentDocumentCandidates(pool, {
        documentId: req.params.documentId,
        reviewer: req.body?.reviewer,
        reportSubjectAddress: req.body?.report_subject_address,
        candidateValues: req.body?.candidate_values,
      });
      const application = await synchronizeUadPurchaseContract(
        pool,
        req.params.workfileId,
        req.params.documentId,
        req.mobileAuth?.userId || null,
      );
      return res.json({
        document: await getAssignmentDocument(pool, req.params.documentId),
        application,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/documents/:documentId/candidates/:candidateId/apply", async (req, res) => {
    try {
      await requireUadDocument(req.params.workfileId, req.params.documentId);
      return res.json(await applyConfirmedUadDocumentCandidate(
        pool,
        req.params.workfileId,
        req.params.documentId,
        req.params.candidateId,
        req.mobileAuth?.userId || null,
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/delivery-attempts", async (req, res) => {
    try {
      res.json({ attempts: await listDeliveryAttempts(pool, req.params.workfileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/delivery-attempts", async (req, res) => {
    try {
      const result = await createGuidedDeliveryAttempt(
        pool,
        req.params.workfileId,
        req.body || {},
        req.mobileAuth?.userId || null,
      );
      res.status(201).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/workfiles/:workfileId/delivery-attempts/:attemptId", async (req, res) => {
    try {
      const attempt = await recordGuidedDeliveryResult(
        pool,
        req.params.workfileId,
        req.params.attemptId,
        req.body || {},
        req.mobileAuth?.userId || null,
      );
      res.json({ attempt });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/compliance", authenticateIfNeeded, async (req, res) => {
    try {
      res.json(await getUadComplianceStatus(
        pool,
        compliance,
        req.params.workfileId,
        req.mobileAuth.userId,
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/compliance/:provider", authenticateIfNeeded, async (req, res) => {
    try {
      const result = await runUadCompliance(
        pool,
        storage,
        compliance,
        req.params.workfileId,
        req.params.provider,
        req.mobileAuth.userId,
      );
      res.status(201).json({ validation: result });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/workfiles/:workfileId/sections/:section", async (req, res) => {
    try {
      const result = await saveUadSection(
        pool,
        req.params.workfileId,
        req.params.section,
        req.body || {},
        req.mobileAuth?.userId || null,
      );
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/shared-data", async (req, res) => {
    try {
      res.json(await getUadSharedData(pool, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/completion-suggestions/apply", async (req, res) => {
    try {
      if (authenticationRequired) {
        authorizeUadAppraiserConfirmation(req.mobileAuth, req.uadAuthorizedWorkfile);
      }
      res.json(await applyCompletionSuggestions(
        pool,
        req.params.workfileId,
        req.body || {},
        req.mobileAuth?.userId || null,
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/sketches", async (req, res) => {
    try {
      res.json({ sketches: await listUadSketches(pool, req.params.workfileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put("/workfiles/:workfileId/sketches", async (req, res) => {
    try {
      const sketch = await saveUadSketch(
        pool,
        req.params.workfileId,
        req.body || {},
        req.mobileAuth?.userId || null,
      );
      res.json({ sketch });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/entities", async (req, res) => {
    try {
      const entity = await createUadEntity(pool, req.params.workfileId, req.body || {});
      res.status(201).json({ entity });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete("/workfiles/:workfileId/entities/:entityId", async (req, res) => {
    try {
      await deleteUadEntity(pool, req.params.workfileId, req.params.entityId);
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/assets", async (req, res) => {
    try {
      res.json({ assets: await listUadAssets(pool, req.params.workfileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/assets/upload-url", async (req, res) => {
    try {
      const upload = await createUadAssetUpload(pool, storage, req.params.workfileId, req.body || {});
      res.status(201).json(upload);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/assets/:assetId/verify", async (req, res) => {
    try {
      const asset = await verifyUadAssetUpload(
        pool,
        storage,
        req.params.workfileId,
        req.params.assetId,
      );
      res.json({ asset });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete("/workfiles/:workfileId/assets/:assetId", async (req, res) => {
    try {
      await deleteUadAsset(pool, storage, req.params.workfileId, req.params.assetId);
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/workfiles/:workfileId/sketches/:sketchId", async (req, res) => {
    try {
      const result = await editUadSketch(
        pool,
        storage,
        req.params.workfileId,
        req.params.sketchId,
        req.body || {},
        req.mobileAuth?.userId || null,
      );
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/mobile-evidence", async (req, res) => {
    try {
      res.json(await listUadMobileEvidence(pool, storage, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/mobile-evidence/version", async (req, res) => {
    try {
      res.json(await getUadMobileEvidenceVersion(pool, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/mobile-evidence/photos/:photoId/import", async (req, res) => {
    try {
      const result = await importUadMobilePhoto(
        pool,
        storage,
        req.params.workfileId,
        req.params.photoId,
        req.body || {},
        req.mobileAuth?.userId || null,
      );
      res.status(result.idempotent ? 200 : 201).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/mobile-evidence/sketches/:sketchId/import", async (req, res) => {
    try {
      const result = await importUadMobileSketch(
        pool,
        storage,
        req.params.workfileId,
        req.params.sketchId,
        req.body || {},
        req.mobileAuth?.userId || null,
      );
      res.status(result.idempotent ? 200 : 201).json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.use((_req, res) => res.status(404).json({ error: "uad_route_not_found" }));

  return router;
}
