import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import nodemailer from "nodemailer";
import { parseClassFilter } from "./util/parseClasses.js";
import { normalizePropertyCity, parsePropertySearch } from "./util/propertySearch.js";
import {
  analyzeComparableOutliers,
  analysisWindow,
  applyRecommendationPolicy,
  DEFAULT_COMPARABLE_SCORING,
  DEFAULT_OUTLIER_ANALYSIS,
  DEFAULT_RECOMMENDATION_POLICY,
  filterComparablesForMarket,
  scoreComparable,
} from "./util/comparableScoring.js";
import { decorateAndRankByInfluence } from "./util/propertyInfluence.js";
import { resolveComparableSearchProfile } from "./util/comparableSearchProfiles.js";
import {
  generateNeighborhoodBoundary,
  getLatestNeighborhoodBoundary,
  reviewNeighborhoodBoundary,
} from "./services/neighborhoodBoundaryEngine.js";
import {
  generateNeighborhoodRelevance,
  getLatestNeighborhoodRelevance,
} from "./services/neighborhoodRelevanceEngine.js";
import {
  ensureAccountLocationsTable,
  findDcadParcelsByAddress,
  refreshAccountLocations,
} from "./services/accountLocations.js";
import {
  enqueueLocationBackfillAccounts,
  ensureLocationBackfillQueueSchema,
  getLocationBackfillStatus,
  runLocationBackfillBatch,
  seedLocationBackfillQueue,
  startLocationBackfillWorker,
} from "./services/locationBackfillQueue.js";
import {
  ensureAccountQualitySchema,
  resolveCanonicalAccountId,
} from "./services/accountQuality.js";
import {
  editorKeyMatches,
  normalizeHousingProfileUpdate,
} from "./util/housingProfileEdit.js";
import { buildGroupedAnalysis } from "./util/groupedAnalysis.js";
import { parseGroupedAnalysisBreakdowns } from "./util/groupedAnalysisBreakdowns.js";
import {
  buildMarketConditionsAnalyses,
  getMarketContext,
  marketConditionsErrorStatus,
} from "./services/marketConditions.js";
import {
  buildPairedSalesStudy,
  pairedSalesErrorStatus,
} from "./services/pairedSalesAnalysis.js";
import {
  buildRegressionStudy,
  regressionAnalysisErrorStatus,
} from "./services/regressionAnalysis.js";
import {
  calculateDepreciatedCostAdjustment,
  depreciatedCostAdjustmentErrorStatus,
} from "./util/depreciatedCostAdjustment.js";
import {
  buildSiteValuationStudy,
  siteValuationErrorStatus,
} from "./services/siteValuation.js";
import {
  calculateQualitativeAnalysis,
  qualitativeAnalysisErrorStatus,
} from "./util/qualitativeAnalysis.js";
import { getAccountPropertyActivityHistory } from "./services/accountSalesHistory.js";
import {
  ensureCensusGeographySchema,
  getCensusGeographyStatus,
  lookupAccountCensusGeographyNow,
  runCensusGeographyBatch,
  seedCensusGeographyQueue,
  startCensusGeographyWorker,
} from "./services/censusGeography.js";
import {
  fetchCensusCityProfile,
  fetchCensusZipProfile,
} from "./services/censusZipProfile.js";
import { loadBoundaryStreetNames } from "./services/boundaryStreets.js";
import {
  buildNeighborhoodLandUseAnalysis,
  neighborhoodLandUseErrorStatus,
} from "./services/neighborhoodLandUse.js";
import {
  ensureAppraisalRatingsSchema,
  SALE_REVIEW_SELECT,
  SUBJECT_RATING_SELECT,
} from "./services/appraisalRatings.js";
import {
  normalizeAppraisalRatingUpdate,
  normalizeEffectiveDate,
} from "./util/appraisalRatings.js";
import { ensurePropertyEnrichmentSchema } from "./services/propertyEnrichment.js";
import {
  ensureSalesReconciliationSchema,
  findAccountByCountyIdentifier,
  listSalesReconciliationQueue,
  reconcileSalesSourceRecord,
} from "./services/salesReconciliation.js";
import { TrestleClient } from "./services/trestleClient.js";
import { getTrestleReplicationStatus } from "./services/trestleReplication.js";
import {
  countyGisConfiguration,
  fetchParcelAreaSuggestion,
} from "./services/parcelGis.js";
import {
  assertNonDallasEnrichmentCounty,
  assertPropertyAttributeKey,
  NON_DALLAS_ENRICHMENT_COUNTIES,
} from "./util/nonDallasEnrichment.js";
import { validateReportManualSection } from "./util/reportManualValues.js";
import { markMaterialParcelDifferences } from "./util/relatedParcelDifferences.js";
import {
  assignmentFileResponse,
  ensureAssignmentFilesSchema,
  normalizeAssignmentFileId,
  normalizeAssignmentFileNumber,
} from "./services/assignmentFiles.js";
import {
  canonicalCustomAppraisalFileName,
  ensureCustomAppraisalWorkfileSchema,
  getCustomAppraisalWorkfile,
  getCustomAppraisalWorkfileDownload,
  getCustomAppraisalWorkfileReadiness,
  saveCustomAppraisalWorkfileSection,
  signCustomAppraisalWorkfile,
} from "./services/customAppraisalWorkfiles.js";
import { getCustomAppraisalReportPdf } from "./services/customAppraisalReportPdf.js";
import {
  analyzePropertyContext,
  getPropertyContextStatus,
  getStoredPropertyContext,
  propertyContextErrorStatus,
  savePropertyContextReview,
} from "./services/propertyContext.js";
import { ensurePropertyContextSchema } from "./services/propertyContextStore.js";
import {
  getPropertyZoningEvidence,
  getZoningDocumentDescriptionSuggestion,
  getZoningDocumentContent,
  savePropertyZoningVerification,
} from "./services/zoningEvidence.js";
import {
  createAssignmentDocument,
  ensureAssignmentDocumentsSchema,
  getAssignmentDocument,
  listAssignmentDocuments,
  MAX_ASSIGNMENT_DOCUMENT_BYTES,
  processAssignmentDocument,
  reviewAssignmentDocumentCandidate,
} from "./services/assignmentDocuments.js";
import {
  enqueuePropertyInfluenceAccounts,
  getPropertyInfluenceContexts,
} from "./services/propertyInfluenceStore.js";
import { getRecentScheduledMaintenanceRuns } from "./services/scheduledMaintenance.js";
import {
  buildDataRepairReadiness,
  createCachedScraperStatusLoader,
} from "./services/operationalReadiness.js";
import { getNeighborhoodEngineReadiness } from "./services/neighborhoodEngineReadiness.js";
import {
  createRequestPerformanceMonitor,
  environmentFlag,
} from "./util/requestPerformance.js";
import { createUadRouter } from "./modules/uad/router.js";
import { createUadObjectStorage } from "./modules/uad/r2Storage.js";
import { createOidcAccessTokenVerifier } from "./modules/mobile/auth.js";
import { createMobileRouter } from "./modules/mobile/router.js";
import {
  getAssignmentInspectionSketch,
  saveAssignmentInspectionSketch,
} from "./modules/mobile/desktopSketches.js";
import { renderSketchPdf, renderSketchSvg } from "./modules/mobile/sketchArtifacts.js";
import {
  getDesktopPropertyTaxFile,
  saveDesktopPropertyTaxFile,
} from "./modules/mobile/desktopPropertyTax.js";
import {
  listPreviousAppraisalFiles,
  registerOriginalAppraisalReport,
} from "./services/appraisalHistory.js";
import { replicateAppraisalFile } from "./services/appraisalReplication.js";

const app = express();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10_000),
  application_name: "homenode-web",
});
pool.on("error", (error) => {
  console.error("[database] idle pool client error", error?.message || error);
});
const requestPerformance = createRequestPerformanceMonitor({ pool });
const loadDcadScraperStatus = createCachedScraperStatusLoader();
app.use(requestPerformance.middleware);
app.use(express.json({ limit: "1mb" }));
// Support comma-separated list in CORS_ORIGIN env (e.g. "http://localhost:5173,http://127.0.0.1:5173")
const corsEnv = process.env.CORS_ORIGIN;
const corsOrigins = !corsEnv
  ? true
  : corsEnv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
app.use(cors({ origin: corsOrigins }));

const uadObjectStorage = createUadObjectStorage();
app.use("/api/uad", createUadRouter({
  pool,
  storage: uadObjectStorage,
  enabled: environmentFlag(process.env.UAD_WORKSPACE_ENABLED),
}));

const mobileOidcVerifier = createOidcAccessTokenVerifier({
  issuer: process.env.OIDC_ISSUER,
  audience: process.env.OIDC_AUDIENCE,
  jwksUri: process.env.OIDC_JWKS_URI,
  clockToleranceSeconds: process.env.OIDC_CLOCK_TOLERANCE_SECONDS,
});
app.use("/api/mobile", createMobileRouter({
  pool,
  verifier: mobileOidcVerifier,
  storage: uadObjectStorage,
  enabled: environmentFlag(process.env.MOBILE_INSPECTION_ENABLED),
  recentFileDays: Number(process.env.MOBILE_RECENT_FILE_DAYS || 30),
}));

const trestleClient = new TrestleClient();

// Ensure a simple signups table exists (no external migrations required)
async function ensureSignupsTable() {
  const ddl = `
    CREATE SCHEMA IF NOT EXISTS app;
    CREATE TABLE IF NOT EXISTS app.signups (
      id            bigserial PRIMARY KEY,
      created_at    timestamptz NOT NULL DEFAULT now(),
      source        text,
      account_id    text,
      owner_name    text NOT NULL,
      owner_telephone text NOT NULL,
      owner_email   text,
      user_agent    text,
      ip            text,
      meta          jsonb
    );
  `;
  try {
    await pool.query(ddl);
    console.log("[init] app.signups ensured");
  } catch (e) {
    console.warn("[init] ensureSignupsTable failed (continuing)", e?.message || e);
  }
}
void ensureSignupsTable();

const accountLocationsReady = ensureAccountLocationsTable(pool)
  .then(() => console.log("[init] core.account_locations ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAccountLocationsTable failed (will retry on request)",
      error?.message || error,
    );
  });

const accountQualityReady = ensureAccountQualitySchema(pool)
  .then(() => console.log("[init] DCAD account quality schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAccountQualitySchema failed (continuing)",
      error?.message || error,
    );
  });

const appraisalRatingsReady = ensureAppraisalRatingsSchema(pool)
  .then(() => console.log("[init] appraisal rating review schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAppraisalRatingsSchema failed (will retry on request)",
      error?.message || error,
    );
  });

const propertyEnrichmentReady = ensurePropertyEnrichmentSchema(pool)
  .then(() => console.log("[init] non-Dallas property enrichment schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensurePropertyEnrichmentSchema failed (will retry on request)",
      error?.message || error,
    );
  });

let assignmentFilesSchemaReady = false;
const assignmentFilesReady = ensureAssignmentFilesSchema(pool)
  .then(() => {
    assignmentFilesSchemaReady = true;
    console.log("[init] appraisal assignment file schema ensured");
  })
  .catch((error) => {
    console.warn(
      "[init] ensureAssignmentFilesSchema failed (will retry on request)",
      error?.message || error,
    );
  });

async function ensureAssignmentFilesAvailable() {
  await assignmentFilesReady;
  if (!assignmentFilesSchemaReady) {
    await ensureAssignmentFilesSchema(pool);
    assignmentFilesSchemaReady = true;
  }
}

let customAppraisalWorkfilesSchemaReady = false;
const customAppraisalWorkfilesReady = assignmentFilesReady
  .then(() => ensureCustomAppraisalWorkfileSchema(pool))
  .then(() => {
    customAppraisalWorkfilesSchemaReady = true;
    console.log("[init] custom appraisal workfile schema ensured");
  })
  .catch((error) => {
    console.warn(
      "[init] custom appraisal workfile schema failed (will retry on request)",
      error?.message || error,
    );
  });

async function ensureCustomAppraisalWorkfilesAvailable() {
  await customAppraisalWorkfilesReady;
  if (!customAppraisalWorkfilesSchemaReady) {
    await ensureAssignmentFilesAvailable();
    await ensureCustomAppraisalWorkfileSchema(pool);
    customAppraisalWorkfilesSchemaReady = true;
  }
}

let assignmentDocumentsSchemaReady = false;
const assignmentDocumentsReady = assignmentFilesReady
  .then(() => ensureAssignmentDocumentsSchema(pool))
  .then(() => {
    assignmentDocumentsSchemaReady = true;
    console.log("[init] assignment document evidence schema ensured");
  })
  .catch((error) => {
    console.warn(
      "[init] assignment document evidence schema failed (will retry on request)",
      error?.message || error,
    );
  });

async function ensureAssignmentDocumentsAvailable() {
  await assignmentDocumentsReady;
  if (!assignmentDocumentsSchemaReady) {
    await ensureAssignmentDocumentsSchema(pool);
    assignmentDocumentsSchemaReady = true;
  }
}

let propertyContextSchemaReady = false;
const propertyContextReady = Promise.all([
  accountLocationsReady,
  assignmentFilesReady,
])
  .then(() => ensurePropertyContextSchema(pool))
  .then(() => {
    propertyContextSchemaReady = true;
    console.log("[init] offline property-context schema ensured");
  })
  .catch((error) => {
    console.warn(
      "[init] property-context schema failed (will retry on request)",
      error?.message || error,
    );
  });

async function ensurePropertyContextAvailable() {
  await propertyContextReady;
  if (!propertyContextSchemaReady) {
    await ensurePropertyContextSchema(pool);
    propertyContextSchemaReady = true;
  }
}

const REPORT_MANUAL_SECTION_KEYS = new Set([
  "report.subject_identification",
  "report.exemptions",
  "report.sales_history",
  "report.property_characteristics",
  "report.land_details",
  "report.appraisal_values",
  "report.assignment_details",
]);

const ASSIGNMENT_FILE_SELECT = `
  SELECT f.id, f.account_id, f.file_number, f.assignment_details,
         f.inherited_from_file_id, parent.file_number AS inherited_from_file_number,
         f.reviewer, f.revision, f.created_at, f.updated_at,
         workfile.workfile_key, workfile.canonical_file_name,
         workfile.status AS workfile_status,
         workfile.signed_at AS workfile_signed_at,
         workfile.signed_by AS workfile_signed_by,
         workfile.updated_at AS workfile_updated_at
  FROM app.assignment_files f
  LEFT JOIN app.assignment_files parent ON parent.id = f.inherited_from_file_id
  LEFT JOIN app.custom_appraisal_workfiles workfile
    ON workfile.assignment_file_id = f.id
`;

async function mirrorLatestAssignmentDetails(client, accountId, assignmentDetails, reviewer, fileNumber) {
  const attributeKey = "report.assignment_details";
  const { rows: currentRows } = await client.query(
    `SELECT revision FROM app.property_attribute_manual_values
     WHERE account_id = $1 AND attribute_key = $2 FOR UPDATE`,
    [accountId, attributeKey],
  );
  const revision = Number(currentRows[0]?.revision || 0) + 1;
  const valueJson = JSON.stringify(assignmentDetails);
  const notes = `Current assignment file ${fileNumber}`;
  await client.query(
    `INSERT INTO app.property_attribute_manual_values (
       account_id, attribute_key, attribute_value, notes, reviewer, revision
     ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
     ON CONFLICT (account_id, attribute_key) DO UPDATE SET
       attribute_value = EXCLUDED.attribute_value,
       notes = EXCLUDED.notes,
       reviewer = EXCLUDED.reviewer,
       revision = EXCLUDED.revision,
       updated_at = now()`,
    [accountId, attributeKey, valueJson, notes, reviewer, revision],
  );
  await client.query(
    `INSERT INTO app.property_attribute_manual_history (
       account_id, attribute_key, attribute_value, notes, reviewer, revision
     ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
    [accountId, attributeKey, valueJson, notes, reviewer, revision],
  );
}

function positiveSiteSize(value) {
  const parsed = typeof value === "string"
    ? Number(value.replace(/[^0-9.-]/g, ""))
    : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function manualLandSiteSize(value) {
  const rows = Array.isArray(value?.land_detail) ? value.land_detail : [];
  let total = 0;
  let measuredRows = 0;
  for (const row of rows) {
    const area = positiveSiteSize(row?.area_sqft);
    if (area === null) continue;
    total += area;
    measuredRows += 1;
  }
  return measuredRows > 0 && total > 0 ? total : null;
}

function mlsLotSizeSquareFeet(value) {
  const area = positiveSiteSize(value);
  if (area === null) return null;
  // NTREIS exports omit the unit column: values below 100 are acreage while
  // larger values are already square feet.
  return area < 100 ? area * 43_560 : area;
}

function greatCircleDistanceMilesSql({
  subjectLatitude,
  subjectLongitude,
  comparableLatitude,
  comparableLongitude,
}) {
  return `3958.7613 * ACOS(
    LEAST(1, GREATEST(-1,
      COS(RADIANS(${subjectLatitude})) *
      COS(RADIANS(${comparableLatitude})) *
      COS(RADIANS(${comparableLongitude}) - RADIANS(${subjectLongitude})) +
      SIN(RADIANS(${subjectLatitude})) *
      SIN(RADIANS(${comparableLatitude}))
    ))
  )`;
}

const salesReconciliationReady = ensureSalesReconciliationSchema(pool)
  .then(() => console.log("[init] sales reconciliation schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureSalesReconciliationSchema failed (will retry on request)",
      error?.message || error,
    );
  });

let locationBackfillWorker = null;
const locationBackfillInlineEnabled = environmentFlag(
  process.env.LOCATION_BACKFILL_ENABLED,
);
const locationBackfillReady = Promise.all([
  accountLocationsReady,
  salesReconciliationReady,
])
  .then(() => ensureLocationBackfillQueueSchema(pool))
  .then(() => {
    console.log("[init] location backfill queue ensured");
    if (locationBackfillInlineEnabled) {
      locationBackfillWorker = startLocationBackfillWorker(pool, {
        intervalMs: process.env.LOCATION_BACKFILL_INTERVAL_MS,
        seedIntervalMs: process.env.LOCATION_BACKFILL_SEED_INTERVAL_MS,
        initialDelayMs: process.env.LOCATION_BACKFILL_INITIAL_DELAY_MS,
        batchSize: process.env.LOCATION_BACKFILL_BATCH_SIZE,
        seedLimit: process.env.LOCATION_BACKFILL_SEED_LIMIT,
        maximumAttempts: process.env.LOCATION_BACKFILL_MAX_ATTEMPTS,
      });
      console.log(
        `[init] location backfill worker started (${locationBackfillWorker.workerId})`,
      );
    } else {
      console.log("[init] location backfill worker disabled; use scheduled maintenance");
    }
  })
  .catch((error) => {
    console.warn(
      "[init] location backfill queue failed (will retry on request)",
      error?.message || error,
    );
  });

let censusGeographyWorker = null;
const censusGeographyInlineEnabled = environmentFlag(
  process.env.CENSUS_GEOGRAPHY_ENABLED,
);
const censusGeographyReady = accountLocationsReady
  .then(() => ensureCensusGeographySchema(pool))
  .then(() => {
    console.log("[init] census geography schema ensured");
    if (censusGeographyInlineEnabled) {
      censusGeographyWorker = startCensusGeographyWorker(pool, {
        intervalMs: process.env.CENSUS_GEOGRAPHY_INTERVAL_MS,
        seedIntervalMs: process.env.CENSUS_GEOGRAPHY_SEED_INTERVAL_MS,
        initialDelayMs: process.env.CENSUS_GEOGRAPHY_INITIAL_DELAY_MS,
        batchSize: process.env.CENSUS_GEOGRAPHY_BATCH_SIZE,
        seedLimit: process.env.CENSUS_GEOGRAPHY_SEED_LIMIT,
        maximumAttempts: process.env.CENSUS_GEOGRAPHY_MAX_ATTEMPTS,
      });
      console.log(
        `[init] census geography worker started (${censusGeographyWorker.workerId})`,
      );
    } else {
      console.log("[init] census geography worker disabled; use scheduled maintenance");
    }
  })
  .catch((error) => {
    console.warn(
      "[init] census geography initialization failed (will retry on request)",
      error?.message || error,
    );
  });

// simple health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Operational acceptance endpoint. It intentionally reports aggregate timing
// and worker state only; credentials, SQL text, and raw property identifiers
// are never included.
app.get("/api/system/performance", async (_req, res) => {
  let recentMaintenance = [];
  let maintenanceStatus = "available";
  try {
    recentMaintenance = await getRecentScheduledMaintenanceRuns(pool, { limit: 8 });
  } catch (error) {
    maintenanceStatus = "unavailable";
    console.warn("[performance] maintenance history unavailable", error?.message || error);
  }
  res.json({
    ok: true,
    uptime_seconds: Math.round(process.uptime()),
    web_process: {
      inline_workers: {
        census_geography: censusGeographyInlineEnabled,
        sales_location_backfill: locationBackfillInlineEnabled,
      },
      scheduled_maintenance_expected: !censusGeographyInlineEnabled && !locationBackfillInlineEnabled,
    },
    requests: requestPerformance.snapshot(),
    maintenance: {
      status: maintenanceStatus,
      recent_runs: recentMaintenance,
    },
  });
});

/**
 * Aggregate repair and enrichment readiness. This endpoint performs no repair
 * work and exposes only counts, timings, and normalized queue state.
 */
app.get("/api/system/data-repair", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const [maintenanceResult, scraperResult] = await Promise.allSettled([
    getRecentScheduledMaintenanceRuns(pool, { limit: 30 }),
    loadDcadScraperStatus(),
  ]);
  if (maintenanceResult.status === "rejected") {
    console.warn(
      "[operations] maintenance history unavailable",
      maintenanceResult.reason?.message || maintenanceResult.reason,
    );
  }
  if (scraperResult.status === "rejected") {
    console.warn(
      "[operations] scraper status unavailable",
      scraperResult.reason?.message || scraperResult.reason,
    );
  }
  const memory = process.memoryUsage();
  const readiness = buildDataRepairReadiness({
    recentMaintenance: maintenanceResult.status === "fulfilled"
      ? maintenanceResult.value
      : [],
    scraper: scraperResult.status === "fulfilled"
      ? scraperResult.value
      : {
          payload: null,
          stale: false,
          error: String(
            scraperResult.reason?.message ||
            scraperResult.reason ||
            "dcad_scraper_status_unavailable"
          ),
        },
    requestPerformance: requestPerformance.snapshot(),
  });
  return res.json({
    ...readiness,
    runtime: {
      uptime_seconds: Math.round(process.uptime()),
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
        censusGeographyInlineEnabled || locationBackfillInlineEnabled,
    },
  });
});

// SMTP status (non-sensitive): helps verify Render env is set correctly
app.get("/api/signup/smtp-status", (_req, res) => {
  const usingUrl = Boolean(process.env.SMTP_URL || process.env.SMTP_CONNECTION_URL);
  const hasHost = Boolean(process.env.SMTP_HOST);
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : null;
  const secure = process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true";
  const hasUser = Boolean(process.env.SMTP_USER);
  const hasPass = Boolean(process.env.SMTP_PASS);
  const fromSet = Boolean(process.env.MAIL_FROM || process.env.SMTP_FROM);
  const cors = process.env.CORS_ORIGIN || process.env.CORS_ORIGINS || null;
  const configured = usingUrl || hasHost;
  res.json({
    ok: true,
    smtp: {
      configured,
      using_url: usingUrl,
      has_host: hasHost,
      port,
      secure,
      has_user: hasUser,
      has_pass: hasPass,
      from_set: fromSet,
    },
    cors_origin: cors,
  });
});

// Lightweight email submission endpoint for Sign Up form
// Expects JSON: { ownerName: string, ownerTelephone: string, accountId?: string }
app.post("/api/signup/email", async (req, res) => {
  try {
    const { ownerName, ownerTelephone, accountId } = req.body || {};
    if (!ownerName || !ownerTelephone) {
      return res.status(400).json({ error: "missing_owner_fields" });
    }

    // Configure transporter from env. Prefer SMTP_URL if provided; otherwise fall back to host/port/user/pass.
    const smtpUrl = process.env.SMTP_URL || process.env.SMTP_CONNECTION_URL;
    let transporter;
    if (smtpUrl) {
      transporter = nodemailer.createTransport(smtpUrl);
    } else if (process.env.SMTP_HOST) {
      transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: process.env.SMTP_SECURE === "1" || process.env.SMTP_SECURE === "true",
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
      });
    }

    const to = "homenodeceo@gmail.com";
    const subject = `New Enrollment Submission${accountId ? ` - ${accountId}` : ""}`;
    const text = `A new enrollment was submitted.\n\nOwner Name: ${ownerName}\nTelephone: ${ownerTelephone}\n${accountId ? `Account ID: ${accountId}\n` : ""}`;

    // Persist signup in DB regardless of email status
    let id = null;
    try {
      const ua = req.headers["user-agent"] || null;
      const ip = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.ip || null;
      const meta = { referer: req.headers.referer || null };
      const { rows } = await pool.query(
        `INSERT INTO app.signups (source, account_id, owner_name, owner_telephone, owner_email, user_agent, ip, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          "web-signup",
          accountId || null,
          ownerName,
          ownerTelephone,
          (req.body && req.body.ownerEmail) || null,
          ua,
          ip,
          meta,
        ]
      );
      id = rows?.[0]?.id ?? null;
    } catch (e) {
      console.error("[signup] DB insert failed", e);
      // Continue to try email even if DB failed
    }

    // Try to send email if SMTP is configured; do not fail the request if mail fails
    let emailSent = false;
    let emailError = null;
    if (transporter) {
      try {
        await transporter.sendMail({
          to,
          from: process.env.MAIL_FROM || process.env.SMTP_FROM || "no-reply@homenode",
          subject,
          text,
        });
        emailSent = true;
      } catch (e) {
        emailError = e?.message || String(e);
      }
    }

    // Always return success for the signup capture; include email status for transparency
    res.json({ ok: true, id, email_sent: emailSent, email_error: emailError });
  } catch (err) {
    const msg = err?.message || "unknown_error";
    const code = err?.code || null;
    const responseCode = err?.responseCode || null;
    const command = err?.command || null;
    console.error("/api/signup/email failed", { message: msg, code, responseCode, command });
    res.status(500).json({ error: "email_failed", message: msg, code, responseCode, command });
  }
});

