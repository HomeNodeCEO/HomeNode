import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import {
  ensureCensusGeographySchema,
  getCensusGeographyStatus,
  lookupAccountCensusGeographyNow,
  runCensusGeographyBatch,
  seedCensusGeographyQueue,
} from "../../services/censusGeography.js";
import {
  fetchCensusCityProfile,
  fetchCensusZipProfile,
} from "../../services/censusZipProfile.js";
import {
  ensureLocationBackfillQueueSchema,
  getLocationBackfillStatus,
  runLocationBackfillBatch,
  seedLocationBackfillQueue,
} from "../../services/locationBackfillQueue.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;

export function createGeographyOperationsRouter({
  pool,
  locationBackfillReady,
  censusGeographyReady,
  accountQualityReady,
  requireEditor,
  ensureLocationSchema = ensureLocationBackfillQueueSchema,
  getLocationStatus = getLocationBackfillStatus,
  seedLocationQueue = seedLocationBackfillQueue,
  runLocationBatch = runLocationBackfillBatch,
  ensureCensusSchema = ensureCensusGeographySchema,
  getCensusStatus = getCensusGeographyStatus,
  resolveAccountId = resolveCanonicalAccountId,
  lookupAccountCensus = lookupAccountCensusGeographyNow,
  getZipProfile = fetchCensusZipProfile,
  getCityProfile = fetchCensusCityProfile,
  seedCensusQueue = seedCensusGeographyQueue,
  runCensusBatch = runCensusGeographyBatch,
  getLocationMaximumAttempts = () => process.env.LOCATION_BACKFILL_MAX_ATTEMPTS,
  getCensusMaximumAttempts = () => process.env.CENSUS_GEOGRAPHY_MAX_ATTEMPTS,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("geography_operations_pool_required");
  }
  if (!locationBackfillReady || typeof locationBackfillReady.then !== "function") {
    throw new TypeError("geography_operations_location_readiness_required");
  }
  if (!censusGeographyReady || typeof censusGeographyReady.then !== "function") {
    throw new TypeError("geography_operations_census_readiness_required");
  }
  if (!accountQualityReady || typeof accountQualityReady.then !== "function") {
    throw new TypeError("geography_operations_account_readiness_required");
  }
  if (typeof requireEditor !== "function") {
    throw new TypeError("geography_operations_editor_policy_required");
  }
  if ([
    ensureLocationSchema,
    getLocationStatus,
    seedLocationQueue,
    runLocationBatch,
    ensureCensusSchema,
    getCensusStatus,
    resolveAccountId,
    lookupAccountCensus,
    getZipProfile,
    getCityProfile,
    seedCensusQueue,
    runCensusBatch,
    getLocationMaximumAttempts,
    getCensusMaximumAttempts,
  ].some((dependency) => typeof dependency !== "function")) {
    throw new TypeError("geography_operations_dependency_required");
  }

  const router = express.Router();

  /** Coordinate coverage and queue health for mapped sale accounts. */
  router.get("/api/location-backfill/status", async (_req, res) => {
    try {
      await locationBackfillReady;
      await ensureLocationSchema(pool);
      return res.json(await getLocationStatus(pool));
    } catch (error) {
      logger.error?.("location backfill status failed", error);
      return res.status(500).json({ error: "location_backfill_status_failed" });
    }
  });

  /** Explicit maintenance run; ordinary imports and sweeps remain automatic. */
  router.post("/api/location-backfill/run", async (req, res) => {
    if (!requireEditor(req, res)) return undefined;
    try {
      await locationBackfillReady;
      await ensureLocationSchema(pool);
      const seed = await seedLocationQueue(pool, {
        limit: req.body?.seed_limit,
      });
      const result = await runLocationBatch(pool, {
        batchSize: req.body?.batch_size,
        maximumAttempts: getLocationMaximumAttempts(),
      });
      return res.json({ ok: true, seed, result });
    } catch (error) {
      logger.error?.("location backfill maintenance run failed", error);
      return res.status(500).json({ error: "location_backfill_run_failed" });
    }
  });

  /** Census tract coverage for every property with a cached parcel coordinate. */
  router.get("/api/census-geography/status", async (_req, res) => {
    try {
      await censusGeographyReady;
      await ensureCensusSchema(pool);
      return res.json(await getCensusStatus(pool));
    } catch (error) {
      logger.error?.("census geography status failed", error);
      return res.status(500).json({ error: "census_geography_status_failed" });
    }
  });

  /** Give a report user one validated tract immediately without waiting for the queue. */
  router.post("/api/accounts/:id/census-geography/lookup", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
    try {
      await accountQualityReady;
      await censusGeographyReady;
      const canonicalId = await resolveAccountId(pool, requestedId);
      const censusGeography = await lookupAccountCensus(pool, canonicalId);
      return res.json({
        ok: true,
        account_id: canonicalId,
        census_geography: censusGeography,
      });
    } catch (error) {
      const code = String(error?.code || error?.message || "");
      if (code === "account_not_found") return res.status(404).json({ error: code });
      if (code === "census_lookup_input_missing") return res.status(422).json({ error: code });
      logger.error?.("on-demand census geography lookup failed", error);
      return res.status(502).json({ error: "census_geography_lookup_failed" });
    }
  });

  /** Latest configured ACS 5-year unemployment estimate for a ZIP/ZCTA. */
  router.get("/api/census/zip-profile/:postalCode", async (req, res) => {
    try {
      return res.json(await getZipProfile(req.params.postalCode));
    } catch (error) {
      const code = String(error?.code || error?.message || "census_zip_profile_failed");
      const status = Number(error?.status) || 502;
      if (status >= 500) logger.error?.("Census ZIP profile lookup failed", code);
      return res.status(status).json({ error: code });
    }
  });

  /** Latest configured ACS 5-year unemployment estimate for a city/place. */
  router.get("/api/census/city-profile", async (req, res) => {
    try {
      return res.json(await getCityProfile(req.query.city, req.query.state));
    } catch (error) {
      const code = String(error?.code || error?.message || "census_city_profile_failed");
      const status = Number(error?.status) || 502;
      if (status >= 500) logger.error?.("Census city profile lookup failed", code);
      return res.status(status).json({ error: code });
    }
  });

  /** Explicit maintenance run; the normal low-impact worker remains automatic. */
  router.post("/api/census-geography/run", async (req, res) => {
    if (!requireEditor(req, res)) return undefined;
    try {
      await censusGeographyReady;
      await ensureCensusSchema(pool);
      const seed = await seedCensusQueue(pool, {
        limit: req.body?.seed_limit,
      });
      const result = await runCensusBatch(pool, {
        batchSize: req.body?.batch_size,
        maximumAttempts: getCensusMaximumAttempts(),
      });
      return res.json({ ok: true, seed, result });
    } catch (error) {
      logger.error?.("census geography maintenance run failed", error);
      return res.status(500).json({ error: "census_geography_run_failed" });
    }
  });

  return router;
}
