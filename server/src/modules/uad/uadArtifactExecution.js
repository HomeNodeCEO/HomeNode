function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

export function createUadArtifactExecutionGate({
  maxConcurrent = 1,
  maxQueued = 2,
  queueTimeoutMs = 15_000,
  logger = console,
} = {}) {
  const concurrency = boundedInteger(maxConcurrent, 1, 1, 4);
  const queueLimit = boundedInteger(maxQueued, 2, 0, 20);
  const waitLimit = boundedInteger(queueTimeoutMs, 15_000, 1_000, 120_000);
  const queue = [];
  const singleFlight = new Map();
  let active = 0;
  let closed = false;
  let completed = 0;
  let failed = 0;

  function abortedError() {
    const error = new Error("uad_artifact_request_aborted");
    error.name = "AbortError";
    return error;
  }

  function snapshot() {
    const saturated = !closed
      && active >= concurrency
      && queue.length >= queueLimit;
    return Object.freeze({
      ready: !closed && !saturated,
      closed,
      saturated,
      active,
      queued: queue.length,
      max_concurrent: concurrency,
      max_queued: queueLimit,
      completed,
      failed,
    });
  }

  function drain() {
    while (!closed && active < concurrency && queue.length) {
      const job = queue.shift();
      clearTimeout(job.timer);
      job.started = true;
      active += 1;
      Promise.resolve()
        .then(() => job.operation(job.controller.signal))
        .then((value) => {
          completed += 1;
          for (const subscriber of [...job.subscribers]) subscriber.resolve(value);
        }, (error) => {
          failed += 1;
          for (const subscriber of [...job.subscribers]) subscriber.reject(error);
        })
        .finally(() => {
          for (const subscriber of [...job.subscribers]) subscriber.cleanup();
          job.subscribers.clear();
          active -= 1;
          if (singleFlight.get(job.key) === job) singleFlight.delete(job.key);
          drain();
        });
    }
  }

  function removeUnobservedJob(job) {
    if (job.subscribers.size || job.controller.signal.aborted) return;
    if (job.started) {
      if (singleFlight.get(job.key) === job) singleFlight.delete(job.key);
      job.controller.abort(abortedError());
      return;
    }
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    clearTimeout(job.timer);
    if (singleFlight.get(job.key) === job) singleFlight.delete(job.key);
    drain();
  }

  function subscribe(job, signal) {
    if (signal?.aborted) return Promise.reject(abortedError());
    return new Promise((resolve, reject) => {
      const subscriber = {
        resolve(value) {
          subscriber.cleanup();
          resolve(value);
        },
        reject(error) {
          subscriber.cleanup();
          reject(error);
        },
        cleanup() {
          signal?.removeEventListener("abort", subscriber.abort);
          job.subscribers.delete(subscriber);
        },
        abort() {
          subscriber.cleanup();
          reject(abortedError());
          removeUnobservedJob(job);
        },
      };
      job.subscribers.add(subscriber);
      signal?.addEventListener("abort", subscriber.abort, { once: true });
      if (signal?.aborted) subscriber.abort();
    });
  }

  function rejectQueuedJob(job, error) {
    clearTimeout(job.timer);
    if (singleFlight.get(job.key) === job) singleFlight.delete(job.key);
    for (const subscriber of [...job.subscribers]) subscriber.reject(error);
    job.subscribers.clear();
  }

  function run(keyValue, operation, { signal } = {}) {
    if (typeof operation !== "function") return Promise.reject(new Error("uad_artifact_operation_required"));
    const key = String(keyValue || "").trim();
    if (!key) return Promise.reject(new Error("uad_artifact_operation_key_required"));
    if (signal != null && !(signal instanceof AbortSignal)) {
      return Promise.reject(new Error("uad_artifact_abort_signal_invalid"));
    }
    if (signal?.aborted) return Promise.reject(abortedError());
    if (closed) return Promise.reject(new Error("uad_artifact_executor_shutting_down"));
    const existing = singleFlight.get(key);
    if (existing) return subscribe(existing, signal);
    if (active >= concurrency && queue.length >= queueLimit) {
      return Promise.reject(new Error("uad_artifact_capacity_exceeded"));
    }

    const job = {
      key,
      operation,
      controller: new AbortController(),
      subscribers: new Set(),
      started: false,
      timer: setTimeout(() => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        rejectQueuedJob(job, new Error("uad_artifact_queue_timeout"));
      }, waitLimit),
    };
    job.timer.unref?.();
    singleFlight.set(key, job);
    queue.push(job);
    const promise = subscribe(job, signal);
    drain();
    return promise;
  }

  function close() {
    if (closed) return false;
    closed = true;
    for (const job of queue.splice(0)) {
      rejectQueuedJob(job, new Error("uad_artifact_executor_shutting_down"));
    }
    logger.info?.("[uad-artifacts] executor closed", snapshot());
    return true;
  }

  return Object.freeze({ run, close, snapshot });
}

const sharedUadArtifactExecutionGate = createUadArtifactExecutionGate({
  maxConcurrent: process.env.UAD_ARTIFACT_MAX_CONCURRENT,
  maxQueued: process.env.UAD_ARTIFACT_MAX_QUEUED,
  queueTimeoutMs: process.env.UAD_ARTIFACT_QUEUE_TIMEOUT_MS,
});

export function runUadArtifactOperation(kind, workfileId, operation, options) {
  return sharedUadArtifactExecutionGate.run(`${kind}:${workfileId}`, operation, options);
}

export function getUadArtifactExecutionSnapshot() {
  return sharedUadArtifactExecutionGate.snapshot();
}

export function closeUadArtifactExecution() {
  return sharedUadArtifactExecutionGate.close();
}
