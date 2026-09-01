import { ApiError } from "../api/client";
import { retryDelayMs } from "./model";

export const MOBILE_SYNC_ACTIVE_INTERVAL_MS = 15_000;

export type SyncLane = "operations" | "photos" | "sketches";

export type SyncLaneResult = {
  attempted: number;
  succeeded: number;
  transientFailures: number;
  permanentFailures: number;
};

export type SyncCircuitState = {
  consecutiveFailures: number;
  nextAttemptAt: number;
};

export function emptySyncLaneResult(): SyncLaneResult {
  return { attempted: 0, succeeded: 0, transientFailures: 0, permanentFailures: 0 };
}

export function recordSyncFailure(result: SyncLaneResult, reason: unknown) {
  if (isTransientSyncFailure(reason)) result.transientFailures += 1;
  else result.permanentFailures += 1;
}

export function isTransientSyncFailure(reason: unknown) {
  if (reason instanceof ApiError) {
    return reason.status === 0 || reason.status === 408 || reason.status === 429 || reason.status >= 500;
  }
  const code = reason instanceof Error ? reason.message : String(reason || "");
  return code === "authentication_temporarily_unavailable"
    || code === "request_timeout"
    || code.startsWith("mobile_photo_upload_transport_failed")
    || code === "mobile_photo_upload_timeout"
    || /^mobile_photo_upload_http_(408|429|5\d\d)(?::|$)/.test(code);
}

export function initialSyncCircuit(): SyncCircuitState {
  return { consecutiveFailures: 0, nextAttemptAt: 0 };
}

export function circuitAllowsSync(state: SyncCircuitState, now = Date.now()) {
  return state.nextAttemptAt <= now;
}

export function updateSyncCircuit(
  state: SyncCircuitState,
  result: SyncLaneResult,
  now = Date.now(),
  entropy = Math.random(),
): SyncCircuitState {
  if (result.transientFailures > 0) {
    const consecutiveFailures = state.consecutiveFailures + 1;
    return {
      consecutiveFailures,
      nextAttemptAt: now + retryDelayMs(consecutiveFailures, entropy),
    };
  }
  if (result.attempted > 0) return initialSyncCircuit();
  return state;
}
