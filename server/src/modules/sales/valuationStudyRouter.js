import express from "express";

import {
  buildMarketConditionsAnalyses,
  marketConditionsErrorStatus,
} from "../../services/marketConditions.js";
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
  buildMarketAnalyses = buildMarketConditionsAnalyses,
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
    typeof buildMarketAnalyses !== "function"
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
    try {
      const result = await buildMarketAnalyses(pool, {
        subjectAccountId: String(req.body?.subject_account_id || "").trim(),
        areaKeys: req.body?.area_keys,
        asOfDate: String(req.body?.as_of || "").trim(),
        periodMonths: req.body?.period_months ?? 24,
        customGeometry: req.body?.custom_geometry || null,
        marketContextOverride: req.body?.context_override || null,
        accountIdAllowed,
      });
      return res.json(result);
    } catch (error) {
      const message = error?.message || "market_analysis_failed";
      logger.error?.("/api/sales/market-analysis failed", error);
      return res.status(marketErrorStatus(message)).json({
        error: message,
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  router.post("/api/sales/regression-analysis", async (req, res) => {
    try {
      const result = await buildRegression(pool, {
        subjectAccountId: String(req.body?.subject_account_id || "").trim(),
        marketKey: String(req.body?.market_key || "city").trim(),
        asOfDate: String(req.body?.as_of || "").trim(),
        customGeometry: req.body?.custom_geometry || null,
        accountIdAllowed,
      });
      return res.json(result);
    } catch (error) {
      const message = error?.message || "regression_analysis_failed";
      logger.error?.("/api/sales/regression-analysis failed", error);
      return res.status(regressionErrorStatus(message)).json({ error: message });
    }
  });

  router.post("/api/sales/depreciated-cost-adjustment", (req, res) => {
    try {
      return res.json(calculateDepreciatedCost(req.body || {}));
    } catch (error) {
      const message = error?.message || "depreciated_cost_adjustment_failed";
      return res.status(depreciatedCostErrorStatus(message)).json({ error: message });
    }
  });

  router.post("/api/sales/site-valuation", async (req, res) => {
    try {
      const result = await buildSiteValuation(pool, {
        subjectAccountId: String(req.body?.subject_account_id || "").trim(),
        marketKey: String(req.body?.market_key || "city").trim(),
        asOfDate: String(req.body?.as_of || "").trim(),
        customGeometry: req.body?.custom_geometry || null,
        accountIdAllowed,
      });
      return res.json(result);
    } catch (error) {
      const message = error?.message || "site_valuation_failed";
      logger.error?.("/api/sales/site-valuation failed", error);
      return res.status(siteErrorStatus(message)).json({ error: message });
    }
  });

  router.post("/api/sales/qualitative-analysis", (req, res) => {
    try {
      return res.json(calculateQualitative(req.body || {}, req.body?.comparables || []));
    } catch (error) {
      const message = error?.message || "qualitative_analysis_failed";
      return res.status(qualitativeErrorStatus(message)).json({ error: message });
    }
  });

  return router;
}
