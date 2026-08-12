import { refreshStoredPropertyInfluenceContext } from "./propertyContext.js";
import {
  claimPropertyInfluenceQueue,
  completePropertyInfluenceQueueItem,
  failPropertyInfluenceQueueItem,
  getPropertyInfluenceStatus,
  recoverStalePropertyInfluenceClaims,
  seedPropertyInfluenceQueue,
} from "./propertyInfluenceStore.js";

export async function runPropertyInfluenceBatch(pool, {
  batchSize = 100,
  workerId = "property-influence-worker",
  maximumAttempts = 5,
  logger = console,
} = {}) {
  const claimed = await claimPropertyInfluenceQueue(pool, { batchSize, workerId });
  const totals = {
    claimed: claimed.length,
    completed: 0,
    retry: 0,
    manualReview: 0,
  };
  for (const item of claimed) {
    try {
      await refreshStoredPropertyInfluenceContext(pool, {
        accountId: item.account_id,
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
  }
  return totals;
}

export {
  getPropertyInfluenceStatus,
  recoverStalePropertyInfluenceClaims,
  seedPropertyInfluenceQueue,
};
