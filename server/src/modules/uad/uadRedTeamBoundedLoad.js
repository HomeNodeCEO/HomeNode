import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RATE_LIMIT = 200;
const MAX_CONCURRENCY = 10;
const MAX_RECOVERY_WAIT_SECONDS = 70;
const SENSITIVE_RESPONSE_PATTERN = /(?:postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+|\b(?:select|insert|update|delete)\s+.+\s+(?:from|into|set)\b)/i;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function headerInteger(value, pattern) {
  const match = pattern.exec(String(value || ""));
  return match ? Number(match[1]) : null;
}

function rateLimitMetadata(headers) {
  const rateLimit = headers?.get?.("ratelimit") || "";
  const policy = headers?.get?.("ratelimit-policy") || "";
  return Object.freeze({
    limit: headerInteger(policy, /(?:^|;)\s*q=(\d+)\b/i)
      ?? headerInteger(rateLimit, /^\s*"?(\d+)-/i)
      ?? headerInteger(headers?.get?.("ratelimit-limit"), /^(\d+)$/),
    remaining: headerInteger(rateLimit, /(?:^|;)\s*r=(\d+)\b/i)
      ?? headerInteger(headers?.get?.("ratelimit-remaining"), /^(\d+)$/),
    resetSeconds: headerInteger(rateLimit, /(?:^|;)\s*t=(\d+)\b/i)
      ?? headerInteger(headers?.get?.("ratelimit-reset"), /^(\d+)$/),
    retryAfterSeconds: headerInteger(headers?.get?.("retry-after"), /^(\d+)$/),
  });
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, "utf8") > MAX_RESPONSE_BYTES) {
      return { body: null, safe: false, error: "response_too_large" };
    }
    try {
      return {
        body: bodyText ? JSON.parse(bodyText) : null,
        safe: !SENSITIVE_RESPONSE_PATTERN.test(bodyText),
        error: null,
      };
    } catch {
      return { body: null, safe: false, error: bodyText ? "response_not_json" : null };
    }
  }

  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { body: null, safe: false, error: "response_too_large" };
    }
    chunks.push(Buffer.from(value));
  }
  const bodyText = Buffer.concat(chunks).toString("utf8");
  try {
    return {
      body: bodyText ? JSON.parse(bodyText) : null,
      safe: !SENSITIVE_RESPONSE_PATTERN.test(bodyText),
      error: null,
    };
  } catch {
    return { body: null, safe: false, error: bodyText ? "response_not_json" : null };
  }
}

async function probe(fetchImpl, url, timeoutMs) {
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
  } catch {
    return {
      status: null,
      body: null,
      error: "request_failed",
      safe: true,
      noStore: false,
      elapsedMs: Math.round(performance.now() - started),
      rateLimit: Object.freeze({}),
    };
  }
  const parsed = await readBoundedJson(response);
  return {
    status: response.status,
    body: parsed.body,
    error: parsed.error,
    safe: parsed.safe,
    noStore: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers?.get?.("cache-control") || ""),
    elapsedMs: Math.round(performance.now() - started),
    rateLimit: rateLimitMetadata(response.headers),
  };
}

function percentile(values, requested) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * requested) - 1)];
}

function capabilityReady(result) {
  return result.status === 200
    && !result.error
    && result.safe
    && result.noStore
    && typeof result.body?.specification_release_key === "string";
}

function rateLimited(result) {
  return result.status === 429
    && !result.error
    && result.safe
    && result.noStore
    && result.body
    && Object.keys(result.body).length === 1
    && result.body.error === "rate_limit_exceeded"
    && Number.isInteger(result.rateLimit.retryAfterSeconds)
    && result.rateLimit.retryAfterSeconds >= 1
    && result.rateLimit.retryAfterSeconds <= MAX_RECOVERY_WAIT_SECONDS;
}

