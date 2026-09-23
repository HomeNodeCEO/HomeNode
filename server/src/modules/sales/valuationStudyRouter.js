import express from "express";

import { safeOperationalErrorCode } from "../../security/safeOperationalErrorCode.js";
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
  qualitativeAnalysisErrorStatus,
} from "../../util/qualitativeAnalysis.js";

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
  qualitativeErrorStatus = qualitativeAnalysisErrorStatus,
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
    || typeof qualitativeErrorStatus !== "function"
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
      const message = error?.message || "market_analysis_failed";
      if (isMarketAnalysisBusyError(message)) {
        res.set("Retry-After", "10");
        return res.status(503).json({ error: "market_analysis_busy" });
      }
      const status = marketErrorStatus(message);
      logger.error?.("/api/sales/market-analysis failed", safeOperationalErrorCode(error));
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
      const message = error?.message || "regression_analysis_failed";
      const status = regressionErrorStatus(message);
      logger.error?.("/api/sales/regression-analysis failed", safeOperationalErrorCode(error));
      return res.status(status).json({ error: status >= 500 ? "regression_analysis_failed" : message });
    }
  });

  router.post("/api/sales/depreciated-cost-adjustment", (req, res) => {
    try {
      return res.json(calculateDepreciatedCost(req.body || {}));
    } catch (error) {
      const message = error?.message || "depreciated_cost_adjustment_failed";
      const status = depreciatedCostErrorStatus(message);
      if (status >= 500) logger.error?.("/api/sales/depreciated-cost-adjustment failed", safeOperationalErrorCode(error));
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
      const message = error?.message || "site_valuation_failed";
      const status = siteErrorStatus(message);
      logger.error?.("/api/sales/site-valuation failed", safeOperationalErrorCode(error));
      return res.status(status).json({ error: status >= 500 ? "site_valuation_failed" : message });
    }
  });

  router.post("/api/sales/qualitative-analysis", (req, res) => {
    try {
      return res.json(calculateQualitative(req.body || {}, req.body?.comparables || []));
    } catch (error) {
      const message = error?.message || "qualitative_analysis_failed";
      const status = qualitativeErrorStatus(message);
      if (status >= 500) logger.error?.("/api/sales/qualitative-analysis failed", safeOperationalErrorCode(error));
      return res.status(status).json({ error: status >= 500 ? "qualitative_analysis_failed" : message });
    }
  });

  return router;
}
