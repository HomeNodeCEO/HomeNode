import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  generateNeighborhoodBoundary,
  getLatestNeighborhoodBoundary,
  reviewNeighborhoodBoundary,
} from "../../services/neighborhoodBoundaryEngine.js";
import { getNeighborhoodEngineReadiness } from "../../services/neighborhoodEngineReadiness.js";
import {
  generateNeighborhoodRelevance,
  getLatestNeighborhoodRelevance,
} from "../../services/neighborhoodRelevanceEngine.js";

export function createNeighborhoodRouter({
  pool,
  ensureAvailable,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  getReadiness = getNeighborhoodEngineReadiness,
  getBoundary = getLatestNeighborhoodBoundary,
  generateBoundary = generateNeighborhoodBoundary,
  reviewBoundary = reviewNeighborhoodBoundary,
  getRelevance = getLatestNeighborhoodRelevance,
  generateRelevance = generateNeighborhoodRelevance,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("neighborhood_router_pool_required");
  }
  const dependencies = [
    ensureAvailable,
    resolveAccountId,
    normalizeFileId,
    getReadiness,
    getBoundary,
    generateBoundary,
    reviewBoundary,
    getRelevance,
    generateRelevance,
  ];
  if (dependencies.some((dependency) => typeof dependency !== "function")) {
    throw new TypeError("neighborhood_router_dependency_required");
  }

  const router = express.Router();

  /** Audit locally stored inputs for the boundary and relevance engines. */
  router.get("/api/neighborhood-engine/readiness", async (req, res) => {
    try {
      await ensureAvailable();
      return res.json(await getReadiness(pool, {
        county: req.query.county || "Dallas",
      }));
    } catch (error) {
      logger.error?.("/api/neighborhood-engine/readiness failed", error);
      if (error?.message === "neighborhood_engine_county_not_configured") {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: "neighborhood_engine_readiness_failed" });
    }
  });

  /** Load the latest generated or appraiser-confirmed broad boundary. */
  router.get("/api/accounts/:id/neighborhood-boundary", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.query.assignment_file_id);
      const assessment = await getBoundary(pool, { accountId, assignmentFileId });
      return res.json({ account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "neighborhood_boundary_lookup_failed";
      const status = message === "account_not_found" ? 404
        : ["invalid_account_id", "invalid_assignment_file"].includes(message) ? 400
          : 500;
      return res.status(status).json({ error: message });
    }
  });

  /** Generate and persist a broad descriptive neighborhood from local mirrors. */
  router.post("/api/accounts/:id/neighborhood-boundary/generate", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      const assessment = await generateBoundary(pool, {
        accountId,
        assignmentFileId,
        searchProfileKey: req.body?.search_profile,
        discoveryRadiusMiles: req.body?.discovery_radius_miles,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "neighborhood_boundary_generation_failed";
      logger.error?.("/api/accounts/:id/neighborhood-boundary/generate failed", error);
      const clientErrors = new Set([
        "invalid_account_id",
        "invalid_assignment_file",
        "invalid_neighborhood_search_profile",
        "invalid_neighborhood_discovery_radius",
      ]);
      const status = message === "account_not_found" ||
        message === "subject_parcel_geometry_unavailable" ? 404
        : clientErrors.has(message) ? 400
          : 500;
      return res.status(status).json({ error: message });
    }
  });

  /** Preserve an assignment-specific appraiser confirmation in the audit table. */
  router.patch("/api/accounts/:id/neighborhood-boundary/:assessmentId", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      const assessment = await reviewBoundary(pool, {
        accountId,
        assessmentId: req.params.assessmentId,
        assignmentFileId,
        confirmed: req.body?.confirmed,
        reviewer: req.body?.reviewer,
        notes: req.body?.notes,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "neighborhood_boundary_review_failed";
      const clientErrors = new Set([
        "invalid_account_id",
        "invalid_assignment_file",
        "invalid_neighborhood_boundary_assessment",
        "invalid_neighborhood_boundary_review",
        "invalid_neighborhood_boundary_reviewer",
        "neighborhood_boundary_notes_too_long",
      ]);
      const status = message === "account_not_found" ||
        message === "neighborhood_boundary_assessment_not_found" ? 404
        : clientErrors.has(message) ? 400
          : 500;
      return res.status(status).json({ error: message });
    }
  });

  /** Load the latest independent relevant-property population summary. */
  router.get("/api/accounts/:id/neighborhood-relevance", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.query.assignment_file_id);
      const assessment = await getRelevance(pool, { accountId, assignmentFileId });
      return res.json({ account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "neighborhood_relevance_lookup_failed";
      return res.status(message === "account_not_found" ? 404
        : ["invalid_account_id", "invalid_assignment_file"].includes(message) ? 400
          : 500).json({ error: message });
    }
  });

  /** Score the broad parcel population and persist reviewable exclusions. */
  router.post("/api/accounts/:id/neighborhood-relevance/generate", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      const assessment = await generateRelevance(pool, {
        accountId,
        assignmentFileId,
        boundaryAssessmentId: req.body?.boundary_assessment_id,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      const message = error?.message || "neighborhood_relevance_generation_failed";
      logger.error?.("/api/accounts/:id/neighborhood-relevance/generate failed", error);
      const clientErrors = new Set([
        "invalid_account_id",
        "invalid_assignment_file",
        "invalid_neighborhood_boundary_assessment",
        "neighborhood_boundary_required",
      ]);
      const status = message === "account_not_found" ? 404
        : clientErrors.has(message) ? 400
          : message === "neighborhood_relevance_candidates_unavailable" ? 422
            : 500;
      return res.status(status).json({ error: message });
    }
  });

  return router;
}
