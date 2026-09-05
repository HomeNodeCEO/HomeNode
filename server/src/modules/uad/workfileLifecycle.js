const MUTABLE_WORKFILE_STATUSES = new Set([
  "draft",
  "validating",
  "ready",
  "revised",
]);

export function isUadWorkfileMutable(status) {
  return MUTABLE_WORKFILE_STATUSES.has(String(status || "").trim());
}

export function assertUadWorkfileMutable(status, errorCode = "uad_workfile_status_locked") {
  if (!isUadWorkfileMutable(status)) throw new Error(errorCode);
}
