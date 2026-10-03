const DEFAULT_ROLLBACK_CODE = "transaction_rollback_failed";

/**
 * Attempt one full rollback on an already-owned client. The owner still decides
 * whether to rethrow, how to handle ambiguous COMMIT/storage outcomes, and when
 * to release the client with this discard reason. This is not a transaction or
 * savepoint manager: it never acquires, commits, retries, releases or logs.
 * failureCode must be an internal diagnostic constant, not request/error text.
 */
export async function rollbackWithDiscardReason(client, failureCode = DEFAULT_ROLLBACK_CODE) {
  try {
    await client.query("ROLLBACK");
    return null;
  } catch {
    // Invalid configuration must not mask the primary error or leak a driver
    // message. Do not coerce objects supplied accidentally as diagnostic codes.
    const code = typeof failureCode === "string"
      && failureCode.length > 0 && failureCode.length <= 96
      && /^[a-z]/.test(failureCode) && !/[^a-z0-9_]/.test(failureCode)
      ? failureCode
      : DEFAULT_ROLLBACK_CODE;
    return new Error(code);
  }
}
