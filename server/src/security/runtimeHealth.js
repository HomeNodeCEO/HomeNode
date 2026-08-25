function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function memorySnapshot(memoryUsage) {
  const memory = memoryUsage();
  return Object.freeze({
    rss_mb: Math.round(Number(memory.rss || 0) / 1024 / 1024),
    heap_used_mb: Math.round(Number(memory.heapUsed || 0) / 1024 / 1024),
    external_mb: Math.round(Number(memory.external || 0) / 1024 / 1024),
  });
}

async function queryWithDeadline(pool, timeoutMs) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => pool.query({
        text: "SELECT 1 AS ready",
        query_timeout: timeoutMs,
      })),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("database_readiness_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createRuntimeHealthHandlers({
  pool,
  isShuttingDown = () => false,
  artifactExecutorSnapshot = () => ({ ready: true, active: 0, queued: 0 }),
  memoryUsage = () => process.memoryUsage(),
  constrainedMemory = () => process.constrainedMemory?.(),
  environment = process.env,
} = {}) {
  if (!pool?.query) throw new Error("runtime_health_pool_required");
  const maxWaitingClients = boundedInteger(
    environment.READINESS_MAX_DATABASE_WAITERS,
    5,
    0,
    1_000,
  );
  const databaseProbeTimeoutMs = boundedInteger(
    environment.READINESS_DATABASE_TIMEOUT_MS,
    2_000,
    100,
    10_000,
  );
  const constrainedBytes = Number(constrainedMemory() || 0);
  const constrainedDefaultMb = constrainedBytes > 0
    ? Math.floor((constrainedBytes / 1024 / 1024) * 0.85)
    : 0;
  const maxRssMb = boundedInteger(
    environment.READINESS_MAX_RSS_MB,
    constrainedDefaultMb,
    0,
    65_536,
  );

  function liveness(_req, res) {
    const shuttingDown = Boolean(isShuttingDown());
    res.set("cache-control", "no-store");
    return res.status(shuttingDown ? 503 : 200).json({
      ok: !shuttingDown,
      status: shuttingDown ? "shutting_down" : "live",
    });
  }

  async function readiness(_req, res) {
    res.set("cache-control", "no-store");
    const blockers = [];
    if (isShuttingDown()) blockers.push("server_shutting_down");
    let databaseConnected = false;
    try {
      await queryWithDeadline(pool, databaseProbeTimeoutMs);
      databaseConnected = true;
    } catch {
      blockers.push("database_unavailable");
    }
    const waiting = Number(pool.waitingCount || 0);
    if (waiting > maxWaitingClients) blockers.push("database_pool_saturated");
    const artifacts = artifactExecutorSnapshot();
    if (artifacts?.ready === false) blockers.push("artifact_executor_unavailable");
    const memory = memorySnapshot(memoryUsage);
    if (maxRssMb > 0 && memory.rss_mb >= maxRssMb) blockers.push("memory_pressure");
    const ok = blockers.length === 0;
    return res.status(ok ? 200 : 503).json({
      ok,
      status: ok ? "ready" : "degraded",
      blockers,
      checks: {
        database: {
          connected: databaseConnected,
          pool: {
            total: Number(pool.totalCount || 0),
            idle: Number(pool.idleCount || 0),
            waiting,
            maximum_waiting: maxWaitingClients,
            probe_timeout_ms: databaseProbeTimeoutMs,
          },
        },
        artifact_executor: artifacts,
        memory: { ...memory, maximum_rss_mb: maxRssMb || null },
      },
    });
  }

  return Object.freeze({ liveness, readiness });
}
