const LIMITS = Object.freeze({ connect_ms: 5000, query_ms: 6000, cleanup_ms: 1000 });

function uncertain(error) {
  return Object.assign(error, { outcome_unknown: true });
}

async function connect(pool) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = new Error('custom_cohort_job_transaction_connect_timeout');
    const timer = setTimeout(() => {
      settled = true;
      reject(timeout);
    }, LIMITS.connect_ms);
    Promise.resolve().then(() => pool.connect()).then(client => {
      if (settled) {
        // A delayed checkout must not leak or become usable after rejection.
        try { client.release(timeout); } catch { /* The checkout already failed. */ }
        return;
      }
      settled = true; clearTimeout(timer); resolve(client);
    }, error => {
      if (settled) return;
      settled = true; clearTimeout(timer); reject(error);
    });
  });
}

/** Own a short capture-job ledger/actor transaction, not a source acquisition.
 * Driver/server query bounds prevent a stuck heartbeat from blocking shutdown.
 * A damaged connection is discarded once. A rejected COMMIT or post-COMMIT
 * release is an unknown outcome, never proof that the fenced write rolled back.
 * The capture coordinator keeps its separate aggregate-budget transaction owner.
 */
export async function withCustomCohortJobTransaction(pool, action) {
  if (typeof pool?.connect !== 'function' || typeof action !== 'function')
    throw new TypeError('custom_cohort_job_transaction_invalid_input');
  const raw = await connect(pool);
  let open = false, closed = false, discard = null, connectionError = null, commitAttempted = false;
  let result, failure, failed = false;
  const connectionFailed = error => { connectionError ||= error; discard ||= error; };
  raw.on?.('error', connectionFailed);
  const client = Object.freeze({ async query(sql, values) {
    if (closed) throw new TypeError('custom_cohort_job_transaction_closed');
    if (connectionError) throw connectionError;
    const config = typeof sql === 'string' ? { text: sql, values } : { ...sql };
    config.query_timeout = Math.min(config.query_timeout ?? LIMITS.query_ms, LIMITS.query_ms);
    try {
      const result = await raw.query(config);
      if (connectionError) throw connectionError;
      return result;
    } catch (error) { discard ||= error; throw error; }
  } });
  try {
    await client.query('BEGIN'); open = true;
    await client.query("SET LOCAL statement_timeout='5000ms'; SET LOCAL lock_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='10000ms'");
    result = await action(client);
    if (discard) throw discard;
    commitAttempted = true;
    await client.query('COMMIT'); open = false;
  } catch (error) {
    failed = true;
    failure = commitAttempted ? uncertain(error) : error;
    if (!commitAttempted && open && !discard) {
      try { await raw.query({ text: 'ROLLBACK', query_timeout: LIMITS.cleanup_ms }); }
      catch (rollbackError) { discard = rollbackError; }
    }
  } finally {
    closed = true;
    try { raw.release(discard || undefined); }
    catch (releaseError) {
      // Preserve an earlier denial/driver failure. Cleanup must not turn
      // access_revoked into capture_failed or erase a lost-COMMIT outcome.
      if (!failed) {
        failed = true;
        failure = commitAttempted ? uncertain(releaseError) : releaseError;
      }
    }
    finally { raw.off?.('error', connectionFailed); }
  }
  if (failed) throw failure;
  return result;
}
