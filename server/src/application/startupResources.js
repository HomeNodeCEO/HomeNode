import { ensureAccountLocationsTable } from "../services/accountLocations.js";
import { ensureAccountQualitySchema } from "../services/accountQuality.js";
import { ensureAppraisalRatingsSchema } from "../services/appraisalRatings.js";
import {
  ensureCensusGeographySchema,
  startCensusGeographyWorker,
} from "../services/censusGeography.js";
import { ensureAssignmentDocumentsSchema } from "../services/assignmentDocuments.js";
import { ensureAssignmentFilesSchema } from "../services/assignmentFiles.js";
import { ensureCustomAppraisalWorkfileSchema } from "../services/customAppraisalWorkfiles.js";
import {
  ensureLocationBackfillQueueSchema,
  startLocationBackfillWorker,
} from "../services/locationBackfillQueue.js";
import { ensurePropertyContextSchema } from "../services/propertyContextStore.js";
import { ensurePropertyEnrichmentSchema } from "../services/propertyEnrichment.js";
import { ensureSalesReconciliationSchema } from "../services/salesReconciliation.js";
import { environmentFlag } from "../util/requestPerformance.js";

const defaultDependencies = Object.freeze({
  ensureAccountLocationsTable,
  ensureAccountQualitySchema,
  ensureAppraisalRatingsSchema,
  ensureAssignmentDocumentsSchema,
  ensureAssignmentFilesSchema,
  ensureCensusGeographySchema,
  ensureCustomAppraisalWorkfileSchema,
  ensureLocationBackfillQueueSchema,
  ensurePropertyContextSchema,
  ensurePropertyEnrichmentSchema,
  ensureSalesReconciliationSchema,
  startCensusGeographyWorker,
  startLocationBackfillWorker,
});

function assertStartupResourceOptions(pool, startupInitialization) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("startup_resources_pool_required");
  }
  if (!startupInitialization || typeof startupInitialization.track !== "function") {
    throw new TypeError("startup_resources_registry_required");
  }
}

