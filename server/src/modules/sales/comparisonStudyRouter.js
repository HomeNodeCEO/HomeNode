import express from "express";

import {
  getMarketContext,
  marketConditionsErrorStatus,
} from "../../services/marketConditions.js";
import {
  buildPairedSalesStudy,
  pairedSalesErrorStatus,
} from "../../services/pairedSalesAnalysis.js";

export function createComparisonStudyRouter({
  pool,
  accountIdAllowed,
  buildPairedStudy = buildPairedSalesStudy,
  pairedErrorStatus = pairedSalesErrorStatus,
  loadMarketContext = getMarketContext,
  marketErrorStatus = marketConditionsErrorStatus,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("comparison_study_pool_required");
  }
  if (typeof accountIdAllowed !== "function") {
    throw new TypeError("comparison_study_account_policy_required");
  }
  if (
    typeof buildPairedStudy !== "function"
    || typeof pairedErrorStatus !== "function"
    || typeof loadMarketContext !== "function"
    || typeof marketErrorStatus !== "function"
  ) {
    throw new TypeError("comparison_study_dependency_required");
  }

  const router = express.Router();

  router.post("/api/sales/paired-analysis", async (req, res) => {
    try {
      const result = await buildPairedStudy(pool, {
        subjectAccountId: String(req.body?.subject_account_id || "").trim(),
        marketKey: String(req.body?.market_key || "city").trim(),
        asOfDate: String(req.body?.as_of || "").trim(),
        customGeometry: req.body?.custom_geometry || null,
        accountIdAllowed,
      });
      return res.json(result);
    } catch (error) {
      const message = error?.message || "paired_sales_analysis_failed";
      logger.error?.("/api/sales/paired-analysis failed", error);
      return res.status(pairedErrorStatus(message)).json({ error: message });
    }
  });

  router.get("/api/sales/market-context", async (req, res) => {
    const subjectAccountId = String(req.query.subject_account_id || "").trim();
    try {
      const subject = await loadMarketContext(pool, subjectAccountId, {
        accountIdAllowed,
      });
      return res.json({ subject });
    } catch (error) {
      const message = error?.message || "market_context_failed";
      logger.error?.("/api/sales/market-context failed", error);
      return res.status(marketErrorStatus(message)).json({
        error: message,
        ...(error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  return router;
}
