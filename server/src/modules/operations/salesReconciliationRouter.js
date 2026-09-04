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
      logger.error?.("sales reconciliation queue failed", error);
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
          locationError?.message || locationError,
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
        message === "ambiguous_collin_account_id"
        || message === "county_account_identifier_conflict"
      ) {
        status = 409;
      } else if (
        String(message).startsWith("invalid_")
        || message === "source_record_not_closed_sale"
        || message === "account_county_mismatch"
        || message === "account_identifier_mismatch"
      ) {
        status = 400;
      }
      if (status === 500) logger.error?.("sales reconciliation failed", error);
      return res.status(status).json({ error: message });
    }
  });

  return router;
}
