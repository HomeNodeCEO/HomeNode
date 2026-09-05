import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createApplicationStartupResources } from "../src/application/startupResources.js";
import { createStartupInitializationRegistry } from "../src/security/startupInitialization.js";

function createDependencies(overrides = {}) {
  return {
    ensureAccountLocationsTable: async () => {},
    ensureAccountQualitySchema: async () => {},
    ensureAppraisalRatingsSchema: async () => {},
    ensureAssignmentDocumentsSchema: async () => {},
    ensureAssignmentFilesSchema: async () => {},
    ensureCensusGeographySchema: async () => {},
    ensureCustomAppraisalWorkfileSchema: async () => {},
    ensureLocationBackfillQueueSchema: async () => {},
    ensurePropertyContextSchema: async () => {},
    ensurePropertyEnrichmentSchema: async () => {},
    ensureSalesReconciliationSchema: async () => {},
    startCensusGeographyWorker: () => ({ workerId: "census-test" }),
    startLocationBackfillWorker: () => ({ workerId: "locations-test" }),
    ...overrides,
  };
}

function createLogger() {
  const messages = [];
  return {
    messages,
    log: (...values) => messages.push(["log", ...values]),
    warn: (...values) => messages.push(["warn", ...values]),
  };
}

function startupPromises(resources) {
  return [
    resources.signupsReady,
    resources.accountLocationsReady,
    resources.accountQualityReady,
    resources.appraisalRatingsReady,
    resources.propertyEnrichmentReady,
    resources.assignmentFilesReady,
    resources.customAppraisalWorkfilesReady,
    resources.assignmentDocumentsReady,
    resources.propertyContextReady,
    resources.salesReconciliationReady,
    resources.locationBackfillReady,
    resources.censusGeographyReady,
  ];
}

test("application startup resources register the complete readiness inventory", async () => {
  const startupInitialization = createStartupInitializationRegistry();
  const databaseCalls = [];
  const resources = createApplicationStartupResources({
    pool: {
      query: async (statement) => databaseCalls.push(statement),
    },
    startupInitialization,
    environment: {},
    logger: createLogger(),
    dependencies: createDependencies(),
  });

  await Promise.all(startupPromises(resources));

  assert.equal(databaseCalls.length, 1);
  assert.match(databaseCalls[0], /CREATE TABLE IF NOT EXISTS app\.signups/);
  assert.match(databaseCalls[0], /ADD COLUMN IF NOT EXISTS submission_id uuid/);
  assert.match(databaseCalls[0], /ADD COLUMN IF NOT EXISTS property_tax_file_id uuid/);
  assert.match(databaseCalls[0], /ADD COLUMN IF NOT EXISTS signature_png bytea/);
  assert.match(databaseCalls[0], /signups_submission_id_uidx/);
  assert.deepEqual(startupInitialization.snapshot(), {
    status: "ready",
    required: {
      ready: [
        "account_locations_schema",
        "account_quality_schema",
        "appraisal_ratings_schema",
        "property_enrichment_schema",
        "assignment_files_schema",
        "custom_appraisal_workfiles_schema",
        "assignment_documents_schema",
        "property_context_schema",
        "sales_reconciliation_schema",
      ],
      pending: [],
      failed: [],
    },
    optional: {
      ready: [
        "signups_schema",
        "location_backfill_schema",
        "census_geography_schema",
      ],
      pending: [],
      failed: [],
    },
  });
  assert.equal(resources.locationBackfillInlineEnabled, false);
  assert.equal(resources.censusGeographyInlineEnabled, false);
});

test("dependent startup resources preserve their schema ordering", async () => {
  const events = [];
  const mark = (name) => async () => {
    events.push(name);
  };
  const resources = createApplicationStartupResources({
    pool: { query: mark("signups") },
    startupInitialization: createStartupInitializationRegistry(),
    environment: {},
    logger: createLogger(),
    dependencies: createDependencies({
      ensureAccountLocationsTable: mark("account-locations"),
      ensureAssignmentFilesSchema: mark("assignment-files"),
      ensureAssignmentDocumentsSchema: mark("assignment-documents"),
      ensureCustomAppraisalWorkfileSchema: mark("custom-workfiles"),
      ensurePropertyContextSchema: mark("property-context"),
      ensureSalesReconciliationSchema: mark("sales-reconciliation"),
      ensureLocationBackfillQueueSchema: mark("location-backfill"),
      ensureCensusGeographySchema: mark("census-geography"),
    }),
  });

  await Promise.all(startupPromises(resources));

  const before = (dependency, consumer) => {
    assert.ok(
      events.indexOf(dependency) < events.indexOf(consumer),
      `${dependency} should initialize before ${consumer}`,
    );
  };
  before("assignment-files", "assignment-documents");
  before("assignment-files", "custom-workfiles");
  before("assignment-files", "property-context");
  before("account-locations", "property-context");
  before("account-locations", "location-backfill");
  before("account-locations", "census-geography");
  before("sales-reconciliation", "location-backfill");
});

