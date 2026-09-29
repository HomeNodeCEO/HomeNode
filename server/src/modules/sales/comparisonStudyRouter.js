import express from "express";

import { knownErrorCode, logBoundedFailure } from "../../security/boundedRouteErrors.js";
import {
  getMarketContext,
  marketConditionsErrorStatus,
} from "../../services/marketConditions.js";
import {
  buildPairedSalesStudy,
  pairedSalesErrorStatus,
} from "../../services/pairedSalesAnalysis.js";

// The service raises these fixed validation codes. Never publish an arbitrary
// exception just because its message happens to start with `invalid_`.
const PAIRED_PUBLIC_ERRORS = new Set([
  "subject_not_found",
  "invalid_subject_account_id",
  "invalid_market_area",
  "invalid_market_period",
  "invalid_as_of",
  "market_areas_required",
  "market_area_limit_exceeded",
  "market_spatial_support_not_ready",
  "custom_area_must_be_polygon",
  "custom_area_coordinates_required",
  "custom_area_requires_three_points",
  "custom_area_too_many_vertices",
  "custom_area_ring_invalid",
  "custom_area_ring_not_closed",
  "custom_area_coordinate_invalid",
  "custom_area_outside_dfw_bounds",
  "custom_area_geometry_invalid",
  "custom_area_size_invalid",
]);
const MARKET_CONTEXT_PUBLIC_ERRORS = new Set([
  "subject_not_found",
  "invalid_subject_account_id",
  "market_spatial_support_not_ready",
]);

export function createComparisonStudyRouter({
  pool,
  accountIdAllowed,
  requireCustomAccountScope,
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
    typeof requireCustomAccountScope !== "function"
    || typeof buildPairedStudy !== "function"
    || typeof pairedErrorStatus !== "function"
    || typeof loadMarketContext !== "function"
    || typeof marketErrorStatus !== "function"
  ) {
    throw new TypeError("comparison_study_dependency_required");
  }

  const router = express.Router();

  router.post("/api/sales/paired-analysis", async (req, res) => {
    const subjectAccountId = String(req.body?.subject_account_id || "").trim();
    if (!accountIdAllowed(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (!await requireCustomAccountScope(
      req, res, subjectAccountId, req.body?.assignment_file_id, "read",
    )) return undefined;
    try {
      const result = await buildPairedStudy(pool, {
        subjectAccountId,
        marketKey: String(req.body?.market_key || "city").trim(),
        asOfDate: String(req.body?.as_of || "").trim(),
        customGeometry: req.body?.custom_geometry || null,
        accountIdAllowed,
      });
      return res.json(result);
    } catch (error) {
      const message = knownErrorCode(error, PAIRED_PUBLIC_ERRORS);
      const status = message ? pairedErrorStatus(message) : 500;
      logBoundedFailure(logger, "/api/sales/paired-analysis failed", error);
      return res.status(status).json({
        error: status >= 500 ? "paired_sales_analysis_failed" : message,
      });
    }
  });

  router.get("/api/sales/market-context", async (req, res) => {
    const subjectAccountId = String(req.query.subject_account_id || "").trim();
    if (!accountIdAllowed(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (!await requireCustomAccountScope(
      req, res, subjectAccountId, req.query.assignment_file_id, "read",
    )) return undefined;
    try {
      const subject = await loadMarketContext(pool, subjectAccountId, {
        accountIdAllowed,
      });
      return res.json({ subject });
    } catch (error) {
      const message = knownErrorCode(error, MARKET_CONTEXT_PUBLIC_ERRORS);
      const status = message ? marketErrorStatus(message) : 500;
      logBoundedFailure(logger, "/api/sales/market-context failed", error);
      return res.status(status).json({
        error: status >= 500 && message !== "market_spatial_support_not_ready"
          ? "market_context_failed" : message,
        ...(status < 500 && error?.detail ? { detail: error.detail } : {}),
      });
    }
  });

  return router;
}
