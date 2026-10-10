import { isProxy } from 'node:util/types';

// A whole actual DB-owner operation, not a replacement for stricter child
// readers (the stock packet still has its own 128-query single-use ceiling).
export const CUSTOM_COHORT_ORIGINAL_ACCOUNT_OWNER_LIMITS = Object.freeze({
  sql_queries: 256, decoded_rows_utf8_bytes: 32_000_000, operation_ms: 60_000,
});
const L = CUSTOM_COHORT_ORIGINAL_ACCOUNT_OWNER_LIMITS;
const fail = reason => { throw new TypeError(`custom_cohort_original_account_owner_${reason}`); };

/** One executor for the actual transaction's authority, workspace, prerequisite,
 * original and ending reads. No caller data/adapter or per-reader reset. The
 * real transaction owner still owns connection deadlines, COMMIT and cleanup.
 */
export function createCustomCohortOriginalAccountOwnerBudget(client, options) {
  if (typeof client?.query !== 'function' || !options || isProxy(options)
    || Object.getPrototypeOf(options) !== Object.prototype) fail('owner_required');
  const descriptors = Object.getOwnPropertyDescriptors(options), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 1 || keys[0] !== 'checkBudget' || !descriptors.checkBudget.enumerable
    || !Object.hasOwn(descriptors.checkBudget, 'value') || typeof descriptors.checkBudget.value !== 'function') fail('owner_required');
  const checkBudget = descriptors.checkBudget.value, started = performance.now();
  let queries = 0, bytes = 0, failure = null;
  const check = () => {
    if (failure) throw failure;
    checkBudget();
    if (performance.now() - started >= L.operation_ms) fail('deadline');
  };
  return Object.freeze({
    // Existing transaction-local repositories require this client shape. They
    // must not release the real connection owned by the outer transaction.
    release() { fail('transaction_owner_required'); },
    async query(...args) {
    try {
      check();
      if (++queries > L.sql_queries) fail('query_limit');
      const result = await client.query(...args);
      check();
      if (!Array.isArray(result?.rows)) fail('invalid_result');
      let encoded;
      try { encoded = JSON.stringify(result.rows); } catch { fail('invalid_result'); }
      if (typeof encoded !== 'string') fail('invalid_result');
      bytes += Buffer.byteLength(encoded);
      if (bytes > L.decoded_rows_utf8_bytes) fail('byte_limit');
      check();
      return result;
    } catch (error) {
      failure ||= error;
      throw error;
    }
  } });
}
