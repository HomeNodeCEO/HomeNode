import express from "express";

import { safeOperationalErrorCode } from "../../security/safeOperationalErrorCode.js";
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
  requireCustomAccountScope,
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
    typeof requireCustomAccountScope !== "function"
    || typeof buildMarketAnalyses !== "function"
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
    if (!accountIdAllowed(request.subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (!await requireCustomAccountScope(
      req, res, request.subjectAccountId, req.body?.assignment_file_id, "read",
    )) return undefined;
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
            boundaryStreetWarning = "boundary_street_lookup_failed";
            logger.warn?.(
              "/api/sales/neighborhood-profile street lookup failed",
              safeOperationalErrorCode(error),
            );
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
      const status = marketErrorStatus(message);
      logger.error?.("/api/sales/neighborhood-profile failed", safeOperationalErrorCode(error));
      return res.status(status).json({
        error: status >= 500 && message !== "market_spatial_support_not_ready"
          ? "neighborhood_profile_failed"
          : message,
        ...(status < 500 && error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  /**
   * Calculates present land-use percentages from every official DCAD parcel
   * intersecting the saved appraiser-defined polygon.
   */
  router.post("/api/sales/neighborhood-land-use", async (req, res) => {
    const subjectAccountId = String(req.body?.subject_account_id || "").trim();
    if (!accountIdAllowed(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (!await requireCustomAccountScope(
      req, res, subjectAccountId, req.body?.assignment_file_id, "read",
    )) return undefined;
    try {
      const result = await buildLandUseAnalysis(pool, {
        subjectAccountId,
        customGeometry: req.body?.custom_geometry || null,
      });
      return res.json(result);
    } catch (error) {
      const message = error?.message || "neighborhood_land_use_analysis_failed";
      const status = landUseErrorStatus(message);
      const publicProviderCode = /^dcad_land_use_query_(?:timeout|unavailable|http_(?:[1-5]\d\d|unknown)|provider_(?:\d{1,6}|error))$/.test(message);
      logger.error?.("/api/sales/neighborhood-land-use failed", safeOperationalErrorCode(error));
      return res.status(status).json({
        error: status >= 500 && !publicProviderCode
          ? "neighborhood_land_use_analysis_failed"
          : message,
        ...(status < 500 && error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  return router;
}