/**
 * GET /api/accounts/:id
 * Returns an object compatible with the frontend's AccountDetail shape:
 *   { account: AccountRow, primary_improvements: {...} }
 */
app.get("/api/accounts/:id", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "missing_id" });
  try {
    await accountQualityReady;
    const canonicalId = await resolveCanonicalAccountId(pool, id);
    const accountSql = `
      SELECT
        a.account_id,
        COALESCE(NULLIF(BTRIM(a.address), ''), raw_loc.address) AS address,
        COALESCE(NULLIF(BTRIM(a.city), ''), raw_loc.city) AS city,
        COALESCE(NULLIF(BTRIM(a.postal_code), ''), raw_loc.postal_code) AS postal_code,
        a.county,
        a.neighborhood_code,
        a.subdivision,
        a.legal_description,
        a.data_quality_status,
        a.data_quality_flags,
        a.canonical_account_id,
        COALESCE(vsc.certified_year, mv.tax_year)                 AS latest_tax_year,
        COALESCE(vsc.market_value, mv.total_value)                AS latest_market_value,
        COALESCE(vsc.improvement_value, mv.imp_value)             AS latest_improvement_value,
        COALESCE(vsc.land_value, mv.land_value)                   AS latest_land_value,
        COALESCE(vsc.capped_value, mv.homestead_cap_value)        AS latest_capped_value
      FROM core.accounts a
      LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
      LEFT JOIN LATERAL (
        SELECT m.* FROM core.market_values m
        WHERE m.account_id = a.account_id
        ORDER BY m.tax_year DESC
        LIMIT 1
      ) mv ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
               ) AS address,
               COALESCE(
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,city}'), ''),
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,situs_city}'), '')
               ) AS city,
               COALESCE(
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,postal_code}'), ''),
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,zip_code}'), '')
               ) AS postal_code
        FROM core.dcad_json_raw r
        WHERE r.account_id = a.account_id
          AND COALESCE(
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
              ) IS NOT NULL
        ORDER BY r.tax_year DESC, r.fetched_at DESC
        LIMIT 1
      ) raw_loc ON TRUE
      WHERE a.account_id = $1
    `;
    const { rows: accRows } = await pool.query(accountSql, [canonicalId]);
    if (!accRows.length) return res.status(404).json({ error: "not_found" });

    // Sales history is core account data. Start its indexed lookup immediately
    // and include it in this response instead of making the frontend wait on
    // the general-purpose /api/sales view.
    const propertyActivityHistoryPromise = getAccountPropertyActivityHistory(pool, canonicalId);
    const censusGeographyPromise = (async () => {
      await censusGeographyReady;
      await ensureCensusGeographySchema(pool);
      const { rows } = await pool.query(
        `SELECT tract_geoid, tract_code, state_fips, county_fips, block_code,
                benchmark, vintage, status, response_status, review_reason,
                source_method, source_latitude, source_longitude,
                looked_up_at, updated_at
         FROM core.account_census_geographies
         WHERE account_id = $1`,
        [canonicalId],
      );
      return rows[0] || null;
    })().catch((error) => {
      console.warn("census geography lookup failed", error?.message || error);
      return null;
    });
    const reportManualValuesPromise = (async () => {
      await propertyEnrichmentReady;
      const { rows } = await pool.query(
        `SELECT attribute_key, attribute_value, revision, reviewer, notes, updated_at
         FROM app.property_attribute_manual_values
         WHERE account_id = $1 AND attribute_key LIKE 'report.%'
         ORDER BY attribute_key`,
        [canonicalId],
      );
      return Object.fromEntries(
        rows.map((row) => [row.attribute_key, {
          value: row.attribute_value,
          revision: Number(row.revision || 0),
          reviewer: row.reviewer,
          notes: row.notes,
          updated_at: row.updated_at,
        }]),
      );
    })();
    const propertyContextPromise = (async () => {
      await ensurePropertyContextAvailable();
      return getStoredPropertyContext(pool, { accountId: canonicalId });
    })().catch((error) => {
      console.warn("property context lookup failed", error?.message || error);
      return null;
    });

    const impSql = `
      SELECT
        construction_type,
        percent_complete,
        year_built,
        effective_year_built,
        actual_age,
        depreciation,
        desirability,
        stories,
        living_area_sqft,
        total_living_area,
        bedroom_count,
        bath_count,
        basement,
        kitchens,
        wetbars,
        fireplaces,
        sprinkler,
        spa,
        pool,
        sauna,
        air_conditioning,
        heating,
        foundation,
        roof_material,
        roof_type,
        exterior_material,
        fence_type,
        number_units,
        building_class,
        total_area_sqft,
        baths_full,
        baths_half
      FROM core.primary_improvements WHERE account_id = $1
    `;
    const { rows: impRows } = await pool.query(impSql, [canonicalId]);

    // The CAD improvement table does not contain a dependable detached/attached
    // field. Use the account-level profile, which fills structural and
    // architectural fields independently from the latest nonblank MLS
    // observations and supports source-attributed verified overrides.
    const housingSql = `
      SELECT
        structural_style,
        housing_type,
        attachment_type,
        architectural_style,
        source_name,
        source_url,
        source_record_reference,
        observed_at,
        confidence,
        profile_source
      FROM core.v_account_housing_profiles
      WHERE account_id = $1
    `;
    const { rows: housingRows } = await pool.query(housingSql, [canonicalId]);

    // Latest owner summary plus every party and recorded ownership share. The
    // party rows were already being scraped, but older clients only received
    // the one-line summary and therefore hid fractional/co-owner records.
    const ownerSql = `
      SELECT
        os.owner_name,
        os.mailing_address,
        os.tax_year,
        COALESCE((
          SELECT json_agg(
            json_build_object(
              'owner_name', op.owner_name,
              'ownership_pct', op.ownership_pct,
              'tax_year', op.tax_year
            )
            ORDER BY op.id
          )
          FROM core.owner_parties op
          WHERE op.account_id = os.account_id
            AND op.tax_year = (
              SELECT MAX(latest.tax_year)
              FROM core.owner_parties latest
              WHERE latest.account_id = os.account_id
            )
        ), '[]'::json) AS owner_parties
      FROM core.owner_summary os
      WHERE os.account_id = $1
      ORDER BY os.tax_year DESC
      LIMIT 1
    `;
    const { rows: ownerRows } = await pool.query(ownerSql, [canonicalId]);

    // Current legal description info (deed date, lines/text)
    const legalSql = `
      SELECT tax_year, legal_lines, legal_text, deed_transfer_date
      FROM core.legal_description_current
      WHERE account_id = $1
      LIMIT 1
    `;
    const { rows: legalRows } = await pool.query(legalSql, [canonicalId]);
    const legalHistSql = `
      SELECT tax_year, legal_lines, legal_text, deed_transfer_date
      FROM core.legal_description_history
      WHERE account_id = $1 AND deed_transfer_date IS NOT NULL
      ORDER BY tax_year DESC
      LIMIT 1
    `;
    const { rows: legalHistRows } = await pool.query(legalHistSql, [canonicalId]);

    // Exemptions summary (latest year) to determine homestead
    const exSql = `
      SELECT tax_year, jurisdiction_key, taxing_jurisdiction, homestead_exemption, disabled_vet, taxable_value
      FROM core.exemptions_summary
      WHERE account_id = $1
      ORDER BY tax_year DESC
    `;
    const { rows: exRowsAll } = await pool.query(exSql, [canonicalId]);
    let exRows = [];
    let exYear = null;
    let homesteadYes = false;
    if (exRowsAll && exRowsAll.length) {
      exYear = exRowsAll[0].tax_year;
      exRows = exRowsAll.filter((r) => r.tax_year === exYear);
      homesteadYes = exRows.some((r) => Number(r.homestead_exemption || 0) > 0);
    }

    // Land detail for latest tax year
    let landRows = [];
    try {
      const landYearSql = `SELECT MAX(tax_year) AS y FROM core.land_detail WHERE account_id = $1`;
      const { rows: yRows } = await pool.query(landYearSql, [canonicalId]);
      const y = yRows?.[0]?.y;
      if (y) {
        const landSql = `
          SELECT line_number AS number,
                 state_code,
                 zoning,
                 frontage_ft,
                 depth_ft,
                 area_sqft,
                 pricing_method,
                 unit_price,
                 market_adjustment_pct,
                 adjusted_price,
                 ag_land
          FROM core.land_detail
          WHERE account_id = $1 AND tax_year = $2
          ORDER BY line_number
        `;
        const { rows } = await pool.query(landSql, [canonicalId, y]);
        landRows = rows || [];
      }
    } catch (e) {
      console.error('land_detail query failed', e);
    }
    const resp = {
      account: {
        ...accRows[0],
        requested_account_id: id,
        resolved_from_legacy: canonicalId !== id.toUpperCase(),
      },
      primary_improvements: impRows[0] || null,
      housing_profile: housingRows[0] || null,
      owner_summary: ownerRows[0]
        ? {
            owner_name: ownerRows[0].owner_name,
            mailing_address: ownerRows[0].mailing_address,
            tax_year: ownerRows[0].tax_year,
          }
        : null,
      owner_parties: ownerRows[0]?.owner_parties || [],
      legal_current: legalRows[0] || null,
      legal_history: legalHistRows[0] || null,
      exemptions_summary_year: exYear,
      exemptions_summary: exRows,
      homestead_yes: homesteadYes,
      land_detail: landRows,
      property_activity_history: await propertyActivityHistoryPromise,
      census_geography: await censusGeographyPromise,
      report_manual_values: await reportManualValuesPromise,
      property_context: await propertyContextPromise,
      // Secondary improvements (all rows for account)
      additional_improvements: []
    };
    resp.sales_history = resp.property_activity_history.filter(
      (row) => row.record_type === "closed_sale",
    );

    // Fetch secondary improvements
    try {
      const secSql = `
        SELECT
          sec_imp_number   AS number,
          sec_imp_type     AS improvement_type,
          sec_imp_cons_type AS construction,
          sec_imp_floor    AS floor,
          sec_imp_ext_wall AS exterior_wall,
          sec_imp_sqft     AS area_sqft,
          sec_imp_value    AS value,
          sec_imp_year_built AS year_built
        FROM core.secondary_improvements
        WHERE account_id = $1
        ORDER BY sec_imp_number NULLS LAST, id
      `;
      const { rows: secRows } = await pool.query(secSql, [canonicalId]);
      resp.additional_improvements = secRows || [];
    } catch (e) {
      console.error('secondary_improvements query failed', e);
    }
    res.json(resp);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "accounts_failed" });
  }
});

/**
 * GET /api/accounts/:id/photos
 * Returns the latest ordered MLS image gallery available for an account.
 * The source listing/sale record remains explicit so the UI never confuses
 * placeholder imagery with MLS evidence.
 */
app.get("/api/accounts/:id/photos", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    const { rows: sourceRows } = await pool.query(
      `
        SELECT
          src.id AS source_record_id,
          src.listing_key,
          src.listing_id,
          src.source_name,
          src.record_type,
          COALESCE(src.close_date, src.listing_contract_date) AS activity_date
        FROM core.sales_source_records src
        JOIN core.v_sales_media_summary media
          ON media.source_record_id = src.id
        WHERE src.primary_account_id = $1
        ORDER BY
          COALESCE(src.close_date, src.listing_contract_date) DESC NULLS LAST,
          (src.record_type = 'listing') DESC,
          src.updated_at DESC,
          src.id DESC
        LIMIT 1
      `,
      [id],
    );
    if (!sourceRows.length) {
      return res.json({
        account_id: id,
        source_record_id: null,
        listing_key: null,
        listing_id: null,
        source_name: null,
        photos: [],
      });
    }
    const source = sourceRows[0];
    const { rows: photos } = await pool.query(
      `
        SELECT
          id,
          source_record_id,
          media_url,
          order_number,
          preferred_photo_yn AS is_primary,
          short_description AS caption,
          mime_type,
          permission,
          modification_timestamp
        FROM core.sales_source_media
        WHERE source_record_id = $1
          AND media_category = 'image'
        ORDER BY
          preferred_photo_yn DESC,
          order_number NULLS LAST,
          id
      `,
      [source.source_record_id],
    );
    res.json({
      account_id: id,
      ...source,
      photos,
    });
  } catch (error) {
    console.error("/api/accounts/:id/photos failed", error);
    res.status(500).json({ error: "account_photos_failed" });
  }
});

/**
 * PATCH /api/accounts/:id/housing-profile
 * Saves a verified, account-level housing classification without changing the
 * immutable MLS source row. The profile becomes the fallback for every sale
 * linked to the same parcel.
 */
app.patch("/api/accounts/:id/housing-profile", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }

  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (!configuredEditorKey) {
    return res.status(503).json({ error: "housing_profile_editor_not_configured" });
  }
  if (
    !editorKeyMatches(
      req.get("x-homenode-editor-key"),
      configuredEditorKey,
    )
  ) {
    return res.status(401).json({ error: "invalid_editor_key" });
  }

  let update;
  try {
    update = normalizeHousingProfileUpdate(req.body);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_housing_profile" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accountResult = await client.query(
      "SELECT 1 FROM core.accounts WHERE account_id = $1",
      [id],
    );
    if (!accountResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }

    await client.query(
      `
        INSERT INTO core.account_housing_profiles (
          account_id,
          structural_style,
          housing_type,
          attachment_type,
          architectural_style,
          source_name,
          source_url,
          source_record_reference,
          observed_at,
          confidence,
          notes
        ) VALUES (
          $1, $2, $3, $4, $5,
          'HomeNode manual comparable review',
          $6, $7, now(), 1.000, $8
        )
        ON CONFLICT (account_id) DO UPDATE SET
          structural_style = EXCLUDED.structural_style,
          housing_type = EXCLUDED.housing_type,
          attachment_type = EXCLUDED.attachment_type,
          architectural_style = EXCLUDED.architectural_style,
          source_name = EXCLUDED.source_name,
          source_url = EXCLUDED.source_url,
          source_record_reference = EXCLUDED.source_record_reference,
          observed_at = EXCLUDED.observed_at,
          confidence = EXCLUDED.confidence,
          notes = EXCLUDED.notes,
          updated_at = now()
      `,
      [
        id,
        update.structuralStyle,
        update.housingType,
        update.attachmentType,
        update.architecturalStyle,
        update.sourceUrl,
        update.sourceRecordReference,
        update.notes,
      ],
    );

    const { rows } = await client.query(
      `
        SELECT
          structural_style,
          housing_type,
          attachment_type,
          architectural_style,
          source_name,
          source_url,
          source_record_reference,
          observed_at,
          confidence,
          profile_source
        FROM core.v_account_housing_profiles
        WHERE account_id = $1
      `,
      [id],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, housing_profile: rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/accounts/:id/housing-profile failed", error);
    return res.status(500).json({ error: "housing_profile_update_failed" });
  } finally {
    client.release();
  }
});

/**
 * Explicitly save user-verified Property Report section overrides. Source CAD
 * and MLS rows remain immutable; every save is upserted and appended to the
 * audit history. This endpoint intentionally supports Dallas and non-Dallas
 * accounts because report editing is separate from the enrichment pipeline.
 */
