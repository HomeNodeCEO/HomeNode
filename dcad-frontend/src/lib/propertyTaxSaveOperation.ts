const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_PREFIX = 'homenode:property-tax-save:';

function storageKey(accountId: string, fileId: string, expectedRevision: number): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(accountId)}:${encodeURIComponent(fileId)}:${expectedRevision}`;
}

export function getOrCreatePropertyTaxSaveOperationId(
  accountId: string,
  fileId: string,
  expectedRevision: number,
): string {
  const key = storageKey(accountId, fileId, expectedRevision);
  try {
    const stored = globalThis.localStorage?.getItem(key);
    const existing = stored?.trim().toLowerCase();
    if (existing && OPERATION_ID_PATTERN.test(existing)) {
      if (stored !== existing) globalThis.localStorage?.setItem(key, existing);
      return existing;
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  const operationId = globalThis.crypto.randomUUID();
  try {
    globalThis.localStorage?.setItem(key, operationId);
  } catch {
    // The in-flight request is still retry-safe even without persistence.
  }
  return operationId;
}

export function clearPropertyTaxSaveOperationId(
  accountId: string,
  fileId: string,
  expectedRevision: number,
  completedOperationId: string,
): void {
  const key = storageKey(accountId, fileId, expectedRevision);
  try {
    if (globalThis.localStorage?.getItem(key)?.trim().toLowerCase() === completedOperationId) {
      globalThis.localStorage.removeItem(key);
    }
  } catch {
    // The server response remains authoritative if cleanup is unavailable.
  }
}
