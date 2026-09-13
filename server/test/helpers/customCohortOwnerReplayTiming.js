import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

const PHASES = new Set(['setup', 'blank_cardinals', 'complete_cardinals', 'committed_retry']);
const POLICIES = new Set(['authorizeMarketData', 'authorizePrivateSales', 'authorizeReportedObservations']);
// Static labels copied from existing SQL comments. Never collect arbitrary tags,
// source IDs, portal names, savepoint names, SQL, values, or driver messages.
const QUERY_TAGS = new Set([
  'custom-neighborhood-source-policy:organization',
  'custom-neighborhood-report-observation-policy:organization',
  'custom-cohort-capture:assignment', 'custom-cohort-capture:existing-context',
  'custom-cohort-capture:private-workfile', 'custom-cohort-capture:report',
  'custom-cohort-capture:report-editor', 'custom-cohort-capture:report-geography',
  'custom-cohort-capture:report-geography-topology', 'custom-cohort-capture:reported-never-accepted',
  'custom-cohort-capture:reported-operation', 'custom-cohort-capture:reported-predecessor',
  'custom-cohort-capture:time', 'custom-cohort-capture:transaction',
  'custom-cohort-capture:workspace', 'custom-cohort-capture:workspace-parent',
  'custom-cohort-context:insert', 'custom-cohort-context:read',
  'custom-cohort-context:target', 'custom-cohort-context:transaction',
  'custom-cohort-recorded-proximity:distances',
  'custom-cohort-review:actor', 'custom-cohort-review:context-lock',
  'custom-cohort-review:fact', 'custom-cohort-review:head', 'custom-cohort-review:insert',
  'custom-cohort-review:operation', 'custom-cohort-review:state-blobs',
  'custom-cohort-review:state-context-lock', 'custom-cohort-review:state-heads',
  'custom-cohort-review:state-summary', 'custom-cohort-review:state-transaction',
  'custom-cohort-selection:transaction', 'custom-cohort-subject:assignment',
  'custom-cohort-subject:case', 'custom-cohort-subject:history-target',
  'custom-cohort-subject:report', 'custom-cohort-subject:section-fence',
  'custom-cohort-subject:sections', 'custom-cohort-subject:signature',
  'custom-cohort-subject:snapshot', 'custom-cohort-subject:transaction',
  'custom-cohort-subject:workfile', 'custom-neighborhood-acceptance:exact-operation',
  'custom-neighborhood-acceptance:insert', 'custom-neighborhood-save:history',
  'neighborhood-application:exact-attachment', 'neighborhood-application:insert-attachment',
  'neighborhood-application:published-context', 'neighborhood-cohort-blob:insert',
  'neighborhood-cohort-blob:insert-batch', 'neighborhood-cohort-blob:read',
  'neighborhood-cohort-blob:read-batch', 'neighborhood:caller-transaction',
  'neighborhood:scope', 'neighborhood:lock-head', 'neighborhood:ensure-head',
  'neighborhood:head-for-scope', 'neighborhood:request-operation', 'neighborhood:request-job',
  'neighborhood:record-request', 'neighborhood:deduplicate', 'neighborhood:reuse-intent',
  'neighborhood:enqueue', 'neighborhood:request-pointer', 'neighborhood:exact-job-head',
  'neighborhood:exact-job-lock', 'neighborhood:exact-claim', 'neighborhood:exhausted',
  'neighborhood:claim', 'neighborhood:heartbeat', 'neighborhood:failure',
  'neighborhood:head-by-job', 'neighborhood:cancel', 'neighborhood:job-head',
  'neighborhood:publication-fence', 'neighborhood:revision', 'neighborhood:source',
  'neighborhood:population', 'neighborhood:members', 'neighborhood:publish',
  'neighborhood:promote', 'neighborhood:finish', 'neighborhood:current',
  'neighborhood:job-status', 'neighborhood:member-page',
]);
const ERROR_CODES = new Set([
  'CUSTOM_COHORT_CAPTURE_FAILED', 'NEIGHBORHOOD_CACHED_READ_ACCESS_DENIED',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ABORT_ERR',
  '23505', '23503', '23514', '40001', '40P01', '55P03', '57014',
  '57P01', '57P02', '57P03', '25P02', '08006', '08003', '53300',
]);
const ERROR_REASONS = new Set([
  'cancelled', 'deadline_exceeded', 'connection_timeout', 'policy_timeout',
  'closed_operation', 'transaction_owner_required', 'market_data_access_denied',
  'market_policy_changed', 'report_policy_changed', 'target_unavailable',
  'target_changed', 'subject_changed', 'workspace_changed', 'review_state_changed',
  'report_editor_changed', 'report_geography_changed', 'report_proposal_changed',
  'report_publication_incomplete', 'operation_conflict', 'database_time_unavailable',
  'invalid_input', 'invalid_options', 'source_query_unavailable',
]);

