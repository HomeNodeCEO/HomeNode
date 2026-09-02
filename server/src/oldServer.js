import "dotenv/config";
import { isIP } from "node:net";
import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import pg from "pg";
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
  ensureAccountLocationsTable,
  refreshAccountLocations,
} from "./services/accountLocations.js";
import {
  enqueueLocationBackfillAccounts,
  ensureLocationBackfillQueueSchema,
  startLocationBackfillWorker,
} from "./services/locationBackfillQueue.js";
import { ensureAccountQualitySchema } from "./services/accountQuality.js";
import { editorKeyMatches } from "./util/housingProfileEdit.js";
import { buildGroupedAnalysis } from "./util/groupedAnalysis.js";
import { parseGroupedAnalysisBreakdowns } from "./util/groupedAnalysisBreakdowns.js";
import { summarizeComparableResults } from "./services/comparableResponseSummary.js";
import {
  ensureCensusGeographySchema,
  startCensusGeographyWorker,
} from "./services/censusGeography.js";
import {
  ensureAppraisalRatingsSchema,
} from "./services/appraisalRatings.js";
import { ensurePropertyEnrichmentSchema } from "./services/propertyEnrichment.js";
import {
  ensureSalesReconciliationSchema,
} from "./services/salesReconciliation.js";
import { TrestleClient } from "./services/trestleClient.js";
import {
  assertNonDallasEnrichmentCounty,
} from "./util/nonDallasEnrichment.js";
import { ensureAssignmentFilesSchema } from "./services/assignmentFiles.js";
import {
  ensureCustomAppraisalWorkfileSchema,
} from "./services/customAppraisalWorkfiles.js";
import { ensurePropertyContextSchema } from "./services/propertyContextStore.js";
import { ensureAssignmentDocumentsSchema } from "./services/assignmentDocuments.js";
import { createDocumentOcrProvider } from "./services/documentOcr.js";
import {
  enqueuePropertyInfluenceAccounts,
  getPropertyInfluenceContexts,
} from "./services/propertyInfluenceStore.js";
import {
  createCachedScraperStatusLoader,
} from "./services/operationalReadiness.js";
import {
  createRequestPerformanceMonitor,
  environmentFlag,
  normalizePerformancePath,
} from "./util/requestPerformance.js";
import { createUadRouter, uadBodyParserErrorHandler } from "./modules/uad/router.js";
import { createUadObjectStorage } from "./modules/uad/r2Storage.js";
import {
  closeUadArtifactExecution,
  getUadArtifactExecutionSnapshot,
} from "./modules/uad/uadArtifactExecution.js";
import { startUadArtifactRecoveryMonitor } from "./modules/uad/uadArtifactRecovery.js";
import { createUadComplianceRegistry } from "./modules/uad/uadComplianceClient.js";
import { createMobileAuthenticator, createOidcAccessTokenVerifier } from "./modules/mobile/auth.js";
import { createMobileRouter } from "./modules/mobile/router.js";
import { createPropertyCatalogRouter } from "./modules/propertyCatalog/router.js";
import { createOperationalRouter } from "./modules/operations/router.js";
import { createGeographyOperationsRouter } from "./modules/operations/geographyRouter.js";
import { createSalesReconciliationRouter } from "./modules/operations/salesReconciliationRouter.js";
import { createEnrichmentReadRouter } from "./modules/operations/enrichmentReadRouter.js";
import { createEnrichmentMutationRouter } from "./modules/operations/enrichmentMutationRouter.js";
import { createSignupRouter } from "./modules/signup/router.js";
import { createAppraisalRatingsRouter } from "./modules/appraisalRatings/router.js";
import { createSaleReviewRouter } from "./modules/appraisalRatings/saleReviewRouter.js";
import { createAccountDetailRouter } from "./modules/accounts/detailRouter.js";
import { createMarketValueHistoryRouter } from "./modules/accounts/marketValueHistoryRouter.js";
import { createPropertySearchRouter } from "./modules/accounts/propertySearchRouter.js";
import { createRelatedParcelsRouter } from "./modules/accounts/relatedParcelsRouter.js";
import {
  createAccountPropertyContextRouter,
  createPropertyContextStatusRouter,
} from "./modules/accounts/propertyContextRouter.js";
import { createNeighborhoodRouter } from "./modules/accounts/neighborhoodRouter.js";
import { createZoningRouter } from "./modules/accounts/zoningRouter.js";
import { createSalesListRouter } from "./modules/sales/salesListRouter.js";
import { createSalesMediaRouter } from "./modules/sales/mediaRouter.js";
import { createComparisonStudyRouter } from "./modules/sales/comparisonStudyRouter.js";
import { createValuationStudyRouter } from "./modules/sales/valuationStudyRouter.js";
import { createNeighborhoodAnalysisRouter } from "./modules/sales/neighborhoodAnalysisRouter.js";
import { createAccountPhotosRouter } from "./modules/accounts/photosRouter.js";
import { createHousingProfileRouter } from "./modules/accounts/housingProfileRouter.js";
import { createReportManualValuesRouter } from "./modules/accounts/reportManualValuesRouter.js";
import { createAssignmentFileListRouter } from "./modules/assignmentFiles/listRouter.js";
import { createAssignmentFileMutationRouter } from "./modules/assignmentFiles/mutationRouter.js";
import { createAssignmentDocumentRouter } from "./modules/assignmentFiles/documentRouter.js";
import { createAssignmentPhotoRouter } from "./modules/assignmentFiles/photoRouter.js";
import { createAssignmentWorkfileReadRouter } from "./modules/assignmentFiles/workfileReadRouter.js";
import { createAssignmentWorkfileMutationRouter } from "./modules/assignmentFiles/workfileMutationRouter.js";
import { createDesktopReportFilesRouter } from "./modules/accounts/reportFilesRouter.js";
import { createAppraisalHistoryRouter } from "./modules/accounts/appraisalHistoryRouter.js";
import { createDesktopAssignmentSketchRouter } from "./modules/mobile/desktopAssignmentSketchRouter.js";
import { createDesktopPropertyTaxRouter } from "./modules/mobile/desktopPropertyTaxRouter.js";
import {
  authenticatedApiRateLimitKey,
  createCorsMiddleware,
  createHttpSecurityConfiguration,
  jsonErrorHandler,
  securityHeaders,
  shouldSkipGlobalApiRateLimit,
} from "./security/httpSecurity.js";
import { isLegacyAccountIdAllowed } from "./security/accountIdPolicy.js";
import { createRedTeamIsolationConfiguration } from "./security/redTeamIsolation.js";
import {
  buildApplicationSession,
  createOptionalApplicationAuthenticator,
  hasApplicationPermission,
} from "./security/applicationAccess.js";
import {
  applicationAuthenticationOperationalState,
  assertApplicationAuthenticationStartup,
  createApplicationAuthenticationPolicy,
} from "./security/applicationAuthenticationPolicy.js";
import { getApplicationAuthReadiness } from "./security/applicationAuthReadiness.js";
import { createWebAuthRouter, createWebSessionAuthenticator } from "./security/webAuth.js";
import { authorizeCustomAssignmentFile } from "./security/assignmentAccess.js";
import {
  createRuntimeResilienceConfiguration,
} from "./security/runtimeResilience.js";
import { startApplicationHttpLifecycle } from "./application/httpLifecycle.js";
import { createRuntimeHealthHandlers } from "./security/runtimeHealth.js";
import { createStartupInitializationRegistry } from "./security/startupInitialization.js";
import { mountApplicationRouteBoundary } from "./security/applicationRouteBoundary.js";

