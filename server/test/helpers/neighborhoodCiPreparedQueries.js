import { randomUUID } from 'node:crypto';

export const NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT = 512;

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
  pool.on('connect', client => {
    const actual = client.query;
    if (typeof actual !== 'function') throw new TypeError('neighborhood_ci_client_required');
    const names = new Map(), prefix = `neighborhood_ci_${randomUUID().replaceAll('-', '')}_`;
    counts.connections++;
    client.query = function (...args) {
      const config = args[0], text = typeof config === 'string' ? config : config?.text,
        values = Array.isArray(args[1]) ? args[1] : config?.values;
      if (typeof text !== 'string' || !Array.isArray(values) || !values.length
        || typeof config === 'object' && (config === null || config.name || typeof config.submit === 'function')) {
        counts.ordinary_calls++;
        return Reflect.apply(actual, this, args);
      }
      let name = names.get(text);
      if (name) counts.repeated_parameterized_calls++;
      else if (names.size < NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT) {
        name = `${prefix}${names.size + 1}`; names.set(text, name); counts.statement_texts++;
      }
      if (!name) {
        counts.ordinary_calls++;
        return Reflect.apply(actual, this, args);
      }
      counts.named_parameterized_calls++;
      args[0] = typeof config === 'string' ? { text, name } : { ...config, name };
      return Reflect.apply(actual, this, args);
    };
  });
  return Object.freeze({ snapshot: () => Object.freeze({ ...counts,
    per_connection_statement_limit: NEIGHBORHOOD_CI_PREPARED_STATEMENT_LIMIT,
    parameters_or_results_cached: false, query_or_failure_skips: false,
    authority_or_commit_evidence: false, production_speed_acceptance: false }) });
}
