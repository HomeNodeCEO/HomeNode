import { safeOperationalErrorCode } from "./safeOperationalErrorCode.js";

const KNOWN_FAILURES = new Set([
  "database_url_required",
  "collin_cad_existing_identifier_conflict",
  "collin_cad_official_identifier_conflict",
]);

/** Keep crosswalk CLI diagnostics useful without printing provider or DB errors. */
export function safeCollinCadSyncFailureCode(error) {
  let message;
  try {
    message = error?.message;
  } catch {
    // Exception-like objects may have throwing accessors.
  }
  if (typeof message === "string" && (
    KNOWN_FAILURES.has(message)
    || /^collin_cad_open_data_(?:stats_)?[1-5]\d{2}$/.test(message)
    || /^collin_cad_crosswalk_conflicts:\d{1,9}$/.test(message)
    || /^collin_cad_row_count_changed:\d{1,9}:\d{1,9}$/.test(message)
  )) return message;

  const operationalCode = safeOperationalErrorCode(error);
  return operationalCode === "unknown"
    ? "collin_cad_sync_failed"
    : `collin_cad_sync_${operationalCode}`;
}
