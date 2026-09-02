import "dotenv/config";
import { isIP } from "node:net";
import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import pg from "pg";
import { ensureAccountLocationsTable } from "./services/accountLocations.js";
import {
  ensureLocationBackfillQueueSchema,
  startLocationBackfillWorker,
} from "./services/locationBackfillQueue.js";
import { ensureAccountQualitySchema } from "./services/accountQuality.js";
import { editorKeyMatches } from "./util/housingProfileEdit.js";
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
import { createComparableRecommendationsRouter } from "./modules/sales/comparableRecommendationsRouter.js";
import { createGroupedAnalysisRouter } from "./modules/sales/groupedAnalysisRouter.js";
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

app.use(createComparableRecommendationsRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  locationsReady: accountLocationsReady,
  enrichmentReady: propertyEnrichmentReady,
  backfillReady: locationBackfillReady,
  distanceSqlBuilder: greatCircleDistanceMilesSql,
}));

app.use(createSalesListRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  distanceSqlBuilder: greatCircleDistanceMilesSql,
}));

app.use(createGroupedAnalysisRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  locationsReady: accountLocationsReady,
}));

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
