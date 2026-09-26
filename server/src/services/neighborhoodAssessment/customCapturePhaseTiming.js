import { performance } from 'node:perf_hooks';

const PHASES = new Set(['subject', 'spatial', 'source', 'source_authorization', 'source_read',
  'preparation', 'retention', 'registration']);
const REPORT_PHASES = new Set(['load', 'assembly', 'publication', 'repository']);
const PREVIEW_PHASES = new Set(['load', 'assembly', 'map', 'projection', 'authorization']);
const CATALOG_PHASES = new Set(['catalog', 'proximity', 'prepared_secondary', 'recommendation', 'opening', 'fallback_opening']);
const PREPARED_CATALOG_PHASES = new Set(['target', 'authorization', 'catalog_read', 'preview_read', 'projection', 'recheck']);
const PREPARED_CATALOG_PROJECTION_PHASES = new Set(['binding', 'membership', 'opening_selection', 'observation_reselect',
  'map_select', 'summary_projection', 'transport_guard']);
const PREPARED_PREVIEW_READ_PHASES = new Set(['query', 'preview_decode', 'preview_restore', 'map_decode']);
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

// Catalog and selection timing excludes identifiers and facts. These fixed
// phases distinguish immutable evidence loading, numeric assembly, optional
// geometry, recommendation/opening projection, and final access recheck.
export function createCustomPreviewPhaseTiming(report = event => {
  console.info('[neighborhood] preview-phase ' + JSON.stringify(event));
}) {
  return createPhaseTiming(report, PREVIEW_PHASES, 'invalid_preview_phase');
}

// Subphases of catalog projection. They overlap its outer preview-phase
// duration and must not be summed with it. No source facts or identifiers.
export function createCustomCatalogPhaseTiming(report = event => {
  console.info('[neighborhood] catalog-phase ' + JSON.stringify(event));
}) {
  return createPhaseTiming(report, CATALOG_PHASES, 'invalid_catalog_phase');
}

// A saved reopen uses a different, selection-neutral read model. Keep its
// timings separate from first-capture catalog projection; never log source
// facts, account IDs, request bodies, or provider diagnostics.
export function createCustomPreparedCatalogPhaseTiming(report = event => {
  console.info('[neighborhood] prepared-catalog-phase ' + JSON.stringify(event));
}) {
  return createPhaseTiming(report, PREPARED_CATALOG_PHASES, 'invalid_prepared_catalog_phase');
}

// These synchronous stages subdivide projection without yielding between
// immutable read-model operations. Log only fixed phase names and durations.
export function createCustomPreparedCatalogProjectionTiming(report = event => {
  console.info('[neighborhood] prepared-catalog-projection-phase ' + JSON.stringify(event));
}) {
  return createSyncPhaseTiming(report, PREPARED_CATALOG_PROJECTION_PHASES, 'invalid_prepared_catalog_projection_phase');
}

// Subphases of prepared-catalog preview_read. The stored row is immutable;
// timings separate PostgreSQL transfer from bounded integrity/decode work.
// No source facts, identifiers, SQL, geometry, or payload lengths are logged.
export function createCustomPreparedPreviewReadTiming(report = event => {
  console.info('[neighborhood] prepared-preview-read-phase ' + JSON.stringify(event));
}) {
  return createPhaseTiming(report, PREPARED_PREVIEW_READ_PHASES, 'invalid_prepared_preview_read_phase');
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

function createSyncPhaseTiming(report, phases, invalidPhase) {
  const started = performance.now(), seen = new Set();
  const elapsed = from => Math.max(0, Math.round(performance.now() - from));
  return (phase, work) => {
    if (!phases.has(phase) || seen.has(phase) || typeof work !== 'function') throw new TypeError(invalidPhase);
    seen.add(phase);
    const began = performance.now();
    let outcome = 'failed';
    try { const value = work(); outcome = 'completed'; return value; }
    finally {
      try { Promise.resolve(report(Object.freeze({ phase, outcome, duration_ms: elapsed(began), elapsed_ms: elapsed(started) }))).catch(() => {}); }
      catch { /* Observability must not change transaction recovery. */ }
    }
  };
}
