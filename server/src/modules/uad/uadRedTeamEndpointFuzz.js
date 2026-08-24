import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const SENSITIVE_RESPONSE_PATTERN = /(?:postgres(?:ql)?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+|\b(?:select|insert|update|delete)\s+.+\s+(?:from|into|set)\b)/i;

function boundedTimeout(value) {
  return Math.max(1_000, Math.min(Number(value) || 15_000, 30_000));
}

function safeErrorCode(value) {
  if (value == null) return null;
  return /^[a-z][a-z0-9_]{0,119}$/.test(String(value))
    ? String(value)
    : "unsafe_error_response";
}

async function readBoundedJson(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bodyText = await response.text();
    if (Buffer.byteLength(bodyText, "utf8") > MAX_RESPONSE_BYTES) {
      return { body: null, bodyText: "", error: "response_too_large" };
    }
    try {
      return { body: bodyText ? JSON.parse(bodyText) : null, bodyText, error: null };
    } catch {
      return { body: null, bodyText, error: bodyText ? "response_not_json" : null };
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
      return { body: null, bodyText: "", error: "response_too_large" };
    }
    chunks.push(Buffer.from(value));
  }
  const bodyText = Buffer.concat(chunks).toString("utf8");
  try {
    return { body: bodyText ? JSON.parse(bodyText) : null, bodyText, error: null };
  } catch {
    return { body: null, bodyText, error: bodyText ? "response_not_json" : null };
  }
}

async function probe(fetchImpl, url, {
  timeoutMs,
  authorization,
  method = "GET",
  headers = {},
  body,
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        authorization,
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    return { status: null, body: null, error: "request_failed", noStore: false, safe: true };
  }
  const parsed = await readBoundedJson(response);
  return {
    status: response.status,
    body: parsed.body,
    error: parsed.error || safeErrorCode(parsed.body?.error),
    noStore: /(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers?.get?.("cache-control") || ""),
    safe: !SENSITIVE_RESPONSE_PATTERN.test(parsed.bodyText || ""),
  };
}

function exactError(result, status, error, { requireNoStore = true } = {}) {
  return result.status === status
    && result.error === error
    && result.safe
    && (!requireNoStore || result.noStore)
    && result.body
    && Object.keys(result.body).length === 1
    && result.body.error === error;
}

function evidence(result, ready, extra = {}) {
  return Object.freeze({
    ready: Boolean(ready),
    http_status: result.status,
    error_code: result.error,
    no_store: result.noStore,
    safe_response: result.safe,
    ...extra,
  });
}