const applicationAuthenticationPolicy = createApplicationAuthenticationPolicy();
const webOidcVerifier = createOidcAccessTokenVerifier({
  issuer: process.env.OIDC_WEB_ISSUER || process.env.OIDC_ISSUER,
  audience: process.env.OIDC_WEB_CLIENT_ID,
  jwksUri: process.env.OIDC_WEB_JWKS_URI || process.env.OIDC_JWKS_URI,
  clockToleranceSeconds: process.env.OIDC_CLOCK_TOLERANCE_SECONDS,
  fetchTimeoutMilliseconds: process.env.OIDC_HTTP_TIMEOUT_MS,
});
assertApplicationAuthenticationStartup({
  authenticationPolicy: applicationAuthenticationPolicy,
  environment: process.env,
  webOidcConfigured: webOidcVerifier.configured,
});
const applicationAuthenticationRequired = applicationAuthenticationPolicy.authenticationRequired;
const app = express();
const httpSecurity = createHttpSecurityConfiguration(process.env, {
  authenticationPolicy: applicationAuthenticationPolicy,
});
const redTeamIsolation = createRedTeamIsolationConfiguration();
const legacyAccountIdAllowed = (value) => isLegacyAccountIdAllowed(value, {
  redTeamEnabled: redTeamIsolation.enabled,
});
const runtimeResilience = createRuntimeResilienceConfiguration();
const startupInitialization = createStartupInitializationRegistry();
app.disable("x-powered-by");
if (httpSecurity.trustProxyHops > 0) app.set("trust proxy", httpSecurity.trustProxyHops);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ...runtimeResilience.database,
  application_name: "homenode-web",
});
pool.on("error", (error) => {
  console.error("[database] idle pool client error", error?.message || error);
});
const requestPerformance = createRequestPerformanceMonitor({ pool });
const loadDcadScraperStatus = redTeamIsolation.external_status_enabled
  ? createCachedScraperStatusLoader()
  : async () => ({
      payload: null,
      stale: false,
      error: "redteam_external_status_disabled",
    });
