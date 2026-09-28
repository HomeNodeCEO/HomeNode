const DCAD_QUERY_ERROR_CODES = new Set([
  "dcad_parcel_query_unavailable",
  "dcad_parcel_query_response_too_large",
  "dcad_parcel_query_response_unavailable",
  "dcad_parcel_query_invalid_response",
  "dcad_parcel_query_error",
]);

function safeDcadQueryErrorCode(error) {
  try {
    const message = error?.message;
    if (typeof message !== "string") return "dcad_parcel_query_failed";
    if (DCAD_QUERY_ERROR_CODES.has(message)) return message;
    if (/^dcad_parcel_query_http_[1-5][0-9]{2}$/.test(message)) return message;
    if (/^dcad_parcel_query_[0-9]{1,6}$/.test(message)) return message;
  } catch {
    // Hostile exception getters must not expose provider details or break a retry.
  }
  return "dcad_parcel_query_failed";
}

/** Keep operational retry context without printing raw provider exceptions. */
export function formatLocationBackfillRetry({
  nextAttempt,
  maximumAttempts,
  batchStart,
  batchSize,
  delayMs,
  error,
}) {
  return `[locations] DCAD GIS retry ${nextAttempt}/${maximumAttempts} for rows ${batchStart + 1}-${batchStart + batchSize} in ${delayMs}ms: ${safeDcadQueryErrorCode(error)}`;
}