app.patch("/api/accounts/:id/report-manual-values", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  const sections = req.body?.sections;
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
    return res.status(400).json({ error: "invalid_report_sections" });
  }
  const entries = Object.entries(sections);
  if (
    !entries.length ||
    entries.length > REPORT_MANUAL_SECTION_KEYS.size ||
    entries.some(([key, value]) =>
      !REPORT_MANUAL_SECTION_KEYS.has(key) || value === undefined
    )
  ) {
    return res.status(400).json({ error: "invalid_report_sections" });
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(sections), "utf8");
  if (serializedSize > 250_000) {
    return res.status(413).json({ error: "report_sections_too_large" });
  }
  try {
    for (const [key, value] of entries) validateReportManualSection(key, value);
  } catch (error) {
    return res.status(400).json({
      error: error?.message || "invalid_report_section_value",
    });
  }

  const reviewer = String(req.body?.reviewer || "HomeNode editor")
    .trim()
    .slice(0, 200) || "HomeNode editor";
  const notes = String(req.body?.notes || "Property Report manual edit")
    .trim()
    .slice(0, 4000) || null;
  let housingUpdate = null;
  const characteristics = sections["report.property_characteristics"];
  if (
    characteristics?.housing_profile?.housing_type &&
    typeof characteristics.housing_profile === "object"
  ) {
    try {
      housingUpdate = normalizeHousingProfileUpdate({
        ...characteristics.housing_profile,
        notes,
      });
    } catch (error) {
      return res.status(400).json({
        error: error?.message || "invalid_housing_profile",
      });
    }
  }
  const client = await pool.connect();
  try {
    await propertyEnrichmentReady;
    await client.query("BEGIN");
    const canonicalId = await resolveCanonicalAccountId(client, requestedId);
    const accountResult = await client.query(
      "SELECT 1 FROM core.accounts WHERE account_id = $1",
      [canonicalId],
    );
    if (!accountResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }

    if (housingUpdate) {
      await client.query(
        `INSERT INTO core.account_housing_profiles (
           account_id, structural_style, housing_type, attachment_type,
           architectural_style, source_name, observed_at, confidence, notes
         ) VALUES ($1,$2,$3,$4,$5,'HomeNode Property Report manual edit',now(),1.000,$6)
         ON CONFLICT (account_id) DO UPDATE SET
           structural_style = EXCLUDED.structural_style,
           housing_type = EXCLUDED.housing_type,
           attachment_type = EXCLUDED.attachment_type,
           architectural_style = EXCLUDED.architectural_style,
           source_name = EXCLUDED.source_name,
           observed_at = EXCLUDED.observed_at,
           confidence = EXCLUDED.confidence,
           notes = EXCLUDED.notes,
           updated_at = now()`,
        [
          canonicalId,
          housingUpdate.structuralStyle,
          housingUpdate.housingType,
          housingUpdate.attachmentType,
          housingUpdate.architecturalStyle,
          housingUpdate.notes,
        ],
      );
    }

    const saved = {};
    for (const [attributeKey, attributeValue] of entries) {
      const { rows: currentRows } = await client.query(
        `SELECT revision FROM app.property_attribute_manual_values
         WHERE account_id = $1 AND attribute_key = $2 FOR UPDATE`,
        [canonicalId, attributeKey],
      );
      const revision = Number(currentRows[0]?.revision || 0) + 1;
      const valueJson = JSON.stringify(attributeValue);
      const { rows } = await client.query(
        `INSERT INTO app.property_attribute_manual_values (
           account_id, attribute_key, attribute_value, notes, reviewer, revision
         ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
         ON CONFLICT (account_id, attribute_key) DO UPDATE SET
           attribute_value = EXCLUDED.attribute_value,
           notes = EXCLUDED.notes,
           reviewer = EXCLUDED.reviewer,
           revision = EXCLUDED.revision,
           updated_at = now()
         RETURNING attribute_key, attribute_value, revision, reviewer, notes, updated_at`,
        [canonicalId, attributeKey, valueJson, notes, reviewer, revision],
      );
      await client.query(
        `INSERT INTO app.property_attribute_manual_history (
           account_id, attribute_key, attribute_value, notes, reviewer, revision
         ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
        [canonicalId, attributeKey, valueJson, notes, reviewer, revision],
      );
      saved[attributeKey] = {
        value: rows[0].attribute_value,
        revision: Number(rows[0].revision),
        reviewer: rows[0].reviewer,
        notes: rows[0].notes,
        updated_at: rows[0].updated_at,
      };
    }
    await client.query("COMMIT");
    return res.json({ ok: true, account_id: canonicalId, manual_values: saved });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/accounts/:id/report-manual-values failed", error);
    return res.status(500).json({ error: "report_manual_values_update_failed" });
  } finally {
    client.release();
  }
});

/** List the independently versioned appraisal files for one property. */
app.get("/api/accounts/:id/assignment-files", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    await Promise.all([
      accountQualityReady,
      propertyEnrichmentReady,
      ensureAssignmentFilesAvailable(),
      ensureCustomAppraisalWorkfilesAvailable(),
    ]);
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const accountResult = await pool.query(
      "SELECT 1 FROM core.accounts WHERE account_id = $1",
      [canonicalId],
    );
    if (!accountResult.rowCount) {
      return res.status(404).json({ error: "account_not_found" });
    }
    const [{ rows }, legacyResult] = await Promise.all([
      pool.query(
        `${ASSIGNMENT_FILE_SELECT}
         WHERE f.account_id = $1
         ORDER BY f.created_at DESC, f.id DESC`,
        [canonicalId],
      ),
      pool.query(
        `SELECT attribute_value
         FROM app.property_attribute_manual_values
         WHERE account_id = $1 AND attribute_key = 'report.assignment_details'`,
        [canonicalId],
      ),
    ]);
    const assignmentIds = rows.map((row) => Number(row.id));
    let sectionRows = [];
    let mobilePhotoRows = [];
    let mobileSketchRows = [];
    if (assignmentIds.length) {
      try {
        [sectionRows, mobilePhotoRows, mobileSketchRows] = await Promise.all([
          pool.query(
            `SELECT assignment_file_id, section_key, section_value, revision,
                    last_applied_session_id, updated_at
               FROM app.custom_appraisal_sections
              WHERE assignment_file_id = ANY($1::bigint[])
              ORDER BY assignment_file_id, section_key`,
            [assignmentIds],
          ).then((result) => result.rows),
          pool.query(
            `SELECT report_file.custom_assignment_file_id AS assignment_file_id,
                    photo.id, photo.category, photo.room_ref, photo.room_label,
                    photo.caption, photo.position, photo.verified_at,
                    photo.retention_until, photo.required_retention_years
               FROM app.report_files report_file
               JOIN app.inspection_photos photo ON photo.report_file_id = report_file.id
              WHERE report_file.custom_assignment_file_id = ANY($1::bigint[])
                AND photo.status = 'verified'
              ORDER BY report_file.custom_assignment_file_id, photo.position, photo.created_at, photo.id`,
            [assignmentIds],
          ).then((result) => result.rows),
          pool.query(
            `SELECT DISTINCT ON (report_file.custom_assignment_file_id)
                    report_file.custom_assignment_file_id AS assignment_file_id,
                    sketch.id, sketch.revision, sketch.document, sketch.summary,
                    sketch.measurement_standard, sketch.measurement_method,
                    sketch.review_status, sketch.confirmed_at, sketch.updated_at
               FROM app.report_files report_file
               JOIN app.inspection_sketches sketch ON sketch.report_file_id = report_file.id
              WHERE report_file.custom_assignment_file_id = ANY($1::bigint[])
              ORDER BY report_file.custom_assignment_file_id, sketch.updated_at DESC, sketch.id DESC`,
            [assignmentIds],
          ).then((result) => result.rows),
        ]);
      } catch (error) {
        if (error?.code !== "42P01") throw error;
      }
    }
    const files = rows.map((row) => {
      const response = assignmentFileResponse(row);
      const customSections = Object.fromEntries(
        sectionRows
          .filter((section) => Number(section.assignment_file_id) === response.id)
          .map((section) => [section.section_key, {
            value: section.section_value,
            revision: Number(section.revision),
            last_applied_session_id: section.last_applied_session_id,
            updated_at: section.updated_at,
          }]),
      );
      return {
        ...response,
        custom_appraisal_sections: customSections,
        mobile_inspection_sketch: mobileSketchRows
          .filter((sketch) => Number(sketch.assignment_file_id) === response.id)
          .map((sketch) => ({
            id: sketch.id,
            revision: Number(sketch.revision),
            document: sketch.document,
            summary: sketch.summary,
            measurement_standard: sketch.measurement_standard,
            measurement_method: sketch.measurement_method,
            review_status: sketch.review_status,
            confirmed_at: sketch.confirmed_at,
            updated_at: sketch.updated_at,
          }))[0] || null,
        mobile_inspection_photos: mobilePhotoRows
          .filter((photo) => Number(photo.assignment_file_id) === response.id)
          .map((photo) => ({
            id: photo.id,
            category: photo.category,
            room_ref: photo.room_ref,
            room_label: photo.room_label,
            caption: photo.caption,
            position: Number(photo.position),
            verified_at: photo.verified_at,
            retention_until: photo.retention_until,
            required_retention_years: Number(photo.required_retention_years),
          })),
      };
    });
    return res.json({
      account_id: canonicalId,
      files,
      latest_file: files[0] || null,
      legacy_assignment_details: legacyResult.rows[0]?.attribute_value || null,
    });
  } catch (error) {
    console.error("assignment file list failed", error);
    return res.status(500).json({ error: "assignment_file_list_failed" });
  }
});

/** List Custom and UAD appraisal history without treating prior observations as current facts. */
app.get("/api/accounts/:id/appraisal-history", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const schema = await pool.query(
      "SELECT to_regclass('app.appraisal_cases') AS table_name",
    );
    if (!schema.rows[0]?.table_name) {
      return res.status(503).json({ error: "appraisal_history_schema_unavailable" });
    }
    return res.json(await listPreviousAppraisalFiles(pool, canonicalId));
  } catch (error) {
    if (String(error?.message || "").startsWith("invalid_")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("appraisal history list failed", error);
    return res.status(500).json({ error: "appraisal_history_list_failed" });
  }
});

/** Create either an alternate report for the same assignment or a clean new appraisal template. */
app.post("/api/accounts/:id/appraisal-history/:reportFileId/replicate", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const result = await replicateAppraisalFile(pool, {
      accountId: canonicalId,
      sourceReportFileId: req.params.reportFileId,
      input: req.body || {},
    });
    return res.status(201).json({ ok: true, ...result });
  } catch (error) {
    const message = String(error?.message || "");
    if (message.endsWith("_not_found")) return res.status(404).json({ error: message });
    if (
      message.startsWith("invalid_")
      || message === "same_assignment_confirmation_required"
      || message === "same_assignment_requires_alternate_workflow"
    ) {
      return res.status(400).json({ error: message });
    }
    if (message.endsWith("_conflict") || error?.code === "23505") {
      return res.status(409).json({ error: message || "appraisal_replication_conflict" });
    }
    console.error("appraisal file replication failed", error);
    return res.status(500).json({ error: "appraisal_file_replication_failed" });
  }
});

/** Download or embed the current report-file sketch as a scalable vector exhibit. */
app.get("/api/accounts/:id/assignment-files/:fileId/mobile-sketch/preview.svg", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  let assignmentFileId;
  try {
    assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await Promise.all([
      accountQualityReady,
      propertyEnrichmentReady,
      ensureAssignmentFilesAvailable(),
      ensureCustomAppraisalWorkfilesAvailable(),
    ]);
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const result = await getAssignmentInspectionSketch(pool, canonicalId, assignmentFileId);
    if (!result) return res.status(404).json({ error: "assignment_sketch_not_found" });
    const fileName = (result.artifact_options.fileNumber || "homenode")
      .replace(/[^A-Za-z0-9._-]/g, "_");
    const svg = renderSketchSvg(result.sketch, result.artifact_options);
    return res
      .set("Cache-Control", "no-store")
      .set("Content-Disposition", 'inline; filename="' + fileName + '-measured-sketch.svg"')
      .type("image/svg+xml")
      .send(svg);
  } catch (error) {
    if (error?.message === "invalid_assignment_file_id") {
      return res.status(400).json({ error: error.message });
    }
    console.error("assignment sketch SVG failed", error);
    return res.status(500).json({ error: "assignment_sketch_svg_failed" });
  }
});

/** Download the current report-file sketch as a report-ready PDF exhibit. */
app.get("/api/accounts/:id/assignment-files/:fileId/mobile-sketch/report.pdf", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  let assignmentFileId;
  try {
    assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await Promise.all([
      accountQualityReady,
      propertyEnrichmentReady,
      ensureAssignmentFilesAvailable(),
      ensureCustomAppraisalWorkfilesAvailable(),
    ]);
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const result = await getAssignmentInspectionSketch(pool, canonicalId, assignmentFileId);
    if (!result) return res.status(404).json({ error: "assignment_sketch_not_found" });
    const fileName = (result.artifact_options.fileNumber || "homenode")
      .replace(/[^A-Za-z0-9._-]/g, "_");
    const pdf = await renderSketchPdf(result.sketch, result.artifact_options);
    return res
      .set("Cache-Control", "no-store")
      .set("Content-Disposition", 'attachment; filename="' + fileName + '-measured-sketch.pdf"')
      .type("application/pdf")
      .send(pdf);
  } catch (error) {
    if (error?.message === "invalid_assignment_file_id") {
      return res.status(400).json({ error: error.message });
    }
    console.error("assignment sketch PDF failed", error);
    return res.status(500).json({ error: "assignment_sketch_pdf_failed" });
  }
});

/** Review a mobile sketch on desktop without overwriting an earlier revision. */
app.patch("/api/accounts/:id/assignment-files/:fileId/mobile-sketch", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  let assignmentFileId;
  try {
    assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await Promise.all([accountQualityReady, propertyEnrichmentReady, ensureAssignmentFilesAvailable()]);
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const result = await saveAssignmentInspectionSketch(
      pool,
      canonicalId,
      assignmentFileId,
      req.body,
    );
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error?.message === "assignment_sketch_not_found") {
      return res.status(404).json({ error: error.message });
    }
    if (error?.message === "sketch_revision_conflict") {
      return res.status(409).json({
        error: error.message,
        current_revision: error.currentRevision,
      });
    }
    if (
      String(error?.message || "").startsWith("invalid_")
      || String(error?.message || "").startsWith("duplicate_")
      || error?.message === "sketch_not_ready_for_confirmation"
      || error?.message === "sketch_operation_conflict"
    ) {
      return res.status(error?.message === "sketch_operation_conflict" ? 409 : 400)
        .json({ error: error.message });
    }
    console.error("assignment sketch desktop review failed", error);
    return res.status(500).json({ error: "assignment_sketch_update_failed" });
  }
});

/** Load the current canonical Property Tax Protest file and accepted mobile evidence. */
app.get("/api/accounts/:id/property-tax-protest", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    await Promise.all([accountQualityReady, propertyEnrichmentReady]);
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const file = await getDesktopPropertyTaxFile(pool, canonicalId, req.query.file_id || null);
    return res.json({ account_id: canonicalId, file });
  } catch (error) {
    if (String(error?.message || "").startsWith("invalid_")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("property tax protest load failed", error);
    return res.status(500).json({ error: "property_tax_protest_load_failed" });
  }
});

/** Save a reviewed desktop protest revision without replacing prior history. */
app.patch("/api/accounts/:id/property-tax-protest/:fileId", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    await Promise.all([accountQualityReady, propertyEnrichmentReady]);
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const file = await saveDesktopPropertyTaxFile(
      pool,
      canonicalId,
      req.params.fileId,
      req.body || {},
    );
    return res.json({ ok: true, file });
  } catch (error) {
    if (error?.message === "property_tax_protest_revision_conflict") {
      return res.status(409).json({ error: error.message, current_revision: error.currentRevision });
    }
    if (error?.message === "property_tax_protest_file_not_found") {
      return res.status(404).json({ error: error.message });
    }
    if (String(error?.message || "").startsWith("invalid_")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("property tax protest save failed", error);
    return res.status(500).json({ error: "property_tax_protest_save_failed" });
  }
});

/** Create a new appraisal file without changing any earlier assignment file. */
app.post("/api/accounts/:id/assignment-files", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  let fileNumber;
  let inheritedFromFileId;
  try {
    fileNumber = normalizeAssignmentFileNumber(req.body?.file_number);
    inheritedFromFileId = normalizeAssignmentFileId(req.body?.inherited_from_file_id);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_assignment_file" });
  }
  const reviewer = String(req.body?.reviewer || "HomeNode editor")
    .trim()
    .slice(0, 200) || "HomeNode editor";
  const client = await pool.connect();
  try {
    await Promise.all([
      accountQualityReady,
      propertyEnrichmentReady,
      ensureAssignmentFilesAvailable(),
      ensureCustomAppraisalWorkfilesAvailable(),
    ]);
    await client.query("BEGIN");
    const canonicalId = await resolveCanonicalAccountId(client, requestedId);
    const accountResult = await client.query(
      "SELECT 1 FROM core.accounts WHERE account_id = $1",
      [canonicalId],
    );
    if (!accountResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }

    let sourceFile = null;
    if (inheritedFromFileId) {
      const sourceResult = await client.query(
        `SELECT id, assignment_details
         FROM app.assignment_files
         WHERE id = $1 AND account_id = $2`,
        [inheritedFromFileId, canonicalId],
      );
      sourceFile = sourceResult.rows[0] || null;
      if (!sourceFile) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "invalid_inherited_assignment_file" });
      }
    }

    let assignmentDetails = req.body?.assignment_details;
    if (assignmentDetails === undefined) {
      if (sourceFile) {
        assignmentDetails = sourceFile.assignment_details;
      } else {
        const latestResult = await client.query(
          `SELECT id, assignment_details
           FROM app.assignment_files
           WHERE account_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
          [canonicalId],
        );
        sourceFile = latestResult.rows[0] || null;
        if (sourceFile) inheritedFromFileId = Number(sourceFile.id);
        assignmentDetails = sourceFile?.assignment_details;
      }
      if (assignmentDetails === undefined) {
        const legacyResult = await client.query(
          `SELECT attribute_value
           FROM app.property_attribute_manual_values
           WHERE account_id = $1 AND attribute_key = 'report.assignment_details'`,
          [canonicalId],
        );
        assignmentDetails = legacyResult.rows[0]?.attribute_value || {};
      }
    }
    validateReportManualSection("report.assignment_details", assignmentDetails);

    const inserted = await client.query(
      `INSERT INTO app.assignment_files (
         account_id, file_number, assignment_details, inherited_from_file_id, reviewer
       ) VALUES ($1,$2,$3::jsonb,$4,$5)
       RETURNING id`,
      [canonicalId, fileNumber, JSON.stringify(assignmentDetails), inheritedFromFileId, reviewer],
    );
    const assignmentFileId = Number(inserted.rows[0].id);
    await client.query(
      `INSERT INTO app.custom_appraisal_workfiles (
         assignment_file_id, canonical_file_name
       ) VALUES ($1, $2)
       ON CONFLICT (assignment_file_id) DO NOTHING`,
      [
        assignmentFileId,
        canonicalCustomAppraisalFileName(fileNumber, assignmentFileId),
      ],
    );
    const reportRegistryResult = await client.query(
      "SELECT to_regclass('app.report_files') AS table_name",
    );
    if (reportRegistryResult.rows[0]?.table_name) {
      const previousRegistryResult = inheritedFromFileId
        ? await client.query(
          `SELECT id FROM app.report_files
            WHERE custom_assignment_file_id = $1`,
          [inheritedFromFileId],
        )
        : { rows: [] };
      await client.query(
        `UPDATE app.report_files
            SET is_current = false, updated_at = now()
          WHERE organization_id IS NULL
            AND account_id = $1
            AND workflow_type = 'custom_appraisal'
            AND is_current = true`,
        [canonicalId],
      );
      const reportFileResult = await client.query(
        `INSERT INTO app.report_files (
           organization_id, account_id, workflow_type, file_number,
           previous_report_file_id, custom_assignment_file_id,
           is_current, registry_revision
         ) VALUES (NULL, $1, 'custom_appraisal', $2, $3, $4, true, 1)
         ON CONFLICT (custom_assignment_file_id)
           WHERE custom_assignment_file_id IS NOT NULL
         DO UPDATE SET is_current = true, updated_at = now()
         RETURNING id`,
        [
          canonicalId,
          fileNumber,
          previousRegistryResult.rows[0]?.id || null,
          assignmentFileId,
        ],
      );
      const historyRegistry = await client.query(
        "SELECT to_regclass('app.appraisal_cases') AS table_name",
      );
      if (historyRegistry.rows[0]?.table_name) {
        await registerOriginalAppraisalReport(client, reportFileResult.rows[0].id, {
          captureReason: "desktop_custom_appraisal_created",
        });
      }
    }
    await client.query(
      `INSERT INTO app.assignment_file_history (
         assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
       ) VALUES ($1,$2,$3,$4::jsonb,$5,1)`,
      [assignmentFileId, canonicalId, fileNumber, JSON.stringify(assignmentDetails), reviewer],
    );
    await mirrorLatestAssignmentDetails(
      client,
      canonicalId,
      assignmentDetails,
      reviewer,
      fileNumber,
    );
    const { rows } = await client.query(
      `${ASSIGNMENT_FILE_SELECT} WHERE f.id = $1`,
      [assignmentFileId],
    );
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, assignment_file: assignmentFileResponse(rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error?.code === "23505") {
      return res.status(409).json({ error: "assignment_file_number_exists" });
    }
    const validationErrors = new Set([
      "invalid_assignment_details",
      "invalid_pud_value",
      "invalid_assignment_type",
      "invalid_hoa_frequency",
      "invalid_occupancy",
      "pud_requires_hoa_dues_or_explanation",
      "other_hoa_frequency_requires_explanation",
      "unknown_occupancy_requires_explanation",
      "other_assignment_type_requires_explanation",
      "invalid_lender_client_name",
      "invalid_lender_client_address",
      "lender_client_name_too_long",
      "lender_client_address_too_long",
      "invalid_subject_under_contract",
      "invalid_contract_arms_length",
      "invalid_seller_match_value",
      "invalid_contract_seller_names",
      "invalid_contract_date",
      "invalid_seller_mismatch_explanation",
      "contract_seller_names_too_long",
      "contract_date_too_long",
      "seller_mismatch_explanation_too_long",
      "contract_requires_purchase_transaction",
      "contract_requires_arms_length_selection",
      "contract_requires_seller_match_selection",
      "seller_mismatch_requires_explanation",
    ]);
    if (
      validationErrors.has(error?.message) ||
      String(error?.message || "").startsWith("invalid_neighborhood_") ||
      String(error?.message || "").startsWith("neighborhood_")
    ) {
      return res.status(400).json({ error: error.message });
    }
    console.error("assignment file create failed", error);
    return res.status(500).json({ error: "assignment_file_create_failed" });
  } finally {
    client.release();
  }
});