app.use(requestPerformance.middleware);
app.use(securityHeaders);
app.use(createCorsMiddleware(httpSecurity));
const globalApiRateLimiterOptions = {
  windowMs: httpSecurity.apiRateLimitWindowMs,
  limit: httpSecurity.apiRateLimitMax,
  // UAD and mobile own stricter limiters and response contracts inside their
  // routers. Applying the global limiter as well would create two counters and
  // overwrite the advertised route policy headers.
  skip: (req) => shouldSkipGlobalApiRateLimit(req, httpSecurity),
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authenticatedKey = authenticatedApiRateLimitKey(req);
    if (authenticatedKey) return authenticatedKey;
    const forwarded = httpSecurity.rateLimitClientIpHeader
      ? String(req.get(httpSecurity.rateLimitClientIpHeader) || "").trim()
      : "";
    return ipKeyGenerator(isIP(forwarded) ? forwarded : req.ip);
  },
  handler: (req, res) => {
    console.warn("[security] api rate limit exceeded", {
      method: String(req.method || "GET").toUpperCase(),
      path: normalizePerformancePath(req.path || req.originalUrl),
      authenticated: Boolean(authenticatedApiRateLimitKey(req)),
    });
    res.status(429).json({ error: "api_rate_limit_exceeded" });
  },
};

const signupRateLimiter = rateLimit({
  windowMs: httpSecurity.signupRateLimitWindowMs,
  limit: httpSecurity.signupRateLimitMax,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const forwarded = httpSecurity.rateLimitClientIpHeader
      ? String(req.get(httpSecurity.rateLimitClientIpHeader) || "").trim()
      : "";
    return ipKeyGenerator(isIP(forwarded) ? forwarded : req.ip);
  },
  handler: (_req, res) => res
    .set("cache-control", "no-store")
    .status(429)
    .json({ error: "signup_rate_limit_exceeded" }),
});

// UAD artifacts can live in a dedicated production bucket without redirecting
// Custom Appraisal documents or the shared mobile-photo workflow. The fallback
// preserves existing deployments until UAD_R2_BUCKET is configured.
const sharedObjectStorage = createUadObjectStorage();
const uadObjectStorage = createUadObjectStorage(process.env, {
  accountId: process.env.UAD_R2_ACCOUNT_ID || process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.UAD_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.UAD_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.UAD_R2_BUCKET || process.env.R2_BUCKET,
  isolated: Boolean(
    process.env.UAD_R2_BUCKET
    && process.env.UAD_R2_BUCKET !== process.env.R2_BUCKET
  ),
});
let gracefulShutdown = null;
const runtimeHealth = createRuntimeHealthHandlers({
  pool,
  isShuttingDown: () => Boolean(gracefulShutdown?.isShuttingDown()),
  artifactExecutorSnapshot: getUadArtifactExecutionSnapshot,
  securityPostureSnapshot: () => applicationAuthenticationOperationalState(
    applicationAuthenticationPolicy,
  ),
  startupInitializationSnapshot: () => startupInitialization.snapshot(),
});
const artifactRecoveryMonitor = startUadArtifactRecoveryMonitor(pool, {
  shouldRun: () => getUadArtifactExecutionSnapshot().active === 0,
});
const uadComplianceRegistry = createUadComplianceRegistry();
const documentOcrProvider = createDocumentOcrProvider();
const mobileOidcVerifier = createOidcAccessTokenVerifier({
  issuer: process.env.OIDC_ISSUER,
  audience: process.env.OIDC_AUDIENCE,
  jwksUri: process.env.OIDC_JWKS_URI,
  clockToleranceSeconds: process.env.OIDC_CLOCK_TOLERANCE_SECONDS,
  fetchTimeoutMilliseconds: process.env.OIDC_HTTP_TIMEOUT_MS,
});
const uadRouter = createUadRouter({
  pool,
  storage: uadObjectStorage,
  verifier: mobileOidcVerifier,
  compliance: uadComplianceRegistry,
  documentOcrProvider,
  enabled: environmentFlag(process.env.UAD_WORKSPACE_ENABLED),
  authenticationRequired: httpSecurity.authenticationRequired,
  security: httpSecurity,
});

