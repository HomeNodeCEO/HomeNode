function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

const NEIGHBORHOOD_PROFILE_BUSY_ERRORS = new Set([
  "neighborhood_profile_capacity_exceeded",
  "neighborhood_profile_queue_timeout",
]);

export function isNeighborhoodProfileBusyError(message) {
  return NEIGHBORHOOD_PROFILE_BUSY_ERRORS.has(String(message || ""));
}

/**
 * Keeps the comparatively expensive neighborhood profile analysis from
 * consuming every connection in the shared PostgreSQL pool. Duplicate work
 * is single-flight so multiple renders or retries share one calculation.
 */
export function createNeighborhoodProfileExecutionGate({
  maxConcurrent = 2,
  maxQueued = 4,
  queueTimeoutMs = 10_000,
} = {}) {
  const concurrency = boundedInteger(maxConcurrent, 2, 1, 4);
  const queueLimit = boundedInteger(maxQueued, 4, 0, 20);
  const waitLimit = boundedInteger(queueTimeoutMs, 10_000, 1_000, 60_000);
  const queue = [];
  const singleFlight = new Map();
  let active = 0;
  let completed = 0;
  let failed = 0;

  function snapshot() {
    return Object.freeze({
      active,
      queued: queue.length,
      in_flight: singleFlight.size,
      max_concurrent: concurrency,
      max_queued: queueLimit,
      completed,
      failed,
      saturated: active >= concurrency && queue.length >= queueLimit,
    });
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      clearTimeout(job.timer);
      active += 1;
      Promise.resolve()
        .then(job.operation)
        .then((value) => {
          completed += 1;
          job.resolve(value);
        }, (error) => {
          failed += 1;
          job.reject(error);
        })
        .finally(() => {
          active -= 1;
          singleFlight.delete(job.key);
          drain();
        });
    }
  }

  function run(keyValue, operation) {
    if (typeof operation !== "function") {
      return Promise.reject(new Error("neighborhood_profile_operation_required"));
    }
    const key = String(keyValue || "").trim();
    if (!key) {
      return Promise.reject(new Error("neighborhood_profile_operation_key_required"));
    }
    const existing = singleFlight.get(key);
    if (existing) return existing;
    if (active >= concurrency && queue.length >= queueLimit) {
      return Promise.reject(new Error("neighborhood_profile_capacity_exceeded"));
    }

    let resolveJob;
    let rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = {
      key,
      operation,
      resolve: resolveJob,
      reject: rejectJob,
      timer: null,
    };
    job.timer = setTimeout(() => {
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1);
      singleFlight.delete(key);
      rejectJob(new Error("neighborhood_profile_queue_timeout"));
    }, waitLimit);
    job.timer.unref?.();
    singleFlight.set(key, promise);
    queue.push(job);
    drain();
    return promise;
  }

  return Object.freeze({ run, snapshot });
}

export function neighborhoodProfileRequestKey({
  subjectAccountId,
  asOfDate,
  periodMonths,
  customGeometry,
  marketContextOverride,
}) {
  return JSON.stringify({
    subject_account_id: String(subjectAccountId || "").trim(),
    as_of: String(asOfDate || "").trim(),
    period_months: periodMonths ?? 24,
    custom_geometry: customGeometry || null,
    context_override: marketContextOverride || null,
  });
}

const sharedNeighborhoodProfileExecutionGate = createNeighborhoodProfileExecutionGate({
  maxConcurrent: process.env.NEIGHBORHOOD_PROFILE_MAX_CONCURRENT,
  maxQueued: process.env.NEIGHBORHOOD_PROFILE_MAX_QUEUED,
  queueTimeoutMs: process.env.NEIGHBORHOOD_PROFILE_QUEUE_TIMEOUT_MS,
});

export function runNeighborhoodProfileOperation(key, operation) {
  return sharedNeighborhoodProfileExecutionGate.run(key, operation);
}

export function getNeighborhoodProfileExecutionSnapshot() {
  return sharedNeighborhoodProfileExecutionGate.snapshot();
}
