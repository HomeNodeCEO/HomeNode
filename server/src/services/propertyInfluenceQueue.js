import { refreshStoredPropertyInfluenceContext } from "./propertyContext.js";
import {
  ensurePropertyContextSchema,
  getPropertyContextSourceHealth,
} from "./propertyContextStore.js";
import {
  claimPropertyInfluenceQueue,
  completePropertyInfluenceQueueItem,
  failPropertyInfluenceQueueItem,
  getPropertyInfluenceStatus,
  recoverStalePropertyInfluenceClaims,
  seedPropertyInfluenceQueue,
} from "./propertyInfluenceStore.js";

export async function runWithConcurrency(items, concurrency, worker) {
  const safeConcurrency = Math.max(1, Math.min(Number(concurrency) || 1, items.length || 1));
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: safeConcurrency }, () => runWorker()));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

/**
 * Give each spatial fingerprint an independent database timeout. A malformed
 * parcel or an unexpectedly expensive geometry must retry by itself instead
 * of holding an entire Render maintenance run open for hours.
 */
export async function refreshInfluenceQueueItem(pool, {
  accountId,
  sourceHealth,
  statementTimeoutMs = 60_000,
  refresh = refreshStoredPropertyInfluenceContext,
} = {}) {
  const timeoutMs = boundedInteger(statementTimeoutMs, 60_000, 5_000, 300_000);
  if (typeof pool?.connect !== "function") {
    return refresh(pool, {
      accountId,
      sourceHealth,
      schemaReady: true,
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('statement_timeout', $1, true)", [`${timeoutMs}ms`]);
    const result = await refresh(client, {
      accountId,
      sourceHealth,
      schemaReady: true,
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function runPropertyInfluenceBatch(pool, {
  batchSize = 100,
  concurrency = 4,
  workerId = "property-influence-worker",
  maximumAttempts = 5,
  statementTimeoutMs = 60_000,
  logger = console,
} = {}) {
  await ensurePropertyContextSchema(pool);
  const sourceHealth = await getPropertyContextSourceHealth(pool);
  const claimed = await claimPropertyInfluenceQueue(pool, { batchSize, workerId });
  const totals = {
    claimed: claimed.length,
    completed: 0,
    retry: 0,
    manualReview: 0,
  };
  await runWithConcurrency(claimed, concurrency, async (item) => {
    try {
      await refreshInfluenceQueueItem(pool, {
        accountId: item.account_id,
        sourceHealth,
        statementTimeoutMs,
      });
      await completePropertyInfluenceQueueItem(pool, item.account_id);
      totals.completed += 1;
    } catch (error) {
      const outcome = await failPropertyInfluenceQueueItem(pool, {
        accountId: item.account_id,
        attempts: item.attempts,
        maximumAttempts,
        error,
      });
      if (outcome === "manual_review") totals.manualReview += 1;
      else totals.retry += 1;
      logger.warn?.(
        `[property-influence] ${item.account_id} ${outcome}: ${error?.message || error}`,
      );
    }
  });
  return totals;
}

export {
  getPropertyInfluenceStatus,
  recoverStalePropertyInfluenceClaims,
  seedPropertyInfluenceQueue,
};
