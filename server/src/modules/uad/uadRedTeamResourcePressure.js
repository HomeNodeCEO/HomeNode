import { brotliCompressSync, gzipSync } from "node:zlib";

import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MIXED_REQUESTS = 36;
const MAX_CONCURRENCY = 8;
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
      ?? headerInteger(rateLimit, /^\s*"?(\d+)-/i),
    remaining: headerInteger(rateLimit, /(?:^|;)\s*r=(\d+)\b/i),
    retryAfterSeconds: headerInteger(headers?.get?.("retry-after"), /^(\d+)$/),
  });
}

async function readBounded(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, "utf8") > MAX_RESPONSE_BYTES) {
      return { body: null, safe: false, error: "response_too_large" };
    }
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* status-only evidence */ }
    return { body, safe: !SENSITIVE_RESPONSE_PATTERN.test(bodyText), error: null };
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
  let body = null;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { /* status-only evidence */ }
  return { body, safe: !SENSITIVE_RESPONSE_PATTERN.test(bodyText), error: null };
}

async function probe(fetchImpl, url, timeoutMs, init = {}) {
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return Object.freeze({
      status: null,
      body: null,
      safe: true,
      error: "request_failed",
      elapsedMs: Math.round(performance.now() - started),
      noStore: false,
      rateLimit: Object.freeze({}),
    });
  }
  const parsed = await readBounded(response);
  return Object.freeze({
    status: response.status,
    body: parsed.body,
    safe: parsed.safe,
    error: parsed.error,
    elapsedMs: Math.round(performance.now() - started),
    noStore: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers?.get?.("cache-control") || ""),
    rateLimit: rateLimitMetadata(response.headers),
  });
}

function percentile(values, requested) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * requested) - 1)];
}

function exactError(result, status, code) {
  return result.status === status
    && result.safe
    && !result.error
    && result.noStore
    && result.body
    && Object.keys(result.body).length === 1
    && result.body.error === code;
}

function pressureResponseReady(result) {
  if (!result.safe || result.error || result.status == null || result.status >= 500) return false;
  if (result.status === 429) {
    return Number.isInteger(result.rateLimit.retryAfterSeconds)
      && result.rateLimit.retryAfterSeconds >= 1
      && result.rateLimit.retryAfterSeconds <= MAX_RECOVERY_WAIT_SECONDS;
  }
  return [200, 401].includes(result.status);
}

