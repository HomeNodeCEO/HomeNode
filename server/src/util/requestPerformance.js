import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const DEFAULT_WARN_MS = 750;
const DEFAULT_SLOW_MS = 1_500;
const DEFAULT_WINDOW_SIZE = 500;
const DEFAULT_EVENT_LOOP_RESOLUTION_MS = 20;
const CLIENT_ERROR_SOURCE = "root_error_boundary";
const CLIENT_ERROR_TYPES = new Set([
  "aggregate_error",
  "chunk_load_error",
  "generic_error",
  "range_error",
  "reference_error",
  "syntax_error",
  "type_error",
  "uri_error",
]);
const CLIENT_ROUTE_CODES = new Set([
  "appraisal_report",
  "comparable_sales_analysis",
  "cost_approach",
  "final_reconciliation",
  "income_approach",
  "property_details",
  "property_report",
  "property_search",
  "property_tax_protest",
  "signup",
  "uad_workspace",
  "unknown",
]);

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
  const dynamicSegments = new Map([
    ["accounts", ":accountId"],
    ["assignment-files", ":fileId"],
    ["assets", ":assetId"],
    ["delivery-attempts", ":attemptId"],
    ["documents", ":documentId"],
    ["entities", ":entityId"],
    ["organizations", ":organizationId"],
    ["photos", ":photoId"],
    ["report-files", ":reportFileId"],
    ["signatures", ":signatureId"],
    ["users", ":userId"],
    ["workfiles", ":workfileId"],
  ]);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const placeholder = dynamicSegments.get(String(segments[index - 1] || "").toLowerCase());
    if (placeholder && segments[index] && !segments[index].startsWith(":")) {
      segments[index] = placeholder;
    } else if (uuidPattern.test(segments[index])) {
      segments[index] = ":id";
    } else if (/^\d{4,}$/.test(segments[index])) {
      segments[index] = ":id";
    }
  }
  return segments.join("/");
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

function nanosecondsToMilliseconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundedMilliseconds(parsed / 1_000_000) : 0;
}

function utilizationPercent(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.round(Math.max(0, Math.min(1, parsed)) * 1_000) / 10
    : 0;
}

