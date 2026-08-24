import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const SENSITIVE_RESPONSE_PATTERN = /(?:postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+|\b(?:select|insert|update|delete)\s+.+\s+(?:from|into|set)\b)/i;

async function readBoundedText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bodyText = await response.text();
    return Buffer.byteLength(bodyText, "utf8") <= MAX_RESPONSE_BYTES
      ? { bodyText, error: null }
      : { bodyText: "", error: "response_too_large" };
  }
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { bodyText: "", error: "response_too_large" };
    }
    chunks.push(Buffer.from(value));
  }
  return { bodyText: Buffer.concat(chunks).toString("utf8"), error: null };
}

async function request(fetchImpl, url, { method = "GET", body, timeoutMs = 15_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1_000, Math.min(Number(timeoutMs) || 15_000, 30_000))),
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return { status: null, body: null, error: "request_failed", noStore: false, safe: true };
  }
  const bounded = await readBoundedText(response);
  if (bounded.error) {
    return { status: response.status, body: null, error: "response_too_large", noStore: false, safe: false };
  }
  const bodyText = bounded.bodyText;
  let parsed = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    return { status: response.status, body: null, error: "response_not_json", noStore: false, safe: false };
  }
  return {
    status: response.status,
    body: parsed,
    error: null,
    noStore: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers?.get?.("cache-control") || ""),
    safe: !SENSITIVE_RESPONSE_PATTERN.test(bodyText),
  };
}

function evidence(result, ready) {
  return Object.freeze({
    ready: Boolean(ready),
    http_status: result.status,
    error_code: result.error || result.body?.error || null,
    no_store: result.noStore,
    safe_response: result.safe,
  });
}

export async function runUadRedTeamKillSwitchCheck({
  baseUrl = REDTEAM_API_ORIGIN,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  const base = normalizeUadRedTeamApiUrl(baseUrl);
  const health = await request(fetchImpl, `${base}/health`, { timeoutMs });
  const capabilities = await request(fetchImpl, `${base}/api/uad/capabilities`, { timeoutMs });
  const readiness = await request(fetchImpl, `${base}/api/uad/readiness`, { timeoutMs });
  const protectedRead = await request(fetchImpl, `${base}/api/uad/workfiles/00000000-0000-4000-8000-000000000001`, { timeoutMs });
  const protectedWrite = await request(fetchImpl, `${base}/api/uad/accounts/UAD-REDTEAM-SFR-0001/workfiles`, {
    method: "POST",
    body: "{}",
    timeoutMs,
  });

  const healthReady = health.status === 200 && health.safe && health.body?.ok === true;
  const capabilitiesReady = capabilities.status === 200
    && capabilities.safe
    && capabilities.noStore
    && capabilities.body?.enabled === false;
  const readinessReady = readiness.status === 503
    && readiness.safe
    && readiness.noStore
    && readiness.body?.ok === false
    && readiness.body?.checks?.workspace?.enabled === false
    && readiness.body?.checks?.workspace?.ready === false
    && Array.isArray(readiness.body?.blockers)
    && readiness.body.blockers.includes("uad_workspace_disabled");
  const disabledResponse = (result) => result.status === 503
    && result.safe
    && result.noStore
    && result.body
    && Object.keys(result.body).length === 1
    && result.body.error === "uad_workspace_disabled";

  const checks = Object.freeze({
    health: evidence(health, healthReady),
    capabilities_disabled: evidence(capabilities, capabilitiesReady),
    readiness_degraded: evidence(readiness, readinessReady),
    protected_read_blocked: evidence(protectedRead, disabledResponse(protectedRead)),
    protected_write_blocked: evidence(protectedWrite, disabledResponse(protectedWrite)),
  });
  return Object.freeze({
    ok: Object.values(checks).every((check) => check.ready),
    profile: "uad_redteam_kill_switch_v1",
    checked_at: checkedAt,
    base_url: base,
    request_count: Object.keys(checks).length,
    checks,
  });
}
