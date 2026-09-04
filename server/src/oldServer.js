import "dotenv/config";
import { isIP } from "node:net";
import express from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import pg from "pg";
import { greatCircleDistanceMilesSql } from "./services/geospatialSql.js";
import { TrestleClient } from "./services/trestleClient.js";
import {
  assertNonDallasEnrichmentCounty,
} from "./util/nonDallasEnrichment.js";
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
} from "./security/applicationAccess.js";
import {
  applicationAuthenticationOperationalState,
  assertApplicationAuthenticationStartup,
  createApplicationAuthenticationPolicy,
} from "./security/applicationAuthenticationPolicy.js";
import { getApplicationAuthReadiness } from "./security/applicationAuthReadiness.js";
import { createWebAuthRouter, createWebSessionAuthenticator } from "./security/webAuth.js";
import { createApplicationAccessGuards } from "./security/applicationAccessGuards.js";
import {
  createRuntimeResilienceConfiguration,
} from "./security/runtimeResilience.js";
import { startApplicationHttpLifecycle } from "./application/httpLifecycle.js";
import { createApplicationStartupResources } from "./application/startupResources.js";
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
  // UAD and mobile own stricter route-local limiters and response headers.
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
  clientId: process.env.OIDC_CLIENT_ID,
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

// Attach the shared OIDC identity to remaining routes before enforcing access.
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
  // Browser reports load in parallel; limit authenticated users independently.
  globalApiRateLimiterOptions,
  webAuthRouter: createWebAuthRouter({
    pool,
    verifier: webOidcVerifier,
    authenticationPolicy: applicationAuthenticationPolicy,
    rateLimiterOptions: globalApiRateLimiterOptions,
  }),
  buildSession: buildApplicationSession,
  loadAuthReadiness: (identity) => getApplicationAuthReadiness(pool, identity),
});

const trestleClient = new TrestleClient();

const {
  accountLocationsReady,
  accountQualityReady,
  appraisalRatingsReady,
  propertyEnrichmentReady,
  salesReconciliationReady,
  locationBackfillReady,
  censusGeographyReady,
  ensureAssignmentFilesAvailable,
  ensureCustomAppraisalWorkfilesAvailable,
  ensureAssignmentDocumentsAvailable,
  ensurePropertyContextAvailable,
  locationBackfillInlineEnabled,
  censusGeographyInlineEnabled,
} = createApplicationStartupResources({
  pool,
  startupInitialization,
});
const {
  requireEditor,
  requirePlatformAdministrator,
  requireCustomAssignmentAccess,
  requireCustomAccountScope,
  requirePropertyTaxAccountScope,
  requireWorkflowAccess,
} = createApplicationAccessGuards({
  pool,
  authenticationRequired: applicationAuthenticationRequired,
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
  authenticationRequired: applicationAuthenticationRequired,
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
  ensureCustomAppraisalWorkfilesAvailable,
  requireEditor,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  authenticationRequired: applicationAuthenticationRequired,
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

app.use(createGeographyOperationsRouter({
  pool,
  locationBackfillReady,
  censusGeographyReady,
  accountQualityReady,
  requireEditor,
  requirePlatformAdministrator,
}));

app.use(createSalesReconciliationRouter({
  pool,
  salesReconciliationReady,
  locationBackfillReady,
  requirePlatformAdministrator,
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
  requireCustomAccountScope,
  requirePropertyTaxAccountScope,
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
  requireCustomAccountScope,
}));

app.use(createRelatedParcelsRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  requireCustomAccountScope,
}));

app.use(createValuationStudyRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  requireCustomAccountScope,
}));

app.use(createNeighborhoodAnalysisRouter({
  pool,
  accountIdAllowed: legacyAccountIdAllowed,
  requireCustomAccountScope,
}));

app.use(createPropertyContextStatusRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
  requirePlatformAdministrator,
}));

app.use(createNeighborhoodRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
}));

app.use(createAccountPropertyContextRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
  requireWorkflowAccess,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  authenticationRequired: applicationAuthenticationRequired,
}));

app.use(createZoningRouter({
  pool,
  ensureAvailable: ensurePropertyContextAvailable,
  requireWorkflowAccess,
  requireAssignmentAccess: requireCustomAssignmentAccess,
  authenticationRequired: applicationAuthenticationRequired,
}));

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
  requestPerformance,
});
gracefulShutdown = applicationHttpLifecycle.gracefulShutdown;
