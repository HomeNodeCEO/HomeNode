import express from "express";

import { createMobileAuthenticator } from "./auth.js";
import {
  completeInspectionSession,
  getInspectionCompletionReadiness,
} from "./completion.js";
import {
  getCustomAppraisalReview,
  refreshCustomAppraisalProposals,
  reviewCustomAppraisalProposal,
} from "./customAppraisal.js";
import { MOBILE_WORKFLOW_TYPES } from "./fileNumbers.js";
import { calculateManualSketch } from "./manualSketch.js";
import { getMobileProperty, searchMobileProperties } from "./properties.js";
import {
  createPhotoUploadBatch,
  CUSTOM_PHOTO_CATEGORIES,
  listInspectionPhotos,
  MAX_MOBILE_PHOTOS_PER_INSPECTION,
  removeInspectionPhoto,
  updateInspectionPhoto,
  verifyInspectionPhoto,
} from "./photos.js";
import {
  createInspectionSession,
  createReportFile,
  getInspectionSession,
  listReportFiles,
} from "./reportFiles.js";
import { getInspectionSketch, saveInspectionSketch } from "./sketches.js";
import { getInspectionSnapshot, syncInspectionOperations } from "./sync.js";
import {
  getTargetFieldReview,
  refreshTargetFieldProposals,
  reviewTargetFieldProposal,
} from "./targetFields.js";
import {
  createMobileUadEntityProposal,
  getMobileUadEntityReview,
  reviewMobileUadEntityProposal,
} from "./uadEntities.js";


const WRITE_ROLES = new Set(["appraiser", "supervisory_appraiser", "organization_admin", "homenode_admin"]);

function errorStatus(error) {
  const message = String(error?.message || "");
  if (error?.statusCode) return error.statusCode;
  if (message === "custom_appraisal_workfile_signed") return 409;
  if (message.endsWith("_not_found")) return 404;
  if (message.endsWith("_access_denied")) return 403;
  if (message.endsWith("_conflict")) return 409;
  if (message.endsWith("_not_configured")) return 503;
  if (message.endsWith("_verification_failed")) return 502;
  if (message.startsWith("invalid_")) return 400;
  if (error?.code === "23505") return 409;
  if (error?.code === "23503") return 400;
  return 500;
}

function sendError(res, error) {
  const status = errorStatus(error);
  const code = status === 500
    ? "mobile_request_failed"
    : String(error?.message || "mobile_request_failed").split(":")[0];
  if (status === 500) console.error("[mobile] request failed", error);
  return res.status(status).json({
    error: code,
    ...(code === "inspection_not_ready_conflict" ? { details: error.details } : {}),
  });
}

function requireWriteRole(req, res, next) {
  const allowed = req.mobileAuth.organizations.some((organization) =>
    organization.roles.some((role) => WRITE_ROLES.has(role)));
  if (!allowed) return res.status(403).json({ error: "mobile_write_role_required" });
  return next();
}

