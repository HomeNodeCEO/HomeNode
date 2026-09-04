const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORAGE_PREFIX = 'homenode:desktop-sketch-save:';

export type DesktopSketchWorkflow = 'custom-appraisal' | 'property-tax-protest';

function storageKey(
  workflow: DesktopSketchWorkflow,
  accountId: string,
  targetId: string | number,
  expectedRevision: number,
): string {
  return [
    STORAGE_PREFIX + workflow,
    encodeURIComponent(accountId),
    encodeURIComponent(String(targetId)),
    expectedRevision,
  ].join(':');
}

export function getOrCreateDesktopSketchSaveOperationId(
  workflow: DesktopSketchWorkflow,
  accountId: string,
  targetId: string | number,
  expectedRevision: number,
): string {
  const key = storageKey(workflow, accountId, targetId, expectedRevision);
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
    // Automatic retries remain idempotent even when persistence is unavailable.
  }
  return operationId;
}

export function clearDesktopSketchSaveOperationId(
  workflow: DesktopSketchWorkflow,
  accountId: string,
  targetId: string | number,
  expectedRevision: number,
  completedOperationId: string,
): void {
  const key = storageKey(workflow, accountId, targetId, expectedRevision);
  try {
    if (globalThis.localStorage?.getItem(key)?.trim().toLowerCase() === completedOperationId) {
      globalThis.localStorage.removeItem(key);
    }
  } catch {
    // A confirmed server response is authoritative if cleanup is unavailable.
  }
}

export async function withDesktopSketchSaveOperation<T>(
  workflow: DesktopSketchWorkflow,
  accountId: string,
  targetId: string | number,
  expectedRevision: number,
  request: (operationId: string) => Promise<T>,
  requestedOperationId?: string,
): Promise<T> {
  const operationId = requestedOperationId || getOrCreateDesktopSketchSaveOperationId(
    workflow, accountId, targetId, expectedRevision,
  );
  try {
    const result = await request(operationId);
    clearDesktopSketchSaveOperationId(
      workflow, accountId, targetId, expectedRevision, operationId,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'sketch_revision_conflict' || message === 'sketch_operation_conflict') {
      clearDesktopSketchSaveOperationId(
        workflow, accountId, targetId, expectedRevision, operationId,
      );
    }
    throw error;
  }
}
