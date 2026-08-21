import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";

export const REDTEAM_API_ORIGIN = "https://homenode-api-redteam.onrender.com";
export const REDTEAM_APP_ORIGIN = "https://homenode-uad-redteam.onrender.com";

const MAX_RESPONSE_BYTES = 64 * 1024;
const SENSITIVE_RESPONSE_PATTERN = new RegExp([
  "postgres(?:ql)?:\\/\\/",
  "r2_secret_access_key",
  "oidc_[a-z0-9_]*secret",
  "-----BEGIN [A-Z ]+PRIVATE KEY-----",
  "\\bat\\s+\\S+\\s+\\([^)]*:\\d+:\\d+\\)",
  "\\b(?:select|insert|update|delete)\\s+.+\\s+(?:from|into|set)\\b",
].join("|"), "i");

function normalizeRedTeamOrigin(value, expectedOrigin, errorCode) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(errorCode);
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.origin !== expectedOrigin
    || !parsed.hostname.includes("redteam")
  ) {
    throw new Error(errorCode);
  }
  return parsed.origin;
}

export function normalizeUadRedTeamApiUrl(value) {
  return normalizeRedTeamOrigin(value, REDTEAM_API_ORIGIN, "invalid_uad_redteam_api_url");
}

export function normalizeUadRedTeamAppUrl(value) {
  return normalizeRedTeamOrigin(value, REDTEAM_APP_ORIGIN, "invalid_uad_redteam_app_url");
}

async function readBoundedBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      return { body: null, errorCode: "response_too_large" };
    }
    return { body: text, errorCode: null };
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { body: null, errorCode: "response_too_large" };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { body: text, errorCode: null };
}

async function probe(fetchImpl, url, { timeoutMs, ...init } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: "error",
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: null, body: null, bodyText: "", errorCode: "request_failed", headers: {} };
  }

  const bounded = await readBoundedBody(response);
  const bodyText = bounded.body || "";
  let body = null;
  if (!bounded.errorCode && bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
  }
  const header = (name) => response.headers?.get?.(name) || null;
  return {
    status: response.status,
    body,
    bodyText,
    errorCode: bounded.errorCode,
    headers: {
      accessControlAllowHeaders: header("access-control-allow-headers"),
      accessControlAllowOrigin: header("access-control-allow-origin"),
      cacheControl: header("cache-control"),
      contentSecurityPolicy: header("content-security-policy"),
      contentType: header("content-type"),
      strictTransportSecurity: header("strict-transport-security"),
      vary: header("vary"),
      xContentTypeOptions: header("x-content-type-options"),
      xFrameOptions: header("x-frame-options"),
      xPoweredBy: header("x-powered-by"),
    },
  };
}

function safeBody(result) {
  return !result.errorCode
    && result.bodyText.length <= MAX_RESPONSE_BYTES
    && !SENSITIVE_RESPONSE_PATTERN.test(result.bodyText);
}

function exactError(result, status, code) {
  return result.status === status
    && safeBody(result)
    && result.body
    && Object.keys(result.body).length === 1
    && result.body.error === code;
}

function evidenceErrorCode(result) {
  if (result.errorCode) return result.errorCode;
  const candidate = result.body?.error;
  if (candidate == null) return null;
  return /^[a-z][a-z0-9_]{0,119}$/.test(String(candidate))
    ? String(candidate)
    : "unsafe_error_response";
}

function complianceIsDisabled(capabilities) {
  const compliance = capabilities?.compliance;
  const providers = Object.values(compliance?.providers || {});
  return compliance?.enabled === false
    && providers.every((provider) => provider?.enabled === false && provider?.configured === false);
}

