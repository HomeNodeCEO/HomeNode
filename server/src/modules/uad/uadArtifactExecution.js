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

  function snapshot() {
    return Object.freeze({
      ready: !closed,
      closed,
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
    if (typeof operation !== "function") return Promise.reject(new Error("uad_artifact_operation_required"));
    const key = String(keyValue || "").trim();
    if (!key) return Promise.reject(new Error("uad_artifact_operation_key_required"));
    if (closed) return Promise.reject(new Error("uad_artifact_executor_shutting_down"));
    const existing = singleFlight.get(key);
    if (existing) return existing;
    if (active >= concurrency && queue.length >= queueLimit) {
      return Promise.reject(new Error("uad_artifact_capacity_exceeded"));
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
      timer: setTimeout(() => {
        const index = queue.indexOf(job);
        if (index < 0) return;
        queue.splice(index, 1);
        singleFlight.delete(key);
        rejectJob(new Error("uad_artifact_queue_timeout"));
      }, waitLimit),
    };
    job.timer.unref?.();
    singleFlight.set(key, promise);
    queue.push(job);
    drain();
    return promise;
  }

  function close() {
    if (closed) return false;
    closed = true;
    for (const job of queue.splice(0)) {
      clearTimeout(job.timer);
      singleFlight.delete(job.key);
      job.reject(new Error("uad_artifact_executor_shutting_down"));
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

export function runUadArtifactOperation(kind, workfileId, operation) {
  return sharedUadArtifactExecutionGate.run(`${kind}:${workfileId}`, operation);
}

export function getUadArtifactExecutionSnapshot() {
  return sharedUadArtifactExecutionGate.snapshot();
}

export function closeUadArtifactExecution() {
  return sharedUadArtifactExecutionGate.close();
}
