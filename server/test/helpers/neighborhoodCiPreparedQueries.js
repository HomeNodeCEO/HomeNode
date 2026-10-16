import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT = 512;
// These are ONLY for tiny, newly created loopback CI protocol databases, not
// production planning or performance acceptance. Every query still executes
// with current values. Avoid JIT/custom-plan setup for repeated small probes:
// https://www.postgresql.org/docs/17/jit-decision.html
// https://www.postgresql.org/docs/17/runtime-config-query.html#GUC-PLAN-CACHE-MODE
// These tiny graphs also have long, explicit native-parent JOIN chains. Honor
// their written join order instead of repeatedly searching equivalent orders
// as fault probes create fresh connections. Every JOIN/predicate still runs;
// no query, row, original, constraint or current authority check is omitted.
// This is not a production planner setting or a population-speed benchmark:
// https://www.postgresql.org/docs/17/explicit-joins.html
export const NEIGHBORHOOD_CI_PROTOCOL_SESSION_OPTIONS = '-c jit=off -c plan_cache_mode=force_generic_plan -c join_collapse_limit=1';
const TIMING_FAMILY_LIMIT = 128;

/** Disposable CI fixture only. Repeated exact parameterized SQL can reuse the
 * driver's server-side parse/plan instead of reparsing hundreds of original
 * owner/fault traversals. No result, parameter, original, authority decision or
 * transaction is cached. Every query still executes with its current values;
 * failures, callbacks, COMMITs and rollbacks pass through without a retry.
 * Explicitly named/non-parameterized/custom query objects remain untouched.
 * The fixed per-connection cap falls back to the ordinary unnamed execution.
 */
export function observeNeighborhoodCiPreparedQueries(pool) {
  if (typeof pool?.on !== 'function') throw new TypeError('neighborhood_ci_pool_required');
  const counts = { connections: 0, named_parameterized_calls: 0,
    repeated_parameterized_calls: 0, statement_texts: 0, ordinary_calls: 0 };
  const timings = new Map();
  pool.on('connect', client => {
    const actual = client.query;
    if (typeof actual !== 'function') throw new TypeError('neighborhood_ci_client_required');
    const names = new Map(), prefix = `neighborhood_ci_${randomUUID().replaceAll('-', '')}_`;
    counts.connections++;
    const execute = (receiver, args, text) => {
      if (typeof args.at(-1) === 'function' || typeof args[0]?.submit === 'function')
        return Reflect.apply(actual, receiver, args);
      // Only a bounded static comment family, never SQL, parameters, rows,
      // original evidence or authorization decisions. No result cache/retry.
      const tag = typeof text === 'string' ? /^\s*\/\*\s*([a-z0-9_:.-]{1,120})\s*\*\//i.exec(text)?.[1] : null;
      let key = tag ?? 'untagged';
      if (!timings.has(key) && timings.size >= TIMING_FAMILY_LIMIT) key = 'other';
      if (!timings.has(key)) timings.set(key, { family: key, completed: 0, errors: 0, total_ms: 0, maximum_ms: 0 });
      const entry = timings.get(key), started = performance.now();
      const finished = failed => {
        const elapsed = performance.now() - started;
        entry.completed++; entry.errors += Number(failed);
        entry.total_ms += elapsed; entry.maximum_ms = Math.max(entry.maximum_ms, elapsed);
      };
      let answer;
      try { answer = Reflect.apply(actual, receiver, args); }
      catch (error) { finished(true); throw error; }
      if (answer instanceof Promise) {
        // Return the observed rejection, not a detached rejection handler:
        // an unawaited native failure must STILL fail the calling process.
        // Exact result/error values, including lost COMMIT ACKs, survive.
        return Promise.prototype.then.call(answer,
          result => { finished(false); return result; },
          error => { finished(true); throw error; });
      } else finished(false);
      // Callback/custom query results remain untouched and are not timed.
      return answer;
    };
    client.query = function (...args) {
      const config = args[0], text = typeof config === 'string' ? config : config?.text,
        values = Array.isArray(args[1]) ? args[1] : config?.values;
      if (typeof text !== 'string' || !Array.isArray(values) || !values.length
        || typeof config === 'object' && (config === null || config.name || typeof config.submit === 'function')) {
        counts.ordinary_calls++;
        return execute(this, args, text);
      }
      let name = names.get(text);
      if (name) counts.repeated_parameterized_calls++;
      else if (names.size < NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT) {
        name = `${prefix}${names.size + 1}`; names.set(text, name); counts.statement_texts++;
      }
      if (!name) {
        counts.ordinary_calls++;
        return execute(this, args, text);
      }
      counts.named_parameterized_calls++;
      args[0] = typeof config === 'string' ? { text, name } : { ...config, name };
      return execute(this, args, text);
    };
  });
  return Object.freeze({ snapshot: () => Object.freeze({ ...counts,
    per_connection_statement_limit: NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT,
    parameters_or_results_cached: false, query_or_failure_skips: false,
    authority_or_commit_evidence: false, production_speed_acceptance: false }),
  timings: () => Object.freeze([...timings.values()].sort((a, b) => b.total_ms - a.total_ms).slice(0, 12)
    .map(entry => Object.freeze({ ...entry, total_ms: Math.round(entry.total_ms * 1000) / 1000,
      maximum_ms: Math.round(entry.maximum_ms * 1000) / 1000 }))) });
}