test("failed assignment initialization remains visible and retries on demand", async () => {
  let assignmentAttempts = 0;
  const startupInitialization = createStartupInitializationRegistry();
  const logger = createLogger();
  const resources = createApplicationStartupResources({
    pool: { query: async () => {} },
    startupInitialization,
    environment: {},
    logger,
    dependencies: createDependencies({
      ensureAssignmentFilesSchema: async () => {
        assignmentAttempts += 1;
        if (assignmentAttempts === 1) throw new Error("private database diagnostic");
      },
    }),
  });

  await Promise.all(startupPromises(resources));
  assert.deepEqual(startupInitialization.snapshot().required.failed, [
    "assignment_files_schema",
  ]);
  assert.doesNotMatch(
    JSON.stringify(startupInitialization.snapshot()),
    /private|database|diagnostic/i,
  );

  await resources.ensureAssignmentFilesAvailable();
  await resources.ensureAssignmentFilesAvailable();
  assert.equal(assignmentAttempts, 2);
  assert.ok(logger.messages.some((entry) => entry[0] === "warn"));
});

test("inline workers receive the established bounded environment settings", async () => {
  const workerCalls = [];
  const environment = {
    LOCATION_BACKFILL_ENABLED: "true",
    LOCATION_BACKFILL_INTERVAL_MS: "101",
    LOCATION_BACKFILL_SEED_INTERVAL_MS: "102",
    LOCATION_BACKFILL_INITIAL_DELAY_MS: "103",
    LOCATION_BACKFILL_BATCH_SIZE: "104",
    LOCATION_BACKFILL_SEED_LIMIT: "105",
    LOCATION_BACKFILL_MAX_ATTEMPTS: "106",
    CENSUS_GEOGRAPHY_ENABLED: "true",
    CENSUS_GEOGRAPHY_INTERVAL_MS: "201",
    CENSUS_GEOGRAPHY_SEED_INTERVAL_MS: "202",
    CENSUS_GEOGRAPHY_INITIAL_DELAY_MS: "203",
    CENSUS_GEOGRAPHY_BATCH_SIZE: "204",
    CENSUS_GEOGRAPHY_SEED_LIMIT: "205",
    CENSUS_GEOGRAPHY_MAX_ATTEMPTS: "206",
  };
  const resources = createApplicationStartupResources({
    pool: { query: async () => {} },
    startupInitialization: createStartupInitializationRegistry(),
    environment,
    logger: createLogger(),
    dependencies: createDependencies({
      startLocationBackfillWorker: (_pool, options) => {
        workerCalls.push(["locations", options]);
        return { workerId: "locations-test" };
      },
      startCensusGeographyWorker: (_pool, options) => {
        workerCalls.push(["census", options]);
        return { workerId: "census-test" };
      },
    }),
  });

  await Promise.all(startupPromises(resources));

  assert.equal(resources.locationBackfillInlineEnabled, true);
  assert.equal(resources.censusGeographyInlineEnabled, true);
  assert.deepEqual(Object.fromEntries(workerCalls), {
    locations: {
      intervalMs: "101",
      seedIntervalMs: "102",
      initialDelayMs: "103",
      batchSize: "104",
      seedLimit: "105",
      maximumAttempts: "106",
    },
    census: {
      intervalMs: "201",
      seedIntervalMs: "202",
      initialDelayMs: "203",
      batchSize: "204",
      seedLimit: "205",
      maximumAttempts: "206",
    },
  });
});

test("startup resources reject incomplete application composition", () => {
  assert.throws(
    () => createApplicationStartupResources(),
    /startup_resources_pool_required/,
  );
  assert.throws(
    () => createApplicationStartupResources({ pool: { query() {} } }),
    /startup_resources_registry_required/,
  );
});

test("the entrypoint delegates startup readiness without changing router dependencies", () => {
  const entrypoint = readFileSync(
    new URL("../src/oldServer.js", import.meta.url),
    "utf8",
  );
  assert.match(entrypoint, /createApplicationStartupResources\(\{\s*pool,\s*startupInitialization,/);
  assert.match(
    entrypoint,
    /accountLocationsReady,[\s\S]*?accountQualityReady,[\s\S]*?appraisalRatingsReady,[\s\S]*?propertyEnrichmentReady,[\s\S]*?salesReconciliationReady,[\s\S]*?locationBackfillReady,[\s\S]*?censusGeographyReady,/,
  );
  assert.doesNotMatch(entrypoint, /\.track\("(?:signups|account_locations|assignment_files)_schema"/);
});