/** Save additional work while retaining internal audit snapshots for conflict recovery. */
app.patch("/api/accounts/:id/assignment-files/:fileId", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  let assignmentFileId;
  try {
    assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    validateReportManualSection("report.assignment_details", req.body?.assignment_details);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_assignment_file" });
  }
  const expectedRevision = Number(req.body?.expected_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return res.status(400).json({ error: "invalid_expected_revision" });
  }
  const reviewer = String(req.body?.reviewer || "HomeNode editor")
    .trim()
    .slice(0, 200) || "HomeNode editor";
  const assignmentDetails = req.body.assignment_details;
  const client = await pool.connect();
  try {
    await Promise.all([
      accountQualityReady,
      propertyEnrichmentReady,
      ensureAssignmentFilesAvailable(),
      ensureCustomAppraisalWorkfilesAvailable(),
    ]);
    await client.query("BEGIN");
    const canonicalId = await resolveCanonicalAccountId(client, requestedId);
    const existingResult = await client.query(
      `SELECT assignment_file.id, assignment_file.file_number, assignment_file.revision,
              workfile.status AS workfile_status
       FROM app.assignment_files assignment_file
       LEFT JOIN app.custom_appraisal_workfiles workfile
         ON workfile.assignment_file_id = assignment_file.id
       WHERE assignment_file.id = $1 AND assignment_file.account_id = $2
       FOR UPDATE OF assignment_file`,
      [assignmentFileId, canonicalId],
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "assignment_file_not_found" });
    }
    if (existing.workfile_status === "signed") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "custom_appraisal_workfile_signed" });
    }
    if (Number(existing.revision) !== expectedRevision) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "assignment_file_revision_conflict",
        current_revision: Number(existing.revision),
      });
    }
    const revision = expectedRevision + 1;
    await client.query(
      `UPDATE app.assignment_files
       SET assignment_details = $1::jsonb, reviewer = $2, revision = $3, updated_at = now()
       WHERE id = $4`,
      [JSON.stringify(assignmentDetails), reviewer, revision, assignmentFileId],
    );
    await client.query(
      `INSERT INTO app.assignment_file_history (
         assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
      [
        assignmentFileId,
        canonicalId,
        existing.file_number,
        JSON.stringify(assignmentDetails),
        reviewer,
        revision,
      ],
    );
    await mirrorLatestAssignmentDetails(
      client,
      canonicalId,
      assignmentDetails,
      reviewer,
      existing.file_number,
    );
    const { rows } = await client.query(
      `${ASSIGNMENT_FILE_SELECT} WHERE f.id = $1`,
      [assignmentFileId],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, assignment_file: assignmentFileResponse(rows[0]) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("assignment file update failed", error);
    return res.status(500).json({ error: "assignment_file_update_failed" });
  } finally {
    client.release();
  }
});

/** Load all database-backed sections for one Custom Appraisal file. */
app.get("/api/accounts/:id/assignment-files/:fileId/workfile", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  let assignmentFileId;
  try {
    assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await ensureCustomAppraisalWorkfilesAvailable();
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const workfile = await getCustomAppraisalWorkfile(pool, {
      accountId: canonicalId,
      assignmentFileId,
    });
    return res.json({ ok: true, account_id: canonicalId, workfile });
  } catch (error) {
    if (error?.message === "assignment_file_not_found") {
      return res.status(404).json({ error: error.message });
    }
    if (String(error?.message || "").startsWith("invalid_")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("custom appraisal workfile load failed", error);
    return res.status(500).json({ error: "custom_appraisal_workfile_load_failed" });
  }
});

/** Run the authoritative finalization E&O checks without changing the file. */
app.get("/api/accounts/:id/assignment-files/:fileId/workfile/readiness", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    const assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await ensureCustomAppraisalWorkfilesAvailable();
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const readiness = await getCustomAppraisalWorkfileReadiness(pool, {
      accountId: canonicalId,
      assignmentFileId,
    });
    return res.json({ ok: true, account_id: canonicalId, readiness });
  } catch (error) {
    if (error?.message === "assignment_file_not_found") {
      return res.status(404).json({ error: error.message });
    }
    if (String(error?.message || "").startsWith("invalid_")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("custom appraisal workfile readiness failed", error);
    return res.status(500).json({ error: "custom_appraisal_workfile_readiness_failed" });
  }
});

/** Download the live draft or immutable signed snapshot under its unique name. */
app.get("/api/accounts/:id/assignment-files/:fileId/workfile/download", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    const assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await ensureCustomAppraisalWorkfilesAvailable();
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const download = await getCustomAppraisalWorkfileDownload(pool, {
      accountId: canonicalId,
      assignmentFileId,
    });
    const fileName = String(download.canonical_file_name).replace(/[\r\n"]/g, "_");
    const serialized = `${JSON.stringify(download.snapshot, null, 2)}\n`;
    res.set({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": download.immutable ? "private, max-age=86400, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-HomeNode-Immutable": String(download.immutable),
    });
    if (download.checksum_sha256) res.set("ETag", `"${download.checksum_sha256}"`);
    return res.send(serialized);
  } catch (error) {
    if (error?.message === "assignment_file_not_found") {
      return res.status(404).json({ error: error.message });
    }
    console.error("custom appraisal workfile download failed", error);
    return res.status(500).json({ error: "custom_appraisal_workfile_download_failed" });
  }
});

/** Generate a fixed-layout draft PDF or return the immutable signed PDF artifact. */
app.get("/api/accounts/:id/assignment-files/:fileId/workfile/report.pdf", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    const assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await ensureCustomAppraisalWorkfilesAvailable();
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const download = await getCustomAppraisalWorkfileDownload(pool, {
      accountId: canonicalId,
      assignmentFileId,
    });
    const report = await getCustomAppraisalReportPdf(pool, {
      accountId: canonicalId,
      assignmentFileId,
      download,
    });
    const fileName = String(report.canonical_file_name).replace(/[\r\n"]/g, "_");
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(report.content.length),
      "Cache-Control": report.immutable ? "private, max-age=86400, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-HomeNode-Immutable": String(report.immutable),
      "X-HomeNode-Report-Pages": String(report.page_count),
      "ETag": `"${report.content_sha256}"`,
    });
    return res.send(report.content);
  } catch (error) {
    if (error?.message === "assignment_file_not_found") {
      return res.status(404).json({ error: error.message });
    }
    console.error("custom appraisal report PDF failed", error);
    return res.status(500).json({ error: "custom_appraisal_report_pdf_failed" });
  }
});

/** Save one independently versioned Custom Appraisal section. */
app.put("/api/accounts/:id/assignment-files/:fileId/workfile/sections/:sectionKey", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  let assignmentFileId;
  try {
    assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await ensureCustomAppraisalWorkfilesAvailable();
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const section = await saveCustomAppraisalWorkfileSection(pool, {
      accountId: canonicalId,
      assignmentFileId,
      sectionKey: req.params.sectionKey,
      sectionValue: req.body?.value,
      expectedRevision: req.body?.expected_revision,
      saveReason: req.body?.save_reason,
      reviewer: req.body?.reviewer,
    });
    return res.json({ ok: true, account_id: canonicalId, assignment_file_id: assignmentFileId, section });
  } catch (error) {
    if (error?.message === "assignment_file_not_found") {
      return res.status(404).json({ error: error.message });
    }
    if (error?.message === "custom_appraisal_section_revision_conflict") {
      return res.status(409).json({
        error: error.message,
        current_revision: Number(error.currentRevision || 0),
      });
    }
    if (error?.message === "custom_appraisal_workfile_signed") {
      return res.status(409).json({ error: error.message });
    }
    if (
      String(error?.message || "").startsWith("invalid_") ||
      error?.message === "custom_appraisal_section_too_large"
    ) {
      return res.status(400).json({ error: error.message });
    }
    console.error("custom appraisal workfile section save failed", error);
    return res.status(500).json({ error: "custom_appraisal_workfile_save_failed" });
  }
});

/** Create the immutable snapshot that represents the signed/finalized appraisal. */
app.post("/api/accounts/:id/assignment-files/:fileId/workfile/sign", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    const assignmentFileId = normalizeAssignmentFileId(req.params.fileId, { required: true });
    await ensureCustomAppraisalWorkfilesAvailable();
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const workfile = await signCustomAppraisalWorkfile(pool, {
      accountId: canonicalId,
      assignmentFileId,
      signedBy: req.body?.signed_by || req.body?.reviewer,
      acknowledgedWarningCodes: req.body?.acknowledged_warning_codes,
    });
    return res.json({ ok: true, account_id: canonicalId, workfile });
  } catch (error) {
    if (error?.message === "assignment_file_not_found") {
      return res.status(404).json({ error: error.message });
    }
    if (["custom_appraisal_workfile_signed", "custom_appraisal_workfile_empty"].includes(error?.message)) {
      return res.status(409).json({ error: error.message });
    }
    if (error?.message === "custom_appraisal_eo_incomplete") {
      return res.status(422).json({
        error: error.message,
        readiness_errors: error.readinessErrors || [],
        readiness: error.readiness || null,
      });
    }
    if (error?.message === "custom_appraisal_eo_warnings_unacknowledged") {
      return res.status(422).json({
        error: error.message,
        readiness_warnings: error.readinessWarnings || [],
        readiness: error.readiness || null,
      });
    }
    if (String(error?.message || "").startsWith("invalid_")) {
      return res.status(400).json({ error: error.message });
    }
    console.error("custom appraisal workfile signing failed", error);
    return res.status(500).json({ error: "custom_appraisal_workfile_sign_failed" });
  }
});

function requireEditor(req, res) {
  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (!configuredEditorKey) {
    res.status(503).json({ error: "editor_not_configured" });
    return false;
  }
  if (!editorKeyMatches(req.get("x-homenode-editor-key"), configuredEditorKey)) {
    res.status(401).json({ error: "invalid_editor_key" });
    return false;
  }
  return true;
}

/** Coordinate coverage and queue health for mapped sale accounts. */
app.get("/api/location-backfill/status", async (_req, res) => {
  try {
    await locationBackfillReady;
    await ensureLocationBackfillQueueSchema(pool);
    return res.json(await getLocationBackfillStatus(pool));
  } catch (error) {
    console.error("location backfill status failed", error);
    return res.status(500).json({ error: "location_backfill_status_failed" });
  }
});

/** Explicit maintenance run; ordinary imports and sweeps remain automatic. */
app.post("/api/location-backfill/run", async (req, res) => {
  if (!requireEditor(req, res)) return;
  try {
    await locationBackfillReady;
    await ensureLocationBackfillQueueSchema(pool);
    const seed = await seedLocationBackfillQueue(pool, {
      limit: req.body?.seed_limit,
    });
    const result = await runLocationBackfillBatch(pool, {
      batchSize: req.body?.batch_size,
      maximumAttempts: process.env.LOCATION_BACKFILL_MAX_ATTEMPTS,
    });
    return res.json({ ok: true, seed, result });
  } catch (error) {
    console.error("location backfill maintenance run failed", error);
    return res.status(500).json({ error: "location_backfill_run_failed" });
  }
});

/** Census tract coverage for every property with a cached parcel coordinate. */
app.get("/api/census-geography/status", async (_req, res) => {
  try {
    await censusGeographyReady;
    await ensureCensusGeographySchema(pool);
    return res.json(await getCensusGeographyStatus(pool));
  } catch (error) {
    console.error("census geography status failed", error);
    return res.status(500).json({ error: "census_geography_status_failed" });
  }
});

/** Give a report user one validated tract immediately without waiting for the queue. */
app.post("/api/accounts/:id/census-geography/lookup", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    await accountQualityReady;
    await censusGeographyReady;
    const canonicalId = await resolveCanonicalAccountId(pool, requestedId);
    const censusGeography = await lookupAccountCensusGeographyNow(pool, canonicalId);
    return res.json({ ok: true, account_id: canonicalId, census_geography: censusGeography });
  } catch (error) {
    const code = String(error?.code || error?.message || "");
    if (code === "account_not_found") return res.status(404).json({ error: code });
    if (code === "census_lookup_input_missing") return res.status(422).json({ error: code });
    console.error("on-demand census geography lookup failed", error);
    return res.status(502).json({ error: "census_geography_lookup_failed" });
  }
});

/** Latest configured ACS 5-year unemployment estimate for a ZIP/ZCTA. */
app.get("/api/census/zip-profile/:postalCode", async (req, res) => {
  try {
    return res.json(await fetchCensusZipProfile(req.params.postalCode));
  } catch (error) {
    const code = String(error?.code || error?.message || "census_zip_profile_failed");
    const status = Number(error?.status) || 502;
    if (status >= 500) console.error("Census ZIP profile lookup failed", code);
    return res.status(status).json({ error: code });
  }
});

/** Latest configured ACS 5-year unemployment estimate for a city/place. */
app.get("/api/census/city-profile", async (req, res) => {
  try {
    return res.json(await fetchCensusCityProfile(req.query.city, req.query.state));
  } catch (error) {
    const code = String(error?.code || error?.message || "census_city_profile_failed");
    const status = Number(error?.status) || 502;
    if (status >= 500) console.error("Census city profile lookup failed", code);
    return res.status(status).json({ error: code });
  }
});

/** Explicit maintenance run; the normal low-impact worker remains automatic. */
app.post("/api/census-geography/run", async (req, res) => {
  if (!requireEditor(req, res)) return;
  try {
    await censusGeographyReady;
    await ensureCensusGeographySchema(pool);
    const seed = await seedCensusGeographyQueue(pool, {
      limit: req.body?.seed_limit,
    });
    const result = await runCensusGeographyBatch(pool, {
      batchSize: req.body?.batch_size,
      maximumAttempts: process.env.CENSUS_GEOGRAPHY_MAX_ATTEMPTS,
    });
    return res.json({ ok: true, seed, result });
  } catch (error) {
    console.error("census geography maintenance run failed", error);
    return res.status(500).json({ error: "census_geography_run_failed" });
  }
});

/** Unmatched closed sales remain visible until a user verifies their CAD account. */
app.get("/api/sales/reconciliation-queue", async (req, res) => {
  try {
    await salesReconciliationReady;
    const queue = await listSalesReconciliationQueue(pool, {
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json(queue);
  } catch (error) {
    console.error("sales reconciliation queue failed", error);
    return res.status(500).json({ error: "sales_reconciliation_queue_failed" });
  }
});

/** Explicitly verify a sale-to-account link and upsert the canonical sale. */
app.patch("/api/sales/:sourceRecordId/reconcile", async (req, res) => {
  if (!requireEditor(req, res)) return;
  try {
    await salesReconciliationReady;
    const result = await reconcileSalesSourceRecord(
      pool,
      req.params.sourceRecordId,
      req.body,
    );
    try {
      await locationBackfillReady;
      await ensureLocationBackfillQueueSchema(pool);
      await enqueueLocationBackfillAccounts(
        pool,
        [
          {
            account_id: result.account.account_id,
            address: result.account.address,
            county: result.account.county,
          },
        ],
        {
          reason: "sales_reconciliation",
          priority: 200,
        },
      );
    } catch (locationError) {
      console.warn(
        "manual sale link saved; location queueing deferred",
        locationError?.message || locationError,
      );
    }
    try {
      await ensurePropertyContextAvailable();
      await enqueuePropertyInfluenceAccounts(
        pool,
        [result.account.account_id],
        {
          reason: "sales_reconciliation",
          priority: 200,
        },
      );
    } catch (influenceError) {
      // The confirmed sale remains saved. The durable sale trigger and the
      // next maintenance seed provide two independent retry paths.
      console.warn(
        "manual sale link saved; influence queueing deferred",
        influenceError?.message || influenceError,
      );
    }
    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error?.message || "sales_reconciliation_failed";
    let status = 500;
    if (message === "source_record_not_found" || message === "account_not_found") {
      status = 404;
    } else if (
      message === "ambiguous_collin_account_id" ||
      message === "county_account_identifier_conflict"
    ) {
      status = 409;
    } else if (
      String(message).startsWith("invalid_") ||
      message === "source_record_not_closed_sale" ||
      message === "account_county_mismatch" ||
      message === "account_identifier_mismatch"
    ) {
      status = 400;
    }
    if (status === 500) {
      console.error("sales reconciliation failed", error);
    }
    return res.status(status).json({ error: message });
  }
});

/** Batch-load manually verified condition and quality ratings for MLS source rows. */
app.get("/api/sales/reviews", async (req, res) => {
  const rawIds = String(req.query.source_record_ids || "").split(",");
  const sourceRecordIds = [...new Set(rawIds.map((value) => value.trim()))]
    .filter((value) => /^\d+$/.test(value))
    .slice(0, 200);
  if (!sourceRecordIds.length) return res.json({ reviews: [] });
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `${SALE_REVIEW_SELECT} WHERE source_record_id = ANY($1::bigint[])
       ORDER BY source_record_id`,
      [sourceRecordIds],
    );
    return res.json({ reviews: rows });
  } catch (error) {
    console.error("/api/sales/reviews failed", error);
    return res.status(500).json({ error: "sale_reviews_failed" });
  }
});

/** Explicitly save a reviewed comparable rating without mutating its source MLS row. */
app.patch("/api/sales/:sourceRecordId/review", async (req, res) => {
  const sourceRecordId = String(req.params.sourceRecordId || "").trim();
  if (!/^\d+$/.test(sourceRecordId)) {
    return res.status(400).json({ error: "invalid_source_record_id" });
  }
  if (!requireEditor(req, res)) return;

  let update;
  try {
    update = normalizeAppraisalRatingUpdate(req.body);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_appraisal_rating" });
  }

  const client = await pool.connect();
  try {
    await appraisalRatingsReady;
    await client.query("BEGIN");
    const { rows: sources } = await client.query(
      `SELECT id, listing_id FROM core.sales_source_records WHERE id = $1 FOR SHARE`,
      [sourceRecordId],
    );
    if (!sources.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "sale_source_record_not_found" });
    }
    const { rows: existingRows } = await client.query(
      `SELECT * FROM app.sale_characteristic_reviews
       WHERE source_record_id = $1 FOR UPDATE`,
      [sourceRecordId],
    );
    const existing = existingRows[0] || null;
    const currentRevision = Number(existing?.revision || 0);
    if (
      update.expectedRevision != null &&
      update.expectedRevision !== currentRevision
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "rating_revision_conflict",
        current_revision: currentRevision,
      });
    }
    const nextRevision = currentRevision + 1;
    const { rows } = await client.query(
      `INSERT INTO app.sale_characteristic_reviews (
         source_record_id, listing_id, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_record_id) DO UPDATE SET
         listing_id = EXCLUDED.listing_id,
         condition_rating = EXCLUDED.condition_rating,
         quality_rating = EXCLUDED.quality_rating,
         notes = EXCLUDED.notes,
         reviewer = EXCLUDED.reviewer,
         revision = EXCLUDED.revision,
         updated_at = now()
       RETURNING *`,
      [
        sourceRecordId,
        sources[0].listing_id,
        update.conditionRating,
        update.qualityRating,
        update.notes,
        update.reviewer,
        nextRevision,
      ],
    );
    const review = rows[0];
    await client.query(
      `INSERT INTO app.sale_characteristic_review_history (
         source_record_id, listing_id, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        review.source_record_id,
        review.listing_id,
        review.condition_rating,
        review.quality_rating,
        review.notes,
        review.reviewer,
        review.revision,
      ],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, review });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("/api/sales/:sourceRecordId/review failed", error);
    return res.status(500).json({ error: "sale_review_update_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/sales/:sourceRecordId/review-history", async (req, res) => {
  const sourceRecordId = String(req.params.sourceRecordId || "").trim();
  if (!/^\d+$/.test(sourceRecordId)) {
    return res.status(400).json({ error: "invalid_source_record_id" });
  }
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `SELECT source_record_id, listing_id, condition_rating, quality_rating,
              notes, reviewer, revision, changed_at
       FROM app.sale_characteristic_review_history
       WHERE source_record_id = $1
       ORDER BY revision DESC, changed_at DESC`,
      [sourceRecordId],
    );
    return res.json({ history: rows });
  } catch (error) {
    console.error("sale review history failed", error);
    return res.status(500).json({ error: "sale_review_history_failed" });
  }
});

/** Load the subject's saved rating for the appraisal effective date. */
app.get("/api/accounts/:id/appraisal-rating", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  let effectiveDate;
  try {
    effectiveDate = normalizeEffectiveDate(req.query.effective_date);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_effective_date" });
  }
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `${SUBJECT_RATING_SELECT}
       WHERE account_id = $1 AND effective_date = $2::date`,
      [id, effectiveDate],
    );
    return res.json({ rating: rows[0] || null });
  } catch (error) {
    console.error("subject appraisal rating load failed", error);
    return res.status(500).json({ error: "subject_rating_failed" });
  }
});

/** Explicitly save the subject's condition/quality for one appraisal date. */
app.put("/api/accounts/:id/appraisal-rating", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;

  let effectiveDate;
  let update;
  try {
    effectiveDate = normalizeEffectiveDate(req.body?.effective_date);
    update = normalizeAppraisalRatingUpdate(req.body);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_appraisal_rating" });
  }

  const client = await pool.connect();
  try {
    await appraisalRatingsReady;
    await client.query("BEGIN");
    const accountResult = await client.query(
      "SELECT 1 FROM core.accounts WHERE account_id = $1 FOR SHARE",
      [id],
    );
    if (!accountResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }
    const { rows: existingRows } = await client.query(
      `SELECT * FROM app.subject_appraisal_ratings
       WHERE account_id = $1 AND effective_date = $2::date FOR UPDATE`,
      [id, effectiveDate],
    );
    const currentRevision = Number(existingRows[0]?.revision || 0);
    if (
      update.expectedRevision != null &&
      update.expectedRevision !== currentRevision
    ) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "rating_revision_conflict",
        current_revision: currentRevision,
      });
    }
    const nextRevision = currentRevision + 1;
    const { rows } = await client.query(
      `INSERT INTO app.subject_appraisal_ratings (
         account_id, effective_date, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1,$2::date,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, effective_date) DO UPDATE SET
         condition_rating = EXCLUDED.condition_rating,
         quality_rating = EXCLUDED.quality_rating,
         notes = EXCLUDED.notes,
         reviewer = EXCLUDED.reviewer,
         revision = EXCLUDED.revision,
         updated_at = now()
       RETURNING *`,
      [
        id,
        effectiveDate,
        update.conditionRating,
        update.qualityRating,
        update.notes,
        update.reviewer,
        nextRevision,
      ],
    );
    const rating = rows[0];
    await client.query(
      `INSERT INTO app.subject_appraisal_rating_history (
         account_id, effective_date, condition_rating, quality_rating,
         notes, reviewer, revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        rating.account_id,
        rating.effective_date,
        rating.condition_rating,
        rating.quality_rating,
        rating.notes,
        rating.reviewer,
        rating.revision,
      ],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, rating });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("subject appraisal rating update failed", error);
    return res.status(500).json({ error: "subject_rating_update_failed" });
  } finally {
    client.release();
  }
});

app.get("/api/accounts/:id/appraisal-rating-history", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    await appraisalRatingsReady;
    const { rows } = await pool.query(
      `SELECT account_id, effective_date, condition_rating, quality_rating,
              notes, reviewer, revision, changed_at
       FROM app.subject_appraisal_rating_history
       WHERE account_id = $1
       ORDER BY effective_date DESC, revision DESC, changed_at DESC
       LIMIT 100`,
      [id],
    );
    return res.json({ history: rows });
  } catch (error) {
    console.error("subject appraisal rating history failed", error);
    return res.status(500).json({ error: "subject_rating_history_failed" });
  }
});

async function getNonDallasAccount(client, accountId) {
  const { rows } = await client.query(
    `SELECT account_id, county FROM core.accounts WHERE account_id = $1`,
    [accountId],
  );
  if (!rows.length) return null;
  return {
    ...rows[0],
    normalized_county: assertNonDallasEnrichmentCounty(rows[0].county),
  };
}

/** Non-sensitive activation status for the additive non-Dallas pipeline. */
app.get("/api/enrichment/status", async (_req, res) => {
  const gis = Object.fromEntries(
    NON_DALLAS_ENRICHMENT_COUNTIES.map((county) => {
      const configuration = countyGisConfiguration(county);
      return [county, { configured: configuration.configured }];
    }),
  );
  try {
    return res.json({
      dallas_county_isolated: true,
      supported_counties: NON_DALLAS_ENRICHMENT_COUNTIES,
      trestle: await getTrestleReplicationStatus(pool, trestleClient.status()),
      gis,
      resolution_order: ["manual_verified", "trestle", "cad", "manual_review"],
    });
  } catch (error) {
    console.error("enrichment status failed", error);
    return res.status(500).json({ error: "enrichment_status_failed" });
  }
});

/** Load verified overrides, review flags, and pending GIS suggestions for an account. */
app.get("/api/accounts/:id/enrichment", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
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
    return res.json({
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
    console.error("account enrichment load failed", error);
    return res.status(500).json({ error: "account_enrichment_failed" });
  }
});

/** Save a verified non-Dallas attribute. No autosave and no source-row mutation. */
app.patch("/api/accounts/:id/verified-attribute", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  let attributeKey;
  try {
    attributeKey = assertPropertyAttributeKey(req.body?.attribute_key);
  } catch (error) {
    return res.status(400).json({ error: error?.message || "invalid_attribute" });
  }
  if (req.body?.attribute_value === undefined) {
    return res.status(400).json({ error: "missing_attribute_value" });
  }
  const notes = String(req.body?.notes || "").trim().slice(0, 4000) || null;
  const reviewer = String(req.body?.reviewer || "HomeNode editor").trim().slice(0, 200);
  const expectedRevision = req.body?.expected_revision == null
    ? null
    : Number(req.body.expected_revision);
  if (expectedRevision != null && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    return res.status(400).json({ error: "invalid_expected_revision" });
  }

  const client = await pool.connect();
  try {
    await propertyEnrichmentReady;
    await client.query("BEGIN");
    const account = await getNonDallasAccount(client, id);
    if (!account) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }
    const { rows: existingRows } = await client.query(
      `SELECT revision FROM app.property_attribute_manual_values
       WHERE account_id = $1 AND attribute_key = $2 FOR UPDATE`,
      [id, attributeKey],
    );
    const currentRevision = Number(existingRows[0]?.revision || 0);
    if (expectedRevision != null && expectedRevision !== currentRevision) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "attribute_revision_conflict",
        current_revision: currentRevision,
      });
    }
    const nextRevision = currentRevision + 1;
    const valueJson = JSON.stringify(req.body.attribute_value);
    const { rows } = await client.query(
      `INSERT INTO app.property_attribute_manual_values (
         account_id, attribute_key, attribute_value, notes, reviewer, revision
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT (account_id, attribute_key) DO UPDATE SET
         attribute_value = EXCLUDED.attribute_value,
         notes = EXCLUDED.notes,
         reviewer = EXCLUDED.reviewer,
         revision = EXCLUDED.revision,
         updated_at = now()
       RETURNING *`,
      [id, attributeKey, valueJson, notes, reviewer, nextRevision],
    );
    const manualValue = rows[0];
    await client.query(
      `INSERT INTO app.property_attribute_manual_history (
         account_id, attribute_key, attribute_value, notes, reviewer, revision
       ) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
      [id, attributeKey, valueJson, notes, reviewer, nextRevision],
    );
    await client.query(
      `UPDATE app.enrichment_review_queue
       SET status = 'resolved', resolved_at = now(), updated_at = now()
       WHERE account_id = $1 AND attribute_key = $2`,
      [id, attributeKey],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, manual_value: manualValue });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const message = String(error?.message || "");
    if (message === "dallas_enrichment_isolated") {
      return res.status(409).json({ error: message });
    }
    console.error("verified attribute update failed", error);
    return res.status(500).json({ error: "verified_attribute_update_failed" });
  } finally {
    client.release();
  }
});

/** Calculate and store a review-only lot-area suggestion from official county GIS. */
app.post("/api/accounts/:id/parcel-area-suggestion", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    await propertyEnrichmentReady;
    const account = await getNonDallasAccount(pool, id);
    if (!account) return res.status(404).json({ error: "account_not_found" });
    const suggestion = await fetchParcelAreaSuggestion({
      county: account.normalized_county,
      accountId: id,
    });
    if (!suggestion) return res.status(404).json({ error: "parcel_geometry_not_found" });
    const { rows } = await pool.query(
      `INSERT INTO app.parcel_geometry_suggestions (
         account_id, county, source_url, geometry, area_square_feet,
         area_acres, source_attributes, status
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,'pending')
       RETURNING id, account_id, county, source_url, area_square_feet,
                 area_acres, status, created_at`,
      [
        id,
        suggestion.county,
        suggestion.source_url,
        JSON.stringify(suggestion.geometry),
        suggestion.area_square_feet,
        suggestion.area_acres,
        JSON.stringify(suggestion.source_attributes),
      ],
    );
    await pool.query(
      `INSERT INTO app.enrichment_review_queue (
         account_id, county, attribute_key, reason, evidence
       ) VALUES ($1,$2,'site_size_sqft','gis_site_area_requires_approval',$3::jsonb)
       ON CONFLICT (account_id, attribute_key) DO UPDATE SET
         county = EXCLUDED.county,
         reason = EXCLUDED.reason,
         status = 'pending',
         evidence = EXCLUDED.evidence,
         resolved_at = NULL,
         updated_at = now()`,
      [id, suggestion.county, JSON.stringify({ suggestion_id: rows[0].id })],
    );
    return res.json({ ok: true, suggestion: rows[0] });
  } catch (error) {
    const message = String(error?.message || "");
    if (["dallas_enrichment_isolated", "county_gis_not_configured"].includes(message)) {
      return res.status(409).json({ error: message });
    }
    console.error("parcel area suggestion failed", error);
    return res.status(500).json({ error: message || "parcel_area_suggestion_failed" });
  }
});

app.post("/api/accounts/:id/parcel-area-suggestions/:suggestionId/decision", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const suggestionId = String(req.params.suggestionId || "").trim();
  const decision = String(req.body?.decision || "").trim().toLowerCase();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id) || !/^\d+$/.test(suggestionId)) {
    return res.status(400).json({ error: "invalid_suggestion_target" });
  }
  if (!new Set(["approved", "rejected"]).has(decision)) {
    return res.status(400).json({ error: "invalid_suggestion_decision" });
  }
  if (!requireEditor(req, res)) return;
  const reviewer = String(req.body?.reviewer || "HomeNode editor").trim().slice(0, 200);
  const client = await pool.connect();
  try {
    await propertyEnrichmentReady;
    await client.query("BEGIN");
    const account = await getNonDallasAccount(client, id);
    if (!account) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "account_not_found" });
    }
    const { rows } = await client.query(
      `SELECT * FROM app.parcel_geometry_suggestions
       WHERE id = $1 AND account_id = $2 FOR UPDATE`,
      [suggestionId, id],
    );
    const suggestion = rows[0];
    if (!suggestion) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "parcel_suggestion_not_found" });
    }
    if (suggestion.status !== "pending") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "parcel_suggestion_already_reviewed" });
    }
    await client.query(
      `UPDATE app.parcel_geometry_suggestions
       SET status = $3, reviewed_by = $4, reviewed_at = now()
       WHERE id = $1 AND account_id = $2`,
      [suggestionId, id, decision, reviewer],
    );
    if (decision === "approved") {
      const valueJson = JSON.stringify(Number(suggestion.area_square_feet));
      const { rows: existingRows } = await client.query(
        `SELECT revision FROM app.property_attribute_manual_values
         WHERE account_id = $1 AND attribute_key = 'site_size_sqft' FOR UPDATE`,
        [id],
      );
      const revision = Number(existingRows[0]?.revision || 0) + 1;
      const notes = `Approved official county GIS suggestion ${suggestionId}.`;
      await client.query(
        `INSERT INTO app.property_attribute_manual_values (
           account_id, attribute_key, attribute_value, notes, reviewer, revision
         ) VALUES ($1,'site_size_sqft',$2::jsonb,$3,$4,$5)
         ON CONFLICT (account_id, attribute_key) DO UPDATE SET
           attribute_value = EXCLUDED.attribute_value,
           notes = EXCLUDED.notes,
           reviewer = EXCLUDED.reviewer,
           revision = EXCLUDED.revision,
           updated_at = now()`,
        [id, valueJson, notes, reviewer, revision],
      );
      await client.query(
        `INSERT INTO app.property_attribute_manual_history (
           account_id, attribute_key, attribute_value, notes, reviewer, revision
         ) VALUES ($1,'site_size_sqft',$2::jsonb,$3,$4,$5)`,
        [id, valueJson, notes, reviewer, revision],
      );
    }
    await client.query(
      `UPDATE app.enrichment_review_queue
       SET status = $2, resolved_at = now(), updated_at = now()
       WHERE account_id = $1 AND attribute_key = 'site_size_sqft'`,
      [id, decision === "approved" ? "approved" : "rejected"],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, decision });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    const message = String(error?.message || "");
    if (message === "dallas_enrichment_isolated") {
      return res.status(409).json({ error: message });
    }
    console.error("parcel suggestion decision failed", error);
    return res.status(500).json({ error: "parcel_suggestion_decision_failed" });
  } finally {
    client.release();
  }
});

