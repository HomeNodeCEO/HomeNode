import { performance } from 'node:perf_hooks';

const PHASES = new Set(['subject', 'spatial', 'source', 'preparation', 'retention', 'registration']);
// Operational timings only: no IDs, errors, query text, payloads or source data.
// Six fixed phases per acquisition; logger failures cannot change its outcome.
export function createCustomCapturePhaseTiming(report = event => {
  console.info('[neighborhood] capture-phase ' + JSON.stringify(event));
}) {
  const started = performance.now(), seen = new Set();
  const elapsed = from => Math.max(0, Math.round(performance.now() - from));
  return async (phase, work) => {
    if (!PHASES.has(phase) || seen.has(phase) || typeof work !== 'function') throw new TypeError('invalid_capture_phase');
    seen.add(phase);
    const began = performance.now();
    let outcome = 'failed';
    try { const result = await work(); outcome = 'completed'; return result; }
    finally {
      try {
        // Do not await a logger, but own any asynchronous rejection too.
        Promise.resolve(report(Object.freeze({ phase, outcome, duration_ms: elapsed(began), elapsed_ms: elapsed(started) }))).catch(() => {});
      } catch { /* Observability must not change transaction recovery. */ }
    }
  };
}