export async function runUadRedTeamBoundedLoad({
  baseUrl = REDTEAM_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  concurrency = 6,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  if (typeof sleep !== "function") throw new Error("uad_redteam_sleep_unavailable");
  const base = normalizeUadRedTeamApiUrl(baseUrl);
  const timeout = boundedInteger(timeoutMs, 10_000, 1_000, 30_000);
  const workerCount = boundedInteger(concurrency, 6, 1, MAX_CONCURRENCY);
  const capabilityUrl = `${base}/api/uad/capabilities`;

  let requestCount = 0;
  const request = async (url) => {
    requestCount += 1;
    return probe(fetchImpl, url, timeout);
  };
  const initial = await request(capabilityUrl);
  const configuredLimit = initial.rateLimit.limit;
  const initialRemaining = initial.rateLimit.remaining;
  const initialReady = capabilityReady(initial)
    && Number.isInteger(configuredLimit)
    && configuredLimit >= 10
    && configuredLimit <= MAX_RATE_LIMIT
    && Number.isInteger(initialRemaining)
    && initialRemaining >= 0
    && initialRemaining < configuredLimit;
  if (!initialReady) {
    return Object.freeze({
      ok: false,
      profile: "uad_redteam_bounded_load_v1",
      checked_at: checkedAt,
      base_url: base,
      request_count: requestCount,
      configured_limit: configuredLimit,
      concurrency: workerCount,
      initial_ready: false,
      load: Object.freeze({ ready: false }),
      recovery: Object.freeze({ ready: false }),
    });
  }

  const requestBudget = Math.min(MAX_RATE_LIMIT + MAX_CONCURRENCY, initialRemaining + workerCount + 1);
  const results = [];
  let nextRequest = 0;
  let stopScheduling = false;
  const worker = async () => {
    while (!stopScheduling) {
      const index = nextRequest;
      nextRequest += 1;
      if (index >= requestBudget) return;
      const result = await request(capabilityUrl);
      results.push(result);
      if (result.status === 429) stopScheduling = true;
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const successResponses = results.filter((result) => capabilityReady(result));
  const limitedResponses = results.filter((result) => rateLimited(result));
  const unexpectedResponses = results.filter((result) => (
    !capabilityReady(result) && !rateLimited(result)
  ));
  const firstLimited = limitedResponses[0] || null;
  const retryAfterSeconds = firstLimited?.rateLimit?.retryAfterSeconds ?? null;
  const timings = results.map((result) => result.elapsedMs).filter(Number.isFinite);
  const loadReady = limitedResponses.length >= 1
    && successResponses.length >= 1
    && unexpectedResponses.length === 0
    && results.length <= requestBudget
    && requestCount <= MAX_RATE_LIMIT + MAX_CONCURRENCY + 3;

  if (loadReady) {
    await sleep((retryAfterSeconds * 1_000) + 1_500);
  }
  const recoveredCapabilities = loadReady ? await request(capabilityUrl) : null;
  const recoveredReadiness = loadReady ? await request(`${base}/api/uad/readiness`) : null;
  const recoveryReady = loadReady
    && capabilityReady(recoveredCapabilities)
    && recoveredReadiness.status === 200
    && !recoveredReadiness.error
    && recoveredReadiness.safe
    && recoveredReadiness.noStore
    && recoveredReadiness.body?.ok === true;

  return Object.freeze({
    ok: loadReady && recoveryReady,
    profile: "uad_redteam_bounded_load_v1",
    checked_at: checkedAt,
    base_url: base,
    request_count: requestCount,
    configured_limit: configuredLimit,
    initial_remaining: initialRemaining,
    concurrency: workerCount,
    initial_ready: initialReady,
    load: Object.freeze({
      ready: loadReady,
      attempted_requests: results.length,
      successful_responses: successResponses.length,
      rate_limited_responses: limitedResponses.length,
      unexpected_responses: unexpectedResponses.length,
      retry_after_seconds: retryAfterSeconds,
      latency_ms: Object.freeze({
        p50: percentile(timings, 0.50),
        p95: percentile(timings, 0.95),
        p99: percentile(timings, 0.99),
        max: timings.length ? Math.max(...timings) : null,
      }),
    }),
    recovery: Object.freeze({
      ready: recoveryReady,
      capabilities_status: recoveredCapabilities?.status ?? null,
      readiness_status: recoveredReadiness?.status ?? null,
    }),
  });
}
