import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { hasApplicationPermission } from "../../security/applicationAccess.js";
import { decideAssignmentAccess } from "../../security/assignmentAccess.js";
import {
  getDesktopPropertyTaxEvidenceVersion,
  getDesktopPropertyTaxFile,
  saveDesktopPropertyTaxFile,
} from "./desktopPropertyTax.js";
import { savePropertyTaxInspectionSketch } from "./desktopSketches.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;
const WORKFLOW = "property_tax_protest";

export function createDesktopPropertyTaxRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  requireWorkflowAccess,
  requireEditor,
  authenticationRequired,
  resolveAccountId = resolveCanonicalAccountId,
  hasPermission = hasApplicationPermission,
  decideAccess = decideAssignmentAccess,
  getFile = getDesktopPropertyTaxFile,
  getEvidenceVersion = getDesktopPropertyTaxEvidenceVersion,
  saveFile = saveDesktopPropertyTaxFile,
  saveSketch = savePropertyTaxInspectionSketch,
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
  ) {
    throw new TypeError("desktop_property_tax_service_required");
  }

  const router = express.Router();

  function organizationIdsForRead(req) {
    if (!authenticationRequired || !req.mobileAuth) return null;
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

  /** Load the current canonical Property Tax Protest file and accepted mobile evidence. */
  router.get("/api/accounts/:id/property-tax-protest", async (req, res) => {
    if (!requireWorkflowAccess(req, res, WORKFLOW, "read")) return undefined;
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    try {
      await Promise.all([accountQualityReady, propertyEnrichmentReady]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const file = await getFile(
        pool,
        canonicalId,
        req.query.file_id || null,
        { organizationIds: organizationIdsForRead(req) },
      );
      if (
        authenticationRequired
        && req.mobileAuth
        && file
        && !decideAccess(req.mobileAuth, file, "read")
      ) {
        return res.status(403).json({ error: "property_tax_protest_access_denied" });
      }
      return res.json({ account_id: canonicalId, file });
    } catch (error) {
      if (String(error?.message || "").startsWith("invalid_")) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("property tax protest load failed", error);
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
        { organizationIds: organizationIdsForRead(req) },
      );
      if (!file) {
        return res.status(404).json({ error: "property_tax_protest_file_not_found" });
      }
      if (
        authenticationRequired
        && req.mobileAuth
        && !decideAccess(req.mobileAuth, file, "read")
      ) return res.status(403).json({ error: "property_tax_protest_access_denied" });
      return res.set("cache-control", "no-store").json({ account_id: canonicalId, file });
    } catch (error) {
      if (String(error?.message || "").startsWith("invalid_")) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("property tax protest evidence version failed", error);
      return res.status(500).json({ error: "property_tax_protest_evidence_version_failed" });
    }
  });

  /** Save a reviewed desktop protest revision without replacing prior history. */
  router.patch("/api/accounts/:id/property-tax-protest/:fileId", async (req, res) => {
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    if (!requireEditor(req, res)) return undefined;
    try {
      await Promise.all([accountQualityReady, propertyEnrichmentReady]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const existingFile = await getFile(pool, canonicalId, req.params.fileId);
      if (
        authenticationRequired
        && req.mobileAuth
        && (!existingFile || !decideAccess(req.mobileAuth, existingFile, "write"))
      ) {
        return res.status(existingFile ? 403 : 404).json({
          error: existingFile
            ? "property_tax_protest_access_denied"
            : "property_tax_protest_file_not_found",
        });
      }
      const file = await saveFile(pool, canonicalId, req.params.fileId, req.body || {});
      return res.json({ ok: true, file });
    } catch (error) {
      if (error?.message === "property_tax_protest_revision_conflict") {
        return res.status(409).json({
          error: error.message,
          current_revision: error.currentRevision,
        });
      }
      if (error?.message === "property_tax_protest_file_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if (String(error?.message || "").startsWith("invalid_")) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("property tax protest save failed", error);
      return res.status(500).json({ error: "property_tax_protest_save_failed" });
    }
  });

  /** Revise the Property Tax Protest sketch through the authenticated desktop workflow. */
  router.patch("/api/accounts/:id/property-tax-protest/:fileId/sketch", async (req, res) => {
    const requestedId = requestedAccountId(req, res);
    if (!requestedId) return undefined;
    if (!requireEditor(req, res)) return undefined;
    try {
      await Promise.all([accountQualityReady, propertyEnrichmentReady]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const existingFile = await getFile(pool, canonicalId, req.params.fileId);
      if (
        authenticationRequired
        && req.mobileAuth
        && (!existingFile || !decideAccess(req.mobileAuth, existingFile, "write"))
      ) {
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
        req.mobileAuth?.userId || null,
      );
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error?.message === "property_tax_protest_sketch_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if (error?.message === "sketch_revision_conflict") {
        return res.status(409).json({
          error: error.message,
          current_revision: error.currentRevision,
        });
      }
      if (
        String(error?.message || "").startsWith("invalid_")
        || String(error?.message || "").startsWith("duplicate_")
        || error?.message === "sketch_not_ready_for_confirmation"
        || error?.message === "sketch_operation_conflict"
      ) {
        return res.status(error?.message === "sketch_operation_conflict" ? 409 : 400)
          .json({ error: error.message });
      }
      logger.error?.("property tax protest sketch review failed", error);
      return res.status(500).json({ error: "property_tax_protest_sketch_update_failed" });
    }
  });

  return router;
}