export async function runUadRedTeamEndpointFuzz({
  baseUrl = REDTEAM_API_ORIGIN,
  fixtureAccountId = "UAD-REDTEAM-SFR-0001",
  getAccessToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  checkedAt = new Date().toISOString(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("uad_redteam_fetch_unavailable");
  if (typeof getAccessToken !== "function") throw new Error("uad_redteam_token_factory_required");
  if (!/^UAD-REDTEAM-[0-9A-Z-]+$/.test(String(fixtureAccountId || ""))) {
    throw new Error("invalid_uad_redteam_fixture_account");
  }

  const base = normalizeUadRedTeamApiUrl(baseUrl);
  const timeout = boundedTimeout(timeoutMs);
  const authorization = `Bearer ${await getAccessToken("homenode_admin")}`;
  let requestCount = 0;
  const request = async (path, options = {}) => {
    requestCount += 1;
    return probe(fetchImpl, `${base}${path}`, {
      timeoutMs: timeout,
      authorization,
      ...options,
    });
  };

  const account = encodeURIComponent(String(fixtureAccountId));
  const discoveryResult = await request(`/api/uad/accounts/${account}/workfiles`);
  const workfile = Array.isArray(discoveryResult.body?.workfiles)
    ? discoveryResult.body.workfiles.find((candidate) => candidate?.file_number === "HN-REDTEAM-ORG-A-0001")
    : null;
  const discoveryReady = discoveryResult.status === 200
    && discoveryResult.safe
    && discoveryResult.noStore
    && typeof workfile?.id === "string";
  const discovery = evidence(discoveryResult, discoveryReady, {
    workfile_count: Array.isArray(discoveryResult.body?.workfiles)
      ? discoveryResult.body.workfiles.length
      : null,
  });
  if (!discoveryReady) {
    return Object.freeze({
      ok: false,
      profile: "uad_redteam_endpoint_input_fuzz_v1",
      checked_at: checkedAt,
      base_url: base,
      fixture_account_id: String(fixtureAccountId),
      request_count: requestCount,
      discovery,
      identifier_attacks: {},
      routing_attacks: {},
      body_shape_attacks: {},
      header_attacks: {},
      recovery: {},
    });
  }

  const workfileId = encodeURIComponent(workfile.id);
  const protectedPath = `/api/uad/workfiles/${workfileId}`;
  const beforeResult = await request(protectedPath);
  const beforeRevision = Number(beforeResult.body?.workfile?.current_revision);
  const beforeReady = beforeResult.status === 200
    && beforeResult.safe
    && beforeResult.noStore
    && beforeResult.body?.workfile?.id === workfile.id
    && Number.isInteger(beforeRevision);

  const identifierCases = {
    invalid_workfile_id: `/api/uad/workfiles/${encodeURIComponent("not-a-uuid")}`,
    sql_metacharacter_workfile_id: `/api/uad/workfiles/${encodeURIComponent("uad'quoted;identifier")}`,
    unicode_workfile_id: `/api/uad/workfiles/${encodeURIComponent("\uFF10\uFF11\uFF12\uFF13-\uD83D\uDD12")}`,
  };
  const identifierAttacks = {};
  for (const [name, path] of Object.entries(identifierCases)) {
    const result = await request(path);
    identifierAttacks[name] = evidence(result, exactError(result, 400, "invalid_uad_workfile_id"));
  }
  for (const [name, rawAccountId] of Object.entries({
    oversized_account_id: "A".repeat(65),
    control_character_account_id: "UAD-REDTEAM\nINJECTED",
  })) {
    const result = await request(`/api/uad/accounts/${encodeURIComponent(rawAccountId)}/workfiles`);
    identifierAttacks[name] = evidence(result, exactError(result, 400, "invalid_account_id"));
  }

  const routingCases = {
    extra_path_segment: { path: `${protectedPath}/editor/extra` },
    doubled_path_separator: { path: `/api/uad//workfiles/${workfileId}` },
    encoded_path_separator: { path: `${protectedPath}%2Feditor`, status: 400, error: "invalid_uad_workfile_id" },
    unsupported_resource_method: {
      path: protectedPath,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  };
  const routingAttacks = {};
  for (const [name, attack] of Object.entries(routingCases)) {
    const result = await request(attack.path, attack);
    const status = attack.status || 404;
    const error = attack.error || "uad_route_not_found";
    routingAttacks[name] = evidence(result, exactError(result, status, error));
  }

  const sectionPath = `${protectedPath}/sections/${encodeURIComponent("__redteam_input_probe__")}`;
  const bodyCases = {
    prototype_keys: {
      headers: { "content-type": "application/json" },
      body: "{\"__proto__\":{\"polluted\":true},\"constructor\":{\"prototype\":{\"polluted\":true}}}",
      status: 400,
      error: "invalid_uad_expected_revision",
    },
    array_root: {
      headers: { "content-type": "application/json" },
      body: "[]",
      status: 400,
      error: "invalid_uad_expected_revision",
    },
    primitive_root: {
      headers: { "content-type": "application/json" },
      body: "true",
      status: 400,
      error: "invalid_json_body",
    },
    deep_but_bounded_object: {
      headers: { "content-type": "application/json" },
      body: `${"{\"nested\":".repeat(32)}null${"}".repeat(32)}`,
      status: 400,
      error: "invalid_uad_expected_revision",
    },
    form_encoded_body: {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "expected_revision=1",
      status: 415,
      error: "unsupported_media_type",
    },
  };
  const bodyShapeAttacks = {};
  for (const [name, attack] of Object.entries(bodyCases)) {
    const result = await request(sectionPath, { method: "PATCH", ...attack });
    bodyShapeAttacks[name] = evidence(result, exactError(result, attack.status, attack.error));
  }

  const forwardedRouteResult = await request("/api/uad/capabilities", {
    headers: {
      "x-original-url": "/health",
      "x-rewrite-url": "/health",
      "x-forwarded-uri": "/health",
    },
  });
  const attackerOriginResult = await request("/api/uad/capabilities", {
    headers: { origin: "https://attacker.invalid" },
  });
  const boundedHeaderResult = await request("/api/uad/capabilities", {
    headers: { "x-redteam-padding": "x".repeat(4_096) },
  });
  const headerAttacks = Object.freeze({
    forwarded_route_headers_ignored: evidence(
      forwardedRouteResult,
      forwardedRouteResult.status === 200
        && forwardedRouteResult.safe
        && forwardedRouteResult.noStore
        && typeof forwardedRouteResult.body?.specification_release_key === "string",
    ),
    hostile_origin_denied: evidence(
      attackerOriginResult,
      exactError(attackerOriginResult, 403, "cors_origin_denied", { requireNoStore: false }),
    ),
    bounded_unknown_header: evidence(
      boundedHeaderResult,
      boundedHeaderResult.status === 200
        && boundedHeaderResult.safe
        && boundedHeaderResult.noStore
        && typeof boundedHeaderResult.body?.specification_release_key === "string",
    ),
  });

  const healthResult = await request("/health");
  const readinessResult = await request("/api/uad/readiness");
  const afterResult = await request(protectedPath);
  const afterRevision = Number(afterResult.body?.workfile?.current_revision);
  const recovery = Object.freeze({
    health: evidence(
      healthResult,
      healthResult.status === 200 && healthResult.safe && healthResult.body?.ok === true,
    ),
    readiness: evidence(
      readinessResult,
      readinessResult.status === 200
        && readinessResult.safe
        && readinessResult.noStore
        && readinessResult.body?.ok === true,
    ),
    fixture_unchanged: evidence(
      afterResult,
      beforeReady
        && afterResult.status === 200
        && afterResult.safe
        && afterResult.noStore
        && afterResult.body?.workfile?.id === workfile.id
        && afterRevision === beforeRevision,
      { before_revision: beforeRevision, after_revision: afterRevision },
    ),
  });

  return Object.freeze({
    ok: discovery.ready
      && beforeReady
      && Object.values(identifierAttacks).every((attack) => attack.ready)
      && Object.values(routingAttacks).every((attack) => attack.ready)
      && Object.values(bodyShapeAttacks).every((attack) => attack.ready)
      && Object.values(headerAttacks).every((attack) => attack.ready)
      && Object.values(recovery).every((check) => check.ready),
    profile: "uad_redteam_endpoint_input_fuzz_v1",
    checked_at: checkedAt,
    base_url: base,
    fixture_account_id: String(fixtureAccountId),
    request_count: requestCount,
    discovery,
    pre_attack_fixture: evidence(beforeResult, beforeReady, { revision: beforeRevision }),
    identifier_attacks: Object.freeze(identifierAttacks),
    routing_attacks: Object.freeze(routingAttacks),
    body_shape_attacks: Object.freeze(bodyShapeAttacks),
    header_attacks: headerAttacks,
    recovery,
  });
}