export async function runUadRedTeamBaseline({
  baseUrl = REDTEAM_API_ORIGIN,
  appUrl = REDTEAM_APP_ORIGIN,
  fixtureAccountId = "UAD-REDTEAM-SFR-0001",
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  const base = normalizeUadRedTeamApiUrl(baseUrl);
  const app = normalizeUadRedTeamAppUrl(appUrl);
  const timeout = Math.max(1_000, Math.min(Number(timeoutMs) || 15_000, 30_000));
  const account = encodeURIComponent(String(fixtureAccountId || ""));
  if (!/^UAD-REDTEAM-[0-9A-Z-]+$/.test(String(fixtureAccountId || ""))) {
    throw new Error("invalid_uad_redteam_fixture_account");
  }

  const health = await probe(fetchImpl, `${base}/health`, {
    timeoutMs: timeout,
    headers: { accept: "application/json" },
  });
  const capabilities = await probe(fetchImpl, `${base}/api/uad/capabilities`, {
    timeoutMs: timeout,
    headers: { accept: "application/json" },
  });
  const readiness = await probe(fetchImpl, `${base}/api/uad/readiness`, {
    timeoutMs: timeout,
    headers: { accept: "application/json" },
  });
  const protectedPath = `${base}/api/uad/accounts/${account}/workfiles`;
  const missingToken = await probe(fetchImpl, protectedPath, {
    timeoutMs: timeout,
    headers: { accept: "application/json" },
  });
  const malformedToken = await probe(fetchImpl, protectedPath, {
    timeoutMs: timeout,
    headers: { accept: "application/json", authorization: "Bearer redteam.invalid.token" },
  });
  const deniedOrigin = await probe(fetchImpl, `${base}/api/uad/capabilities`, {
    timeoutMs: timeout,
    headers: { accept: "application/json", origin: "https://attacker.invalid" },
  });
  const allowedPreflight = await probe(fetchImpl, `${base}/api/uad/capabilities`, {
    timeoutMs: timeout,
    method: "OPTIONS",
    headers: {
      origin: app,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization,content-type,idempotency-key",
    },
  });
  const webApp = await probe(fetchImpl, `${app}/uad-3.6/${account}`, {
    timeoutMs: timeout,
    headers: { accept: "text/html" },
  });

  const capabilitiesBody = capabilities.body || {};
  const readinessBody = readiness.body || {};
  const checks = {
    health: {
      ready: health.status === 200 && health.body?.ok === true && safeBody(health),
      http_status: health.status,
      error_code: health.errorCode,
    },
    strict_capabilities: {
      ready: capabilities.status === 200
        && safeBody(capabilities)
        && capabilitiesBody.enabled === true
        && capabilitiesBody.specification_release_key === CURRENT_UAD_RELEASE_KEY
        && capabilitiesBody.object_storage?.configured === true
        && capabilitiesBody.authentication?.required === true
        && capabilitiesBody.authentication?.configured === true
        && capabilitiesBody.security?.strict === true
        && capabilitiesBody.security?.cors_restricted === true
        && capabilitiesBody.security?.rate_limit_enabled === true,
      http_status: capabilities.status,
      release_key: capabilitiesBody.specification_release_key || null,
      error_code: capabilities.errorCode,
    },
    operational_readiness: {
      ready: readiness.status === 200
        && safeBody(readiness)
        && readinessBody.ok === true
        && readinessBody.local_delivery_ready === true
        && Array.isArray(readinessBody.blockers)
        && readinessBody.blockers.length === 0,
      http_status: readiness.status,
      status: readinessBody.status || null,
      blocker_count: Array.isArray(readinessBody.blockers) ? readinessBody.blockers.length : null,
      no_store: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(readiness.headers.cacheControl || ""),
      error_code: readiness.errorCode,
    },
    external_providers_disabled: {
      ready: capabilities.status === 200 && complianceIsDisabled(capabilitiesBody),
      compliance_enabled: capabilitiesBody.compliance?.enabled === true,
      configured_provider_count: Object.values(capabilitiesBody.compliance?.providers || {})
        .filter((provider) => provider?.configured === true).length,
    },
    missing_token: {
      ready: exactError(missingToken, 401, "invalid_access_token"),
      http_status: missingToken.status,
      error_code: evidenceErrorCode(missingToken),
    },
    malformed_token: {
      ready: exactError(malformedToken, 401, "invalid_access_token"),
      http_status: malformedToken.status,
      error_code: evidenceErrorCode(malformedToken),
    },
    denied_origin: {
      ready: exactError(deniedOrigin, 403, "cors_origin_denied")
        && deniedOrigin.headers.accessControlAllowOrigin === null,
      http_status: deniedOrigin.status,
      allow_origin_present: deniedOrigin.headers.accessControlAllowOrigin !== null,
      error_code: evidenceErrorCode(deniedOrigin),
    },
    allowed_preflight: {
      ready: allowedPreflight.status === 204
        && allowedPreflight.headers.accessControlAllowOrigin === app
        && /authorization/i.test(allowedPreflight.headers.accessControlAllowHeaders || "")
        && /idempotency-key/i.test(allowedPreflight.headers.accessControlAllowHeaders || "")
        && /origin/i.test(allowedPreflight.headers.vary || ""),
      http_status: allowedPreflight.status,
      exact_origin: allowedPreflight.headers.accessControlAllowOrigin === app,
      error_code: allowedPreflight.errorCode,
    },
    security_headers: {
      ready: capabilities.headers.xPoweredBy === null
        && capabilities.headers.xContentTypeOptions === "nosniff"
        && capabilities.headers.xFrameOptions === "DENY"
        && /frame-ancestors 'none'/i.test(capabilities.headers.contentSecurityPolicy || "")
        && /max-age=31536000/i.test(capabilities.headers.strictTransportSecurity || ""),
      x_powered_by_absent: capabilities.headers.xPoweredBy === null,
      nosniff: capabilities.headers.xContentTypeOptions === "nosniff",
      frame_denied: capabilities.headers.xFrameOptions === "DENY",
    },
    web_app: {
      ready: webApp.status === 200
        && !webApp.errorCode
        && /text\/html/i.test(webApp.headers.contentType || "")
        && webApp.bodyText.includes('id="root"')
        && safeBody(webApp),
      http_status: webApp.status,
      error_code: webApp.errorCode,
    },
  };

  return Object.freeze({
    ok: Object.values(checks).every((check) => check.ready === true),
    profile: "uad_redteam_unauthenticated_baseline_v1",
    checked_at: checkedAt,
    base_url: base,
    app_url: app,
    fixture_account_id: String(fixtureAccountId),
    request_count: 8,
    checks,
  });
}
