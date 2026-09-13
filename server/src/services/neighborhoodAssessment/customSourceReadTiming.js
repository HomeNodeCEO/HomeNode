import { performance } from 'node:perf_hooks';

const QUERY_TAGS = Object.freeze(['begin', 'settings', 'commit', 'caller-snapshot', 'scope', 'capabilities',
  'parcels', 'accounts', 'sync-state', 'sync-runs', 'source-ids', 'transaction-identities',
  'link-identities', 'legacy-identities', 'transactions', 'sale-links', 'legacy', 'other']);
const knownTags = new Set(QUERY_TAGS);
const elapsed = (from, until) => Math.max(0, until - from);

// One bounded operational event per dense reader invocation. Timing includes
// intake validation and cleanup; the owner's prior access.prepare is outside.
// "completed" means the method returned, not that its result is complete or
// eligible. Query wait includes driver work; non-query wall is NOT CPU time.
// No IDs, SQL, parameters, returned rows, errors or capture references are read.
export function createCustomSourceReadTiming(report = event => {
  console.info('[neighborhood] source-read-timing ' + JSON.stringify(event));
}) {
  const started = performance.now();
  const queries = Object.fromEntries(QUERY_TAGS.map(tag => [tag, { count: 0, duration_ms: 0 }]));
  let queryCount = 0, queryMs = 0, finalizationStarted = null, reported = false;
  return Object.freeze({
    startQuery(tag) {
      const bucket = queries[knownTags.has(tag) ? tag : 'other'], began = performance.now();
      queryCount++; bucket.count++;
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        const duration = elapsed(began, performance.now());
        queryMs += duration; bucket.duration_ms += duration;
      };
    },
    beginFinalization() { finalizationStarted ??= performance.now(); },
    async run(work) {
      let outcome = 'failed';
      try { const result = await work(); outcome = 'completed'; return result; }
      finally {
        if (!reported) {
          reported = true;
          try {
            const ended = performance.now(), total = elapsed(started, ended);
            const event = Object.freeze({ phase: 'source_read', outcome,
              duration_ms: Math.round(total), query_count: queryCount, query_ms: Math.round(queryMs),
              non_query_wall_ms: Math.round(Math.max(0, total - queryMs)),
              finalization_ms: finalizationStarted === null ? 0 : Math.round(elapsed(finalizationStarted, ended)),
              queries: Object.freeze(Object.fromEntries(QUERY_TAGS.map(tag => [tag,
                Object.freeze({ count: queries[tag].count, duration_ms: Math.round(queries[tag].duration_ms) })]))) });
            // Never await logging or let its synchronous/asynchronous failure
            // replace a capture result, thrown error or transaction cleanup.
            Promise.resolve(report(event)).catch(() => {});
          } catch { /* Operational diagnostics cannot change recovery. */ }
        }
      }
    },
  });
}
