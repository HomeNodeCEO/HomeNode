import express from "express";

import { countyGisConfiguration } from "../../services/parcelGis.js";
import { getTrestleReplicationStatus } from "../../services/trestleReplication.js";
import { NON_DALLAS_ENRICHMENT_COUNTIES } from "../../util/nonDallasEnrichment.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;

export function createEnrichmentReadRouter({
  pool,
  propertyEnrichmentReady,
  trestleClient,
  getNonDallasAccount,
  requirePlatformAdministrator,
  supportedCounties = NON_DALLAS_ENRICHMENT_COUNTIES,
  getGisConfiguration = countyGisConfiguration,
  getReplicationStatus = getTrestleReplicationStatus,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("enrichment_read_pool_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("enrichment_read_readiness_required");
  }
  if (!trestleClient || typeof trestleClient.status !== "function") {
    throw new TypeError("enrichment_read_trestle_client_required");
  }
  if (
    typeof getNonDallasAccount !== "function"
    || typeof getGisConfiguration !== "function"
    || typeof getReplicationStatus !== "function"
  ) {
    throw new TypeError("enrichment_read_dependency_required");
  }
  if (!Array.isArray(supportedCounties)) {
    throw new TypeError("enrichment_read_supported_counties_required");
  }
  if (typeof requirePlatformAdministrator !== "function") {
    throw new TypeError("enrichment_read_admin_policy_required");
  }

  const router = express.Router();

  /** Non-sensitive activation status for the additive non-Dallas pipeline. */
  router.get("/api/enrichment/status", async (_req, res) => {
    const gis = Object.fromEntries(
      supportedCounties.map((county) => {
        const configuration = getGisConfiguration(county);
        return [county, { configured: configuration.configured }];
      }),
    );
    try {
      return res.json({
        dallas_county_isolated: true,
        supported_counties: supportedCounties,
        trestle: await getReplicationStatus(pool, trestleClient.status()),
        gis,
        resolution_order: ["manual_verified", "trestle", "cad", "manual_review"],
      });
    } catch (error) {
      logger.error?.("enrichment status failed", error);
      return res.status(500).json({ error: "enrichment_status_failed" });
    }
  });

  /** Load verified overrides, review flags, and pending GIS suggestions for an account. */
  router.get("/api/accounts/:id/enrichment", async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(id)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requirePlatformAdministrator(req, res)) return undefined;
    try {
      await propertyEnrichmentReady;
      const account = await getNonDallasAccount(pool, id);
      if (!account) return res.status(404).json({ error: "account_not_found" });
      const [manualResult, reviewResult, gisResult] = await Promise.all([
        pool.query(
          `SELECT attribute_key, attribute_value, notes, reviewer, revision,
                  created_at, updated_at
           FROM app.property_attribute_manual_values
           WHERE account_id = $1 ORDER BY attribute_key`,
          [id],
        ),
        pool.query(
          `SELECT attribute_key, reason, status, evidence, first_flagged_at,
                  updated_at, resolved_at
           FROM app.enrichment_review_queue
           WHERE account_id = $1 ORDER BY status, attribute_key`,
          [id],
        ),
        pool.query(
          `SELECT id, area_square_feet, area_acres, source_url, status,
                  reviewed_by, reviewed_at, created_at
           FROM app.parcel_geometry_suggestions
           WHERE account_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [id],
        ),
      ]);
      return res.set("cache-control", "no-store").json({
        account_id: id,
        county: account.normalized_county,
        manual_values: manualResult.rows,
        review_queue: reviewResult.rows,
        parcel_area_suggestions: gisResult.rows,
      });
    } catch (error) {
      const message = String(error?.message || "");
      if (message === "dallas_enrichment_isolated") {
        return res.status(409).json({ error: message });
      }
      logger.error?.("account enrichment load failed", error);
      return res.status(500).json({ error: "account_enrichment_failed" });
    }
  });

  return router;
}