const mobileRouter = createMobileRouter({
  pool,
  verifier: mobileOidcVerifier,
  storage: sharedObjectStorage,
  enabled: environmentFlag(process.env.MOBILE_INSPECTION_ENABLED),
  recentFileDays: Number(process.env.MOBILE_RECENT_FILE_DAYS || 30),
  security: httpSecurity,
});

// UAD, Custom Appraisal, Property Tax Protest, and mobile all share the same
// provisioned OIDC identity and organization membership model. The UAD/mobile
// routers authenticate themselves above; this optional middleware attaches the
// same identity to the remaining application routes whenever a bearer token is
// present. The legacy editor key is available only before mandatory unified
// authentication is activated.
const authenticateApplicationUser = createMobileAuthenticator({
  pool,
  verifier: mobileOidcVerifier,
});
mountApplicationRouteBoundary(app, {
  authenticationPolicy: applicationAuthenticationPolicy,
  webSessionAuthenticator: createWebSessionAuthenticator({ pool }),
  uadRouter,
  uadBodyParserErrorHandler,
  jsonBodyParser: express.json({ limit: "1mb" }),
  mobileRouter,
  optionalApplicationAuthenticator: createOptionalApplicationAuthenticator(
    authenticateApplicationUser,
  ),
  // Browser report pages load several independent analyses in parallel. The
  // broad limiter follows authentication so users receive independent counters.
  globalApiRateLimiterOptions,
  webAuthRouter: createWebAuthRouter({
    pool,
    verifier: webOidcVerifier,
    authenticationPolicy: applicationAuthenticationPolicy,
  }),
  buildSession: buildApplicationSession,
  loadAuthReadiness: (identity) => getApplicationAuthReadiness(pool, identity),
});

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
  await pool.query(ddl);
}
void startupInitialization
  .track("signups_schema", ensureSignupsTable, { required: false })
  .then(() => console.log("[init] app.signups ensured"))
  .catch((error) => {
    console.warn("[init] ensureSignupsTable failed (continuing)", error?.message || error);
  });

const accountLocationsReady = startupInitialization
  .track("account_locations_schema", () => ensureAccountLocationsTable(pool))
  .then(() => console.log("[init] core.account_locations ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAccountLocationsTable failed (will retry on request)",
      error?.message || error,
    );
  });

const accountQualityReady = startupInitialization
  .track("account_quality_schema", () => ensureAccountQualitySchema(pool))
  .then(() => console.log("[init] DCAD account quality schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAccountQualitySchema failed (continuing)",
      error?.message || error,
    );
  });

const appraisalRatingsReady = startupInitialization
  .track("appraisal_ratings_schema", () => ensureAppraisalRatingsSchema(pool))
  .then(() => console.log("[init] appraisal rating review schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensureAppraisalRatingsSchema failed (will retry on request)",
      error?.message || error,
    );
  });

const propertyEnrichmentReady = startupInitialization
  .track("property_enrichment_schema", () => ensurePropertyEnrichmentSchema(pool))
  .then(() => console.log("[init] non-Dallas property enrichment schema ensured"))
  .catch((error) => {
    console.warn(
      "[init] ensurePropertyEnrichmentSchema failed (will retry on request)",
      error?.message || error,
    );
  });

let assignmentFilesSchemaReady = false;
const assignmentFilesReady = startupInitialization
  .track("assignment_files_schema", () => ensureAssignmentFilesSchema(pool))
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
const customAppraisalWorkfilesReady = startupInitialization
  .track("custom_appraisal_workfiles_schema", async () => {
    await assignmentFilesReady;
    return ensureCustomAppraisalWorkfileSchema(pool);
  })
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
const assignmentDocumentsReady = startupInitialization
  .track("assignment_documents_schema", async () => {
    await assignmentFilesReady;
    return ensureAssignmentDocumentsSchema(pool);
  })
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
const propertyContextReady = startupInitialization
  .track("property_context_schema", async () => {
    await Promise.all([
      accountLocationsReady,
      assignmentFilesReady,
    ]);
    return ensurePropertyContextSchema(pool);
  })
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

