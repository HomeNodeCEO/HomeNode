export function normalizeUadExpectedRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new Error("invalid_uad_expected_revision");
  }
  return revision;
}

export function normalizeUadSaveReason(value) {
  const reason = value == null ? "manual_save" : String(value).trim();
  if (!["manual_save", "autosave"].includes(reason)) {
    throw new Error("invalid_uad_save_reason");
  }
  return reason;
}
