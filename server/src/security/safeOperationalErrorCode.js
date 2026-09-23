const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

/** Preserve a bounded diagnostic class without logging exception messages or stacks. */
export function safeOperationalErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (/^[A-Z0-9]{5}$/.test(code)) return code; // PostgreSQL SQLSTATE.
  if (NETWORK_CODES.has(code)) return code;
  return "unknown";
}
