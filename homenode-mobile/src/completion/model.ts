export type LocalCompletionSourceCounts = {
  pendingOperations: number;
  conflicts: number;
  pendingPhotos: number;
  pendingSketches: number;
};

export type LocalCompletionCheck = {
  key: "pending_operations" | "conflicts" | "pending_photos" | "pending_sketches";
  label: string;
  detail: string;
  openCount: number;
  passed: boolean;
};

export type LocalInspectionCompletionReadiness = {
  ready: boolean;
  checks: LocalCompletionCheck[];
  blockers: LocalCompletionCheck["key"][];
};

function count(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function localInspectionCompletionReadiness(
  source: LocalCompletionSourceCounts,
): LocalInspectionCompletionReadiness {
  const checks: LocalCompletionCheck[] = [
    {
      key: "pending_operations",
      label: "Field edits synchronized",
      detail: "Send every queued field and UAD entity change to HomeNode.",
      openCount: count(source.pendingOperations),
      passed: count(source.pendingOperations) === 0,
    },
    {
      key: "conflicts",
      label: "Device conflicts resolved",
      detail: "Choose the HomeNode or mobile value for every local conflict.",
      openCount: count(source.conflicts),
      passed: count(source.conflicts) === 0,
    },
    {
      key: "pending_photos",
      label: "Photos uploaded",
      detail: "Upload, verify, or remove every photo draft on this device.",
      openCount: count(source.pendingPhotos),
      passed: count(source.pendingPhotos) === 0,
    },
    {
      key: "pending_sketches",
      label: "Sketch synchronized",
      detail: "Save the current sketch draft to HomeNode.",
      openCount: count(source.pendingSketches),
      passed: count(source.pendingSketches) === 0,
    },
  ];
  return {
    ready: checks.every((item) => item.passed),
    checks,
    blockers: checks.filter((item) => !item.passed).map((item) => item.key),
  };
}