const salesReconciliationReady = startupInitialization
  .track("sales_reconciliation_schema", () => ensureSalesReconciliationSchema(pool))
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
const locationBackfillReady = startupInitialization
  .track("location_backfill_schema", async () => {
    await Promise.all([
      accountLocationsReady,
      salesReconciliationReady,
    ]);
    return ensureLocationBackfillQueueSchema(pool);
  }, { required: false })
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
const censusGeographyReady = startupInitialization
  .track("census_geography_schema", async () => {
    await accountLocationsReady;
    return ensureCensusGeographySchema(pool);
  }, { required: false })
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

app.use(createOperationalRouter({
  runtimeHealth,
  pool,
  requestPerformance,
  artifactRecoveryMonitor,
  getArtifactExecutorSnapshot: getUadArtifactExecutionSnapshot,
  loadDcadScraperStatus,
  inlineWorkers: {
    censusGeography: censusGeographyInlineEnabled,
    locationBackfill: locationBackfillInlineEnabled,
  },
  documentEvidence: {
    privateObjectStorageConfigured: sharedObjectStorage.configured,
    ocrProvider: documentOcrProvider.provider,
    ocrConfigured: documentOcrProvider.configured,
  },
}));
app.use(createSignupRouter({ pool, signupRateLimiter }));
app.use(createAccountDetailRouter({
  pool,
  accountQualityReady,
  censusGeographyReady,
  propertyEnrichmentReady,
  ensurePropertyContextAvailable,
}));
app.use(createAccountPhotosRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
}));
app.use(createHousingProfileRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  requireWorkflowAccess,
}));
app.use(createReportManualValuesRouter({
  pool,
  propertyEnrichmentReady,
  requireEditor,
}));
app.use(createAssignmentFileListRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  ensureAssignmentFilesAvailable,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  authenticationRequired: applicationAuthenticationRequired,
  sharedObjectStorage,
}));

app.use(createDesktopReportFilesRouter({
  pool,
  requireWorkflowAccess,
}));
app.use(createAppraisalHistoryRouter({
  pool,
  requireWorkflowAccess,
  requireEditor,
  authenticationRequired: applicationAuthenticationRequired,
}));
app.use(createDesktopAssignmentSketchRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  ensureAssignmentFilesAvailable,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess: requireCustomAssignmentAccess,
}));
app.use(createDesktopPropertyTaxRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  requireWorkflowAccess,
  requireEditor,
  authenticationRequired: applicationAuthenticationRequired,
  ensureDocuments: ensureAssignmentDocumentsAvailable,
  documentStorage: sharedObjectStorage,
  documentOcrProvider,
}));

app.use(createAssignmentFileMutationRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  ensureAssignmentFilesAvailable,
  ensureCustomAppraisalWorkfilesAvailable,
  requireEditor,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  authenticationRequired: applicationAuthenticationRequired,
}));

app.use(createAssignmentWorkfileReadRouter({
  pool,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  objectStorage: sharedObjectStorage,
}));

app.use(createAssignmentWorkfileMutationRouter({
  pool,
  ensureCustomAppraisalWorkfilesAvailable,
  requireEditor,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  authenticationRequired: applicationAuthenticationRequired,
  objectStorage: sharedObjectStorage,
}));

