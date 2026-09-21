import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";
import {
  readBoundedJsonResponse,
  readBoundedResponseBuffer,
} from "../../util/boundedResponse.js";

const DEFAULT_FIXTURE_ACCOUNT_ID = "UAD-STAGING-SFR-0001";
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_RESPONSE_BYTES = 2 * 1024 * 1024;

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The smoke check already has its result; cancellation is best-effort cleanup.
  }
}

function responseStatus(response) {
  return Number.isInteger(response?.status)
    && response.status >= 100
    && response.status <= 599
    ? response.status
    : null;
}

export function normalizeUadSmokeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:"))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("invalid_uad_staging_base_url");
  }
  return url.toString().replace(/\/$/, "");
}

async function getJson(fetchImpl, url, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
  } catch {
    return { ok: false, status: null, body: null, error_code: "request_failed" };
  }
  const status = responseStatus(response);
  if (!response.ok) {
    await cancelResponseBody(response);
    return { ok: false, status, body: null, error_code: "http_error" };
  }
  let body = null;
  try {
    body = await readBoundedJsonResponse(response, {
      maximumBytes: MAX_JSON_RESPONSE_BYTES,
      tooLargeCode: "uad_smoke_response_too_large",
      unavailableCode: "uad_smoke_response_unavailable",
    });
  } catch (error) {
    const errorCode = signal.aborted
      ? "request_failed"
      : error?.message === "uad_smoke_response_too_large"
        ? "response_too_large"
        : "invalid_json";
    return { ok: false, status, body: null, error_code: errorCode };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status, body: null, error_code: "invalid_json" };
  }
  return {
    ok: true,
    status,
    body,
    error_code: null,
  };
}

async function getHtml(fetchImpl, url, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "text/html" },
      redirect: "error",
      signal,
    });
  } catch {
    return { ok: false, status: null, error_code: "request_failed" };
  }
  const status = responseStatus(response);
  if (!response.ok) {
    await cancelResponseBody(response);
    return { ok: false, status, error_code: "http_error" };
  }
  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
  if (!contentType.includes("text/html")) {
    await cancelResponseBody(response);
    return { ok: false, status, error_code: "invalid_content_type" };
  }
  let body;
  try {
    body = (await readBoundedResponseBuffer(response, {
      maximumBytes: MAX_HTML_RESPONSE_BYTES,
      tooLargeCode: "uad_smoke_response_too_large",
      unavailableCode: "uad_smoke_response_unavailable",
    })).toString("utf8");
  } catch (error) {
    return {
      ok: false,
      status,
      error_code: signal.aborted
        ? "request_failed"
        : error?.message === "uad_smoke_response_too_large"
          ? "response_too_large"
          : "invalid_html",
    };
  }
  const ok = body.includes("id=\"root\"");
  return { ok, status, error_code: ok ? null : "invalid_html" };
}

export async function runUadStagingSmoke({
  baseUrl,
  appUrl = null,
  fixtureAccountId = DEFAULT_FIXTURE_ACCOUNT_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  requireCompliance = false,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_staging_fetch_unavailable");
  const base = normalizeUadSmokeBaseUrl(baseUrl);
  const appBase = appUrl ? normalizeUadSmokeBaseUrl(appUrl) : null;
  const timeout = Math.max(1_000, Math.min(Number(timeoutMs) || 15_000, 60_000));
  const account = encodeURIComponent(String(fixtureAccountId || DEFAULT_FIXTURE_ACCOUNT_ID));
  const [health, capabilities, readiness, fixture, webApp] = await Promise.all([
    getJson(fetchImpl, `${base}/health`, timeout),
    getJson(fetchImpl, `${base}/api/uad/capabilities`, timeout),
    getJson(fetchImpl, `${base}/api/uad/readiness`, timeout),
    getJson(fetchImpl, `${base}/api/uad/accounts/${account}/workfiles`, timeout),
    appBase
      ? getHtml(fetchImpl, `${appBase}/uad-3.6/${account}`, timeout)
      : Promise.resolve({ ok: true, status: null, error_code: null }),
  ]);

  const healthReady = health.ok && health.body?.ok === true;
  const capabilitiesReady = capabilities.ok
    && capabilities.body?.enabled === true
    && capabilities.body?.specification_release_key === CURRENT_UAD_RELEASE_KEY
    && capabilities.body?.object_storage?.configured === true
    && Number(capabilities.body?.xml?.mapped_total_unique_ids || 0) > 0;
  const operationalReady = readiness.ok
    && readiness.body?.ok === true
    && readiness.body?.specification_release_key === CURRENT_UAD_RELEASE_KEY
    && readiness.body?.local_delivery_ready === true;
  const fixtureReady = fixture.ok
    && Array.isArray(fixture.body?.workfiles)
    && fixture.body.workfiles.length > 0;
  const providers = readiness.body?.checks?.compliance?.providers || {};
  const complianceReady = Object.values(providers).some((provider) => provider?.ready === true);

  const checks = {
    health: { ready: healthReady, http_status: health.status, error_code: health.error_code },
    capabilities: {
      ready: capabilitiesReady,
      http_status: capabilities.status,
      enabled: capabilities.body?.enabled === true,
      specification_release_key: capabilities.body?.specification_release_key || null,
      mapped_field_count: Number(capabilities.body?.xml?.mapped_total_unique_ids || 0),
      object_storage_configured: capabilities.body?.object_storage?.configured === true,
      error_code: capabilities.error_code,
    },
    operational_readiness: {
      ready: operationalReady,
      http_status: readiness.status,
      status: readiness.body?.status || null,
      blockers: Array.isArray(readiness.body?.blockers) ? readiness.body.blockers.slice(0, 20) : [],
      error_code: readiness.error_code,
    },
    synthetic_fixture: {
      ready: fixtureReady,
      http_status: fixture.status,
      account_id: String(fixtureAccountId || DEFAULT_FIXTURE_ACCOUNT_ID),
      workfile_count: Array.isArray(fixture.body?.workfiles) ? fixture.body.workfiles.length : 0,
      error_code: fixture.error_code,
    },
    web_app: {
      required: Boolean(appBase),
      ready: webApp.ok,
      http_status: webApp.status,
      error_code: webApp.error_code,
    },
    external_compliance: {
      required: Boolean(requireCompliance),
      ready: complianceReady,
      providers: Object.fromEntries(Object.entries(providers).map(([key, provider]) => [key, {
        enabled: provider?.enabled === true,
        configured: provider?.configured === true,
        environment: provider?.environment || null,
        ready: provider?.ready === true,
      }])),
    },
  };
  const ok = healthReady && capabilitiesReady && operationalReady && fixtureReady && webApp.ok
    && (!requireCompliance || complianceReady);
  return {
    ok,
    checked_at: checkedAt,
    base_url: base,
    app_url: appBase,
    fixture_account_id: String(fixtureAccountId || DEFAULT_FIXTURE_ACCOUNT_ID),
    checks,
  };
}

export const uadStagingSmokeInternals = Object.freeze({
  MAX_HTML_RESPONSE_BYTES,
  MAX_JSON_RESPONSE_BYTES,
});