/** Preview licensed Trestle data; activation remains off until credentials exist. */
app.post("/api/accounts/:id/trestle-preview", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z_-]{1,50}$/.test(id)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  if (!requireEditor(req, res)) return;
  try {
    const account = await getNonDallasAccount(pool, id);
    if (!account) return res.status(404).json({ error: "account_not_found" });
    const preview = await trestleClient.findProperty({
      listingKey: req.body?.listing_key,
      listingId: req.body?.listing_id,
      originatingSystemName: req.body?.originating_system_name,
    });
    return res.json({ account_id: id, county: account.normalized_county, preview });
  } catch (error) {
    const message = String(error?.message || "");
    if (
      [
        "dallas_enrichment_isolated",
        "trestle_disabled",
        "trestle_credentials_missing",
        "missing_listing_identifier",
        "ambiguous_listing_id",
      ].includes(message)
    ) {
      return res.status(409).json({ error: message });
    }
    console.error("Trestle preview failed", error);
    return res.status(502).json({ error: message || "trestle_preview_failed" });
  }
});

/**
 * GET /api/accounts/:id/market_value_history
 * Returns market value history rows ordered by tax_year desc
 */
app.get("/api/accounts/:id/market_value_history", async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "missing_id" });
  try {
    // Helper: pick a likely market value column from a row object
    const pickMarketValueKey = (row) => {
      const keys = Object.keys(row || {});
      const lc = (s) => String(s || '').toLowerCase();
      const score = (k) => {
        const s = lc(k);
        let sc = 0;
        if (s.includes('market') || s.includes('mkt')) sc += 3;
        if (s.includes('total') || s.includes('tot')) sc += 2;
        if (s.includes('value') || s.includes('val')) sc += 2;
        if (s === 'market_value' || s === 'total_market' || s === 'total_value') sc += 5;
        return sc;
      };
      const candidates = keys
        .filter(k => k !== 'tax_year' && k !== 'account_id')
        .sort((a, b) => score(b) - score(a));
      return candidates[0];
    };

    // Attempt 1: use core.market_value_history and infer the market value column name
    try {
      const { rows } = await pool.query(
        `SELECT * FROM core.market_value_history WHERE account_id = $1 ORDER BY tax_year DESC`,
        [id]
      );
      if (rows && rows.length) {
        const key = pickMarketValueKey(rows[0]);
        if (!key) return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: null })));
        return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: r[key] })));
      }
      return res.json([]);
    } catch (err) {
      // 42P01 = undefined_table; fall back to core.market_values
      if (err && err.code !== '42P01') throw err;
      const { rows } = await pool.query(
        `SELECT * FROM core.market_values WHERE account_id = $1 ORDER BY tax_year DESC`,
        [id]
      );
      if (rows && rows.length) {
        const key = pickMarketValueKey(rows[0]);
        if (!key) return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: null })));
        return res.json(rows.map(r => ({ tax_year: r.tax_year, market_value: r[key] })));
      }
      return res.json([]);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "history_failed" });
  }
});

/**
 * GET /api/search?q=&city=&limit=&offset=
 * Search by Dallas account ID, native Collin geoID, or indexed address/street
 * metadata. The optional
 * city parameter independently narrows the original query. Queries
 * beginning with a house number remain full-address prefixes so every
 * keystroke narrows the same autocomplete results.
 * Returns an array of AccountRow objects for the frontend.
 */
app.get("/api/search", async (req, res) => {
  try {
    await accountQualityReady;
    await salesReconciliationReady;
    const q = String(req.query.q || "").trim();
    const requestedCity = normalizePropertyCity(req.query.city) || null;
    const limit = Math.min(parseInt(String(req.query.limit || "25"), 10) || 25, 100);
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);

    if (!q && !requestedCity) return res.json([]);

    const parsed = q ? parsePropertySearch(q) : null;
    if (q && !parsed.isAccountId && !parsed.normalizedAddress) return res.json([]);

    const params = [];
    const bind = (value) => `$${params.push(value)}`;
    let where;
    let matchSql;
    let orderSql;
    let requestedLegacyAccountId = null;
    const citySql = `upper(COALESCE(a.city, '')) COLLATE "C"`;
    const cityWhere = (parsedCity = null) => {
      const filters = [];
      if (parsedCity) filters.push(`upper(a.city) = ${bind(parsedCity)}`);
      if (requestedCity) filters.push(`${citySql} LIKE ${bind(`${requestedCity}%`)}`);
      return filters.length ? `AND ${filters.join(" AND ")}` : "";
    };

    if (!q && requestedCity) {
      const cityPlaceholder = bind(`${requestedCity}%`);
      where = `
        a.canonical_account_id IS NULL
        AND ${citySql} LIKE ${cityPlaceholder}
      `;
      matchSql = `'city_prefix'`;
      orderSql = `
        ${citySql},
        upper(COALESCE(a.street_name, '')) COLLATE "C",
        upper(btrim(split_part(COALESCE(a.address, ''), ',', 1))) COLLATE "C",
        a.account_id
      `;
    } else if (parsed.isAccountId) {
      await salesReconciliationReady;
      const countyAccount = await findAccountByCountyIdentifier(pool, q);
      const canonicalAccountId = countyAccount?.account_id || await resolveCanonicalAccountId(pool, q);
      if (canonicalAccountId !== q.toUpperCase()) {
        requestedLegacyAccountId = q;
      }
      where = `a.account_id = ${bind(canonicalAccountId)} ${cityWhere(parsed.city)}`;
      matchSql = `'exact_account'`;
      orderSql = "a.account_id";
    } else if (parsed.isAddressPrefix) {
      const addressLineSql = `upper(btrim(split_part(a.address, ',', 1))) COLLATE "C"`;
      const normalizedAddressPlaceholder = bind(parsed.normalizedAddress);
      const addressPrefixPlaceholder = bind(`${parsed.normalizedAddress}%`);
      const cityFilter = cityWhere(parsed.city);

      where = `
        a.address IS NOT NULL
        AND a.canonical_account_id IS NULL
        AND ${addressLineSql} LIKE ${addressPrefixPlaceholder}
        ${cityFilter}
      `;
      matchSql = `
        CASE
          WHEN ${addressLineSql} = ${normalizedAddressPlaceholder} THEN 'exact_address'
          ELSE 'address_prefix'
        END
      `;
      orderSql = `
        ${addressLineSql},
        upper(COALESCE(a.city, '')) COLLATE "C",
        a.account_id
      `;
    } else {
      const streetSql = `upper(a.street_name) COLLATE "C"`;
      const addressLineSql = `upper(btrim(split_part(a.address, ',', 1))) COLLATE "C"`;
      const streetPlaceholder = bind(`${parsed.streetName}%`);
      const cityFilter = cityWhere(parsed.city);

      where = `
        a.street_name IS NOT NULL
        AND a.canonical_account_id IS NULL
        AND ${streetSql} LIKE ${streetPlaceholder}
        ${cityFilter}
      `;
      matchSql = `'same_street'`;
      orderSql = `
        ${streetSql},
        ${citySql},
        ${addressLineSql},
        a.account_id
      `;
    }

    const sql = `
      SELECT
        a.account_id,
        COALESCE(NULLIF(BTRIM(a.address), ''), raw_loc.address) AS address,
        a.street_name,
        a.city,
        a.postal_code,
        a.county,
        a.neighborhood_code,
        a.subdivision,
        a.legal_description,
        a.data_quality_status,
        a.data_quality_flags,
        a.canonical_account_id,
        native_identifier.native_account_id,
        ${matchSql} AS search_match,
        COALESCE(vsc.certified_year, mv.tax_year)                 AS latest_tax_year,
        COALESCE(vsc.market_value, mv.total_value)                AS latest_market_value,
        COALESCE(vsc.improvement_value, mv.imp_value)             AS latest_improvement_value,
        COALESCE(vsc.land_value, mv.land_value)                   AS latest_land_value,
        COALESCE(vsc.capped_value, mv.homestead_cap_value)        AS latest_capped_value
      FROM core.accounts a
      LEFT JOIN LATERAL (
        SELECT identifier.native_account_id
        FROM app.county_account_identifiers identifier
        WHERE identifier.account_id = a.account_id
        ORDER BY
          (identifier.verification_source = 'collin_cad_open_data') DESC,
          identifier.updated_at DESC
        LIMIT 1
      ) native_identifier ON TRUE
      LEFT JOIN core.value_summary_current vsc ON vsc.account_id = a.account_id
      LEFT JOIN LATERAL (
        SELECT m.* FROM core.market_values m
        WHERE m.account_id = a.account_id
        ORDER BY m.tax_year DESC
        LIMIT 1
      ) mv ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                 NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
               ) AS address
        FROM core.dcad_json_raw r
        WHERE r.account_id = a.account_id
          AND COALESCE(
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,address}'), ''),
                NULLIF(BTRIM(r.raw #>> '{detail,property_location,subject_address}'), '')
              ) IS NOT NULL
        ORDER BY r.tax_year DESC, r.fetched_at DESC
        LIMIT 1
      ) raw_loc ON NULLIF(BTRIM(a.address), '') IS NULL
      WHERE ${where}
      ORDER BY ${orderSql}
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}
    `;
    const { rows } = await pool.query(sql, params);
    res.json(
      requestedLegacyAccountId
        ? rows.map((row) => ({
            ...row,
            requested_account_id: requestedLegacyAccountId,
            resolved_from_legacy: true,
            data_quality_status: "legacy_resolved",
          }))
        : rows,
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "search_failed" });
  }
});

/**
 * GET /api/sales/recommendations
 *
 * Ranks matched CAD sales first by comparable mapped location influences when
 * local influence coverage is sufficient, then by parcel-centroid distance (40%), continuous
 * living-area similarity (37%), year-built similarity (10%), site-size
 * similarity (5%), and closing-date recency (8%). The default
 * 12-month analysis period excludes older sales unless the caller explicitly
 * expands the period to 24 or 36 months. The response also returns lower-ranked
 * one-year challengers and a price-per-square-foot outlier audit for sales at
 * or above the requested score floor. Statistical flags require at least 30
 * distinct properties plus adequate data and time coverage.
 */
