import express from "express";

import { loadBoundaryStreetNames } from "../../services/boundaryStreets.js";
import {
  buildMarketConditionsAnalyses,
  marketConditionsErrorStatus,
} from "../../services/marketConditions.js";
import {
  buildNeighborhoodLandUseAnalysis,
  neighborhoodLandUseErrorStatus,
} from "../../services/neighborhoodLandUse.js";
import {
  compactNeighborhoodProfileResponse,
  isNeighborhoodProfileBusyError,
  neighborhoodProfileRequestKey,
  runNeighborhoodProfileOperation,
} from "../../services/neighborhoodProfileExecution.js";

export function createNeighborhoodAnalysisRouter({
  pool,
  accountIdAllowed,
  buildMarketAnalyses = buildMarketConditionsAnalyses,
  marketErrorStatus = marketConditionsErrorStatus,
  loadBoundaryStreets = loadBoundaryStreetNames,
  compactProfileResponse = compactNeighborhoodProfileResponse,
  isProfileBusyError = isNeighborhoodProfileBusyError,
  profileRequestKey = neighborhoodProfileRequestKey,
  runProfileOperation = runNeighborhoodProfileOperation,
  buildLandUseAnalysis = buildNeighborhoodLandUseAnalysis,
  landUseErrorStatus = neighborhoodLandUseErrorStatus,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("neighborhood_analysis_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("neighborhood_analysis_account_policy_required");
  }
  if (
    typeof buildMarketAnalyses !== "function"
    || typeof marketErrorStatus !== "function"
    || typeof loadBoundaryStreets !== "function"
    || typeof compactProfileResponse !== "function"
    || typeof isProfileBusyError !== "function"
    || typeof profileRequestKey !== "function"
    || typeof runProfileOperation !== "function"
    || typeof buildLandUseAnalysis !== "function"
    || typeof landUseErrorStatus !== "function"
  ) {
    throw new TypeError("neighborhood_analysis_dependency_required");
  }

  const router = express.Router();

  /**
   * Refreshes the appraiser-defined neighborhood ranges, a citywide comparison,
   * and a reviewable north/east/south/west road summary for the drawn boundary.
   */
  router.post("/api/sales/neighborhood-profile", async (req, res) => {
    const request = {
      subjectAccountId: String(req.body?.subject_account_id || "").trim(),
      asOfDate: String(req.body?.as_of || "").trim(),
      periodMonths: req.body?.period_months ?? 24,
      customGeometry: req.body?.custom_geometry || null,
      marketContextOverride: req.body?.context_override || null,
      forceRefresh: req.body?.force_refresh === true,
    };
    try {
      const response = await runProfileOperation(
        profileRequestKey(request),
        async () => {
          const market = await buildMarketAnalyses(pool, {
            subjectAccountId: request.subjectAccountId,
            areaKeys: ["custom", "city"],
            asOfDate: request.asOfDate,
            periodMonths: request.periodMonths,
            customGeometry: request.customGeometry,
            marketContextOverride: request.marketContextOverride,
            accountIdAllowed,
          });
          let boundaryStreets = null;
          let boundaryStreetWarning = null;
          try {
            boundaryStreets = await loadBoundaryStreets(pool, request.customGeometry);
          } catch (error) {
            boundaryStreetWarning = error?.message || "boundary_street_lookup_failed";
            logger.warn?.("/api/sales/neighborhood-profile street lookup failed", error);
          }
          return compactProfileResponse({
            ...market,
            boundary_streets: boundaryStreets,
            boundary_street_warning: boundaryStreetWarning,
          });
        },
        { allowCached: !request.forceRefresh },
      );
      return res.json(response);
    } catch (error) {
      const message = error?.message || "neighborhood_profile_failed";
      if (isProfileBusyError(message)) {
        res.set("Retry-After", "10");
        return res.status(503).json({ error: "neighborhood_profile_busy" });
      }
      logger.error?.("/api/sales/neighborhood-profile failed", error);
      return res.status(marketErrorStatus(message)).json({
        error: message,
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  /**
   * Calculates present land-use percentages from every official DCAD parcel
   * intersecting the saved appraiser-defined polygon.
   */
  router.post("/api/sales/neighborhood-land-use", async (req, res) => {
    try {
      const result = await buildLandUseAnalysis(pool, {
        subjectAccountId: String(req.body?.subject_account_id || "").trim(),
        customGeometry: req.body?.custom_geometry || null,
      });
      return res.json(result);
    } catch (error) {
      const message = error?.message || "neighborhood_land_use_analysis_failed";
      logger.error?.("/api/sales/neighborhood-land-use failed", error);
      return res.status(landUseErrorStatus(message)).json({
        error: message,
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  return router;
}
