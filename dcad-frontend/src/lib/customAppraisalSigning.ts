const SIGNATURE_EVENT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_PREFIX = "homenode:custom-appraisal-signature:";

function storageKey(accountId: string, assignmentFileId: number) {
  return `${STORAGE_PREFIX}${encodeURIComponent(accountId)}:${assignmentFileId}`;
}

export function getOrCreateCustomAppraisalSignatureEventId(
  accountId: string,
  assignmentFileId: number,
) {
  const key = storageKey(accountId, assignmentFileId);
  try {
    const existing = globalThis.localStorage?.getItem(key)?.trim().toLowerCase();
    if (existing && SIGNATURE_EVENT_PATTERN.test(existing)) return existing;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  const eventId = globalThis.crypto.randomUUID();
  try {
    globalThis.localStorage?.setItem(key, eventId);
  } catch {
    // The request remains idempotent for this attempt even without persistence.
  }
  return eventId;
}

export function clearCustomAppraisalSignatureEventId(
  accountId: string,
  assignmentFileId: number,
  completedEventId: string,
) {
  const key = storageKey(accountId, assignmentFileId);
  try {
    if (globalThis.localStorage?.getItem(key) === completedEventId) {
      globalThis.localStorage.removeItem(key);
    }
  } catch {
    // A successful server response is authoritative even if storage cleanup fails.
  }
}
