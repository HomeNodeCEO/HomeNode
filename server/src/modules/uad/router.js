import express from "express";

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
import { createUadEntity, deleteUadEntity } from "./entities.js";
import { generateUadXmlArtifact, getLatestUadXmlArtifact } from "./uadArtifacts.js";
import { generateUadPdfArtifact, getLatestUadPdfArtifact } from "./uadPdfArtifacts.js";
import {
  generateUadSubmissionPackage,
  getLatestUadSubmissionPackage,
} from "./uadPackageArtifacts.js";
import { getUadXmlMappingSummary } from "./uadXml.js";
import { getUadSharedData } from "./sharedData.js";
import { listUadSketches, saveUadSketch } from "./sketches.js";
import { getLatestUadValidation, runLocalUadValidation } from "./validation.js";
import {
  createUadWorkfile,
  getUadSubjectSummary,
  getUadWorkfile,
  listUadWorkfiles,
} from "./workfiles.js";
import { createMobileAuthenticator } from "../mobile/auth.js";

function errorStatus(error) {
  const message = String(error?.message || "");
  if (message.includes("not_found")) return 404;
  if (message.includes("source_changed") || message.includes("adapter_changed") || message.includes("stale_revision") || message.includes("selection_changed")) return 409;
  if (message === "uad_validation_status_locked") return 409;
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
  if (message.startsWith("uad_completion_")) return 400;
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

export function createUadRouter({
  pool,
  storage,
  verifier,
  compliance = { enabled: false, providers: {} },
  enabled = false,
}) {
  const router = express.Router();
  const authenticateSigner = verifier?.verify
    ? createMobileAuthenticator({ pool, verifier })
    : (_req, res) => res.status(503).json({ error: "mobile_oidc_not_configured" });

  router.get("/capabilities", (_req, res) => {
    res.json({
      enabled,
      specification_release_key: CURRENT_UAD_RELEASE_KEY,
      initial_property_type: "traditional_single_family",
      object_storage: {
        provider: storage.provider,
        configured: storage.configured,
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
    });
  });

  router.use((req, res, next) => {
    if (enabled) return next();
    return res.status(503).json({ error: "uad_workspace_disabled" });
  });

  router.get("/accounts/:accountId/workfiles", async (req, res) => {
    try {
      const workfiles = await listUadWorkfiles(pool, req.params.accountId);
      res.json({ account_id: req.params.accountId, workfiles });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/accounts/:accountId/subject-summary", async (req, res) => {
    try {
      const subject = await getUadSubjectSummary(pool, req.params.accountId);
      res.json({ subject });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/accounts/:accountId/workfiles", async (req, res) => {
    try {
      const workfile = await createUadWorkfile(pool, req.params.accountId, req.body || {});
      res.status(201).json({ workfile });
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

  router.get("/workfiles/:workfileId/certification-readiness", authenticateSigner, async (req, res) => {
    try {
      const readiness = await getUadCertificationReadiness(pool, req.params.workfileId);
      if (!readiness.signers.some((signer) => signer.user_id === req.mobileAuth.userId)) {
        return res.status(403).json({ error: "uad_signature_access_denied" });
      }
      return res.json({ readiness });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/signatures", authenticateSigner, async (req, res) => {
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

  router.get("/workfiles/:workfileId/compliance", authenticateSigner, async (req, res) => {
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

  router.post("/workfiles/:workfileId/compliance/:provider", authenticateSigner, async (req, res) => {
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
      res.json(await applyUadCompletionSuggestions(
        pool,
        req.params.workfileId,
        req.body || {},
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
      const sketch = await saveUadSketch(pool, req.params.workfileId, req.body || {});
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
      await deleteUadAsset(pool, req.params.workfileId, req.params.assetId);
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