function requireEditor(req, res) {
  if (req.mobileAuth) {
    if (
      hasApplicationPermission(req.mobileAuth, "custom_appraisal", "write")
      || hasApplicationPermission(req.mobileAuth, "property_tax_protest", "write")
    ) {
      return true;
    }
    res.set("cache-control", "no-store")
      .status(403)
      .json({ error: "application_access_denied" });
    return false;
  }
  if (applicationAuthenticationRequired) {
    res.set("cache-control", "no-store")
      .status(401)
      .json({ error: "authentication_required" });
    return false;
  }
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

app.use(createGeographyOperationsRouter({
  pool,
  locationBackfillReady,
  censusGeographyReady,
  accountQualityReady,
  requireEditor,
}));

app.use(createSalesReconciliationRouter({
  pool,
  salesReconciliationReady,
  locationBackfillReady,
  requireEditor,
  ensurePropertyContextAvailable,
}));

app.use(createSaleReviewRouter({
  pool,
  ratingsReady: appraisalRatingsReady,
  requireEditor,
}));

app.use(createAppraisalRatingsRouter({
  pool,
  ratingsReady: appraisalRatingsReady,
  accountIdAllowed: legacyAccountIdAllowed,
  requireEditor,
}));

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

app.use(createEnrichmentReadRouter({
  pool,
  propertyEnrichmentReady,
  trestleClient,
  getNonDallasAccount,
}));

app.use(createEnrichmentMutationRouter({
  pool,
  propertyEnrichmentReady,
  trestleClient,
  getNonDallasAccount,
  requireEditor,
}));

app.use(createMarketValueHistoryRouter({ pool }));

app.use(createPropertySearchRouter({
  pool,
  accountQualityReady,
  salesReconciliationReady,
}));

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
    if (!legacyAccountIdAllowed(subjectAccountId)) {
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
    const {
      recommendedSales,
      secondarySales,
      olderThanOneYearCount,
      olderThanTwoYearsCount,
    } = summarizeComparableResults(analyzedSales);

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
        older_than_two_years_count: olderThanTwoYearsCount,
        older_than_one_year_count: olderThanOneYearCount,
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

app.use(createSalesListRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  distanceSqlBuilder: greatCircleDistanceMilesSql,
}));

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
    if (!legacyAccountIdAllowed(subjectAccountId)) {
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
            COALESCE(
              sale.mls_pool_yn,
              CASE
                WHEN lower(btrim(sale.cad_pool::text))
                  IN ('true', 't', 'yes', 'y', '1') THEN true
                WHEN lower(btrim(sale.cad_pool::text))
                  IN ('false', 'f', 'no', 'n', '0', '') THEN false
                ELSE NULL
              END
            ) AS pool_yn,
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

app.use(createComparisonStudyRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
}));

app.use(createRelatedParcelsRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
}));

app.use(createValuationStudyRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
}));

app.use(createNeighborhoodAnalysisRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
}));

app.use(createPropertyContextStatusRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
}));

app.use(createNeighborhoodRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
}));

app.use(createAccountPropertyContextRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
}));

app.use(createZoningRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
  requireWorkflowAccess,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  authenticationRequired: applicationAuthenticationRequired,
}));

async function requireCustomAssignmentAccess(req, res, accountId, assignmentFileId, permission) {
  if (!applicationAuthenticationRequired) return true;
  if (req.mobileAuth) {
    try {
      await authorizeCustomAssignmentFile(pool, req.mobileAuth, {
        accountId,
        assignmentFileId,
        permission,
      });
      return true;
    } catch (error) {
      const notFound = error?.message === "assignment_file_not_found";
      res.set("cache-control", "no-store").status(notFound ? 404 : 403).json({
        error: notFound ? "assignment_file_not_found" : "assignment_file_access_denied",
      });
      return false;
    }
  }
  res.set("cache-control", "no-store").status(401).json({ error: "authentication_required" });
  return false;
}

function requireWorkflowAccess(req, res, workflow, permission) {
  if (req.mobileAuth) {
    if (hasApplicationPermission(req.mobileAuth, workflow, permission)) return true;
    res.set("cache-control", "no-store")
      .status(403)
      .json({ error: "application_access_denied" });
    return false;
  }
  if (applicationAuthenticationRequired) {
    res.set("cache-control", "no-store")
      .status(401)
      .json({ error: "authentication_required" });
    return false;
  }
  const configuredEditorKey = String(process.env.HOMENODE_EDITOR_KEY || "");
  if (configuredEditorKey && editorKeyMatches(req.get("x-homenode-editor-key"), configuredEditorKey)) {
    return true;
  }
  if (!applicationAuthenticationRequired) return true;
  res.set("cache-control", "no-store");
  res.status(req.mobileAuth ? 403 : 401).json({
    error: req.mobileAuth ? "application_access_denied" : "authentication_required",
  });
  return false;
}

app.use(createAssignmentPhotoRouter({
  pool,
  objectStorage: sharedObjectStorage,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess: requireCustomAssignmentAccess,
}));

app.use(createAssignmentDocumentRouter({
  pool,
  objectStorage: sharedObjectStorage,
  ensureAvailable: ensureAssignmentDocumentsAvailable,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  authenticationRequired: applicationAuthenticationRequired,
  ocrProvider: documentOcrProvider,
}));

app.use(createSalesMediaRouter({ pool }));

app.use(createPropertyCatalogRouter({ pool }));

const applicationHttpLifecycle = startApplicationHttpLifecycle({
  app,
  pool,
  runtimeResilience,
  finalErrorHandler: jsonErrorHandler,
  artifactRecoveryMonitor,
  closeArtifactExecution: closeUadArtifactExecution,
});
gracefulShutdown = applicationHttpLifecycle.gracefulShutdown;
