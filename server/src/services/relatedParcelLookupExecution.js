function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

const RELATED_PARCEL_LOOKUP_BUSY_ERRORS = new Set([
  "related_parcel_lookup_capacity_exceeded",
  "related_parcel_lookup_principal_capacity_exceeded",
  "related_parcel_lookup_queue_timeout",
]);

export function isRelatedParcelLookupBusyError(message) {
  return RELATED_PARCEL_LOOKUP_BUSY_ERRORS.has(String(message || ""));
}

export function relatedParcelLookupRequestKey(address) {
  return String(address || "")
    .split(",")[0]
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/**
 * Bounds calls to the comparatively slow official DCAD address endpoint.
 * Identical lookups are single-flight across callers, completed results are
 * cached briefly, and one principal cannot occupy the global queue alone.
 */
export function createRelatedParcelLookupExecutionGate({
  maxConcurrent = 2,
  maxQueued = 4,
  maxConcurrentPerPrincipal = 1,
  maxQueuedPerPrincipal = 1,
  queueTimeoutMs = 5_000,
  successCacheTtlMs = 5 * 60_000,
  unavailableCacheTtlMs = 15_000,
  maxCacheEntries = 64,
  now = Date.now,
} = {}) {
  const concurrency = boundedInteger(maxConcurrent, 2, 1, 4);
  const queueLimit = boundedInteger(maxQueued, 4, 0, 20);
  const principalConcurrency = boundedInteger(maxConcurrentPerPrincipal, 1, 1, 2);
  const principalQueueLimit = boundedInteger(maxQueuedPerPrincipal, 1, 0, 4);
  const waitLimit = boundedInteger(queueTimeoutMs, 5_000, 250, 60_000);
  const successCacheTtl = boundedInteger(
    successCacheTtlMs,
    5 * 60_000,
    0,
    30 * 60_000,
  );
  const unavailableCacheTtl = boundedInteger(
    unavailableCacheTtlMs,
    15_000,
    0,
    60_000,
  );
  const cacheLimit = boundedInteger(maxCacheEntries, 64, 0, 256);
  const clock = typeof now === "function" ? now : Date.now;
  const queue = [];
  const singleFlight = new Map();
  const completedCache = new Map();
  const activeByPrincipal = new Map();
  const queuedByPrincipal = new Map();
  let active = 0;
  let completed = 0;
  let failed = 0;
  let cacheHits = 0;

  function principalCount(counts, key) {
    return counts.get(key) || 0;
  }

  function adjustPrincipalCount(counts, key, delta) {
    const next = principalCount(counts, key) + delta;
    if (next > 0) counts.set(key, next);
    else counts.delete(key);
  }

  function pruneCache(currentTime = clock()) {
    for (const [key, entry] of completedCache) {
      if (entry.expiresAt <= currentTime) completedCache.delete(key);
    }
    while (completedCache.size > cacheLimit) {
      const oldestKey = completedCache.keys().next().value;
      if (oldestKey === undefined) break;
      completedCache.delete(oldestKey);
    }
  }

  function cachedValue(key) {
    if (!cacheLimit) return null;
    const currentTime = clock();
    const entry = completedCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= currentTime) {
      completedCache.delete(key);
      return null;
    }
    completedCache.delete(key);
    completedCache.set(key, entry);
    cacheHits += 1;
    return entry.value;
  }

  function cacheValue(key, value) {
    const ttl = value?.status === "unavailable"
      ? unavailableCacheTtl
      : successCacheTtl;
    if (!cacheLimit || !ttl) return;
    completedCache.delete(key);
    completedCache.set(key, {
      value,
      expiresAt: clock() + ttl,
    });
    pruneCache();
  }

  function snapshot() {
    return Object.freeze({
      active,
      queued: queue.length,
      in_flight: singleFlight.size,
      cached: completedCache.size,
      cache_hits: cacheHits,
      max_concurrent: concurrency,
      max_queued: queueLimit,
      max_concurrent_per_principal: principalConcurrency,
      max_queued_per_principal: principalQueueLimit,
      completed,
      failed,
      saturated: active >= concurrency && queue.length >= queueLimit,
    });
  }

  function start(job) {
    clearTimeout(job.timer);
    adjustPrincipalCount(queuedByPrincipal, job.principal, -1);
    active += 1;
    adjustPrincipalCount(activeByPrincipal, job.principal, 1);
    Promise.resolve()
      .then(job.operation)
      .then((value) => {
        completed += 1;
        cacheValue(job.key, value);
        job.resolve(value);
      }, (error) => {
        failed += 1;
        job.reject(error);
      })
      .finally(() => {
        active -= 1;
        adjustPrincipalCount(activeByPrincipal, job.principal, -1);
        singleFlight.delete(job.key);
        drain();
      });
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const index = queue.findIndex((job) => (
        principalCount(activeByPrincipal, job.principal) < principalConcurrency
      ));
      if (index < 0) break;
      const [job] = queue.splice(index, 1);
      start(job);
    }
  }

  function run(keyValue, principalValue, operation) {
    if (typeof operation !== "function") {
      return Promise.reject(new Error("related_parcel_lookup_operation_required"));
    }
    const key = String(keyValue || "").trim();
    if (!key) {
      return Promise.reject(new Error("related_parcel_lookup_key_required"));
    }
    const principal = String(principalValue || "").trim();
    if (!principal) {
      return Promise.reject(new Error("related_parcel_lookup_principal_required"));
    }
    const existing = singleFlight.get(key);
    if (existing) return existing;
    const cached = cachedValue(key);
    if (cached !== null) return Promise.resolve(cached);

    const principalActive = principalCount(activeByPrincipal, principal);
    const principalQueued = principalCount(queuedByPrincipal, principal);
    const canStart = active < concurrency && principalActive < principalConcurrency;
    if (!canStart && principalQueued >= principalQueueLimit) {
      return Promise.reject(
        new Error("related_parcel_lookup_principal_capacity_exceeded"),
      );
    }
    if (!canStart && queue.length >= queueLimit) {
      return Promise.reject(new Error("related_parcel_lookup_capacity_exceeded"));
    }

    let resolveJob;
    let rejectJob;
    const promise = new Promise((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job = {
      key,
      principal,
      operation,
      resolve: resolveJob,
      reject: rejectJob,
      timer: null,
    };
    job.timer = setTimeout(() => {
      const index = queue.indexOf(job);
      if (index < 0) return;
      queue.splice(index, 1);
      adjustPrincipalCount(queuedByPrincipal, principal, -1);
      singleFlight.delete(key);
      rejectJob(new Error("related_parcel_lookup_queue_timeout"));
    }, waitLimit);
    job.timer.unref?.();
    singleFlight.set(key, promise);
    queue.push(job);
    adjustPrincipalCount(queuedByPrincipal, principal, 1);
    drain();
    return promise;
  }

  return Object.freeze({ run, snapshot });
}

const sharedRelatedParcelLookupExecutionGate = createRelatedParcelLookupExecutionGate({
  maxConcurrent: process.env.RELATED_PARCELS_MAX_CONCURRENT,
  maxQueued: process.env.RELATED_PARCELS_MAX_QUEUED,
  maxConcurrentPerPrincipal: process.env.RELATED_PARCELS_MAX_CONCURRENT_PER_PRINCIPAL,
  maxQueuedPerPrincipal: process.env.RELATED_PARCELS_MAX_QUEUED_PER_PRINCIPAL,
  queueTimeoutMs: process.env.RELATED_PARCELS_QUEUE_TIMEOUT_MS,
  successCacheTtlMs: process.env.RELATED_PARCELS_CACHE_TTL_MS,
  unavailableCacheTtlMs: process.env.RELATED_PARCELS_UNAVAILABLE_CACHE_TTL_MS,
  maxCacheEntries: process.env.RELATED_PARCELS_CACHE_MAX_ENTRIES,
});

export function runRelatedParcelLookupOperation(key, principal, operation) {
  return sharedRelatedParcelLookupExecutionGate.run(key, principal, operation);
}

export function getRelatedParcelLookupExecutionSnapshot() {
  return sharedRelatedParcelLookupExecutionGate.snapshot();
}
