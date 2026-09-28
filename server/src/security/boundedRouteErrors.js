import { safeOperationalErrorCode } from "./safeOperationalErrorCode.js";

/** Optional diagnostics must not replace a route's fixed response. */
export function logBoundedFailure(logger, label, error, level = "error") {
  try {
    const method = level === "warn" ? "warn" : "error";
    logger?.[method]?.(label, safeOperationalErrorCode(error));
  } catch {
    // A failed logger or hostile Error getter must not escape the route boundary.
  }
}

/** Admit only codes explicitly produced by the route's known validation paths. */
export function knownErrorCode(error, allowedCodes) {
  try {
    const message = error?.message;
    return allowedCodes.has(message) ? message : null;
  } catch {
    return null;
  }
}
