import express from "express";

import { knownErrorCode, logBoundedFailure } from "../../security/boundedRouteErrors.js";
import {
  buildMarketConditionsAnalyses,
  marketConditionsErrorStatus,
  normalizeMarketAnalysisRequest,
} from "../../services/marketConditions.js";
import {
  isNeighborhoodProfileBusyError,
  marketAnalysisRequestKey,
  runNeighborhoodProfileOperation,
} from "../../services/neighborhoodProfileExecution.js";
import {
  buildRegressionStudy,
  regressionAnalysisErrorStatus,
} from "../../services/regressionAnalysis.js";
import {
  calculateDepreciatedCostAdjustment,
  depreciatedCostAdjustmentErrorStatus,
} from "../../util/depreciatedCostAdjustment.js";
import {
  buildSiteValuationStudy,
  siteValuationErrorStatus,
} from "../../services/siteValuation.js";
import {
  calculateQualitativeAnalysis,
} from "../../util/qualitativeAnalysis.js";
import {
  DEPRECIATED_COST_PUBLIC_ERRORS,
  MARKET_ANALYSIS_PUBLIC_ERRORS,
  MARKET_STUDY_PUBLIC_ERRORS,
} from "./studyPublicErrors.js";

const MARKET_ANALYSIS_BUSY_ERRORS = new Set([
  "neighborhood_profile_capacity_exceeded",
  "neighborhood_profile_queue_timeout",
]);

