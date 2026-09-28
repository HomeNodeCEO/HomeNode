import express from "express";

import {
  enqueueLocationBackfillAccounts,
  ensureLocationBackfillQueueSchema,
} from "../../services/locationBackfillQueue.js";
import { enqueuePropertyInfluenceAccounts } from "../../services/propertyInfluenceStore.js";
import {
  listSalesReconciliationQueue,
  reconcileSalesSourceRecord,
} from "../../services/salesReconciliation.js";
import { safeOperationalErrorCode } from "../../security/safeOperationalErrorCode.js";
import { PaginationError } from "../../util/pagination.js";

const PUBLIC_RECONCILIATION_ERRORS = new Map([
  ["source_record_not_found", 404],
  ["account_not_found", 404],
  ["ambiguous_collin_account_id", 409],
  ["county_account_identifier_conflict", 409],
  ["source_record_already_verified", 409],
  ["source_record_not_reconcilable", 409],
  ["invalid_account_id", 400],
  ["invalid_dallas_account_id", 400],
  ["invalid_collin_account_id", 400],
  ["invalid_source_record_id", 400],
  ["source_record_not_closed_sale", 400],
  ["account_county_mismatch", 400],
  ["account_identifier_mismatch", 400],
]);

export function createSalesReconciliationRouter({
  pool,
  salesReconciliationReady,
  locationBackfillReady,
  requirePlatformAdministrator,
  ensurePropertyContextAvailable,
  listQueue = listSalesReconciliationQueue,
  reconcileSourceRecord = reconcileSalesSourceRecord,
  ensureLocationSchema = ensureLocationBackfillQueueSchema,
  enqueueLocationAccounts = enqueueLocationBackfillAccounts,
  enqueueInfluenceAccounts = enqueuePropertyInfluenceAccounts,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("sales_reconciliation_pool_required");
  }
  if (!salesReconciliationReady || typeof salesReconciliationReady.then !== "function") {
    throw new TypeError("sales_reconciliation_readiness_required");
  }
  if (!locationBackfillReady || typeof locationBackfillReady.then !== "function") {
    throw new TypeError("sales_reconciliation_location_readiness_required");
  }
  if (typeof requirePlatformAdministrator !== "function") {
    throw new TypeError("sales_reconciliation_platform_admin_policy_required");
  }
  if (
    typeof ensurePropertyContextAvailable !== "function"
    || typeof listQueue !== "function"
    || typeof reconcileSourceRecord !== "function"
    || typeof ensureLocationSchema !== "function"
    || typeof enqueueLocationAccounts !== "function"
    || typeof enqueueInfluenceAccounts !== "function"
  ) {
    throw new TypeError("sales_reconciliation_dependency_required");
  }

  const router = express.Router();

  /** Unmatched closed sales remain visible until a user verifies their CAD account. */
  router.get("/api/sales/reconciliation-queue", async (req, res) => {
    if (!requirePlatformAdministrator(req, res)) return undefined;
    try {
      await salesReconciliationReady;
      const queue = await listQueue(pool, {
        limit: req.query.limit,
        offset: req.query.offset,
      });
      return res.json(queue);
    } catch (error) {
      if (error instanceof PaginationError) return res.status(400).json({ error: error.message });
      logger.error?.("sales reconciliation queue failed", safeOperationalErrorCode(error));
      return res.status(500).json({ error: "sales_reconciliation_queue_failed" });
    }
  });

  /** Explicitly verify a sale-to-account link and upsert the canonical sale. */
  router.patch("/api/sales/:sourceRecordId/reconcile", async (req, res) => {
    if (!requirePlatformAdministrator(req, res)) return undefined;
    try {
      await salesReconciliationReady;
      const result = await reconcileSourceRecord(
        pool,
        req.params.sourceRecordId,
        req.body,
        {
          reviewer: req.mobileAuth?.displayName
            || req.mobileAuth?.email
            || req.mobileAuth?.userId
            || "HomeNode platform administrator",
        },
      );
      try {
        await locationBackfillReady;
        await ensureLocationSchema(pool);
        await enqueueLocationAccounts(
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
        logger.warn?.(
          "manual sale link saved; location queueing deferred",
          safeOperationalErrorCode(locationError),
        );
      }
      try {
        await ensurePropertyContextAvailable();
        await enqueueInfluenceAccounts(
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
        logger.warn?.(
          "manual sale link saved; influence queueing deferred",
          safeOperationalErrorCode(influenceError),
        );
      }
      return res.json({ ok: true, ...result });
    } catch (error) {
      const message = error?.message || "sales_reconciliation_failed";
      const status = PUBLIC_RECONCILIATION_ERRORS.get(message) || 500;
      if (status === 500) logger.error?.("sales reconciliation failed", safeOperationalErrorCode(error));
      return res.status(status).json({ error: status === 500 ? "sales_reconciliation_failed" : message });
    }
  });

  return router;
}
