type HttpFailure = {
  status?: unknown;
  code?: unknown;
};

type CachedIdentityRecovery<T> = {
  loadCachedIdentity: () => Promise<T | null>;
  lockCachedIdentity: () => Promise<void>;
};

const TEMPORARY_FAILURE_CODES = new Set([
  "network_request_failed",
  "token_refresh_temporarily_unavailable",
]);

export function canUseCachedIdentityAfterMeFailure(reason: unknown) {
  if (!reason || typeof reason !== "object") return false;
  const failure = reason as HttpFailure;
  const status = typeof failure.status === "number" ? failure.status : null;
  const code = typeof failure.code === "string" ? failure.code : "";

  if (status === 0) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  if (status !== null) return status >= 500 && status <= 599;
  return TEMPORARY_FAILURE_CODES.has(code);
}

export async function recoverCachedIdentityAfterMeFailure<T>(
  reason: unknown,
  recovery: CachedIdentityRecovery<T>,
) {
  if (canUseCachedIdentityAfterMeFailure(reason)) {
    return recovery.loadCachedIdentity();
  }
  await recovery.lockCachedIdentity();
  throw reason;
}