export function createMobileRouter({ pool, verifier, storage, enabled = false, recentFileDays = 30 }) {
  const router = express.Router();

  router.get("/capabilities", (_req, res) => {
    res.json({
      enabled,
      authentication: {
        protocol: "oidc",
        configured: Boolean(verifier?.configured),
        client_type: "public",
        authorization_flow: "authorization_code_pkce",
        client_secret_embedded: false,
        explicit_identity_mapping: true,
        token_transport: "bearer",
      },
      workflows: MOBILE_WORKFLOW_TYPES,
      report_file_retention_years: 5,
      sketch: {
        manual_measurement: true,
        lidar: false,
        persisted: true,
        offline_drafts: true,
        multiple_areas: true,
        room_photo_links: true,
        measurement_standard: "ANSI Z765-2021",
        appraiser_confirmation_required: true,
      },
      offline_sync: {
        durable_queue: true,
        maximum_batch_size: 25,
        conflict_resolution: ["accept_server", "apply_mobile"],
      },
      photos: {
        enabled: Boolean(storage?.configured),
        storage_provider: storage?.provider || null,
        maximum_per_inspection: MAX_MOBILE_PHOTOS_PER_INSPECTION,
        bulk_selection_limit: MAX_MOBILE_PHOTOS_PER_INSPECTION,
        sources: ["camera", "library"],
        states: ["local", "queued", "uploading", "verifying", "synchronized", "failed"],
        original_retained: true,
        display_derivative: true,
        retention_years: 5,
        custom_categories: CUSTOM_PHOTO_CATEGORIES,
      },
      custom_appraisal: {
        assignment_scoped: true,
        review_required_before_report_update: true,
        sparse_updates: true,
        exact_value_conflict_detection: true,
        property_wide_overrides_mutated: false,
      },
      target_adapters: {
        workflows: ["uad_3_6", "property_tax_protest"],
        offline_sparse_updates: true,
        review_required_before_report_update: true,
        exact_value_conflict_detection: true,
        uad_official_catalog: true,
        property_tax_version_history: true,
      },
      uad_repeatable_entities: {
        enabled: true,
        offline_queue: true,
        review_required_before_report_update: true,
        exact_delete_conflict_detection: true,
        official_catalog_only: true,
        comparable_creation: "official_catalog",
      },
      inspection_completion: {
        enabled: true,
        server_authoritative: true,
        idempotent: true,
        blocks_unresolved_work: true,
        report_signing: false,
        report_submission: false,
      },
    });
  });

  router.use((_req, res, next) => {
    if (enabled) return next();
    return res.status(503).json({ error: "mobile_inspection_disabled" });
  });
  router.use(createMobileAuthenticator({ pool, verifier }));

  router.get("/me", (req, res) => {
    res.json({ user: req.mobileAuth });
  });

  router.get("/properties/search", async (req, res) => {
    try {
      const result = await searchMobileProperties(pool, req.mobileAuth, {
        query: req.query.q,
        limit: req.query.limit,
      });
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/properties/:accountId", async (req, res) => {
    try {
      return res.json(await getMobileProperty(pool, req.mobileAuth, req.params.accountId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/sketches/calculate", requireWriteRole, (req, res) => {
    try {
      return res.json({ sketch: calculateManualSketch(req.body || {}) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/report-files", async (req, res) => {
    try {
      const result = await listReportFiles(pool, req.mobileAuth, {
        accountId: req.query.account_id,
        workflowType: req.query.workflow_type,
        recentDays: recentFileDays,
      });
      return res.json({
        account_id: result.accountId,
        workflow_type: result.workflowType,
        files: result.files,
        recommended_file: result.recommended,
        recently_created: result.recentlyCreated,
        requires_creation: result.requiresCreation,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/report-files", requireWriteRole, async (req, res) => {
    try {
      const result = await createReportFile(pool, req.mobileAuth, req.body || {});
      return res.status(result.created ? 201 : 200).json({
        report_file: result.reportFile,
        created: result.created,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions", requireWriteRole, async (req, res) => {
    try {
      const result = await createInspectionSession(pool, req.mobileAuth, req.body || {});
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId", async (req, res) => {
    try {
      const session = await getInspectionSession(pool, req.mobileAuth, req.params.sessionId);
      if (!session) return res.status(404).json({ error: "inspection_session_not_found" });
      return res.json({ session });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId/snapshot", async (req, res) => {
    try {
      return res.json(await getInspectionSnapshot(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId/completion-readiness", async (req, res) => {
    try {
      return res.json(await getInspectionCompletionReadiness(
        pool,
        req.mobileAuth,
        req.params.sessionId,
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/complete", requireWriteRole, async (req, res) => {
    try {
      return res.json(await completeInspectionSession(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId/sketch", async (req, res) => {
    try {
      return res.json(await getInspectionSketch(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.put("/inspection-sessions/:sessionId/sketch", requireWriteRole, async (req, res) => {
    try {
      return res.json(await saveInspectionSketch(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/sync", requireWriteRole, async (req, res) => {
    try {
      return res.json(await syncInspectionOperations(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId/custom-appraisal", async (req, res) => {
    try {
      return res.json(await getCustomAppraisalReview(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/custom-appraisal/proposals/refresh", requireWriteRole, async (req, res) => {
    try {
      return res.json(await refreshCustomAppraisalProposals(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/custom-appraisal/proposals/:proposalId/review", requireWriteRole, async (req, res) => {
    try {
      return res.json(await reviewCustomAppraisalProposal(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.params.proposalId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });


  router.get("/inspection-sessions/:sessionId/target-fields", async (req, res) => {
    try {
      return res.json(await getTargetFieldReview(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/target-fields/proposals/refresh", requireWriteRole, async (req, res) => {
    try {
      return res.json(await refreshTargetFieldProposals(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/target-fields/proposals/:proposalId/review", requireWriteRole, async (req, res) => {
    try {
      return res.json(await reviewTargetFieldProposal(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.params.proposalId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId/uad-entities", async (req, res) => {
    try {
      return res.json(await getMobileUadEntityReview(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/uad-entities/proposals", requireWriteRole, async (req, res) => {
    try {
      const result = await createMobileUadEntityProposal(
        pool, req.mobileAuth, req.params.sessionId, req.body || {},
      );
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/uad-entities/proposals/:proposalId/review", requireWriteRole, async (req, res) => {
    try {
      return res.json(await reviewMobileUadEntityProposal(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.params.proposalId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId/photos", async (req, res) => {
    try {
      return res.json(await listInspectionPhotos(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/photos/upload-requests", requireWriteRole, async (req, res) => {
    try {
      return res.json(await createPhotoUploadBatch(
        pool,
        storage,
        req.mobileAuth,
        req.params.sessionId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/photos/:photoId/verify", requireWriteRole, async (req, res) => {
    try {
      return res.json({ photo: await verifyInspectionPhoto(
        pool,
        storage,
        req.mobileAuth,
        req.params.sessionId,
        req.params.photoId,
      ) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.patch("/inspection-sessions/:sessionId/photos/:photoId", requireWriteRole, async (req, res) => {
    try {
      return res.json({ photo: await updateInspectionPhoto(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.params.photoId,
        req.body || {},
      ) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.delete("/inspection-sessions/:sessionId/photos/:photoId", requireWriteRole, async (req, res) => {
    try {
      return res.json(await removeInspectionPhoto(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.params.photoId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