app.get("/api/sales/recommendations", async (req, res) => {
  try {
    await accountLocationsReady;
    await propertyEnrichmentReady;

    const subjectAccountId = String(
      req.query.subject_account_id || "",
    ).trim();
    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();
    const requestedAnalysisAsOf = String(
      req.query.analysis_as_of ||
      dateTo ||
      new Date().toISOString().slice(0, 10),
    ).trim();
    const requestedPeriodMonths = Number(
      req.query.period_months ||
      DEFAULT_RECOMMENDATION_POLICY.periodMonths,
    );
    const comparableSearchProfile = resolveComparableSearchProfile(
      req.query.search_profile,
    );
    if (!comparableSearchProfile) {
      return res.status(400).json({ error: "invalid_comparable_search_profile" });
    }
    const marketBreakdownValue = String(
      req.query.market_breakdown || "",
    ).trim();
    const resultLimit = Math.min(
      Math.max(
        parseInt(String(req.query.limit || "25"), 10) || 25,
        DEFAULT_RECOMMENDATION_POLICY.count,
      ),
      100,
    );
    if (!/^[0-9A-Za-z]{17}$/.test(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      return res.status(400).json({ error: "invalid_date_from" });
    }
    if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: "invalid_date_to" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAnalysisAsOf)) {
      return res.status(400).json({ error: "invalid_analysis_as_of" });
    }
    if (
      !Number.isInteger(requestedPeriodMonths) ||
      ![12, 24, 36].includes(requestedPeriodMonths)
    ) {
      return res.status(400).json({ error: "invalid_analysis_period" });
    }
    const requestedWindow = analysisWindow(
      requestedAnalysisAsOf,
      requestedPeriodMonths,
    );
    if (!requestedWindow) {
      return res.status(400).json({ error: "invalid_analysis_period" });
    }
    const effectiveDateFrom =
      dateFrom || requestedWindow.analysisStartDate;
    const effectiveDateTo =
      dateTo || requestedWindow.analysisAsOf;
    let marketBreakdown = null;
    if (marketBreakdownValue) {
      try {
        const parsedBreakdowns = parseGroupedAnalysisBreakdowns(
          marketBreakdownValue,
        );
        if (parsedBreakdowns.length !== 1) {
          return res.status(400).json({
            error: "invalid_market_breakdown",
          });
        }
        [marketBreakdown] = parsedBreakdowns;
      } catch {
        return res.status(400).json({
          error: "invalid_market_breakdown",
        });
      }
    }

    const parseTunableNumber = (value, fallback, minimum, maximum) => {
      if (value === undefined || value === null || value === "") return fallback;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error("invalid_scoring_configuration");
      }
      return parsed;
    };
    const scoringConfig = {
      locationWeight: parseTunableNumber(
        req.query.location_weight,
        DEFAULT_COMPARABLE_SCORING.locationWeight,
        0,
        1,
      ),
      squareFootageWeight: parseTunableNumber(
        req.query.square_footage_weight,
        DEFAULT_COMPARABLE_SCORING.squareFootageWeight,
        0,
        1,
      ),
      yearBuiltWeight: parseTunableNumber(
        req.query.year_built_weight,
        DEFAULT_COMPARABLE_SCORING.yearBuiltWeight,
        0,
        1,
      ),
      siteSizeWeight: parseTunableNumber(
        req.query.site_size_weight,
        DEFAULT_COMPARABLE_SCORING.siteSizeWeight,
        0,
        1,
      ),
      salesDateWeight: parseTunableNumber(
        req.query.sales_date_weight,
        DEFAULT_COMPARABLE_SCORING.salesDateWeight,
        0,
        1,
      ),
      locationScaleMiles: parseTunableNumber(
        req.query.location_scale_miles,
        DEFAULT_COMPARABLE_SCORING.locationScaleMiles,
        0.05,
        25,
      ),
      squareFootageScaleRatio: parseTunableNumber(
        req.query.square_footage_scale_ratio,
        DEFAULT_COMPARABLE_SCORING.squareFootageScaleRatio,
        0.01,
        1,
      ),
      yearBuiltScaleYears: parseTunableNumber(
        req.query.year_built_scale_years,
        DEFAULT_COMPARABLE_SCORING.yearBuiltScaleYears,
        1,
        100,
      ),
      siteSizeScaleRatio: parseTunableNumber(
        req.query.site_size_scale_ratio,
        DEFAULT_COMPARABLE_SCORING.siteSizeScaleRatio,
        0.01,
        2,
      ),
      salesDateScaleDays: parseTunableNumber(
        req.query.sales_date_scale_days,
        DEFAULT_COMPARABLE_SCORING.salesDateScaleDays,
        30,
        1095,
      ),
    };
    const outlierScoreThreshold = parseTunableNumber(
      req.query.outlier_score_threshold,
      DEFAULT_OUTLIER_ANALYSIS.scoreThreshold,
      0,
      100,
    );
    if (
      scoringConfig.locationWeight +
        scoringConfig.squareFootageWeight +
        scoringConfig.yearBuiltWeight +
        scoringConfig.siteSizeWeight +
        scoringConfig.salesDateWeight <=
      0
    ) {
      return res.status(400).json({ error: "invalid_scoring_configuration" });
    }

    const loadSubject = async () => {
      const { rows } = await pool.query(
        `
          SELECT
            account.account_id,
            account.address,
            account.city,
            account.county,
            NULLIF(
              LEFT(
                REGEXP_REPLACE(COALESCE(account.postal_code, ''), '\\D', '', 'g'),
                5
              ),
              ''
            ) AS postal_code,
            account.neighborhood_code,
            profile.structural_style,
            profile.housing_type,
            profile.attachment_type,
            COALESCE(improvement.living_area_sqft, improvement.total_living_area) AS living_area_sqft,
            COALESCE(
              CASE
                WHEN manual_report.attribute_value #>> '{main_improvement,year_built}' ~ '^[0-9]{4}$'
                  THEN (manual_report.attribute_value #>> '{main_improvement,year_built}')::integer
                ELSE NULL
              END,
              improvement.year_built
            ) AS year_built,
            manual_land_report.attribute_value AS manual_land_value,
            cad_site.site_size_sqft AS cad_site_size_sqft,
            location.latitude,
            location.longitude,
            location.status AS location_status,
            location.source AS location_source,
            location.precision AS location_precision,
            location.confidence AS location_confidence,
            location.review_required AS location_review_required,
            location.review_reason AS location_review_reason,
            location.geocoded_at
          FROM core.accounts account
          LEFT JOIN core.primary_improvements improvement
            ON improvement.account_id = account.account_id
          LEFT JOIN core.v_account_housing_profiles profile
            ON profile.account_id = account.account_id
          LEFT JOIN app.property_attribute_manual_values manual_report
            ON manual_report.account_id = account.account_id
           AND manual_report.attribute_key = 'report.property_characteristics'
          LEFT JOIN app.property_attribute_manual_values manual_land_report
            ON manual_land_report.account_id = account.account_id
           AND manual_land_report.attribute_key = 'report.land_details'
          LEFT JOIN LATERAL (
            SELECT SUM(land.area_sqft)::numeric AS site_size_sqft
            FROM core.land_detail land
            WHERE land.account_id = account.account_id
              AND land.tax_year = (
                SELECT MAX(latest_land.tax_year)
                FROM core.land_detail latest_land
                WHERE latest_land.account_id = account.account_id
              )
          ) cad_site ON TRUE
          LEFT JOIN core.account_locations location
            ON location.account_id = account.account_id
          WHERE account.account_id = $1
        `,
        [subjectAccountId],
      );
      const row = rows[0] || null;
      if (!row) return null;
      row.site_size_sqft =
        manualLandSiteSize(row.manual_land_value) ??
        positiveSiteSize(row.cad_site_size_sqft);
      delete row.manual_land_value;
      delete row.cad_site_size_sqft;
      return row;
    };

    let subject = await loadSubject();
    if (!subject) {
      return res.status(404).json({ error: "subject_not_found" });
    }
    if (
      subject.location_status !== "matched" ||
      subject.latitude == null ||
      subject.longitude == null
    ) {
      await refreshAccountLocations(pool, [subject], { batchSize: 1 });
      subject = await loadSubject();
    }
    if (
      subject?.location_status !== "matched" ||
      subject?.latitude == null ||
      subject?.longitude == null
    ) {
      return res.status(422).json({
        error: "subject_location_unavailable",
        subject_account_id: subjectAccountId,
      });
    }
    if (!Number.isFinite(Number(subject.living_area_sqft)) || Number(subject.living_area_sqft) <= 0) {
      return res.status(422).json({
        error: "subject_living_area_unavailable",
        subject_account_id: subjectAccountId,
      });
    }

    const subjectInfluenceContexts = await getPropertyInfluenceContexts(
      pool,
      [subjectAccountId],
    );
    const subjectInfluenceContext = subjectInfluenceContexts.get(subjectAccountId) || null;
    const subjectInfluenceSignature = subjectInfluenceContext?.influence_signature || null;
    if (!subjectInfluenceSignature) {
      void enqueuePropertyInfluenceAccounts(pool, [subjectAccountId], {
        reason: "comparable_subject",
        priority: 120,
      }).catch((error) => {
        console.warn(
          "[recommendations] subject influence queueing failed",
          error?.message || error,
        );
      });
    }

    const candidateParams = [subjectAccountId];
    const candidateWhere = [
      "sale.primary_account_id IS NOT NULL",
      "sale.primary_account_id <> $1",
      "sale.record_type = 'closed_sale'",
    ];
    candidateParams.push(effectiveDateFrom);
    candidateWhere.push(
      `sale.closing_date >= $${candidateParams.length}::date`,
    );
    candidateParams.push(effectiveDateTo);
    candidateWhere.push(
      `sale.closing_date <= $${candidateParams.length}::date`,
    );
    const subjectLatitude = Number(subject.latitude);
    const subjectLongitude = Number(subject.longitude);
    const radiusMiles = comparableSearchProfile.radiusMiles;
    const latitudeDelta = radiusMiles / 69;
    const longitudeDelta = radiusMiles /
      (69 * Math.max(Math.cos(subjectLatitude * Math.PI / 180), 0.1));
    const latitudeMinimum = `$${candidateParams.push(subjectLatitude - latitudeDelta)}::double precision`;
    const latitudeMaximum = `$${candidateParams.push(subjectLatitude + latitudeDelta)}::double precision`;
    const longitudeMinimum = `$${candidateParams.push(subjectLongitude - longitudeDelta)}::double precision`;
    const longitudeMaximum = `$${candidateParams.push(subjectLongitude + longitudeDelta)}::double precision`;
    const subjectLatitudeSql = `$${candidateParams.push(subjectLatitude)}::double precision`;
    const subjectLongitudeSql = `$${candidateParams.push(subjectLongitude)}::double precision`;
    const radiusMilesSql = `$${candidateParams.push(radiusMiles)}::double precision`;
    const candidateDistanceSql = greatCircleDistanceMilesSql({
      subjectLatitude: subjectLatitudeSql,
      subjectLongitude: subjectLongitudeSql,
      comparableLatitude: "location.latitude::double precision",
      comparableLongitude: "location.longitude::double precision",
    });
    candidateWhere.push(
      "location.status = 'matched'",
      "location.latitude IS NOT NULL",
      "location.longitude IS NOT NULL",
    );
    const standardRadiusScopeSql = `(
      location.latitude::double precision BETWEEN ${latitudeMinimum} AND ${latitudeMaximum}
      AND location.longitude::double precision BETWEEN ${longitudeMinimum} AND ${longitudeMaximum}
      AND (${candidateDistanceSql}) <= ${radiusMilesSql}
    )`;
    const subjectMaterialCategories = subjectInfluenceSignature?.material_influence_present
      ? subjectInfluenceSignature.material_categories || []
      : [];
    if (subjectMaterialCategories.length) {
      const influenceCategoriesSql = `$${candidateParams.push(subjectMaterialCategories)}::text[]`;
      candidateWhere.push(`(
        ${standardRadiusScopeSql}
        OR candidate_influence.material_categories && ${influenceCategoriesSql}
      )`);
    } else {
      candidateWhere.push(standardRadiusScopeSql);
    }

    const candidateSql = `
      SELECT
        sale.sale_id,
        sale.source_record_id,
        (
          SELECT source_record.listing_id
          FROM core.sales_source_records source_record
          WHERE source_record.id = sale.source_record_id
        ) AS listing_id,
        sale.primary_account_id,
        sale.county,
        account.county AS account_county,
        account.neighborhood_code,
        account.subdivision,
        COALESCE(NULLIF(BTRIM(sale.address), ''), NULLIF(BTRIM(account.address), '')) AS address,
        COALESCE(NULLIF(BTRIM(sale.city), ''), NULLIF(BTRIM(account.city), '')) AS city,
        sale.state,
        COALESCE(NULLIF(BTRIM(sale.zip), ''), NULLIF(BTRIM(account.postal_code), '')) AS zip,
        sale.closing_date,
        sale.sale_price,
        sale.days_on_market,
        sale.concessions,
        sale.seller_contributions,
        sale.listing_contract_date,
        sale.buyer_financing,
        sale.mls_status,
        sale.record_type,
        sale.structural_style,
        sale.housing_type,
        sale.attachment_type,
        sale.architectural_style,
        sale.source,
        sale.source_filename,
        sale.source_row_number,
        sale.match_status,
        sale.has_multiple_parcel_numbers,
        sale.multi_parcel_status,
        sale.has_unresolved_parcel,
        sale.requires_additional_review,
        sale.data_quality_flags,
        sale.provided_parcel_fields,
        sale.resolved_account_count,
        sale.linked_parcels,
        sale.mls_bedrooms_total,
        sale.mls_bathrooms_total_integer,
        sale.mls_bathrooms_full,
        sale.mls_bathrooms_half,
        sale.mls_living_area,
        sale.mls_lot_size_area,
        sale.mls_year_built,
        sale.mls_garage_spaces,
        sale.mls_garage_yn,
        sale.mls_pool_yn,
        sale.ratio_current_price_by_living_area,
        sale.ratio_close_price_by_list_price,
        sale.ratio_close_price_by_original_list_price,
        sale.ratio_close_price_by_living_area,
        sale.cad_bedroom_count,
        sale.cad_bath_count,
        sale.cad_baths_full,
        sale.cad_baths_half,
        sale.cad_living_area_sqft,
        sale.cad_total_area_sqft,
        sale.cad_year_built,
        sale.cad_effective_year_built,
        sale.cad_stories,
        sale.cad_pool,
        sale.cad_building_class,
        sale.cad_land_value,
        sale.cad_improvement_value,
        sale.cad_market_value,
        manual_land_report.attribute_value AS manual_land_value,
        CASE
          WHEN manual_report.attribute_value #>> '{main_improvement,year_built}' ~ '^[0-9]{4}$'
            THEN (manual_report.attribute_value #>> '{main_improvement,year_built}')::integer
          ELSE NULL
        END AS manual_year_built,
        media.primary_photo_url,
        COALESCE(media.photo_count, 0) AS photo_count,
        location.latitude,
        location.longitude,
        location.status AS location_status,
        location.source AS location_source,
        location.precision AS location_precision,
        location.confidence AS location_confidence,
        location.review_required AS location_review_required,
        location.review_reason AS location_review_reason,
        location.geocoded_at AS location_geocoded_at,
        candidate_influence.influence_signature AS candidate_influence_signature,
        candidate_influence.material_keys AS candidate_material_keys,
        candidate_influence.material_categories AS candidate_material_categories,
        candidate_influence.computed_at AS candidate_influence_computed_at
      FROM core.v_sales_enriched sale
      JOIN core.accounts account
        ON account.account_id = sale.primary_account_id
      LEFT JOIN core.account_locations location
        ON location.account_id = sale.primary_account_id
      LEFT JOIN gis.property_influence_contexts candidate_influence
        ON candidate_influence.account_id = sale.primary_account_id
       AND candidate_influence.methodology_version >= 3
      LEFT JOIN app.property_attribute_manual_values manual_report
        ON manual_report.account_id = sale.primary_account_id
       AND manual_report.attribute_key = 'report.property_characteristics'
      LEFT JOIN app.property_attribute_manual_values manual_land_report
        ON manual_land_report.account_id = sale.primary_account_id
       AND manual_land_report.attribute_key = 'report.land_details'
      LEFT JOIN core.v_sales_media_summary media
        ON media.source_record_id = sale.source_record_id
      WHERE ${candidateWhere.join(" AND ")}
      ORDER BY sale.closing_date DESC NULLS LAST,
               sale.source_record_id DESC NULLS LAST,
               sale.sale_id DESC NULLS LAST
      LIMIT 10000
    `;
    const { rows: candidates } = await pool.query(
      candidateSql,
      candidateParams,
    );

    // Ranking uses only cached coordinates. Missing candidate locations are
    // prioritized for the background worker without delaying this response.
    const candidateLocationQueue = [
      ...new Map(
        candidates
          .filter(
            (candidate) =>
              candidate.primary_account_id &&
              (
                candidate.location_status !== "matched" ||
                candidate.latitude == null ||
                candidate.longitude == null
              ),
          )
          .map((candidate) => [
            candidate.primary_account_id,
            {
              account_id: candidate.primary_account_id,
              address: candidate.address,
              county: candidate.account_county || candidate.county,
            },
          ]),
      ).values(),
    ].slice(0, 1000);
    if (candidateLocationQueue.length) {
      void (async () => {
        await locationBackfillReady;
        await enqueueLocationBackfillAccounts(pool, candidateLocationQueue, {
          reason: "comparable_recommendation",
          priority: 100,
        });
      })().catch((error) => {
        console.warn(
          "[recommendations] candidate location queueing failed",
          error?.message || error,
        );
      });
    }

    const candidateAccountIds = [
      ...new Set(
        candidates
          .map((candidate) => candidate.primary_account_id)
          .filter(Boolean),
      ),
    ];
    const missingInfluenceAccounts = candidates
      .filter((candidate) => !candidate.candidate_influence_signature)
      .slice(0, 1_000)
      .map((candidate) => candidate.primary_account_id);
    if (missingInfluenceAccounts.length) {
      void enqueuePropertyInfluenceAccounts(pool, missingInfluenceAccounts, {
        reason: "comparable_recommendation",
        priority: 110,
      }).catch((error) => {
        console.warn(
          "[recommendations] candidate influence queueing failed",
          error?.message || error,
        );
      });
    }
    const cadSiteSizeByAccount = new Map();
    if (candidateAccountIds.length) {
      const { rows: cadSiteRows } = await pool.query(
        `
          SELECT account_id, SUM(area_sqft)::numeric AS site_size_sqft
          FROM (
            SELECT
              land.account_id,
              land.area_sqft,
              land.tax_year,
              MAX(land.tax_year) OVER (PARTITION BY land.account_id) AS latest_tax_year
            FROM core.land_detail land
            WHERE land.account_id = ANY($1::text[])
          ) latest_land
          WHERE tax_year = latest_tax_year
          GROUP BY account_id
        `,
        [candidateAccountIds],
      );
      for (const row of cadSiteRows) {
        const siteSize = positiveSiteSize(row.site_size_sqft);
        if (siteSize !== null) {
          cadSiteSizeByAccount.set(row.account_id, siteSize);
        }
      }
    }

    let missingLocationCount = 0;
    let unsupportedCountyCount = 0;
    let missingSquareFootageCount = 0;
    let missingYearBuiltCount = 0;
    let missingSiteSizeCount = 0;
    const scored = [];
    for (const candidate of candidates) {
      if (
        candidate.location_status !== "matched" ||
        candidate.latitude == null ||
        candidate.longitude == null
      ) {
        const candidateCounty = String(candidate.account_county || "")
          .trim()
          .toLowerCase();
        if (candidateCounty && !candidateCounty.includes("dallas")) {
          unsupportedCountyCount += 1;
        } else {
          missingLocationCount += 1;
        }
        continue;
      }
      const comparableSquareFeet =
        candidate.cad_living_area_sqft ?? candidate.mls_living_area;
      if (
        !Number.isFinite(Number(comparableSquareFeet)) ||
        Number(comparableSquareFeet) <= 0
      ) {
        missingSquareFootageCount += 1;
        continue;
      }
      const comparableYearBuilt =
        candidate.manual_year_built ??
        candidate.cad_year_built ??
        candidate.mls_year_built;
      if (
        !Number.isFinite(Number(subject.year_built)) ||
        Number(subject.year_built) <= 0 ||
        !Number.isFinite(Number(comparableYearBuilt)) ||
        Number(comparableYearBuilt) <= 0
      ) {
        missingYearBuiltCount += 1;
      }
      const manualSiteSize = manualLandSiteSize(candidate.manual_land_value);
      delete candidate.manual_land_value;
      const cadSiteSize = cadSiteSizeByAccount.get(candidate.primary_account_id) ?? null;
      const mlsSiteSize = mlsLotSizeSquareFeet(candidate.mls_lot_size_area);
      const candidateCounty = String(
        candidate.account_county || candidate.county || "",
      ).toLowerCase();
      const comparableSiteSize = manualSiteSize ?? (
        candidateCounty.includes("dallas")
          ? cadSiteSize ?? mlsSiteSize
          : mlsSiteSize ?? cadSiteSize
      );
      if (
        !Number.isFinite(Number(subject.site_size_sqft)) ||
        Number(subject.site_size_sqft) <= 0 ||
        !Number.isFinite(Number(comparableSiteSize)) ||
        Number(comparableSiteSize) <= 0
      ) {
        missingSiteSizeCount += 1;
      }
      const score = scoreComparable(
        {
          subjectLatitude: subject.latitude,
          subjectLongitude: subject.longitude,
          comparableLatitude: candidate.latitude,
          comparableLongitude: candidate.longitude,
          subjectSquareFeet: subject.living_area_sqft,
          comparableSquareFeet,
          subjectYearBuilt: subject.year_built,
          comparableYearBuilt,
          subjectSiteSize: subject.site_size_sqft,
          comparableSiteSize,
          closingDate: candidate.closing_date,
          referenceDate: effectiveDateTo,
          subjectHousingType: subject.housing_type,
          subjectAttachmentType: subject.attachment_type,
          subjectStructuralStyle: subject.structural_style,
          comparableHousingType: candidate.housing_type,
          comparableAttachmentType: candidate.attachment_type,
          comparableStructuralStyle: candidate.structural_style,
        },
        scoringConfig,
      );
      if (!score) continue;
      scored.push({
        ...candidate,
        ...score,
        comparable_square_feet: Number(comparableSquareFeet),
        score_requires_review:
          Boolean(candidate.requires_additional_review) ||
          Boolean(candidate.location_review_required) ||
          !score.ageDataAvailable ||
          !score.siteDataAvailable,
      });
    }

    const scoped = filterComparablesForMarket(
      scored,
      subject,
      marketBreakdown,
    );

    scoped.sort(
      (left, right) =>
        right.comparableScore - left.comparableScore ||
        left.distanceMiles - right.distanceMiles ||
        left.squareFootageDifferenceRatio -
          right.squareFootageDifferenceRatio ||
        String(right.closing_date || "").localeCompare(
          String(left.closing_date || ""),
        ),
    );
    const influenceRanked = decorateAndRankByInfluence(
      scoped,
      subjectInfluenceSignature,
      (candidate) => candidate.candidate_influence_signature || null,
    );
    const rankedScoped = influenceRanked.sales.map((candidate) => ({
      ...candidate,
      influence_support_candidate:
        Number(candidate.distanceMiles) > Number(radiusMiles) &&
        candidate.influence_similarity?.exact_material_match === true,
      candidate_purpose:
        Number(candidate.distanceMiles) > Number(radiusMiles) &&
        candidate.influence_similarity?.exact_material_match === true
          ? "influence_support"
          : "primary_similarity",
    }));
    rankedScoped.forEach((candidate, index) => {
      candidate.score_rank = index + 1;
    });
    const recommendationResult = applyRecommendationPolicy(rankedScoped, {
      referenceDate: effectiveDateTo,
      policy: {
        ...DEFAULT_RECOMMENDATION_POLICY,
        periodMonths: requestedPeriodMonths,
      },
    });
    const outlierResult = analyzeComparableOutliers(
      recommendationResult.sales,
      {
        ...DEFAULT_OUTLIER_ANALYSIS,
        scoreThreshold: outlierScoreThreshold,
      },
    );
    const analyzedSales = outlierResult.sales;
    const recommendedSales = analyzedSales.filter((sale) => sale.recommended);
    const secondarySales = analyzedSales.filter(
      (sale) =>
        sale.insideAnalysisPeriod &&
        sale.housingTypeCompatible !== false &&
        !sale.recommended,
    ).sort((left, right) =>
      Number(Boolean(right.influence_support_candidate)) - Number(Boolean(left.influence_support_candidate)) ||
      Number(right.influence_similarity?.priority_tier || 0) - Number(left.influence_similarity?.priority_tier || 0) ||
      Number(right.comparableScore || 0) - Number(left.comparableScore || 0),
    );

    const marketLabel = !marketBreakdown
      ? "All eligible sales"
      : marketBreakdown.scope === "city"
        ? [subject.city, subject.county].filter(Boolean).join(", ")
        : marketBreakdown.scope === "zip"
          ? `ZIP ${subject.postal_code}`
          : `Within ${marketBreakdown.radiusMiles} mile${marketBreakdown.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;

    res.json({
      subject: {
        account_id: subject.account_id,
        address: subject.address,
        city: subject.city,
        county: subject.county,
        postal_code: subject.postal_code,
        neighborhood_code: subject.neighborhood_code,
        structural_style: subject.structural_style,
        housing_type: subject.housing_type,
        attachment_type: subject.attachment_type,
        living_area_sqft: Number(subject.living_area_sqft),
        year_built: Number.isFinite(Number(subject.year_built))
          ? Number(subject.year_built)
          : null,
        site_size_sqft: Number.isFinite(Number(subject.site_size_sqft))
          ? Number(subject.site_size_sqft)
          : null,
        latitude: Number(subject.latitude),
        longitude: Number(subject.longitude),
        location_source: subject.location_source,
        location_precision: subject.location_precision,
        location_confidence: subject.location_confidence,
        location_review_required: subject.location_review_required,
        location_review_reason: subject.location_review_reason,
        location_geocoded_at: subject.geocoded_at,
        influence_signature: subjectInfluenceSignature,
      },
      scoring: {
        ...scoringConfig,
        locationWeightPercent: Math.round(scoringConfig.locationWeight * 100),
        squareFootageWeightPercent: Math.round(
          scoringConfig.squareFootageWeight * 100,
        ),
        yearBuiltWeightPercent: Math.round(
          scoringConfig.yearBuiltWeight * 100,
        ),
        siteSizeWeightPercent: Math.round(
          scoringConfig.siteSizeWeight * 100,
        ),
        salesDateWeightPercent: Math.round(
          scoringConfig.salesDateWeight * 100,
        ),
        squareFootageScalePercent: Math.round(
          scoringConfig.squareFootageScaleRatio * 100,
        ),
        yearBuiltScaleYears: Math.round(scoringConfig.yearBuiltScaleYears),
        siteSizeScalePercent: Math.round(
          scoringConfig.siteSizeScaleRatio * 100,
        ),
        salesDateScaleDays: Math.round(scoringConfig.salesDateScaleDays),
        squareFootageIsHardFilter: false,
      },
      coverage: {
        candidate_count: candidates.length,
        eligible_count: scoped.length,
        total_scored_count: scored.length,
        scope_eligible_count: scoped.length,
        missing_location_count: missingLocationCount,
        unsupported_county_count: unsupportedCountyCount,
        missing_square_footage_count: missingSquareFootageCount,
        missing_year_built_count: missingYearBuiltCount,
        missing_site_size_count: missingSiteSizeCount,
        housing_type_mismatch_count:
          recommendationResult.policy.housingTypeMismatchCount,
        recommended_count: recommendedSales.length,
        older_than_two_years_count: analyzedSales.filter(
          (sale) => sale.soldOverTwoYears,
        ).length,
        older_than_one_year_count: analyzedSales.filter(
          (sale) => sale.soldOverOneYear,
        ).length,
        recent_high_score_count:
          recommendationResult.policy.recentHighScoreCount,
        influence_context_count: influenceRanked.policy.measured_sale_count,
        missing_influence_context_count: Math.max(
          0,
          influenceRanked.policy.eligible_sale_count -
            influenceRanked.policy.measured_sale_count,
        ),
      },
      influence_ranking: influenceRanked.policy,
      recommendation_policy: recommendationResult.policy,
      statistical_analysis: outlierResult.analysis,
      analysis_period: {
        analysis_as_of: effectiveDateTo,
        date_from: effectiveDateFrom,
        period_months: requestedPeriodMonths,
      },
      search_profile: {
        key: comparableSearchProfile.key,
        label: comparableSearchProfile.label,
        geography: comparableSearchProfile.geography,
        complexity: comparableSearchProfile.complexity,
        radius_miles: comparableSearchProfile.radiusMiles,
      },
      study_market: {
        key: marketBreakdown?.key || null,
        scope: marketBreakdown?.scope || null,
        radius_miles: marketBreakdown?.radiusMiles || null,
        label: marketLabel,
      },
      recommended_sales: recommendedSales,
      secondary_sales: secondarySales.slice(0, resultLimit),
      competitive_sales: secondarySales.slice(0, resultLimit),
      sales: analyzedSales.slice(0, resultLimit),
    });
  } catch (err) {
    const message = err?.message || "comparable_recommendations_failed";
    if (String(message).startsWith("invalid_")) {
      return res.status(400).json({ error: message });
    }
    console.error("/api/sales/recommendations failed", err);
    res.status(500).json({ error: "comparable_recommendations_failed" });
  }
});

/**
 * GET /api/sales
 * Search transaction-level sales from core.v_sales_enriched.
 *
 * Supported filters:
 *   q, account_id, exclude_account_id, neighborhood_code, date_from,
 *   date_to, min_price, max_price, matched, review, multi_parcel,
 *   record_type, include_attached, limit, offset
 *
 * A multi-parcel transaction is returned once. Its sale price must never be
 * multiplied by the number of linked parcels.
 */
app.get("/api/sales", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const subjectAccountId = String(req.query.subject_account_id || "").trim();
    const accountId = String(req.query.account_id || "").trim();
    const excludeAccountId = String(req.query.exclude_account_id || "").trim();
    const neighborhoodCode = String(req.query.neighborhood_code || "").trim();
    const recordType = String(req.query.record_type || "closed_sale").trim().toLowerCase();
    const dateFrom = String(req.query.date_from || "").trim();
    const dateTo = String(req.query.date_to || "").trim();
    const multiParcel = String(req.query.multi_parcel || "").trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || "25"), 10) || 25, 1), 200);
    const offset = Math.max(parseInt(String(req.query.offset || "0"), 10) || 0, 0);
    const searchProfileRequested = req.query.search_profile !== undefined &&
      String(req.query.search_profile).trim() !== "";
    const comparableSearchProfile = searchProfileRequested
      ? resolveComparableSearchProfile(req.query.search_profile, { useDefault: false })
      : null;
    if (searchProfileRequested && !comparableSearchProfile) {
      return res.status(400).json({ error: "invalid_comparable_search_profile" });
    }

    const parseOptionalBoolean = (value, name) => {
      if (value === undefined || value === null || value === "") return null;
      const normalized = String(value).trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
      throw new Error(`invalid_${name}`);
    };

    const matched = parseOptionalBoolean(req.query.matched, "matched");
    const review = parseOptionalBoolean(req.query.review, "review");
    const includeAttached =
      parseOptionalBoolean(req.query.include_attached, "include_attached") ?? true;
    if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      return res.status(400).json({ error: "invalid_date_from" });
    }
    if (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      return res.status(400).json({ error: "invalid_date_to" });
    }
    if (multiParcel && !["single", "possible", "confirmed"].includes(multiParcel)) {
      return res.status(400).json({ error: "invalid_multi_parcel" });
    }
    if (!["closed_sale", "listing", "all"].includes(recordType)) {
      return res.status(400).json({ error: "invalid_record_type" });
    }
    if (subjectAccountId && !/^[0-9A-Za-z]{17}$/.test(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (comparableSearchProfile && !subjectAccountId) {
      return res.status(400).json({ error: "search_profile_requires_subject" });
    }

    const parsePrice = (value, name) => {
      if (value === undefined || value === null || value === "") return null;
      const parsed = Number(String(value).replace(/[$,\s]/g, ""));
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid_${name}`);
      return parsed;
    };
    const minPrice = parsePrice(req.query.min_price, "min_price");
    const maxPrice = parsePrice(req.query.max_price, "max_price");
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
      return res.status(400).json({ error: "invalid_price_range" });
    }

    const params = [];
    const where = [];
    const bind = (value) => `$${params.push(value)}`;
    const subjectAccountPlaceholder = subjectAccountId
      ? bind(subjectAccountId)
      : null;
    const addAccountFilter = (id) => {
      const placeholder = bind(id);
      where.push(`(
        v.primary_account_id = ${placeholder}
        OR EXISTS (
          SELECT 1
          FROM core.sale_parcels sp
          WHERE sp.source_record_id = v.source_record_id
            AND sp.account_id = ${placeholder}
        )
      )`);
    };

    if (accountId) addAccountFilter(accountId);
    if (excludeAccountId) {
      const placeholder = bind(excludeAccountId);
      where.push(`(
        v.primary_account_id IS DISTINCT FROM ${placeholder}
        AND NOT EXISTS (
          SELECT 1
          FROM core.sale_parcels excluded_sp
          WHERE excluded_sp.source_record_id = v.source_record_id
            AND excluded_sp.account_id = ${placeholder}
        )
      )`);
    }
    if (neighborhoodCode) where.push(`sale_account.neighborhood_code = ${bind(neighborhoodCode)}`);
    if (q) {
      if (/^[0-9A-Za-z]{17}$/.test(q)) {
        addAccountFilter(q);
      } else {
        const pattern = bind(`%${q.replace(/%/g, "").replace(/_/g, "")}%`);
        where.push(`(
          v.address ILIKE ${pattern}
          OR sale_account.address ILIKE ${pattern}
          OR v.city ILIKE ${pattern}
          OR v.source ILIKE ${pattern}
        )`);
      }
    }
    const activityDateColumn =
      recordType === "listing"
        ? "v.listing_contract_date"
        : recordType === "all"
          ? "COALESCE(v.closing_date, v.listing_contract_date)"
          : "v.closing_date";
    if (dateFrom) where.push(`${activityDateColumn} >= ${bind(dateFrom)}::date`);
    if (dateTo) where.push(`${activityDateColumn} <= ${bind(dateTo)}::date`);
    if (minPrice !== null) where.push(`v.sale_price >= ${bind(minPrice)}`);
    if (maxPrice !== null) where.push(`v.sale_price <= ${bind(maxPrice)}`);
    if (matched !== null) {
      where.push(matched ? "v.primary_account_id IS NOT NULL" : "v.primary_account_id IS NULL");
    }
    if (review !== null) where.push(`v.requires_additional_review = ${bind(review)}`);
    if (multiParcel) where.push(`v.multi_parcel_status = ${bind(multiParcel)}`);
    if (recordType !== "all") where.push(`v.record_type = ${bind(recordType)}`);
    if (!includeAttached) {
      where.push("v.attachment_type NOT IN ('attached', 'mixed')");
    }

    const distanceSql = subjectAccountPlaceholder
      ? `
        CASE
          WHEN subject_location.latitude IS NULL
            OR subject_location.longitude IS NULL
            OR sale_location.latitude IS NULL
            OR sale_location.longitude IS NULL
          THEN NULL
          ELSE ${greatCircleDistanceMilesSql({
            subjectLatitude: "subject_location.latitude::double precision",
            subjectLongitude: "subject_location.longitude::double precision",
            comparableLatitude: "sale_location.latitude::double precision",
            comparableLongitude: "sale_location.longitude::double precision",
          })}
        END
      `
      : `NULL::double precision`;
    const subjectLocationJoin = subjectAccountPlaceholder
      ? `LEFT JOIN core.account_locations subject_location
           ON subject_location.account_id = ${subjectAccountPlaceholder}`
      : "";
    if (comparableSearchProfile) {
      where.push(
        "subject_location.status = 'matched'",
        "sale_location.status = 'matched'",
        `(${distanceSql}) <= ${bind(comparableSearchProfile.radiusMiles)}::double precision`,
      );
    }

    const sql = `
      SELECT
        v.sale_id,
        v.source_record_id,
        (
          SELECT source_record.listing_id
          FROM core.sales_source_records source_record
          WHERE source_record.id = v.source_record_id
        ) AS listing_id,
        v.primary_account_id,
        v.county,
        sale_account.neighborhood_code,
        sale_account.subdivision,
        COALESCE(NULLIF(BTRIM(v.address), ''), NULLIF(BTRIM(sale_account.address), '')) AS address,
        v.city,
        v.state,
        v.zip,
        v.closing_date,
        v.sale_price,
        v.days_on_market,
        v.concessions,
        v.seller_contributions,
        v.listing_contract_date,
        v.buyer_financing,
        v.mls_status,
        v.record_type,
        v.structural_style,
        v.housing_type,
        v.attachment_type,
        v.architectural_style,
        v.source,
        v.source_filename,
        v.source_row_number,
        v.match_status,
        v.has_multiple_parcel_numbers,
        v.multi_parcel_status,
        v.has_unresolved_parcel,
        v.requires_additional_review,
        v.data_quality_flags,
        v.provided_parcel_fields,
        v.resolved_account_count,
        v.linked_parcels,
        v.mls_bedrooms_total,
        v.mls_bathrooms_total_integer,
        v.mls_bathrooms_full,
        v.mls_bathrooms_half,
        v.mls_living_area,
        v.mls_lot_size_area,
        v.mls_year_built,
        v.mls_garage_spaces,
        v.mls_garage_yn,
        v.mls_pool_yn,
        v.ratio_current_price_by_living_area,
        v.ratio_close_price_by_list_price,
        v.ratio_close_price_by_original_list_price,
        v.ratio_close_price_by_living_area,
        v.cad_bedroom_count,
        v.cad_bath_count,
        v.cad_baths_full,
        v.cad_baths_half,
        v.cad_living_area_sqft,
        v.cad_total_area_sqft,
        v.cad_year_built,
        v.cad_effective_year_built,
        v.cad_stories,
        v.cad_pool,
        v.cad_building_class,
        v.cad_land_value,
        v.cad_improvement_value,
        v.cad_market_value,
        media.primary_photo_url,
        COALESCE(media.photo_count, 0) AS photo_count,
        sale_location.latitude,
        sale_location.longitude,
        sale_location.status AS location_status,
        sale_location.source AS location_source,
        sale_location.precision AS location_precision,
        sale_location.confidence AS location_confidence,
        sale_location.review_required AS location_review_required,
        sale_location.review_reason AS location_review_reason,
        sale_location.geocoded_at AS location_geocoded_at,
        ${distanceSql} AS "distanceMiles"
      FROM core.v_sales_enriched v
      LEFT JOIN core.accounts sale_account
        ON sale_account.account_id = v.primary_account_id
      LEFT JOIN core.v_sales_media_summary media
        ON media.source_record_id = v.source_record_id
      LEFT JOIN core.account_locations sale_location
        ON sale_location.account_id = v.primary_account_id
      ${subjectLocationJoin}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY ${subjectAccountPlaceholder ? `"distanceMiles" ASC NULLS LAST,` : ""}
               COALESCE(v.closing_date, v.listing_contract_date) DESC NULLS LAST,
               v.source_record_id DESC NULLS LAST,
               v.sale_id DESC NULLS LAST
      LIMIT ${bind(limit)} OFFSET ${bind(offset)}
    `;

    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    const message = err?.message || "sales_search_failed";
    if (String(message).startsWith("invalid_")) {
      return res.status(400).json({ error: message });
    }
    console.error("/api/sales failed", err);
    res.status(500).json({ error: "sales_search_failed" });
  }
});