export async function runUadRedTeamResourcePressure({
  baseUrl = REDTEAM_API_ORIGIN,
  fixtureAccountId = "UAD-REDTEAM-SFR-0001",
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  concurrency = 6,
  mixedRequests = 24,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  if (typeof sleep !== "function") throw new Error("uad_redteam_sleep_unavailable");
  const base = normalizeUadRedTeamApiUrl(baseUrl);
  if (!/^UAD-REDTEAM-[0-9A-Z-]+$/.test(String(fixtureAccountId || ""))) {
    throw new Error("invalid_uad_redteam_fixture_account");
  }
  const timeout = boundedInteger(timeoutMs, 15_000, 1_000, 30_000);
  const workerCount = boundedInteger(concurrency, 6, 1, MAX_CONCURRENCY);
  const requestedMixedCount = boundedInteger(mixedRequests, 24, 6, MAX_MIXED_REQUESTS);
  const account = encodeURIComponent(String(fixtureAccountId));
  let requestCount = 0;
  const request = async (path, init) => {
    requestCount += 1;
    return probe(fetchImpl, `${base}${path}`, timeout, init);
  };

  const initial = await request("/api/uad/capabilities", {
    headers: { accept: "application/json" },
  });
  const advertisedLimit = initial.rateLimit.limit;
  const advertisedRemaining = initial.rateLimit.remaining;
  const initialReady = initial.status === 200
    && initial.safe
    && !initial.error
    && initial.noStore
    && Number.isInteger(advertisedLimit)
    && advertisedLimit >= 10
    && advertisedLimit <= 200
    && Number.isInteger(advertisedRemaining)
    && advertisedRemaining >= 5;
  if (!initialReady) {
    return Object.freeze({
      ok: false,
      profile: "uad_redteam_resource_pressure_v1",
      checked_at: checkedAt,
      base_url: base,
      request_count: requestCount,
      initial_ready: false,
      checks: Object.freeze({}),
    });
  }

  const expandedJson = Buffer.from(JSON.stringify({ value: "x".repeat(1_100_000) }));
  const compressedProbes = await Promise.all([
    request(`/api/uad/accounts/${account}/workfiles`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gzipSync(expandedJson),
    }),
    request(`/api/uad/accounts/${account}/workfiles`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "content-encoding": "br",
      },
      body: brotliCompressSync(expandedJson),
    }),
  ]);
  const headerPressure = await request("/api/uad/capabilities", {
    headers: { accept: "application/json", "x-redteam-bounded-header": "x".repeat(24 * 1024) },
  });

  const mixedCount = Math.min(
    requestedMixedCount,
    Math.max(6, advertisedRemaining - compressedProbes.length - 4),
  );
  const paths = [
    "/api/uad/capabilities",
    "/api/uad/readiness",
    `/api/uad/accounts/${account}/workfiles`,
  ];
  const mixedResults = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= mixedCount) return;
      mixedResults.push(await request(paths[index % paths.length], {
        headers: { accept: "application/json" },
      }));
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const limited = mixedResults.filter((result) => result.status === 429);
  const retryAfterSeconds = Math.max(0, ...limited.map(
    (result) => result.rateLimit.retryAfterSeconds || 0,
  ));
  if (retryAfterSeconds > 0) await sleep((retryAfterSeconds * 1_000) + 1_500);
  const [health, capabilities, readiness] = await Promise.all([
    request("/health", { headers: { accept: "application/json" } }),
    request("/api/uad/capabilities", { headers: { accept: "application/json" } }),
    request("/api/uad/readiness", { headers: { accept: "application/json" } }),
  ]);

  const timings = [...compressedProbes, headerPressure, ...mixedResults]
    .map((result) => result.elapsedMs)
    .filter(Number.isFinite);
  const checks = Object.freeze({
    compressed_expansion: Object.freeze({
      ready: compressedProbes.every((result) => exactError(result, 413, "request_body_too_large")),
      probe_count: compressedProbes.length,
      rejected_count: compressedProbes.filter((result) => result.status === 413).length,
    }),
    header_pressure: Object.freeze({
      ready: headerPressure.safe
        && !headerPressure.error
        && headerPressure.status != null
        && headerPressure.status < 500,
      http_status: headerPressure.status,
    }),
    mixed_concurrency: Object.freeze({
      ready: mixedResults.length === mixedCount && mixedResults.every(pressureResponseReady),
      concurrency: workerCount,
      attempted_requests: mixedResults.length,
      rate_limited_responses: limited.length,
      server_error_responses: mixedResults.filter((result) => result.status >= 500).length,
      transport_errors: mixedResults.filter((result) => result.error).length,
      latency_ms: Object.freeze({
        p50: percentile(timings, 0.5),
        p95: percentile(timings, 0.95),
        p99: percentile(timings, 0.99),
        max: timings.length ? Math.max(...timings) : null,
      }),
    }),
    recovery: Object.freeze({
      ready: health.status === 200
        && health.safe
        && health.body?.ok === true
        && capabilities.status === 200
        && capabilities.safe
        && capabilities.noStore
        && readiness.status === 200
        && readiness.safe
        && readiness.noStore
        && readiness.body?.ok === true,
      health_status: health.status,
      capabilities_status: capabilities.status,
      readiness_status: readiness.status,
    }),
  });
  return Object.freeze({
    ok: Object.values(checks).every((check) => check.ready),
    profile: "uad_redteam_resource_pressure_v1",
    checked_at: checkedAt,
    base_url: base,
    fixture_account_id: String(fixtureAccountId),
    request_count: requestCount,
    initial_ready: true,
    advertised_limit: advertisedLimit,
    checks,
  });
}
