import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";

const DEFAULT_FIXTURE_ACCOUNT_ID = "UAD-STAGING-SFR-0001";

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
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, status: null, body: null, error_code: "request_failed" };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status, body: null, error_code: "invalid_json" };
  }
  return {
    ok: response.ok,
    status: response.status,
    body,
    error_code: response.ok ? null : String(body?.error || "http_error").slice(0, 120),
  };
}

async function getHtml(fetchImpl, url, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "text/html" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();
    return {
      ok: response.ok && contentType.includes("text/html") && body.includes("id=\"root\""),
      status: response.status,
      error_code: response.ok ? null : "http_error",
    };
  } catch {
    return { ok: false, status: null, error_code: "request_failed" };
  }
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