/**
 * GET /api/sales/grouped-analysis
 *
 * Builds one-year grouped adjustment studies for any requested combination of
 * the subject's city, ZIP code, and cumulative one-through-five-mile radii.
 * Closed, single-parcel sales are grouped by total bathrooms, garage spaces,
 * pool presence, and ten ordered living-area bands. Missing garage spaces are
 * treated as zero only when the MLS explicitly says the property has no
 * garage.
 */
app.get("/api/sales/grouped-analysis", async (req, res) => {
  try {
    const subjectAccountId = String(
      req.query.subject_account_id || "",
    ).trim();
    const asOfDate = String(req.query.as_of || "").trim();
    const multipleBreakdownsRequested = req.query.breakdowns !== undefined;
    if (!/^[0-9A-Za-z]{17}$/.test(subjectAccountId)) {
      return res.status(400).json({ error: "invalid_subject_account_id" });
    }
    if (asOfDate && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
      return res.status(400).json({ error: "invalid_as_of" });
    }

    let requestedBreakdowns;
    try {
      requestedBreakdowns = parseGroupedAnalysisBreakdowns(
        req.query.breakdowns,
      );
    } catch (error) {
      return res.status(400).json({
        error: error?.message || "invalid_grouped_analysis_breakdown",
      });
    }

    await accountLocationsReady;
    const loadSubject = async () => {
      const subjectResult = await pool.query(
        `
          SELECT
            account.account_id,
            account.address,
            account.city,
            account.county,
            NULLIF(
              LEFT(
                REGEXP_REPLACE(COALESCE(account.postal_code, ''), '\\D', '', 'g'),
                5
              ),
              ''
            ) AS postal_code,
            location.latitude,
            location.longitude,
            location.status AS location_status
          FROM core.accounts account
          LEFT JOIN core.account_locations location
            ON location.account_id = account.account_id
          WHERE account.account_id = $1
        `,
        [subjectAccountId],
      );
      return subjectResult.rows[0] || null;
    };

    let subject = await loadSubject();
    if (!subject) {
      return res.status(404).json({ error: "subject_not_found" });
    }

    const radiusRequested = requestedBreakdowns.some(
      (breakdown) => breakdown.scope === "radius",
    );
    if (
      radiusRequested &&
      (
        subject.location_status !== "matched" ||
        subject.latitude == null ||
        subject.longitude == null
      )
    ) {
      try {
        await refreshAccountLocations(pool, [subject], { batchSize: 1 });
        subject = await loadSubject();
      } catch (error) {
        console.warn(
          "[grouped-analysis] subject location refresh failed; radius studies may be unavailable",
          error?.message || error,
        );
      }
    }

    const unavailableBreakdowns = [];
    const availableBreakdowns = requestedBreakdowns.filter((breakdown) => {
      if (breakdown.scope === "city" && !String(subject.city || "").trim()) {
        unavailableBreakdowns.push({
          key: breakdown.key,
          label: "Citywide",
          reason: "The subject city is unavailable.",
        });
        return false;
      }
      if (breakdown.scope === "zip" && !subject.postal_code) {
        unavailableBreakdowns.push({
          key: breakdown.key,
          label: "Subject ZIP code",
          reason: "The subject ZIP code is unavailable.",
        });
        return false;
      }
      if (
        breakdown.scope === "radius" &&
        (
          subject?.location_status !== "matched" ||
          subject?.latitude == null ||
          subject?.longitude == null
        )
      ) {
        unavailableBreakdowns.push({
          key: breakdown.key,
          label: `Within ${breakdown.radiusMiles} mile${breakdown.radiusMiles === 1 ? "" : "s"}`,
          reason: "The subject parcel location is unavailable.",
        });
        return false;
      }
      return true;
    });

    if (!multipleBreakdownsRequested && unavailableBreakdowns.length) {
      return res.status(422).json({
        error: "subject_market_area_unavailable",
        subject_account_id: subjectAccountId,
      });
    }

    const analyses = [];
    for (const breakdown of availableBreakdowns) {
      const { rows } = await pool.query(
      `
        WITH parameters AS (
          SELECT
            COALESCE(NULLIF($1, '')::date, CURRENT_DATE) AS period_end,
            BTRIM($2) AS subject_city,
            NULLIF(BTRIM($3), '') AS subject_county,
            NULLIF(BTRIM($4), '') AS subject_postal_code,
            $5::double precision AS subject_latitude,
            $6::double precision AS subject_longitude,
            $7::text AS breakdown_scope,
            $8::double precision AS radius_miles
        ),
        eligible AS (
          SELECT
            sale.sale_price::numeric AS sale_price,
            sale.closing_date,
            sale.mls_bathrooms_total_integer::integer AS bathrooms_total,
            CASE
              WHEN sale.mls_garage_spaces IS NOT NULL
                THEN ROUND(sale.mls_garage_spaces)::integer
              WHEN sale.mls_garage_yn = false
                THEN 0
              ELSE NULL
            END AS garage_spaces,
            COALESCE(sale.mls_pool_yn, sale.cad_pool) AS pool_yn,
            COALESCE(
              NULLIF(sale.mls_living_area, 0),
              NULLIF(sale.cad_living_area_sqft, 0)
            )::numeric AS living_area,
            sale.days_on_market
          FROM core.v_sales_enriched sale
          JOIN core.accounts sale_account
            ON sale_account.account_id = sale.primary_account_id
          LEFT JOIN core.account_locations sale_location
            ON sale_location.account_id = sale.primary_account_id
          CROSS JOIN parameters
          WHERE sale.record_type = 'closed_sale'
            AND sale.closing_date >=
              (parameters.period_end - INTERVAL '1 year')::date
            AND sale.closing_date <= parameters.period_end
            AND (
              (
                parameters.breakdown_scope = 'city'
                AND LOWER(BTRIM(sale_account.city)) =
                  LOWER(parameters.subject_city)
                AND (
                  parameters.subject_county IS NULL
                  OR REGEXP_REPLACE(
                    LOWER(BTRIM(sale_account.county)),
                    '\\s+county$',
                    ''
                  ) = REGEXP_REPLACE(
                    LOWER(parameters.subject_county),
                    '\\s+county$',
                    ''
                  )
                )
              )
              OR (
                parameters.breakdown_scope = 'zip'
                AND parameters.subject_postal_code IS NOT NULL
                AND NULLIF(
                  LEFT(
                    REGEXP_REPLACE(
                      COALESCE(
                        NULLIF(BTRIM(sale_account.postal_code), ''),
                        NULLIF(BTRIM(sale.zip), '')
                      ),
                      '\\D',
                      '',
                      'g'
                    ),
                    5
                  ),
                  ''
                ) = parameters.subject_postal_code
              )
              OR (
                parameters.breakdown_scope = 'radius'
                AND parameters.subject_latitude IS NOT NULL
                AND parameters.subject_longitude IS NOT NULL
                AND parameters.radius_miles IS NOT NULL
                AND sale_location.status = 'matched'
                AND sale_location.latitude IS NOT NULL
                AND sale_location.longitude IS NOT NULL
                AND (
                  3958.7613 * ACOS(
                    LEAST(
                      1.0,
                      GREATEST(
                        -1.0,
                        COS(RADIANS(parameters.subject_latitude)) *
                        COS(RADIANS(sale_location.latitude)) *
                        COS(
                          RADIANS(sale_location.longitude) -
                          RADIANS(parameters.subject_longitude)
                        ) +
                        SIN(RADIANS(parameters.subject_latitude)) *
                        SIN(RADIANS(sale_location.latitude))
                      )
                    )
                  )
                ) <= parameters.radius_miles
              )
            )
        ),
        living_area_ranked AS (
          SELECT
            eligible.*,
            NTILE(10) OVER (
              ORDER BY living_area, sale_price, closing_date
            ) AS living_area_group
          FROM eligible
          WHERE living_area > 0
        ),
        coverage AS (
          SELECT
            COUNT(*)::integer AS eligible_sale_count,
            COUNT(bathrooms_total)::integer AS bathroom_sale_count,
            COUNT(garage_spaces)::integer AS garage_sale_count,
            COUNT(pool_yn)::integer AS pool_sale_count,
            (COUNT(living_area) FILTER (WHERE living_area > 0))::integer
              AS living_area_sale_count,
            (SELECT period_end FROM parameters) AS period_end,
            (
              SELECT (period_end - INTERVAL '1 year')::date
              FROM parameters
            ) AS period_start
          FROM eligible
        ),
        dimension_rows AS (
          SELECT
            'bathrooms'::text AS dimension,
            bathrooms_total::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
            AVG(living_area) FILTER (WHERE living_area > 0)
              AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
              FILTER (WHERE living_area > 0) AS median_living_area,
            MIN(living_area) FILTER (WHERE living_area > 0)
              AS minimum_living_area,
            MAX(living_area) FILTER (WHERE living_area > 0)
              AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM eligible
          WHERE bathrooms_total >= 1
          GROUP BY bathrooms_total

          UNION ALL

          SELECT
            'garage'::text AS dimension,
            garage_spaces::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
            AVG(living_area) FILTER (WHERE living_area > 0)
              AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
              FILTER (WHERE living_area > 0) AS median_living_area,
            MIN(living_area) FILTER (WHERE living_area > 0)
              AS minimum_living_area,
            MAX(living_area) FILTER (WHERE living_area > 0)
              AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM eligible
          WHERE garage_spaces >= 0
          GROUP BY garage_spaces

          UNION ALL

          SELECT
            'pool'::text AS dimension,
            pool_yn::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / NULLIF(living_area, 0))
              FILTER (WHERE living_area > 0) AS median_price_per_square_foot,
            AVG(living_area) FILTER (WHERE living_area > 0)
              AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY living_area)
              FILTER (WHERE living_area > 0) AS median_living_area,
            MIN(living_area) FILTER (WHERE living_area > 0)
              AS minimum_living_area,
            MAX(living_area) FILTER (WHERE living_area > 0)
              AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM eligible
          WHERE pool_yn IS NOT NULL
          GROUP BY pool_yn

          UNION ALL

          SELECT
            'living_area'::text AS dimension,
            living_area_group::text AS group_value,
            COUNT(*)::integer AS sample_size,
            MIN(sale_price) AS minimum_sale_price,
            MAX(sale_price) AS maximum_sale_price,
            AVG(sale_price) AS average_sale_price,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price) AS median_sale_price,
            percentile_cont(0.25) WITHIN GROUP
              (ORDER BY sale_price) AS lower_quartile_sale_price,
            percentile_cont(0.75) WITHIN GROUP
              (ORDER BY sale_price) AS upper_quartile_sale_price,
            stddev_samp(sale_price) AS sale_price_standard_deviation,
            AVG(sale_price / living_area)
              AS average_price_per_square_foot,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY sale_price / living_area)
              AS median_price_per_square_foot,
            AVG(living_area) AS average_living_area,
            percentile_cont(0.5) WITHIN GROUP
              (ORDER BY living_area) AS median_living_area,
            MIN(living_area) AS minimum_living_area,
            MAX(living_area) AS maximum_living_area,
            AVG(days_on_market) FILTER (WHERE days_on_market >= 0)
              AS average_days_on_market,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY days_on_market)
              FILTER (WHERE days_on_market >= 0) AS median_days_on_market
          FROM living_area_ranked
          GROUP BY living_area_group
        )
        SELECT dimension_rows.*, coverage.*
        FROM dimension_rows
        CROSS JOIN coverage
        ORDER BY
          CASE dimension
            WHEN 'bathrooms' THEN 1
            WHEN 'garage' THEN 2
            WHEN 'pool' THEN 3
            ELSE 4
          END,
          CASE
            WHEN dimension = 'pool' AND group_value = 'false' THEN 0
            WHEN dimension = 'pool' AND group_value = 'true' THEN 1
            ELSE group_value::integer
          END
      `,
      [
        asOfDate,
        String(subject.city || ""),
        String(subject.county || ""),
        String(subject.postal_code || ""),
        subject.latitude == null ? null : Number(subject.latitude),
        subject.longitude == null ? null : Number(subject.longitude),
        breakdown.scope,
        breakdown.radiusMiles,
      ],
    );

      const coverageRow = rows[0] || {};
      const marketLabel =
        breakdown.scope === "city"
          ? [subject.city, subject.county].filter(Boolean).join(", ")
          : breakdown.scope === "zip"
            ? `ZIP ${subject.postal_code}`
            : `Within ${breakdown.radiusMiles} mile${breakdown.radiusMiles === 1 ? "" : "s"} of ${subject.address || subject.account_id}`;
      analyses.push({
        subject: {
          account_id: subject.account_id,
          address: subject.address,
        },
        market: {
          key: breakdown.key,
          scope: breakdown.scope,
          city: subject.city,
          county: subject.county,
          postal_code: subject.postal_code,
          radius_miles: breakdown.radiusMiles,
          label: marketLabel,
        },
        period: {
          start: coverageRow.period_start || null,
          end: coverageRow.period_end || asOfDate || null,
        },
        population: {
          eligible_sale_count: Number(coverageRow.eligible_sale_count || 0),
          bathroom_sale_count: Number(coverageRow.bathroom_sale_count || 0),
          garage_sale_count: Number(coverageRow.garage_sale_count || 0),
          pool_sale_count: Number(coverageRow.pool_sale_count || 0),
          living_area_sale_count: Number(coverageRow.living_area_sale_count || 0),
        },
        filters: {
          record_type: "closed_sale",
          minimum_sale_price: null,
          review_flagged_sales_included: true,
          multi_parcel_sales_included: true,
          attached_housing_included: true,
          period_years: 1,
        },
        dimensions: buildGroupedAnalysis(rows),
      });
    }

    if (!multipleBreakdownsRequested) {
      return res.json(analyses[0]);
    }

    res.json({
      subject: {
        account_id: subject.account_id,
        address: subject.address,
        city: subject.city,
        county: subject.county,
        postal_code: subject.postal_code,
        latitude: subject.latitude == null ? null : Number(subject.latitude),
        longitude: subject.longitude == null ? null : Number(subject.longitude),
      },
      analyses,
      unavailable_breakdowns: unavailableBreakdowns,
    });
  } catch (error) {
    console.error("/api/sales/grouped-analysis failed", error);
    res.status(500).json({
      error: "grouped_analysis_failed",
      ...(process.env.GROUPED_ANALYSIS_DEBUG === "true"
        ? {
            detail: error?.message || String(error),
            database_code: error?.code || null,
          }
        : {}),
    });
  }
});

/**
 * POST /api/sales/paired-analysis
 *
 * Finds non-overlapping, closely matched sale pairs within one selected market
 * area. Negative feature contributions are retained so the mean, median, COD,
 * coefficient of variation, and standard deviation describe the full evidence.
 */
app.post("/api/sales/paired-analysis", async (req, res) => {
  try {
    const result = await buildPairedSalesStudy(pool, {
      subjectAccountId: String(
        req.body?.subject_account_id || "",
      ).trim(),
      marketKey: String(req.body?.market_key || "city").trim(),
      asOfDate: String(req.body?.as_of || "").trim(),
      customGeometry: req.body?.custom_geometry || null,
    });
    res.json(result);
  } catch (error) {
    const message = error?.message || "paired_sales_analysis_failed";
    console.error("/api/sales/paired-analysis failed", error);
    res.status(pairedSalesErrorStatus(message)).json({
      error: message,
    });
  }
});

/**
 * GET /api/sales/market-context
 *
 * Returns the subject location and market identifiers needed to center the
 * market-conditions map before a study is run.
 */
app.get("/api/sales/market-context", async (req, res) => {
  const subjectAccountId = String(
    req.query.subject_account_id || "",
  ).trim();
  try {
    const subject = await getMarketContext(pool, subjectAccountId);
    res.json({ subject });
  } catch (error) {
    const message = error?.message || "market_context_failed";
    console.error("/api/sales/market-context failed", error);
    res.status(marketConditionsErrorStatus(message)).json({
      error: message,
      ...(error?.detail ? { detail: error.detail } : {}),
    });
  }
});

/**
 * GET /api/accounts/:id/related-parcels
 *
 * Review-only companion parcel discovery. Exact situs-address matches are
 * collected from both the local account inventory and official DCAD parcel
 * GIS. No records are merged or changed by this endpoint.
 */
app.get("/api/accounts/:id/related-parcels", async (req, res) => {
  const accountId = String(req.params.id || "").trim();
  if (!/^[0-9A-Za-z]{17}$/.test(accountId)) {
    return res.status(400).json({ error: "invalid_account_id" });
  }
  try {
    const { rows: accountRows } = await pool.query(
      `SELECT account_id, address, city, postal_code, county
       FROM core.accounts WHERE account_id = $1`,
      [accountId],
    );
    const account = accountRows[0];
    if (!account) return res.status(404).json({ error: "account_not_found" });
    const requestedAddress = String(req.query.address || account.address || "")
      .trim()
      .slice(0, 200);
    if (!requestedAddress) {
      return res.status(422).json({ error: "related_parcel_address_required" });
    }
    const addressLine = requestedAddress
      .split(",")[0]
      .toUpperCase()
      .trim();
    const isDallasCounty =
      !account.county || /dallas/i.test(String(account.county));
    let liveResult = { query_address: requestedAddress, parcels: [] };
    let liveQueryStatus = isDallasCounty ? "complete" : "unsupported_county";
    let liveQueryError = null;
    if (isDallasCounty) {
      try {
        liveResult = await findDcadParcelsByAddress(requestedAddress);
      } catch (error) {
        liveQueryStatus = "unavailable";
        liveQueryError = String(error?.message || "dcad_address_query_failed");
      }
    }
    const remoteIds = liveResult.parcels.map((parcel) => parcel.account_id);
    const { rows: localRows } = await pool.query(
      `SELECT
         account.account_id,
         account.address,
         account.city,
         account.postal_code,
         account.county,
         account.neighborhood_code,
         account.legal_description,
         account.data_quality_status,
         COALESCE(improvement.living_area_sqft, improvement.total_living_area) AS living_area_sqft,
         values.land_value,
         values.improvement_value,
         values.market_value AS total_value,
         location.latitude,
         location.longitude
       FROM core.accounts account
       LEFT JOIN core.account_locations location
         ON location.account_id = account.account_id
       LEFT JOIN core.value_summary_current values
         ON values.account_id = account.account_id
       LEFT JOIN LATERAL (
         SELECT living_area_sqft, total_living_area
         FROM core.primary_improvements
         WHERE account_id = account.account_id
         LIMIT 1
       ) improvement ON TRUE
       WHERE account.account_id = ANY($1::text[])
          OR UPPER(BTRIM(SPLIT_PART(COALESCE(account.address, ''), ',', 1))) = $2
       ORDER BY account.account_id`,
      [remoteIds, addressLine],
    );
    const localById = new Map(localRows.map((row) => [row.account_id, row]));
    const combined = new Map();
    for (const parcel of liveResult.parcels) {
      const local = localById.get(parcel.account_id) || null;
      combined.set(parcel.account_id, {
        ...parcel,
        address: local?.address || parcel.site_address,
        city: local?.city || null,
        postal_code: local?.postal_code || null,
        county: local?.county || account.county || "DALLAS COUNTY",
        legal_description: local?.legal_description || parcel.property_description,
        living_area_sqft:
          parcel.living_area_sqft ??
          (local?.living_area_sqft == null ? null : Number(local.living_area_sqft)),
        land_value:
          parcel.land_value ?? (local?.land_value == null ? null : Number(local.land_value)),
        improvement_value:
          parcel.improvement_value ??
          (local?.improvement_value == null ? null : Number(local.improvement_value)),
        total_value:
          parcel.total_value ?? (local?.total_value == null ? null : Number(local.total_value)),
        data_quality_status: local?.data_quality_status || null,
        in_database: Boolean(local),
        is_subject: parcel.account_id === accountId,
      });
    }
    for (const local of localRows) {
      if (combined.has(local.account_id)) continue;
      combined.set(local.account_id, {
        account_id: local.account_id,
        low_parcel_id: null,
        site_address: local.address?.split(",")[0]?.trim() || null,
        address: local.address,
        city: local.city,
        postal_code: local.postal_code,
        county: local.county,
        neighborhood_code: local.neighborhood_code,
        property_description: local.legal_description,
        legal_description: local.legal_description,
        use_description: null,
        living_area_sqft:
          local.living_area_sqft == null ? null : Number(local.living_area_sqft),
        land_value: local.land_value == null ? null : Number(local.land_value),
        improvement_value:
          local.improvement_value == null ? null : Number(local.improvement_value),
        total_value: local.total_value == null ? null : Number(local.total_value),
        latitude: local.latitude == null ? null : Number(local.latitude),
        longitude: local.longitude == null ? null : Number(local.longitude),
        source_updated_at: null,
        source: "database_address_match",
        data_quality_status: local.data_quality_status,
        in_database: true,
        is_subject: local.account_id === accountId,
      });
    }
    const parcels = markMaterialParcelDifferences([...combined.values()], accountId).sort((left, right) => {
      if (left.is_subject !== right.is_subject) return left.is_subject ? -1 : 1;
      return String(left.account_id).localeCompare(String(right.account_id));
    });
    const materialDifferenceFound = parcels.some((parcel) => parcel.materially_different);
    return res.json({
      subject_account_id: accountId,
      query_address: liveResult.query_address || requestedAddress,
      live_query_status: liveQueryStatus,
      live_query_error: liveQueryError,
      review_required: materialDifferenceFound,
      material_difference_found: materialDifferenceFound,
      merge_performed: false,
      parcels,
    });
  } catch (error) {
    console.error("related parcel lookup failed", error);
    return res.status(500).json({ error: "related_parcel_lookup_failed" });
  }
});

/**
 * POST /api/sales/market-analysis
 *
 * Builds independent market-conditions studies for any requested combination
 * of city, ZIP, cumulative one-through-five-mile radii, and an appraiser-drawn
 * GeoJSON polygon. These areas do not filter comparable recommendations.
 */
app.post("/api/sales/market-analysis", async (req, res) => {
  try {
    const result = await buildMarketConditionsAnalyses(pool, {
      subjectAccountId: String(
        req.body?.subject_account_id || "",
      ).trim(),
      areaKeys: req.body?.area_keys,
      asOfDate: String(req.body?.as_of || "").trim(),
      periodMonths: req.body?.period_months ?? 24,
      customGeometry: req.body?.custom_geometry || null,
      marketContextOverride: req.body?.context_override || null,
    });
    res.json(result);
  } catch (error) {
    const message = error?.message || "market_analysis_failed";
    console.error("/api/sales/market-analysis failed", error);
    res.status(marketConditionsErrorStatus(message)).json({
      error: message,
      ...(error?.detail ? { detail: error.detail } : {}),
    });
  }
});

/**
 * POST /api/sales/regression-analysis
 *
 * Fits an auditable OLS model to same-housing-type sales in one appraiser-selected
 * market area. Sale prices remain unadjusted for time, and incomplete predictors
 * are reported rather than silently replaced with zeroes.
 */
app.post("/api/sales/regression-analysis", async (req, res) => {
  try {
    const result = await buildRegressionStudy(pool, {
      subjectAccountId: String(req.body?.subject_account_id || "").trim(),
      marketKey: String(req.body?.market_key || "city").trim(),
      asOfDate: String(req.body?.as_of || "").trim(),
      customGeometry: req.body?.custom_geometry || null,
    });
    res.json(result);
  } catch (error) {
    const message = error?.message || "regression_analysis_failed";
    console.error("/api/sales/regression-analysis failed", error);
    res.status(regressionAnalysisErrorStatus(message)).json({ error: message });
  }
});

/**
 * POST /api/sales/depreciated-cost-adjustment
 *
 * Recalculates one feature adjustment from replacement cost new less accrued
 * depreciation. The result can support GLA, garage, or pool differences; land
 * is excluded because it is not a depreciable improvement.
 */
