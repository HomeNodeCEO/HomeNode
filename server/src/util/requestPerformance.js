const DEFAULT_WARN_MS = 750;
const DEFAULT_SLOW_MS = 1_500;
const DEFAULT_WINDOW_SIZE = 500;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function environmentFlag(value, { defaultEnabled = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultEnabled;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

export function normalizePerformancePath(value) {
  const path = String(value || "/").split("?")[0] || "/";
  return path
    .replace(/\b[0-9A-Za-z]{17}\b/g, ":accountId")
    .replace(/\/assignment-files\/\d+(?=\/|$)/g, "/assignment-files/:fileId")
    .replace(/\/\d{4,}(?=\/|$)/g, "/:id");
}

export function percentile(values, requestedPercentile) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const rank = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((Number(requestedPercentile) / 100) * sorted.length) - 1),
  );
  return sorted[rank];
}

function roundedMilliseconds(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

export function createRequestPerformanceMonitor({
  pool = null,
  logger = console,
  env = process.env,
  now = () => process.hrtime.bigint(),
} = {}) {
  const warnMs = boundedInteger(env.PERFORMANCE_WARN_MS, DEFAULT_WARN_MS, 50, 60_000);
  const slowMs = boundedInteger(env.PERFORMANCE_SLOW_MS, DEFAULT_SLOW_MS, warnMs, 120_000);
  const windowSize = boundedInteger(
    env.PERFORMANCE_WINDOW_SIZE,
    DEFAULT_WINDOW_SIZE,
    25,
    5_000,
  );
  const logAll = environmentFlag(env.PERFORMANCE_LOG_ALL);
  const samples = [];

  function poolSnapshot() {
    if (!pool) return null;
    return {
      total: Number(pool.totalCount || 0),
      idle: Number(pool.idleCount || 0),
      waiting: Number(pool.waitingCount || 0),
    };
  }

  function record(sample) {
    samples.push(sample);
    if (samples.length > windowSize) samples.splice(0, samples.length - windowSize);
  }

  function middleware(req, res, next) {
    const startedAt = now();
    res.once("finish", () => {
      const durationMs = Number(now() - startedAt) / 1_000_000;
      const sample = {
        method: String(req.method || "GET").toUpperCase(),
        path: normalizePerformancePath(req.path || req.originalUrl),
        status: Number(res.statusCode || 0),
        duration_ms: roundedMilliseconds(durationMs),
        response_bytes: Number(res.getHeader?.("content-length") || 0) || null,
        recorded_at: new Date().toISOString(),
      };
      record(sample);

      const logPayload = { ...sample, database_pool: poolSnapshot() };
      if (sample.status >= 500 || durationMs >= slowMs) {
        logger.warn?.("[performance] slow request", logPayload);
      } else if (durationMs >= warnMs) {
        logger.info?.("[performance] request above target", logPayload);
      } else if (logAll) {
        logger.info?.("[performance] request", logPayload);
      }
    });
    next();
  }

  function snapshot() {
    const durations = samples.map((sample) => sample.duration_ms);
    const byRoute = new Map();
    for (const sample of samples) {
      const key = `${sample.method} ${sample.path}`;
      const current = byRoute.get(key) || [];
      current.push(sample.duration_ms);
      byRoute.set(key, current);
    }
    const slowestRoutes = [...byRoute.entries()]
      .map(([route, routeDurations]) => ({
        route,
        requests: routeDurations.length,
        p95_ms: roundedMilliseconds(percentile(routeDurations, 95)),
        maximum_ms: roundedMilliseconds(Math.max(...routeDurations)),
      }))
      .sort((left, right) => right.p95_ms - left.p95_ms)
      .slice(0, 10);

    return {
      targets: { warn_ms: warnMs, slow_ms: slowMs },
      window: {
        capacity: windowSize,
        requests: samples.length,
        p50_ms: roundedMilliseconds(percentile(durations, 50)),
        p95_ms: roundedMilliseconds(percentile(durations, 95)),
        maximum_ms: roundedMilliseconds(durations.length ? Math.max(...durations) : 0),
        above_target: samples.filter((sample) => sample.duration_ms >= warnMs).length,
        server_errors: samples.filter((sample) => sample.status >= 500).length,
      },
      database_pool: poolSnapshot(),
      slowest_routes: slowestRoutes,
    };
  }

  return { middleware, snapshot };
}
