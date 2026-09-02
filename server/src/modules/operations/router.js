import express from "express";

import { buildDataRepairReadiness } from "../../services/operationalReadiness.js";
import { getRecentScheduledMaintenanceRuns } from "../../services/scheduledMaintenance.js";

function requireFunction(value, code) {
  if (typeof value !== "function") throw new TypeError(code);
  return value;
}

function requireSnapshotProvider(value, code) {
  if (!value || typeof value.snapshot !== "function") throw new TypeError(code);
  return value;
}

export function createOperationalRouter({
  runtimeHealth,
  pool,
  requestPerformance,
  artifactRecoveryMonitor,
  getArtifactExecutorSnapshot,
  loadDcadScraperStatus,
  inlineWorkers,
  documentEvidence,
  processTarget = process,
  logger = console,
  loadRecentMaintenance = getRecentScheduledMaintenanceRuns,
  buildRepairReadiness = buildDataRepairReadiness,
} = {}) {
  const liveness = requireFunction(runtimeHealth?.liveness, "operational_liveness_handler_required");
  const readiness = requireFunction(runtimeHealth?.readiness, "operational_readiness_handler_required");
  if (!pool || typeof pool !== "object") throw new TypeError("operational_pool_required");
  const performance = requireSnapshotProvider(
    requestPerformance,
    "operational_request_performance_required",
  );
  const recovery = requireSnapshotProvider(
    artifactRecoveryMonitor,
    "operational_artifact_recovery_required",
  );
  const artifactSnapshot = requireFunction(
    getArtifactExecutorSnapshot,
    "operational_artifact_executor_required",
  );
  const scraperStatus = requireFunction(
    loadDcadScraperStatus,
    "operational_scraper_status_loader_required",
  );
  const maintenanceRuns = requireFunction(
    loadRecentMaintenance,
    "operational_maintenance_loader_required",
  );
  const repairReadiness = requireFunction(
    buildRepairReadiness,
    "operational_repair_builder_required",
  );
  if (!inlineWorkers || typeof inlineWorkers !== "object") {
    throw new TypeError("operational_inline_workers_required");
  }
  if (!documentEvidence || typeof documentEvidence !== "object") {
    throw new TypeError("operational_document_evidence_required");
  }
  if (typeof processTarget?.uptime !== "function" || typeof processTarget?.memoryUsage !== "function") {
    throw new TypeError("operational_process_target_required");
  }

  const router = express.Router();
  router.get("/health", liveness);
  router.get("/ready", readiness);

  router.get("/api/system/performance", async (_req, res) => {
    let recentMaintenance = [];
    let maintenanceStatus = "available";
    try {
      recentMaintenance = await maintenanceRuns(pool, { limit: 8 });
    } catch (error) {
      maintenanceStatus = "unavailable";
      logger.warn?.("[performance] maintenance history unavailable", error?.message || error);
    }
    return res.json({
      ok: true,
      uptime_seconds: Math.round(processTarget.uptime()),
      web_process: {
        inline_workers: {
          census_geography: Boolean(inlineWorkers.censusGeography),
          sales_location_backfill: Boolean(inlineWorkers.locationBackfill),
        },
        scheduled_maintenance_expected:
          !inlineWorkers.censusGeography && !inlineWorkers.locationBackfill,
      },
      document_evidence: {
        private_object_storage_configured: Boolean(documentEvidence.privateObjectStorageConfigured),
        ocr_provider: documentEvidence.ocrProvider,
        ocr_configured: Boolean(documentEvidence.ocrConfigured),
        ocr_runs_in_scheduled_maintenance: true,
      },
      requests: performance.snapshot(),
      artifact_executor: artifactSnapshot(),
      artifact_recovery: recovery.snapshot(),
      maintenance: {
        status: maintenanceStatus,
        recent_runs: recentMaintenance,
      },
    });
  });

  router.get("/api/system/data-repair", async (_req, res) => {
    res.set("Cache-Control", "no-store");
    const [maintenanceResult, scraperResult] = await Promise.allSettled([
      maintenanceRuns(pool, { limit: 30 }),
      scraperStatus(),
    ]);
    if (maintenanceResult.status === "rejected") {
      logger.warn?.(
        "[operations] maintenance history unavailable",
        maintenanceResult.reason?.message || maintenanceResult.reason,
      );
    }
    if (scraperResult.status === "rejected") {
      logger.warn?.(
        "[operations] scraper status unavailable",
        scraperResult.reason?.message || scraperResult.reason,
      );
    }
    const memory = processTarget.memoryUsage();
    const result = repairReadiness({
      recentMaintenance: maintenanceResult.status === "fulfilled"
        ? maintenanceResult.value
        : [],
      scraper: scraperResult.status === "fulfilled"
        ? scraperResult.value
        : {
            payload: null,
            stale: false,
            error: String(
              scraperResult.reason?.message
              || scraperResult.reason
              || "dcad_scraper_status_unavailable"
            ),
          },
      requestPerformance: performance.snapshot(),
    });
    return res.json({
      ...result,
      runtime: {
        uptime_seconds: Math.round(processTarget.uptime()),
        memory_mb: {
          resident_set: Math.round(memory.rss / 1_048_576),
          heap_used: Math.round(memory.heapUsed / 1_048_576),
          heap_total: Math.round(memory.heapTotal / 1_048_576),
        },
        database_pool: {
          total: Number(pool.totalCount || 0),
          idle: Number(pool.idleCount || 0),
          waiting: Number(pool.waitingCount || 0),
        },
        inline_bulk_workers_enabled:
          Boolean(inlineWorkers.censusGeography) || Boolean(inlineWorkers.locationBackfill),
      },
    });
  });

  return router;
}