app.post("/api/sales/depreciated-cost-adjustment", (req, res) => {
  try {
    res.json(calculateDepreciatedCostAdjustment(req.body || {}));
  } catch (error) {
    const message = error?.message || "depreciated_cost_adjustment_failed";
    res.status(depreciatedCostAdjustmentErrorStatus(message)).json({ error: message });
  }
});

/** POST /api/sales/site-valuation — allocated site value per square foot. */
app.post("/api/sales/site-valuation", async (req, res) => {
  try {
    const result = await buildSiteValuationStudy(pool, {
      subjectAccountId: String(req.body?.subject_account_id || "").trim(),
      marketKey: String(req.body?.market_key || "city").trim(),
      asOfDate: String(req.body?.as_of || "").trim(),
      customGeometry: req.body?.custom_geometry || null,
    });
    res.json(result);
  } catch (error) {
    const message = error?.message || "site_valuation_failed";
    console.error("/api/sales/site-valuation failed", error);
    res.status(siteValuationErrorStatus(message)).json({ error: message });
  }
});

/** POST /api/sales/qualitative-analysis — reconcile appraisal bracketing judgments. */
app.post("/api/sales/qualitative-analysis", (req, res) => {
  try {
    res.json(calculateQualitativeAnalysis(req.body || {}, req.body?.comparables || []));
  } catch (error) {
    const message = error?.message || "qualitative_analysis_failed";
    res.status(qualitativeAnalysisErrorStatus(message)).json({ error: message });
  }
});

/**
 * POST /api/sales/neighborhood-profile
 *
 * Refreshes the appraiser-defined neighborhood ranges, a citywide comparison,
 * and a reviewable north/east/south/west road summary for the drawn boundary.
 */
app.post("/api/sales/neighborhood-profile", async (req, res) => {
  const customGeometry = req.body?.custom_geometry || null;
  try {
    const market = await buildMarketConditionsAnalyses(pool, {
      subjectAccountId: String(req.body?.subject_account_id || "").trim(),
      areaKeys: ["custom", "city"],
      asOfDate: String(req.body?.as_of || "").trim(),
      periodMonths: req.body?.period_months ?? 24,
      customGeometry,
      marketContextOverride: req.body?.context_override || null,
    });
    let boundaryStreets = null;
    let boundaryStreetWarning = null;
    try {
      boundaryStreets = await loadBoundaryStreetNames(pool, customGeometry);
    } catch (error) {
      boundaryStreetWarning = error?.message || "boundary_street_lookup_failed";
      console.warn("/api/sales/neighborhood-profile street lookup failed", error);
    }
    res.json({
      ...market,
      boundary_streets: boundaryStreets,
      boundary_street_warning: boundaryStreetWarning,
    });
  } catch (error) {
    const message = error?.message || "neighborhood_profile_failed";
    console.error("/api/sales/neighborhood-profile failed", error);
    res.status(marketConditionsErrorStatus(message)).json({
      error: message,
      ...(error?.detail ? { detail: error.detail } : {}),
    });
  }
});

/**
 * POST /api/sales/neighborhood-land-use
 *
 * Calculates present land-use percentages from every official DCAD parcel
 * intersecting the saved appraiser-defined polygon. This is intentionally
 * on-demand and independent from the residential account scraper.
 */
app.post("/api/sales/neighborhood-land-use", async (req, res) => {
  try {
    const result = await buildNeighborhoodLandUseAnalysis(pool, {
      subjectAccountId: String(req.body?.subject_account_id || "").trim(),
      customGeometry: req.body?.custom_geometry || null,
    });
    res.json(result);
  } catch (error) {
    const message = error?.message || "neighborhood_land_use_analysis_failed";
    console.error("/api/sales/neighborhood-land-use failed", error);
    res.status(neighborhoodLandUseErrorStatus(message)).json({
      error: message,
      ...(error?.detail ? { detail: error.detail } : {}),
    });
  }
});

/**
 * GET /api/property-context/status
 *
 * Reports local mirror freshness without contacting any external service.
 */
app.get("/api/property-context/status", async (_req, res) => {
  try {
    await ensurePropertyContextAvailable();
    res.json(await getPropertyContextStatus(pool));
  } catch (error) {
    console.error("/api/property-context/status failed", error);
    res.status(500).json({ error: "property_context_status_failed" });
  }
});

/**
 * GET /api/neighborhood-engine/readiness
 *
 * Audits locally stored Dallas County inputs for the broad-boundary and
 * independent relevance-selection engines. It never contacts a remote source.
 */
app.get("/api/neighborhood-engine/readiness", async (req, res) => {
  try {
    await ensurePropertyContextAvailable();
    res.json(await getNeighborhoodEngineReadiness(pool, {
      county: req.query.county || "Dallas",
    }));
  } catch (error) {
    console.error("/api/neighborhood-engine/readiness failed", error);
    if (error?.message === "neighborhood_engine_county_not_configured") {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "neighborhood_engine_readiness_failed" });
  }
});

/** Load the latest generated or appraiser-confirmed broad neighborhood boundary. */
app.get("/api/accounts/:id/neighborhood-boundary", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.query.assignment_file_id);
    const assessment = await getLatestNeighborhoodBoundary(pool, {
      accountId,
      assignmentFileId,
    });
    res.json({ account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "neighborhood_boundary_lookup_failed";
    const status = message === "account_not_found" ? 404
      : ["invalid_account_id", "invalid_assignment_file"].includes(message) ? 400
        : 500;
    res.status(status).json({ error: message });
  }
});

/**
 * Generate and persist a broad descriptive neighborhood from local PostGIS
 * mirrors. Independent statistical relevance screening remains a later step.
 */
app.post("/api/accounts/:id/neighborhood-boundary/generate", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.body?.assignment_file_id);
    const assessment = await generateNeighborhoodBoundary(pool, {
      accountId,
      assignmentFileId,
      searchProfileKey: req.body?.search_profile,
    });
    res.json({ ok: true, account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "neighborhood_boundary_generation_failed";
    console.error("/api/accounts/:id/neighborhood-boundary/generate failed", error);
    const clientErrors = new Set([
      "invalid_account_id",
      "invalid_assignment_file",
      "invalid_neighborhood_search_profile",
    ]);
    const status = message === "account_not_found" ||
      message === "subject_parcel_geometry_unavailable" ? 404
      : clientErrors.has(message) ? 400
        : 500;
    res.status(status).json({ error: message });
  }
});

/** Preserve the appraiser's assignment-specific confirmation in the audit table. */
app.patch("/api/accounts/:id/neighborhood-boundary/:assessmentId", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.body?.assignment_file_id);
    const assessment = await reviewNeighborhoodBoundary(pool, {
      accountId,
      assessmentId: req.params.assessmentId,
      assignmentFileId,
      confirmed: req.body?.confirmed,
      reviewer: req.body?.reviewer,
      notes: req.body?.notes,
    });
    res.json({ ok: true, account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "neighborhood_boundary_review_failed";
    const clientErrors = new Set([
      "invalid_account_id",
      "invalid_assignment_file",
      "invalid_neighborhood_boundary_assessment",
      "invalid_neighborhood_boundary_review",
      "invalid_neighborhood_boundary_reviewer",
      "neighborhood_boundary_notes_too_long",
    ]);
    const status = message === "account_not_found" ||
      message === "neighborhood_boundary_assessment_not_found" ? 404
      : clientErrors.has(message) ? 400
        : 500;
    res.status(status).json({ error: message });
  }
});

/** Load the latest independent relevant-property population summary. */
app.get("/api/accounts/:id/neighborhood-relevance", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.query.assignment_file_id);
    const assessment = await getLatestNeighborhoodRelevance(pool, {
      accountId,
      assignmentFileId,
    });
    res.json({ account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "neighborhood_relevance_lookup_failed";
    res.status(message === "account_not_found" ? 404
      : ["invalid_account_id", "invalid_assignment_file"].includes(message) ? 400
        : 500).json({ error: message });
  }
});

/** Score the broad area's parcel population and persist reviewable exclusions. */
app.post("/api/accounts/:id/neighborhood-relevance/generate", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.body?.assignment_file_id);
    const assessment = await generateNeighborhoodRelevance(pool, {
      accountId,
      assignmentFileId,
      boundaryAssessmentId: req.body?.boundary_assessment_id,
    });
    res.json({ ok: true, account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "neighborhood_relevance_generation_failed";
    console.error("/api/accounts/:id/neighborhood-relevance/generate failed", error);
    const clientErrors = new Set([
      "invalid_account_id",
      "invalid_assignment_file",
      "invalid_neighborhood_boundary_assessment",
      "neighborhood_boundary_required",
    ]);
    const status = message === "account_not_found" ? 404
      : clientErrors.has(message) ? 400
        : message === "neighborhood_relevance_candidates_unavailable" ? 422
          : 500;
    res.status(status).json({ error: message });
  }
});

/** Load the latest saved property-context and complexity assessment. */
app.get("/api/accounts/:id/property-context", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    await ensurePropertyContextAvailable();
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(
      req.query.assignment_file_id,
    );
    const assessment = await getStoredPropertyContext(pool, {
      accountId,
      assignmentFileId,
    });
    res.json({ account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "property_context_lookup_failed";
    res.status(propertyContextErrorStatus(message)).json({ error: message });
  }
});

/**
 * POST /api/accounts/:id/property-context/analyze
 *
 * Uses only locally stored CAD, property-characteristic, and road data. Source
 * outages are surfaced in the response but never cause a live GIS dependency.
 */
app.post("/api/accounts/:id/property-context/analyze", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    await ensurePropertyContextAvailable();
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(
      req.body?.assignment_file_id,
    );
    const assessment = await analyzePropertyContext(pool, {
      accountId,
      assignmentFileId,
      customGeometry: req.body?.custom_geometry || null,
      geography: req.body?.geography || null,
    });
    res.json({ ok: true, account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "property_context_analysis_failed";
    console.error("/api/accounts/:id/property-context/analyze failed", error);
    res.status(propertyContextErrorStatus(message)).json({ error: message });
  }
});

/** Save an appraiser confirmation or override without rewriting source data. */
app.patch("/api/accounts/:id/property-context", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    await ensurePropertyContextAvailable();
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(
      req.body?.assignment_file_id,
    );
    const assessment = await savePropertyContextReview(pool, {
      accountId,
      assignmentFileId,
      review: req.body,
    });
    res.json({ ok: true, account_id: accountId, assessment });
  } catch (error) {
    const message = error?.message || "property_context_review_failed";
    console.error("/api/accounts/:id/property-context review failed", error);
    res.status(propertyContextErrorStatus(message)).json({ error: message });
  }
});

/** Load the correct official zoning evidence and review contact for a subject. */
app.get("/api/accounts/:id/zoning-evidence", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  try {
    await ensurePropertyContextAvailable();
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.query.assignment_file_id);
    const evidence = await getPropertyZoningEvidence(pool, { accountId, assignmentFileId });
    res.json({ ok: true, account_id: accountId, evidence });
  } catch (error) {
    const message = error?.message || "zoning_evidence_lookup_failed";
    res.status(message === "account_not_found" ? 404 : 500).json({ error: message });
  }
});

/** Stream the immutable cached PDF inline; old versions remain auditable. */
app.get("/api/zoning-source-documents/:id/content", async (req, res) => {
  const documentId = Number(req.params.id);
  if (!Number.isInteger(documentId) || documentId < 1) {
    return res.status(400).json({ error: "invalid_zoning_document_id" });
  }
  try {
    await ensurePropertyContextAvailable();
    const document = await getZoningDocumentContent(pool, documentId);
    if (!document) return res.status(404).json({ error: "zoning_document_not_found" });
    res.set({
      "Content-Type": document.content_type || "application/pdf",
      "Content-Disposition": `inline; filename="zoning-evidence-${document.id}.pdf"`,
      ETag: `"${document.checksum_sha256}"`,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    return res.send(document.content);
  } catch (error) {
    console.error("zoning document stream failed", error);
    return res.status(500).json({ error: "zoning_document_stream_failed" });
  }
});

/** Suggest the verbatim district wording found beside a confirmed zoning code. */
app.get("/api/zoning-source-documents/:id/description-suggestion", async (req, res) => {
  try {
    await ensurePropertyContextAvailable();
    const result = await getZoningDocumentDescriptionSuggestion(pool, {
      documentId: req.params.id,
      zoningCode: String(req.query.zoning_code || "").trim(),
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error?.message || "zoning_description_suggestion_failed";
    const status = message === "zoning_document_not_found"
      ? 404
      : message === "invalid_zoning_document_id" ? 400 : 500;
    return res.status(status).json({ error: message });
  }
});

/** Save an appraiser-confirmed zoning result with its source and reviewer. */
app.put("/api/accounts/:id/zoning-verification", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (!configuredEditorKey) {
    return res.status(503).json({ error: "zoning_editor_not_configured" });
  }
  if (!editorKeyMatches(req.get("x-homenode-editor-key"), configuredEditorKey)) {
    return res.status(401).json({ error: "invalid_editor_key" });
  }
  try {
    await ensurePropertyContextAvailable();
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.body?.assignment_file_id);
    const verification = await savePropertyZoningVerification(pool, {
      accountId,
      assignmentFileId,
      input: req.body,
    });
    return res.json({ ok: true, account_id: accountId, verification });
  } catch (error) {
    const message = error?.message || "zoning_verification_failed";
    const clientErrors = new Set([
      "invalid_zoning_jurisdiction",
      "zoning_code_required",
      "zoning_description_required",
      "zoning_reviewer_required",
      "invalid_zoning_source_type",
      "invalid_zoning_source_document",
    ]);
    return res.status(clientErrors.has(message) ? 400 : 500).json({ error: message });
  }
});

function decodedDocumentHeader(req, name, fallback = "") {
  const value = String(req.get(name) || fallback);
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** List assignment PDFs and their machine-review status for a property file. */
app.get("/api/accounts/:id/documents", async (req, res) => {
  const requestedId = String(req.params.id || "").trim();
  if (!requireEditor(req, res)) return;
  try {
    await ensureAssignmentDocumentsAvailable();
    const accountId = await resolveCanonicalAccountId(pool, requestedId);
    const assignmentFileId = normalizeAssignmentFileId(req.query.assignment_file_id);
    const documents = await listAssignmentDocuments(pool, { accountId, assignmentFileId });
    return res.json({ ok: true, account_id: accountId, documents });
  } catch (error) {
    const message = error?.message || "assignment_documents_lookup_failed";
    return res.status(message === "account_not_found" ? 404 : 500).json({ error: message });
  }
});

/**
 * Upload a PDF without base64 expansion. Extraction is durable and asynchronous;
 * a scheduled maintenance pass retries any interrupted work.
 */
app.post(
  "/api/accounts/:id/documents",
  express.raw({
    type: ["application/pdf", "application/octet-stream"],
    limit: MAX_ASSIGNMENT_DOCUMENT_BYTES,
  }),
  async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
    if (!configuredEditorKey) return res.status(503).json({ error: "document_editor_not_configured" });
    if (!editorKeyMatches(req.get("x-homenode-editor-key"), configuredEditorKey)) {
      return res.status(401).json({ error: "invalid_editor_key" });
    }
    try {
      await ensureAssignmentDocumentsAvailable();
      const accountId = await resolveCanonicalAccountId(pool, requestedId);
      const assignmentFileId = normalizeAssignmentFileId(req.get("x-assignment-file-id"));
      if (assignmentFileId) {
        const { rowCount } = await pool.query(
          "SELECT 1 FROM app.assignment_files WHERE id = $1 AND account_id = $2",
          [assignmentFileId, accountId],
        );
        if (!rowCount) return res.status(400).json({ error: "invalid_assignment_file" });
      }
      const document = await createAssignmentDocument(pool, {
        accountId,
        assignmentFileId,
        documentType: decodedDocumentHeader(req, "x-document-type", "other"),
        title: decodedDocumentHeader(req, "x-document-title"),
        fileName: decodedDocumentHeader(req, "x-document-file-name", "document.pdf"),
        contentType: req.get("content-type"),
        content: req.body,
        uploadedBy: decodedDocumentHeader(req, "x-document-uploaded-by"),
      });
      if (document.processing_status === "uploaded") {
        void processAssignmentDocument(pool, document.id).catch((error) => {
          if (error?.message !== "document_processing_in_progress") {
            console.warn("[documents] background extraction failed", error?.message || error);
          }
        });
      }
      return res.status(201).json({ ok: true, account_id: accountId, document });
    } catch (error) {
      const message = error?.message || "assignment_document_upload_failed";
      const clientErrors = new Set([
        "document_content_required",
        "document_too_large",
        "document_not_pdf",
        "invalid_document_type",
      ]);
      return res.status(clientErrors.has(message) ? 400 : 500).json({ error: message });
    }
  },
);

/** Load a document plus page-cited field candidates. */
app.get("/api/documents/:id", async (req, res) => {
  if (!requireEditor(req, res)) return;
  try {
    await ensureAssignmentDocumentsAvailable();
    const document = await getAssignmentDocument(pool, req.params.id);
    if (!document) return res.status(404).json({ error: "document_not_found" });
    return res.json({ ok: true, document });
  } catch (error) {
    console.error("assignment document lookup failed", error);
    return res.status(500).json({ error: "assignment_document_lookup_failed" });
  }
});

/** Stream immutable uploaded source bytes inline for the embedded PDF viewer. */
app.get("/api/documents/:id/content", async (req, res) => {
  if (!requireEditor(req, res)) return;
  try {
    await ensureAssignmentDocumentsAvailable();
    const document = await getAssignmentDocument(pool, req.params.id, { includeContent: true });
    if (!document) return res.status(404).json({ error: "document_not_found" });
    const fileName = String(document.file_name || `document-${document.id}.pdf`)
      .replace(/[\r\n"]/g, "_");
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
      ETag: `"${document.checksum_sha256}"`,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    });
    return res.send(document.content);
  } catch (error) {
    console.error("assignment document stream failed", error);
    return res.status(500).json({ error: "assignment_document_stream_failed" });
  }
});

/** Retry text extraction after a worker interruption or parser improvement. */
app.post("/api/documents/:id/reprocess", async (req, res) => {
  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (!configuredEditorKey) return res.status(503).json({ error: "document_editor_not_configured" });
  if (!editorKeyMatches(req.get("x-homenode-editor-key"), configuredEditorKey)) {
    return res.status(401).json({ error: "invalid_editor_key" });
  }
  try {
    await ensureAssignmentDocumentsAvailable();
    const document = await processAssignmentDocument(pool, req.params.id, { force: true });
    return res.json({ ok: true, document });
  } catch (error) {
    const message = error?.message || "assignment_document_reprocess_failed";
    const clientErrors = new Set([
      "invalid_document_id",
      "document_processing_in_progress",
      "document_retry_not_due",
      "document_not_processable",
    ]);
    return res.status(message === "document_not_found" ? 404 : clientErrors.has(message) ? 409 : 500).json({ error: message });
  }
});

/** Confirm or reject one machine suggestion without mutating the source PDF. */
app.patch("/api/documents/:documentId/candidates/:candidateId", async (req, res) => {
  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (!configuredEditorKey) return res.status(503).json({ error: "document_editor_not_configured" });
  if (!editorKeyMatches(req.get("x-homenode-editor-key"), configuredEditorKey)) {
    return res.status(401).json({ error: "invalid_editor_key" });
  }
  try {
    await ensureAssignmentDocumentsAvailable();
    const candidate = await reviewAssignmentDocumentCandidate(pool, {
      documentId: req.params.documentId,
      candidateId: req.params.candidateId,
      reviewStatus: req.body?.review_status,
      confirmedValue: req.body?.confirmed_value,
      reviewer: req.body?.reviewer,
    });
    return res.json({ ok: true, candidate });
  } catch (error) {
    const message = error?.message || "document_candidate_review_failed";
    const clientErrors = new Set([
      "invalid_document_candidate",
      "invalid_document_review_status",
      "document_reviewer_required",
      "document_candidate_not_found",
    ]);
    return res.status(clientErrors.has(message) ? 400 : 500).json({ error: message });
  }
});

/**
 * GET /api/sales/:sourceRecordId/photos
 * Lazily loads an ordered gallery after the user opens a comparable image.
 */
app.get("/api/sales/:sourceRecordId/photos", async (req, res) => {
  const sourceRecordId = String(req.params.sourceRecordId || "").trim();
  if (!/^[1-9][0-9]*$/.test(sourceRecordId)) {
    return res.status(400).json({ error: "invalid_source_record_id" });
  }
  try {
    const { rows: sourceRows } = await pool.query(
      `
        SELECT id AS source_record_id, listing_key, listing_id, source_name
        FROM core.sales_source_records
        WHERE id = $1
      `,
      [sourceRecordId],
    );
    if (!sourceRows.length) {
      return res.status(404).json({ error: "sale_source_record_not_found" });
    }
    const { rows: photos } = await pool.query(
      `
        SELECT
          id,
          source_record_id,
          media_url,
          order_number,
          preferred_photo_yn AS is_primary,
          short_description AS caption,
          mime_type,
          permission,
          modification_timestamp
        FROM core.sales_source_media
        WHERE source_record_id = $1
          AND media_category = 'image'
        ORDER BY
          preferred_photo_yn DESC,
          order_number NULLS LAST,
          id
      `,
      [sourceRecordId],
    );
    res.json({
      ...sourceRows[0],
      photos,
    });
  } catch (error) {
    console.error("/api/sales/:sourceRecordId/photos failed", error);
    res.status(500).json({ error: "sale_photos_failed" });
  }
});

/**
 * Helper to build WHERE for classes (numeric ranges + labels).
 * Returns { whereSql, params } pieces to plug into the main query.
 */
function buildClassWhere({ classes, county, neighborhoods }) {
  const { exact, lows, highs, labels } = parseClassFilter(String(classes || ""));
  const counties = String(county || "").split(",").map(s => s.trim()).filter(Boolean);
  const nbhds   = String(neighborhoods || "").split(",").map(s => s.trim()).filter(Boolean);

  const where = [];
  const params = [];

  // Build the class OR-group
  const classParts = [];
  if (exact.length || lows.length || highs.length) {
    classParts.push(
      `matches_classes_lohi(c.building_class_int, $${params.push(exact)}::int[], $${params.push(lows)}::int[], $${params.push(highs)}::int[])`
    );
  }
  if (labels.length) {
    classParts.push(`UPPER(c.building_class) = ANY($${params.push(labels.map(l => l.toUpperCase()))}::text[])`);
  }
  if (classParts.length) where.push(`(${classParts.join(" OR ")})`);

  if (counties.length) where.push(`p.county = ANY($${params.push(counties)}::text[])`);
  if (nbhds.length)    where.push(`p.neighborhood_code = ANY($${params.push(nbhds)}::text[])`);

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
}

/**
 * GET /api/properties/search
 * Query:
 *   - classes: e.g. "14" or "7,12,25; 2-3; 5-6" or "CONDOMINIUM; LAND ONLY"
 *   - limit: number (default 100, max 1000)
 *   - county, neighborhoods: optional comma-separated lists
 */
app.get("/api/properties/search", async (req, res) => {
  try {
    const { classes = "", limit = "100", county = "", neighborhoods = "" } = req.query;
    const lim = Math.min(parseInt(limit, 10) || 100, 1000);

    const { whereSql, params } = buildClassWhere({ classes, county, neighborhoods });

    // If literally no filters, you can choose to return an error or everything. We?ll just return first N.
    const sql = `
      SELECT p.account_id, p.county, p.situs_address,
             c.building_class, c.building_class_int
      FROM properties p
      JOIN primary_building_class c USING (account_id)
      ${whereSql}
      ORDER BY p.account_id
      LIMIT $${params.push(lim)}
    `;

    const { rows } = await pool.query(sql, params);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "query_failed" });
  }
});

/**
 * GET /api/stats/class-distribution
 * Same filters as /search; returns grouped counts by class label & code.
 */
app.get("/api/stats/class-distribution", async (req, res) => {
  try {
    const { classes = "", county = "", neighborhoods = "" } = req.query;
    const { whereSql, params } = buildClassWhere({ classes, county, neighborhoods });

    const sql = `
      SELECT
        c.building_class       AS class_label,
        c.building_class_int   AS class_code_int,
        COUNT(*)::bigint       AS n
      FROM properties p
      JOIN primary_building_class c USING (account_id)
      ${whereSql}
      GROUP BY c.building_class, c.building_class_int
      ORDER BY n DESC, class_label NULLS LAST
    `;

    const { rows } = await pool.query(sql, params);
    res.json({ count: rows.length, rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "stats_failed" });
  }
});

const port = parseInt(process.env.PORT || "4000", 10);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
