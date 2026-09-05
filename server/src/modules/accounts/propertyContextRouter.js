import express from "express";

import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import {
  analyzePropertyContext,
  getPropertyContextStatus,
  getStoredPropertyContext,
  propertyContextErrorStatus,
  savePropertyContextReview,
} from "../../services/propertyContext.js";

function requirePool(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("property_context_pool_required");
  }
}

export function createPropertyContextStatusRouter({
  pool,
  ensureAvailable,
  requirePlatformAdministrator,
  getStatus = getPropertyContextStatus,
  logger = console,
} = {}) {
  requirePool(pool);
  if (
    typeof ensureAvailable !== "function"
    || typeof requirePlatformAdministrator !== "function"
    || typeof getStatus !== "function"
  ) {
    throw new TypeError("property_context_status_dependency_required");
  }

  const router = express.Router();

  /** Report local mirror freshness without contacting an external service. */
  router.get("/api/property-context/status", async (req, res) => {
    if (!requirePlatformAdministrator(req, res)) return undefined;
    try {
      await ensureAvailable();
      return res.json(await getStatus(pool));
    } catch (error) {
      logger.error?.("/api/property-context/status failed", error);
      return res.status(500).json({ error: "property_context_status_failed" });
    }
  });

  return router;
}

export function createAccountPropertyContextRouter({
  pool,
  ensureAvailable,
  requireWorkflowAccess,
  requireAssignmentAccess,
  authenticationRequired,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  getStoredContext = getStoredPropertyContext,
  analyzeContext = analyzePropertyContext,
  saveContextReview = savePropertyContextReview,
  errorStatus = propertyContextErrorStatus,
  logger = console,
} = {}) {
  requirePool(pool);
  const dependencies = [
    ensureAvailable,
    requireWorkflowAccess,
    requireAssignmentAccess,
    resolveAccountId,
    normalizeFileId,
    getStoredContext,
    analyzeContext,
    saveContextReview,
    errorStatus,
  ];
  if (dependencies.some((dependency) => typeof dependency !== "function")) {
    throw new TypeError("account_property_context_dependency_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("account_property_context_authentication_mode_required");
  }

  const router = express.Router();

  /** Load the latest saved property-context and complexity assessment. */
  router.get("/api/accounts/:id/property-context", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return undefined;
    const requestedId = String(req.params.id || "").trim();
    try {
      const assignmentFileId = normalizeFileId(req.query.assignment_file_id);
      if (!assignmentFileId) {
        return res.status(400).json({ error: "assignment_file_required" });
      }
      await ensureAvailable();
      const accountId = await resolveAccountId(pool, requestedId);
      if (!await requireAssignmentAccess(req, res, accountId, assignmentFileId, "read")) {
        return undefined;
      }
      const assessment = await getStoredContext(pool, {
        accountId,
        assignmentFileId,
      });
      return res.json({ account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "property_context_lookup_failed";
      return res.status(errorStatus(message)).json({ error: message });
    }
  });

  /** Analyze locally stored CAD, property-characteristic, and road data. */
  router.post("/api/accounts/:id/property-context/analyze", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "write")) return undefined;
    const requestedId = String(req.params.id || "").trim();
    try {
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      if (!assignmentFileId) {
        return res.status(400).json({ error: "assignment_file_required" });
      }
      await ensureAvailable();
      const accountId = await resolveAccountId(pool, requestedId);
      if (!await requireAssignmentAccess(req, res, accountId, assignmentFileId, "write")) {
        return undefined;
      }
      const assessment = await analyzeContext(pool, {
        accountId,
        assignmentFileId,
        customGeometry: req.body?.custom_geometry || null,
        geography: req.body?.geography || null,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "property_context_analysis_failed";
      logger.error?.("/api/accounts/:id/property-context/analyze failed", error);
      return res.status(errorStatus(message)).json({ error: message });
    }
  });

  /** Save an appraiser confirmation or override without rewriting source data. */
  router.patch("/api/accounts/:id/property-context", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "sign")) return undefined;
    const requestedId = String(req.params.id || "").trim();
    try {
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      if (!assignmentFileId) {
        return res.status(400).json({ error: "assignment_file_required" });
      }
      await ensureAvailable();
      const accountId = await resolveAccountId(pool, requestedId);
      if (!await requireAssignmentAccess(req, res, accountId, assignmentFileId, "sign")) {
        return undefined;
      }
      const review = {
        ...req.body,
        reviewer: req.mobileAuth?.displayName
          || req.mobileAuth?.email
          || req.mobileAuth?.userId,
      };
      const assessment = await saveContextReview(pool, {
        accountId,
        assignmentFileId,
        review,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "property_context_review_failed";
      logger.error?.("/api/accounts/:id/property-context review failed", error);
      return res.status(errorStatus(message)).json({ error: message });
    }
  });

  return router;
}