export function createValuationStudyRouter({
  pool,
  accountIdAllowed,
  requireCustomAccountScope,
  buildMarketAnalyses = buildMarketConditionsAnalyses,
  isMarketAnalysisBusyError = isNeighborhoodProfileBusyError,
  marketRequestKey = marketAnalysisRequestKey,
  normalizeMarketRequest = normalizeMarketAnalysisRequest,
  runMarketAnalysisOperation = runNeighborhoodProfileOperation,
  marketErrorStatus = marketConditionsErrorStatus,
  buildRegression = buildRegressionStudy,
  regressionErrorStatus = regressionAnalysisErrorStatus,
  calculateDepreciatedCost = calculateDepreciatedCostAdjustment,
  depreciatedCostErrorStatus = depreciatedCostAdjustmentErrorStatus,
  buildSiteValuation = buildSiteValuationStudy,
  siteErrorStatus = siteValuationErrorStatus,
  calculateQualitative = calculateQualitativeAnalysis,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("valuation_study_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("valuation_study_account_policy_required");
  }
  if (
    typeof requireCustomAccountScope !== "function"
    || typeof buildMarketAnalyses !== "function"
    || typeof isMarketAnalysisBusyError !== "function"
    || typeof marketRequestKey !== "function"
    || typeof normalizeMarketRequest !== "function"
    || typeof runMarketAnalysisOperation !== "function"
    || typeof marketErrorStatus !== "function"
    || typeof buildRegression !== "function"
    || typeof regressionErrorStatus !== "function"
    || typeof calculateDepreciatedCost !== "function"
    || typeof depreciatedCostErrorStatus !== "function"
    || typeof buildSiteValuation !== "function"
    || typeof siteErrorStatus !== "function"
    || typeof calculateQualitative !== "function"
  ) {
    throw new TypeError("valuation_study_dependency_required");
  }

  const router = express.Router();

  router.post("/api/sales/market-analysis", async (req, res) => {
    const request = {
      subjectAccountId: String(req.body?.subject_account_id || "").trim(),
      areaKeys: req.body?.area_keys,
      asOfDate: String(req.body?.as_of || "").trim(),
      periodMonths: req.body?.period_months ?? 24,
      customGeometry: req.body?.custom_geometry || null,
      marketContextOverride: req.body?.context_override || null,
    };
    if (!accountIdAllowed(request.subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (!await requireCustomAccountScope(
      req, res, request.subjectAccountId, req.body?.assignment_file_id, "read",
    )) return undefined;
    try {
      const normalizedRequest = normalizeMarketRequest(request);
      const result = await runMarketAnalysisOperation(
        marketRequestKey(normalizedRequest),
        () => buildMarketAnalyses(pool, {
          ...normalizedRequest,
          accountIdAllowed,
        }),
        // A full response can contain up to 1,000 mapped sales per selected
        // area. Share concurrent work, but never retain those large payloads.
        { allowCached: false, cacheResult: false },
      );
      return res.json(result);
    } catch (error) {
      const busyCode = knownErrorCode(error, MARKET_ANALYSIS_BUSY_ERRORS);
      if (busyCode && isMarketAnalysisBusyError(busyCode)) {
        res.set("Retry-After", "10");
        return res.status(503).json({ error: "market_analysis_busy" });
      }
      const message = knownErrorCode(error, MARKET_ANALYSIS_PUBLIC_ERRORS);
      const status = message ? marketErrorStatus(message) : 500;
      logBoundedFailure(logger, "/api/sales/market-analysis failed", error);
      return res.status(status).json({
        error: status >= 500 && message !== "market_spatial_support_not_ready"
          ? "market_analysis_failed"
          : message,
        ...(status < 500 && error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  router.post("/api/sales/regression-analysis", async (req, res) => {
    const subjectAccountId = String(req.body?.subject_account_id || "").trim();
    if (!accountIdAllowed(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (!await requireCustomAccountScope(
      req, res, subjectAccountId, req.body?.assignment_file_id, "read",
    )) return undefined;
    try {
      const result = await buildRegression(pool, {
        subjectAccountId,
        marketKey: String(req.body?.market_key || "city").trim(),
        asOfDate: String(req.body?.as_of || "").trim(),
        customGeometry: req.body?.custom_geometry || null,
        accountIdAllowed,
      });
      return res.json(result);
    } catch (error) {
      const message = knownErrorCode(error, MARKET_STUDY_PUBLIC_ERRORS);
      const status = message ? regressionErrorStatus(message) : 500;
      logBoundedFailure(logger, "/api/sales/regression-analysis failed", error);
      return res.status(status).json({ error: status >= 500 ? "regression_analysis_failed" : message });
    }
  });

  router.post("/api/sales/depreciated-cost-adjustment", (req, res) => {
    try {
      return res.json(calculateDepreciatedCost(req.body || {}));
    } catch (error) {
      const message = knownErrorCode(error, DEPRECIATED_COST_PUBLIC_ERRORS);
      const status = message ? depreciatedCostErrorStatus(message) : 500;
      if (status >= 500) logBoundedFailure(logger, "/api/sales/depreciated-cost-adjustment failed", error);
      return res.status(status).json({ error: status >= 500 ? "depreciated_cost_adjustment_failed" : message });
    }
  });

  router.post("/api/sales/site-valuation", async (req, res) => {
    const subjectAccountId = String(req.body?.subject_account_id || "").trim();
    if (!accountIdAllowed(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (!await requireCustomAccountScope(
      req, res, subjectAccountId, req.body?.assignment_file_id, "read",
    )) return undefined;
    try {
      const result = await buildSiteValuation(pool, {
        subjectAccountId,
        marketKey: String(req.body?.market_key || "city").trim(),
        asOfDate: String(req.body?.as_of || "").trim(),
        customGeometry: req.body?.custom_geometry || null,
        accountIdAllowed,
      });
      return res.json(result);
    } catch (error) {
      const message = knownErrorCode(error, MARKET_STUDY_PUBLIC_ERRORS);
      const status = message ? siteErrorStatus(message) : 500;
      logBoundedFailure(logger, "/api/sales/site-valuation failed", error);
      return res.status(status).json({ error: status >= 500 ? "site_valuation_failed" : message });
    }
  });

  router.post("/api/sales/qualitative-analysis", (req, res) => {
    try {
      return res.json(calculateQualitative(req.body || {}, req.body?.comparables || []));
    } catch (error) {
      // This calculator has no public validation exceptions; unknown failures
      // must not be reclassified by an attacker-controlled `invalid_` prefix.
      logBoundedFailure(logger, "/api/sales/qualitative-analysis failed", error);
      return res.status(500).json({ error: "qualitative_analysis_failed" });
    }
  });

  return router;
}
