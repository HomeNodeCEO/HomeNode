import { performance } from 'node:perf_hooks';

const TAGS = Object.freeze(['neighborhood-cohort-blob:read', 'neighborhood-cohort-blob:insert-batch',
  'neighborhood-cohort-blob:read-batch', 'neighborhood-cohort-blob:insert', 'custom-cohort-capture:transaction',
  'custom-cohort-selection:transaction', 'custom-cohort-subject:history-target', 'other']);
const known = new Set(TAGS);

// One fixed-size operational event. No SQL, parameters, source records, IDs,
// errors or references are emitted. Completed means retention returned, not that
// the owner committed. Query time includes driver work; its complement is wall
// time, not a CPU measurement. Logging never changes results or cleanup.
export async function withCustomCohortRetentionTiming(client, work, report = event => {
  console.info('[neighborhood] retention-timing ' + JSON.stringify(event));
}) {
  const started = performance.now(), queries = Object.fromEntries(TAGS.map(tag => [tag, { count: 0, duration_ms: 0 }]));
  let outcome = 'failed', queryCount = 0, queryMs = 0;
  const observed = {
    async query(...args) {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const match = typeof text === 'string' ? text.slice(0, 128).match(/^\s*\/\* ([a-z-]+:[a-z-]+) \*\//)?.[1] : undefined;
      const bucket = queries[known.has(match) ? match : 'other'], at = performance.now();
      queryCount++; bucket.count++;
      try { return await client.query(...args); }
      finally {
        const ms = Math.max(0, performance.now() - at);
        queryMs += ms; bucket.duration_ms += ms;
      }
    },
    release: typeof client?.release === 'function' ? (...args) => client.release(...args) : client?.release,
  };
  try {
    const result = await work(observed); outcome = 'completed'; return result;
  } finally {
    try {
      const duration = Math.max(0, performance.now() - started);
      const event = Object.freeze({ phase: 'retention', outcome, duration_ms: Math.round(duration), query_count: queryCount,
        query_ms: Math.round(queryMs), non_query_wall_ms: Math.round(Math.max(0, duration - queryMs)),
        queries: Object.freeze(Object.fromEntries(TAGS.map(tag => [tag, Object.freeze({ count: queries[tag].count,
          duration_ms: Math.round(queries[tag].duration_ms) })]))) });
      Promise.resolve(report(event)).catch(() => {});
    } catch { /* Diagnostics cannot replace a result, thrown error or rollback. */ }
  }
}