// Metadata inspection never invokes a getter or changes a driver's exception.
function dataField(value, key) {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function queryLabel(config) {
  const sql = typeof config === 'string' ? config : dataField(config, 'text');
  if (typeof sql !== 'string') return 'other';
  const prefix = sql.slice(0, 256).trimStart();
  const tag = /^\/\* ([a-z0-9-]+:[a-z0-9-]+) \*\//.exec(prefix)?.[1];
  if (tag) return QUERY_TAGS.has(tag) ? tag : 'other';
  if (/^ROLLBACK\s+TO\b/i.test(prefix)) return 'rollback_to_savepoint';
  if (/^RELEASE\s+(?:SAVEPOINT\s+)?\S/i.test(prefix)) return 'release_savepoint';
  if (/^SAVEPOINT\b/i.test(prefix)) return 'savepoint';
  if (/^BEGIN\b/i.test(prefix)) return 'begin';
  if (/^COMMIT\b/i.test(prefix)) return 'commit';
  if (/^ROLLBACK\b/i.test(prefix)) return 'rollback';
  if (/^SET\b/i.test(prefix)) return 'set';
  return 'other';
}
function safeError(error) {
  const code = dataField(error, 'code'), reason = dataField(error, 'reason');
  return { code: ERROR_CODES.has(code) ? code : 'other', reason: ERROR_REASONS.has(reason) ? reason : 'other' };
}
function rowCount(result) {
  const count = dataField(result, 'rowCount');
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
function stringParameterBytes(label, args) {
  if (label !== 'neighborhood:source' && label !== 'neighborhood:members') return null;
  const values = dataField(args[0], 'values') ?? args[1];
  if (!Array.isArray(values)) return null;
  const length = dataField(values, 'length');
  if (!Number.isSafeInteger(length) || length < 0) return null;
  let bytes = 0;
  for (let index = 0; index < length; index += 1) {
    const value = dataField(values, String(index));
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8');
  }
  return bytes;
}
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, frozenCopy(item)])));
  }
  return value;
}

/** Test-only observer, not a pool, authorization policy, or owner-stage model.
 * Native Promise and positional-callback query/connect forms are observed. Exact query
 * config/values, synchronous throws, resolved values and rejected errors pass
 * through; callback return values and callback this/arguments also pass through.
 * Other synchronous driver returns are passed through without awaiting them.
 * No driver event listeners are added, removed, or replaced.
 * Event success means the call completed, never that a policy allowed access.
 *
 * transaction_ordinal is a local BEGIN-attempt ordinal, NOT a database ID or
 * evidence that a transaction committed. Only successful terminal queries clear
 * it; release also clears it. pool.query has client_ordinal 0 and no transaction
 * attribution because its checked-out client is not observable here.
 * string_parameter_utf8_bytes counts only already-serialized string parameters
 * for the source/member INSERT tags, NOT wire size or source observation count.
 * All arrays are bounded (phases 256; each other array maximumQueries); reaching
 * a recording cap never suppresses work. Counts continue, with dropped counts.
 */
