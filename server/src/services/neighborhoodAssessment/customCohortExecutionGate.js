// Per-process admission for memory-heavy Custom cohort HTTP operations. This is
// independent of API rate limits: no source grant, request retry or lock lease.
// Hold the permit through response serialization and cleanup, not merely until
// the first database transaction ends. Ordinary routes never enter this gate.
export const CUSTOM_COHORT_EXECUTION_LIMITS = Object.freeze({ active: 1, queued: 4, duration_ms: 60_000 });
const failure = code => Object.assign(new Error(code), { code });

export function createCustomCohortExecutionGate() {
  let active = false;
  const queued = [];
  function grant(resolve) {
    active = true; let released = false;
    resolve(() => {
      if (released) return;
      released = true; active = false;
      while (queued.length) {
        const next = queued.shift(); next.cleanup();
        if (next.signal?.aborted || performance.now() >= next.deadline) {
          next.reject(failure('custom_cohort_execution_interrupted')); continue;
        }
        grant(next.resolve); break;
      }
    });
  }
  return Object.freeze({
    acquire({ signal, deadline }) {
      if (!(signal instanceof AbortSignal) || !Number.isFinite(deadline)) throw new TypeError('custom_cohort_execution_options');
      if (signal.aborted || performance.now() >= deadline) return Promise.reject(failure('custom_cohort_execution_interrupted'));
      if (!active) return new Promise(resolve => grant(resolve));
      if (queued.length >= CUSTOM_COHORT_EXECUTION_LIMITS.queued) return Promise.reject(failure('custom_cohort_execution_busy'));
      return new Promise((resolve, reject) => {
        let timer;
        const remove = () => {
          const index = queued.indexOf(entry); if (index < 0) return;
          queued.splice(index, 1); entry.cleanup(); reject(failure('custom_cohort_execution_interrupted'));
        };
        const entry = { resolve, reject, signal, deadline,
          cleanup() { clearTimeout(timer); signal.removeEventListener('abort', remove); } };
        queued.push(entry); signal.addEventListener('abort', remove, { once: true });
        timer = setTimeout(remove, Math.max(1, Math.ceil(deadline - performance.now())));
        if (signal.aborted) remove();
      });
    },
  });
}

// Multiple mounted routers share one ceiling, not one allocation per account,
// organization or browser tab. No evidence or principal is cached globally.
export const customCohortExecutionGate = createCustomCohortExecutionGate();