export function createApplicationStartupResources({
  pool,
  startupInitialization,
  environment = process.env,
  logger = console,
  dependencies: dependencyOverrides = {},
} = {}) {
  assertStartupResourceOptions(pool, startupInitialization);
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  async function ensureSignupsTable() {
    const ddl = `
      CREATE SCHEMA IF NOT EXISTS app;
      CREATE TABLE IF NOT EXISTS app.signups (
        id              bigserial PRIMARY KEY,
        created_at      timestamptz NOT NULL DEFAULT now(),
        source          text,
        account_id      text,
        owner_name      text NOT NULL,
        owner_telephone text NOT NULL,
        owner_email     text,
        user_agent      text,
        ip              text,
        meta            jsonb
      );
      ALTER TABLE app.signups
        ADD COLUMN IF NOT EXISTS submission_id uuid,
        ADD COLUMN IF NOT EXISTS property_tax_file_id uuid,
        ADD COLUMN IF NOT EXISTS organization_id uuid,
        ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid,
        ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'legacy_unverified',
        ADD COLUMN IF NOT EXISTS signer_printed_name text,
        ADD COLUMN IF NOT EXISTS signer_title text,
        ADD COLUMN IF NOT EXISTS signer_role text,
        ADD COLUMN IF NOT EXISTS signature_sha256 text,
        ADD COLUMN IF NOT EXISTS signature_png bytea,
        ADD COLUMN IF NOT EXISTS authorization_sha256 text,
        ADD COLUMN IF NOT EXISTS attestation_accepted_at timestamptz;
      CREATE UNIQUE INDEX IF NOT EXISTS signups_submission_id_uidx
        ON app.signups (submission_id)
        WHERE submission_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS signups_property_tax_file_created_idx
        ON app.signups (property_tax_file_id, created_at DESC, id DESC)
        WHERE property_tax_file_id IS NOT NULL;
    `;
    await pool.query(ddl);
  }

  const signupsReady = startupInitialization
    .track("signups_schema", ensureSignupsTable, { required: false })
    .then(() => logger.log("[init] app.signups ensured"))
    .catch((error) => {
      logger.warn("[init] ensureSignupsTable failed (continuing)", error?.message || error);
    });

  const accountLocationsReady = startupInitialization
    .track("account_locations_schema", () => dependencies.ensureAccountLocationsTable(pool))
    .then(() => logger.log("[init] core.account_locations ensured"))
    .catch((error) => {
      logger.warn(
        "[init] ensureAccountLocationsTable failed (will retry on request)",
        error?.message || error,
      );
    });

  const accountQualityReady = startupInitialization
    .track("account_quality_schema", () => dependencies.ensureAccountQualitySchema(pool))
    .then(() => logger.log("[init] DCAD account quality schema ensured"))
    .catch((error) => {
      logger.warn(
        "[init] ensureAccountQualitySchema failed (continuing)",
        error?.message || error,
      );
    });

  const appraisalRatingsReady = startupInitialization
    .track("appraisal_ratings_schema", () => dependencies.ensureAppraisalRatingsSchema(pool))
    .then(() => logger.log("[init] appraisal rating review schema ensured"))
    .catch((error) => {
      logger.warn(
        "[init] ensureAppraisalRatingsSchema failed (will retry on request)",
        error?.message || error,
      );
    });

  const propertyEnrichmentReady = startupInitialization
    .track("property_enrichment_schema", () => dependencies.ensurePropertyEnrichmentSchema(pool))
    .then(() => logger.log("[init] non-Dallas property enrichment schema ensured"))
    .catch((error) => {
      logger.warn(
        "[init] ensurePropertyEnrichmentSchema failed (will retry on request)",
        error?.message || error,
      );
    });

  let assignmentFilesSchemaReady = false;
  const assignmentFilesReady = startupInitialization
    .track("assignment_files_schema", () => dependencies.ensureAssignmentFilesSchema(pool))
    .then(() => {
      assignmentFilesSchemaReady = true;
      logger.log("[init] appraisal assignment file schema ensured");
    })
    .catch((error) => {
      logger.warn(
        "[init] ensureAssignmentFilesSchema failed (will retry on request)",
        error?.message || error,
      );
    });

  async function ensureAssignmentFilesAvailable() {
    await assignmentFilesReady;
    if (!assignmentFilesSchemaReady) {
      await dependencies.ensureAssignmentFilesSchema(pool);
      assignmentFilesSchemaReady = true;
    }
  }

  let customAppraisalWorkfilesSchemaReady = false;
  const customAppraisalWorkfilesReady = startupInitialization
    .track("custom_appraisal_workfiles_schema", async () => {
      await assignmentFilesReady;
      return dependencies.ensureCustomAppraisalWorkfileSchema(pool);
    })
    .then(() => {
      customAppraisalWorkfilesSchemaReady = true;
      logger.log("[init] custom appraisal workfile schema ensured");
    })
    .catch((error) => {
      logger.warn(
        "[init] custom appraisal workfile schema failed (will retry on request)",
        error?.message || error,
      );
    });

  async function ensureCustomAppraisalWorkfilesAvailable() {
    await customAppraisalWorkfilesReady;
    if (!customAppraisalWorkfilesSchemaReady) {
      await ensureAssignmentFilesAvailable();
      await dependencies.ensureCustomAppraisalWorkfileSchema(pool);
      customAppraisalWorkfilesSchemaReady = true;
    }
  }

  let assignmentDocumentsSchemaReady = false;
  const assignmentDocumentsReady = startupInitialization
    .track("assignment_documents_schema", async () => {
      await assignmentFilesReady;
      return dependencies.ensureAssignmentDocumentsSchema(pool);
    })
    .then(() => {
      assignmentDocumentsSchemaReady = true;
      logger.log("[init] assignment document evidence schema ensured");
    })
    .catch((error) => {
      logger.warn(
        "[init] assignment document evidence schema failed (will retry on request)",
        error?.message || error,
      );
    });

  async function ensureAssignmentDocumentsAvailable() {
    await assignmentDocumentsReady;
    if (!assignmentDocumentsSchemaReady) {
      await dependencies.ensureAssignmentDocumentsSchema(pool);
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
      return dependencies.ensurePropertyContextSchema(pool);
    })
    .then(() => {
      propertyContextSchemaReady = true;
      logger.log("[init] offline property-context schema ensured");
    })
    .catch((error) => {
      logger.warn(
        "[init] property-context schema failed (will retry on request)",
        error?.message || error,
      );
    });

  async function ensurePropertyContextAvailable() {
    await propertyContextReady;
    if (!propertyContextSchemaReady) {
      await dependencies.ensurePropertyContextSchema(pool);
      propertyContextSchemaReady = true;
    }
  }

  const salesReconciliationReady = startupInitialization
    .track("sales_reconciliation_schema", () => dependencies.ensureSalesReconciliationSchema(pool))
    .then(() => logger.log("[init] sales reconciliation schema ensured"))
    .catch((error) => {
      logger.warn(
        "[init] ensureSalesReconciliationSchema failed (will retry on request)",
        error?.message || error,
      );
    });

  let locationBackfillWorker = null;
  const locationBackfillInlineEnabled = environmentFlag(
    environment.LOCATION_BACKFILL_ENABLED,
  );
  const locationBackfillReady = startupInitialization
    .track("location_backfill_schema", async () => {
      await Promise.all([
        accountLocationsReady,
        salesReconciliationReady,
      ]);
      return dependencies.ensureLocationBackfillQueueSchema(pool);
    }, { required: false })
    .then(() => {
      logger.log("[init] location backfill queue ensured");
      if (locationBackfillInlineEnabled) {
        locationBackfillWorker = dependencies.startLocationBackfillWorker(pool, {
          intervalMs: environment.LOCATION_BACKFILL_INTERVAL_MS,
          seedIntervalMs: environment.LOCATION_BACKFILL_SEED_INTERVAL_MS,
          initialDelayMs: environment.LOCATION_BACKFILL_INITIAL_DELAY_MS,
          batchSize: environment.LOCATION_BACKFILL_BATCH_SIZE,
          seedLimit: environment.LOCATION_BACKFILL_SEED_LIMIT,
          maximumAttempts: environment.LOCATION_BACKFILL_MAX_ATTEMPTS,
        });
        logger.log(
          `[init] location backfill worker started (${locationBackfillWorker.workerId})`,
        );
      } else {
        logger.log("[init] location backfill worker disabled; use scheduled maintenance");
      }
    })
    .catch((error) => {
      logger.warn(
        "[init] location backfill queue failed (will retry on request)",
        error?.message || error,
      );
    });

  let censusGeographyWorker = null;
  const censusGeographyInlineEnabled = environmentFlag(
    environment.CENSUS_GEOGRAPHY_ENABLED,
  );
  const censusGeographyReady = startupInitialization
    .track("census_geography_schema", async () => {
      await accountLocationsReady;
      return dependencies.ensureCensusGeographySchema(pool);
    }, { required: false })
    .then(() => {
      logger.log("[init] census geography schema ensured");
      if (censusGeographyInlineEnabled) {
        censusGeographyWorker = dependencies.startCensusGeographyWorker(pool, {
          intervalMs: environment.CENSUS_GEOGRAPHY_INTERVAL_MS,
          seedIntervalMs: environment.CENSUS_GEOGRAPHY_SEED_INTERVAL_MS,
          initialDelayMs: environment.CENSUS_GEOGRAPHY_INITIAL_DELAY_MS,
          batchSize: environment.CENSUS_GEOGRAPHY_BATCH_SIZE,
          seedLimit: environment.CENSUS_GEOGRAPHY_SEED_LIMIT,
          maximumAttempts: environment.CENSUS_GEOGRAPHY_MAX_ATTEMPTS,
        });
        logger.log(
          `[init] census geography worker started (${censusGeographyWorker.workerId})`,
        );
      } else {
        logger.log("[init] census geography worker disabled; use scheduled maintenance");
      }
    })
    .catch((error) => {
      logger.warn(
        "[init] census geography initialization failed (will retry on request)",
        error?.message || error,
      );
    });

  return Object.freeze({
    signupsReady,
    accountLocationsReady,
    accountQualityReady,
    appraisalRatingsReady,
    propertyEnrichmentReady,
    assignmentFilesReady,
    customAppraisalWorkfilesReady,
    assignmentDocumentsReady,
    propertyContextReady,
    salesReconciliationReady,
    locationBackfillReady,
    censusGeographyReady,
    ensureAssignmentFilesAvailable,
    ensureCustomAppraisalWorkfilesAvailable,
    ensureAssignmentDocumentsAvailable,
    ensurePropertyContextAvailable,
    locationBackfillInlineEnabled,
    censusGeographyInlineEnabled,
  });
}