export function createCustomCohortOwnerReplayTiming({ pool, now = () => performance.now(), maximumQueries = 10000 } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(maximumQueries) || maximumQueries < 0 || maximumQueries > 100000) {
    throw new TypeError('owner_replay_timing_invalid_options');
  }
  const records = { phases: [], queries: [], connections: [], policies: [], releases: [] };
  const counts = { phases: 0, queries: 0, query_completions: 0, query_errors: 0,
    connections: 0, connection_completions: 0, connection_errors: 0, clients: 0,
    transactions: 0, commits: 0, rollbacks: 0, policies: 0, policy_completions: 0,
    policy_errors: 0, releases: 0, release_errors: 0, clock_errors: 0,
    dropped_phases: 0, dropped_queries: 0, dropped_connections: 0, dropped_policies: 0, dropped_releases: 0 };
  let active = null, lastClock = 0;
  const clients = new WeakMap();
  function time() {
    try {
      const value = now();
      if (Number.isFinite(value) && value >= lastClock) { lastClock = value; return value; }
    } catch { /* A diagnostic clock must never replace an owner outcome. */ }
    counts.clock_errors += 1;
    return lastClock;
  }
  function record(kind, extra = {}) {
    const ordinal = ++counts[kind];
    const value = { ordinal, phase: active?.name ?? 'unscoped', phase_ordinal: active?.ordinal ?? 0,
      start_ms: time(), end_ms: null, wall_ms: null, success: null, error: null, ...extra };
    if (records[kind].length < maximumQueries) records[kind].push(value);
    else counts[`dropped_${kind}`] += 1;
    return value;
  }
  function finish(event, success, error) {
    if (event.end_ms !== null) return false;
    event.end_ms = time(); event.wall_ms = event.end_ms - event.start_ms;
    event.success = success; event.error = success ? null : safeError(error);
    return true;
  }
  // Never make the invocation itself async: a driver's synchronous throw must
  // remain synchronous. The chained Promise preserves its value/error identity.
  function observe(invoke, complete, callbackIndex, args, transform = value => value) {
    let callbackRan = false;
    let forwarded = args;
    if (callbackIndex >= 0) {
      forwarded = [...args];
      const actual = args[callbackIndex];
      forwarded[callbackIndex] = function (...values) {
        callbackRan = true;
        complete(!values[0], values[1], values[0]);
        if (!values[0] && values.length > 1) values[1] = transform(values[1]);
        return Reflect.apply(actual, this, values);
      };
    }
    let result;
    try { result = invoke(forwarded); }
    catch (error) { if (!callbackRan) complete(false, undefined, error); throw error; }
    if (callbackIndex >= 0) return result;
    if (types.isPromise(result)) return Promise.prototype.then.call(result,
      value => { complete(true, value); return transform(value); },
      error => { complete(false, undefined, error); throw error; });
    complete(true, result);
    return transform(result);
  }
  function query(raw, method, args, state) {
    const label = queryLabel(args[0]);
    if (state.ordinal && label === 'begin') state.transaction = ++counts.transactions;
    const event = record('queries', { label, client_ordinal: state.ordinal,
      transaction_ordinal: state.transaction, rows: null,
      string_parameter_utf8_bytes: stringParameterBytes(label, args) });
    return observe(values => Reflect.apply(method, raw, values), (success, result, error) => {
      if (!finish(event, success, error)) return;
      counts.query_completions += 1;
      if (!success) counts.query_errors += 1;
      else {
        event.rows = rowCount(result);
        if (label === 'commit') counts.commits += 1;
        if (label === 'rollback') counts.rollbacks += 1;
        if (label === 'commit' || label === 'rollback') state.transaction = 0;
      }
    }, typeof args.at(-1) === 'function' ? args.length - 1 : -1, args);
  }
  function wrap(raw, isPool, state) {
    const cache = new Map();
    const proxy = new Proxy(raw, {
      get(target, key) {
        const method = Reflect.get(target, key, target);
        if (typeof method !== 'function') return method;
        // pg replaces client.release on every checkout, so refresh by identity.
        if (cache.get(key)?.actual === method) return cache.get(key).observed;
        let observed;
        if (key === 'query') observed = (...args) => query(target, method, args, state);
        else if (isPool && key === 'connect') observed = (...args) => {
          const event = record('connections', { client_ordinal: 0 });
          return observe(values => Reflect.apply(method, target, values), (success, result, error) => {
            if (!finish(event, success, error)) return;
            counts.connection_completions += 1;
            if (!success) counts.connection_errors += 1;
            else event.client_ordinal = clientState(result).ordinal;
          }, typeof args.at(-1) === 'function' ? args.length - 1 : -1, args, value => clientState(value).proxy);
        };
        else if (!isPool && key === 'release') observed = (...args) => {
          const event = record('releases', { client_ordinal: state.ordinal, transaction_ordinal: state.transaction,
            discard: Boolean(args[0]), discard_error: args[0] ? safeError(args[0]) : null });
          try { const result = Reflect.apply(method, target, args); finish(event, true); return result; }
          catch (error) { counts.release_errors += 1; finish(event, false, error); throw error; }
          finally { state.transaction = 0; }
        };
        else observed = (...args) => {
          const result = Reflect.apply(method, target, args);
          return result === target ? proxy : result;
        };
        cache.set(key, { actual: method, observed });
        return observed;
      },
    });
    return proxy;
  }
  function clientState(raw) {
    let state = clients.get(raw);
    if (!state) {
      state = { ordinal: ++counts.clients, transaction: 0, proxy: null };
      state.proxy = wrap(raw, false, state);
      clients.set(raw, state);
    }
    return state;
  }
  const observedPool = wrap(pool, true, { ordinal: 0, transaction: 0 });
  return Object.freeze({
    pool: observedPool,
    wrapPolicy(name, actual) {
      if (!POLICIES.has(name) || typeof actual !== 'function') throw new TypeError('owner_replay_timing_invalid_policy');
      return function (...args) {
        const event = record('policies', { label: name });
        return observe(values => Reflect.apply(actual, this, values), (success, result, error) => {
          if (!finish(event, success, error)) return;
          counts.policy_completions += 1;
          if (!success) counts.policy_errors += 1;
        }, -1, args);
      };
    },
    begin(name) {
      if (!PHASES.has(name) || active) throw new TypeError('owner_replay_timing_invalid_phase_begin');
      active = { name, ordinal: ++counts.phases, start_ms: time(), end_ms: null, wall_ms: null };
      if (records.phases.length < 256) records.phases.push(active); else counts.dropped_phases += 1;
      return active.ordinal;
    },
    end(name) {
      if (!active || active.name !== name) throw new TypeError('owner_replay_timing_invalid_phase_end');
      active.end_ms = time(); active.wall_ms = active.end_ms - active.start_ms;
      const ordinal = active.ordinal; active = null; return ordinal;
    },
    snapshot() {
      return frozenCopy({ schema_version: 1, clock: 'performance_now_milliseconds',
        maximum_queries: maximumQueries, counts, ...records });
    },
  });
}
