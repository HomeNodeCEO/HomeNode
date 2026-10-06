import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import { knownErrorCode, logBoundedFailure } from "../../security/boundedRouteErrors.js";
import {
  generateNeighborhoodBoundary,
  getLatestNeighborhoodBoundary,
  reviewNeighborhoodBoundary,
} from "../../services/neighborhoodBoundaryEngine.js";
import { getNeighborhoodEngineReadiness } from "../../services/neighborhoodEngineReadiness.js";
import { createNearbySchoolLookup } from "../../services/nearbySchool.js";
import {
  generateNeighborhoodRelevance,
  getLatestNeighborhoodRelevance,
} from "../../services/neighborhoodRelevanceEngine.js";

function authenticatedReviewer(req) {
  const userId = String(req.mobileAuth?.userId || "").trim();
  if (!userId) throw new Error("authentication_required");
  return String(
    req.mobileAuth?.displayName || req.mobileAuth?.email || userId,
  ).trim() || userId;
}

export function createNeighborhoodRouter({
  pool,
  ensureAvailable,
  requirePlatformAdministrator,
  requireCustomAccountScope,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  getReadiness = getNeighborhoodEngineReadiness,
  getBoundary = getLatestNeighborhoodBoundary,
  generateBoundary = generateNeighborhoodBoundary,
  reviewBoundary = reviewNeighborhoodBoundary,
  getRelevance = getLatestNeighborhoodRelevance,
  generateRelevance = generateNeighborhoodRelevance,
  nearbySchool,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("neighborhood_router_pool_required");
  }
  const dependencies = [
    ensureAvailable,
    requirePlatformAdministrator,
    requireCustomAccountScope,
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
  const lookupSchool = nearbySchool ?? createNearbySchoolLookup({ pool });
  if (typeof lookupSchool !== 'function') throw new TypeError('neighborhood_router_dependency_required');
  router.use((_req, res, next) => {
    res.set("cache-control", "no-store");
    next();
  });

  router.get("/api/accounts/:id/neighborhood-summary-school", async (req, res) => {
    try {
      const accountId = await resolveAccountId(pool, String(req.params.id || "").trim());
      const assignmentFileId = normalizeFileId(req.query.assignment_file_id);
      if (!assignmentFileId) return res.status(400).json({ error: "invalid_assignment_file" });
      if (!await requireCustomAccountScope(req, res, accountId, assignmentFileId, "read")) return undefined;
      const school = await lookupSchool({ accountId });
      if (req.aborted || res.destroyed) return undefined;
      // Recheck assignment ownership/access after the bounded public lookup.
      if (!await requireCustomAccountScope(req, res, accountId, assignmentFileId, "read")) return undefined;
      return res.json({ account_id: accountId, assignment_file_id: String(assignmentFileId), ...school });
    } catch (error) {
      const code = knownErrorCode(error, new Set(["account_not_found", "invalid_account_id", "invalid_assignment_file"]));
      if (!code) logBoundedFailure(logger, "neighborhood summary school lookup failed", error);
      return res.status(code === "account_not_found" ? 404 : code ? 400 : 503)
        .json({ error: code || "neighborhood_summary_school_unavailable" });
    }
  });

  /** Audit locally stored inputs for the boundary and relevance engines. */
  router.get("/api/neighborhood-engine/readiness", async (req, res) => {
    if (!requirePlatformAdministrator(req, res)) return undefined;
    try {
      await ensureAvailable();
      return res.json(await getReadiness(pool, {
        county: req.query.county || "Dallas",
      }));
    } catch (error) {
      logBoundedFailure(logger, "/api/neighborhood-engine/readiness failed", error);
      const code = knownErrorCode(error, new Set(["neighborhood_engine_county_not_configured"]));
      if (code) {
        return res.status(400).json({ error: code });
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
      if (!await requireCustomAccountScope(
        req, res, accountId, assignmentFileId, "read",
      )) return undefined;
      const assessment = await getBoundary(pool, { accountId, assignmentFileId });
      return res.json({ account_id: accountId, assessment });
    } catch (error) {
      const code = knownErrorCode(error, new Set([
        "account_not_found", "invalid_account_id", "invalid_assignment_file",
      ]));
      const status = code === "account_not_found" ? 404
        : code ? 400
          : 500;
      if (status === 500) logBoundedFailure(logger, "/api/accounts/:id/neighborhood-boundary failed", error);
      return res.status(status).json({ error: code || "neighborhood_boundary_lookup_failed" });
    }
  });

  /** Generate and persist a broad descriptive neighborhood from local mirrors. */
  router.post("/api/accounts/:id/neighborhood-boundary/generate", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      if (!await requireCustomAccountScope(
        req, res, accountId, assignmentFileId, "write",
      )) return undefined;
      const assessment = await generateBoundary(pool, {
        accountId,
        assignmentFileId,
        searchProfileKey: req.body?.search_profile,
        discoveryRadiusMiles: req.body?.discovery_radius_miles,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      logBoundedFailure(logger, "/api/accounts/:id/neighborhood-boundary/generate failed", error);
      const clientErrors = new Set([
        "invalid_account_id",
        "invalid_assignment_file",
        "invalid_neighborhood_search_profile",
        "invalid_neighborhood_discovery_radius",
      ]);
      const code = knownErrorCode(error, new Set([
        ...clientErrors, "account_not_found", "subject_parcel_geometry_unavailable",
      ]));
      const status = code === "account_not_found" ||
        code === "subject_parcel_geometry_unavailable" ? 404
        : clientErrors.has(code) ? 400
          : 500;
      return res.status(status).json({ error: code || "neighborhood_boundary_generation_failed" });
    }
  });

  /** Preserve an assignment-specific appraiser confirmation in the audit table. */
  router.patch("/api/accounts/:id/neighborhood-boundary/:assessmentId", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      if (!await requireCustomAccountScope(
        req, res, accountId, assignmentFileId, "write",
      )) return undefined;
      const assessment = await reviewBoundary(pool, {
        accountId,
        assessmentId: req.params.assessmentId,
        assignmentFileId,
        confirmed: req.body?.confirmed,
        reviewer: authenticatedReviewer(req),
        notes: req.body?.notes,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      const clientErrors = new Set([
        "invalid_account_id",
        "invalid_assignment_file",
        "invalid_neighborhood_boundary_assessment",
        "invalid_neighborhood_boundary_review",
        "invalid_neighborhood_boundary_reviewer",
        "neighborhood_boundary_notes_too_long",
      ]);
      const code = knownErrorCode(error, new Set([
        ...clientErrors, "account_not_found", "neighborhood_boundary_assessment_not_found",
      ]));
      const status = code === "account_not_found" ||
        code === "neighborhood_boundary_assessment_not_found" ? 404
        : clientErrors.has(code) ? 400
          : 500;
      if (status === 500) logBoundedFailure(logger, "/api/accounts/:id/neighborhood-boundary review failed", error);
      return res.status(status).json({ error: code || "neighborhood_boundary_review_failed" });
    }
  });

  /** Load the latest independent relevant-property population summary. */
  router.get("/api/accounts/:id/neighborhood-relevance", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.query.assignment_file_id);
      if (!await requireCustomAccountScope(
        req, res, accountId, assignmentFileId, "read",
      )) return undefined;
      const assessment = await getRelevance(pool, { accountId, assignmentFileId });
      return res.json({ account_id: accountId, assessment });
    } catch (error) {
      const code = knownErrorCode(error, new Set([
        "account_not_found", "invalid_account_id", "invalid_assignment_file",
      ]));
      const status = code === "account_not_found" ? 404
        : code ? 400
          : 500;
      if (status === 500) logBoundedFailure(logger, "/api/accounts/:id/neighborhood-relevance failed", error);
      return res.status(status).json({ error: code || "neighborhood_relevance_lookup_failed" });
    }
  });

  /** Score the broad parcel population and persist reviewable exclusions. */
  router.post("/api/accounts/:id/neighborhood-relevance/generate", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    try {
      const accountId = await resolveAccountId(pool, requestedId);
      const assignmentFileId = normalizeFileId(req.body?.assignment_file_id);
      if (!await requireCustomAccountScope(
        req, res, accountId, assignmentFileId, "write",
      )) return undefined;
      const assessment = await generateRelevance(pool, {
        accountId,
        assignmentFileId,
        boundaryAssessmentId: req.body?.boundary_assessment_id,
      });
      return res.json({ ok: true, account_id: accountId, assessment });
    } catch (error) {
      logBoundedFailure(logger, "/api/accounts/:id/neighborhood-relevance/generate failed", error);
      const clientErrors = new Set([
        "invalid_account_id",
        "invalid_assignment_file",
        "invalid_neighborhood_boundary_assessment",
        "neighborhood_boundary_required",
      ]);
      const code = knownErrorCode(error, new Set([
        ...clientErrors, "account_not_found", "neighborhood_relevance_candidates_unavailable",
      ]));
      const status = code === "account_not_found" ? 404
        : clientErrors.has(code) ? 400
          : code === "neighborhood_relevance_candidates_unavailable" ? 422
            : 500;
      return res.status(status).json({ error: code || "neighborhood_relevance_generation_failed" });
    }
  });

  return router;
}