export function createRequestPerformanceMonitor({
  pool = null,
  logger = console,
  env = process.env,
  now = () => process.hrtime.bigint(),
  createEventLoopDelayMonitor = monitorEventLoopDelay,
  eventLoopUtilization = () => performance.eventLoopUtilization(),
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
  const eventLoopResolutionMs = boundedInteger(
    env.PERFORMANCE_EVENT_LOOP_RESOLUTION_MS,
    DEFAULT_EVENT_LOOP_RESOLUTION_MS,
    10,
    1_000,
  );
  const eventLoopDelay = createEventLoopDelayMonitor({ resolution: eventLoopResolutionMs });
  if (!eventLoopDelay || typeof eventLoopDelay.enable !== "function") {
    throw new TypeError("performance_event_loop_monitor_required");
  }
  eventLoopDelay.enable();
  const samples = [];
  const clientErrorSamples = [];

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

  function recordClientError(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    if (event.source !== CLIENT_ERROR_SOURCE) return false;
    const keys = Object.keys(event).sort();
    if (keys.join(",") !== "error_type,route_code,source") return false;
    if (!CLIENT_ERROR_TYPES.has(event.error_type) || !CLIENT_ROUTE_CODES.has(event.route_code)) {
      return false;
    }
    const errorType = event.error_type;
    const routeCode = event.route_code;
    const sample = {
      source: CLIENT_ERROR_SOURCE,
      error_type: errorType,
      route_code: routeCode,
      recorded_at: new Date().toISOString(),
    };
    clientErrorSamples.push(sample);
    if (clientErrorSamples.length > windowSize) {
      clientErrorSamples.splice(0, clientErrorSamples.length - windowSize);
    }
    logger.error?.("[frontend] application render failure", {
      code: "application_render_failure",
      error_type: errorType,
      route_code: routeCode,
    });
    return true;
  }

  function middleware(req, res, next) {
    const startedAt = now();
    let recorded = false;
    const finalize = (outcome) => {
      if (recorded) return;
      recorded = true;
      const durationMs = Number(now() - startedAt) / 1_000_000;
      const sample = {
        method: String(req.method || "GET").toUpperCase(),
        path: normalizePerformancePath(req.path || req.originalUrl),
        status: outcome === "completed" ? Number(res.statusCode || 0) : 0,
        outcome,
        duration_ms: roundedMilliseconds(durationMs),
        response_bytes: outcome === "completed"
          ? Number(res.getHeader?.("content-length") || 0) || null
          : null,
        recorded_at: new Date().toISOString(),
      };
      record(sample);

      const logPayload = { ...sample, database_pool: poolSnapshot() };
      if (sample.outcome !== "completed") {
        logger.warn?.("[performance] request closed before completion", logPayload);
      } else if (sample.status >= 500 || durationMs >= slowMs) {
        logger.warn?.("[performance] slow request", logPayload);
      } else if (durationMs >= warnMs) {
        logger.info?.("[performance] request above target", logPayload);
      } else if (logAll) {
        logger.info?.("[performance] request", logPayload);
      }
    };
    res.once("finish", () => finalize("completed"));
    res.once("close", () => finalize("closed_before_finish"));
    next();
  }

  function eventLoopSnapshot() {
    const samplesRecorded = Number(eventLoopDelay.count || 0);
    const utilization = eventLoopUtilization?.() || {};
    return {
      delay: {
        resolution_ms: eventLoopResolutionMs,
        samples: samplesRecorded,
        sample_state: samplesRecorded > 0 ? "ready" : "warming",
        mean_ms: samplesRecorded > 0 ? nanosecondsToMilliseconds(eventLoopDelay.mean) : 0,
        p50_ms: samplesRecorded > 0
          ? nanosecondsToMilliseconds(eventLoopDelay.percentile?.(50))
          : 0,
        p95_ms: samplesRecorded > 0
          ? nanosecondsToMilliseconds(eventLoopDelay.percentile?.(95))
          : 0,
        p99_ms: samplesRecorded > 0
          ? nanosecondsToMilliseconds(eventLoopDelay.percentile?.(99))
          : 0,
        maximum_ms: samplesRecorded > 0 ? nanosecondsToMilliseconds(eventLoopDelay.max) : 0,
      },
      utilization_percent: utilizationPercent(utilization.utilization),
    };
  }

  function clientErrorSnapshot() {
    const byRoute = new Map();
    const byType = new Map();
    for (const sample of clientErrorSamples) {
      byRoute.set(sample.route_code, Number(byRoute.get(sample.route_code) || 0) + 1);
      byType.set(sample.error_type, Number(byType.get(sample.error_type) || 0) + 1);
    }
    const counts = (values, key) => [...values.entries()]
      .map(([code, events]) => ({ [key]: code, events }))
      .sort((left, right) => right.events - left.events || String(left[key]).localeCompare(right[key]));
    return {
      window: {
        capacity: windowSize,
        events: clientErrorSamples.length,
        last_recorded_at: clientErrorSamples.at(-1)?.recorded_at || null,
      },
      by_route: counts(byRoute, "route_code"),
      by_error_type: counts(byType, "error_type"),
    };
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
      .map(([route, routeDurations]) => {
        const routeSamples = samples.filter(
          (sample) => `${sample.method} ${sample.path}` === route,
        );
        return {
          route,
          requests: routeDurations.length,
          average_ms: roundedMilliseconds(
            routeDurations.reduce((sum, duration) => sum + duration, 0) /
              routeDurations.length,
          ),
          p50_ms: roundedMilliseconds(percentile(routeDurations, 50)),
          p95_ms: roundedMilliseconds(percentile(routeDurations, 95)),
          maximum_ms: roundedMilliseconds(Math.max(...routeDurations)),
          above_target: routeDurations.filter((duration) => duration >= warnMs).length,
          completed: routeSamples.filter((sample) => sample.outcome === "completed").length,
          interrupted: routeSamples.filter((sample) => sample.outcome !== "completed").length,
          client_errors: routeSamples.filter((sample) => sample.status >= 400 && sample.status < 500).length,
          server_errors: routeSamples.filter((sample) => sample.status >= 500).length,
        };
      })
      .sort((left, right) => right.p95_ms - left.p95_ms)
      .slice(0, 10);

    return {
      targets: { warn_ms: warnMs, slow_ms: slowMs },
      window: {
        capacity: windowSize,
        requests: samples.length,
        minimum_ready_samples: Math.min(25, windowSize),
        sample_state: samples.length >= Math.min(25, windowSize) ? "ready" : "warming",
        p50_ms: roundedMilliseconds(percentile(durations, 50)),
        p95_ms: roundedMilliseconds(percentile(durations, 95)),
        maximum_ms: roundedMilliseconds(durations.length ? Math.max(...durations) : 0),
        above_target: samples.filter((sample) => sample.duration_ms >= warnMs).length,
        completed: samples.filter((sample) => sample.outcome === "completed").length,
        interrupted: samples.filter((sample) => sample.outcome !== "completed").length,
        client_errors: samples.filter((sample) => sample.status >= 400 && sample.status < 500).length,
        server_errors: samples.filter((sample) => sample.status >= 500).length,
      },
      database_pool: poolSnapshot(),
      event_loop: eventLoopSnapshot(),
      browser_recovery: clientErrorSnapshot(),
      slowest_routes: slowestRoutes,
    };
  }

  function dispose() {
    eventLoopDelay.disable?.();
  }

  return Object.freeze({ middleware, snapshot, recordClientError, dispose });
}
