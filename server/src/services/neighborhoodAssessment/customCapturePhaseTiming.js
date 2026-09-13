import { performance } from 'node:perf_hooks';

const PHASES = new Set(['subject', 'spatial', 'source', 'source_authorization', 'source_read',
  'preparation', 'retention', 'registration']);
const REPORT_PHASES = new Set(['load', 'assembly', 'publication', 'repository']);
// Operational timings only: no IDs, errors, query text, payloads or source data.
// Fixed phases and source subphases; logger failures cannot change the outcome.
export function createCustomCapturePhaseTiming(report = event => {
  console.info('[neighborhood] capture-phase ' + JSON.stringify(event));
}) {
  return createPhaseTiming(report, PHASES, 'invalid_capture_phase');
}

// Report-only durations identify the exhausted stage without logging a request
// identifier, source facts, SQL or exception text. Repository is a subphase of
// publication, so those durations must not be added together.
export function createCustomReportPhaseTiming(report = event => {
  console.info('[neighborhood] report-phase ' + JSON.stringify(event));
}) {
  return createPhaseTiming(report, REPORT_PHASES, 'invalid_report_phase');
}

function createPhaseTiming(report, phases, invalidPhase) {
  const started = performance.now(), seen = new Set();
  const elapsed = from => Math.max(0, Math.round(performance.now() - from));
  return async (phase, work) => {
    if (!phases.has(phase) || seen.has(phase) || typeof work !== 'function') throw new TypeError(invalidPhase);
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
