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
  method = "GET",
  authorization,
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
        ...(authorization ? { authorization } : {}),
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

function exactError(result, status, error) {
  return result.status === status
    && result.error === error
    && result.safe
    && result.noStore
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

function corruptSignature(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || !parts[2]) return "invalid.invalid.invalid";
  parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  return parts.join(".");
}

export async function runUadRedTeamProtocolFuzz({
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
  const account = encodeURIComponent(String(fixtureAccountId));
  const timeout = boundedTimeout(timeoutMs);
  const validToken = await getAccessToken("homenode_admin");
  let requestCount = 0;
  const request = async (path, options = {}) => {
    requestCount += 1;
    return probe(fetchImpl, `${base}${path}`, { timeoutMs: timeout, ...options });
  };
  const bearer = (token) => `Bearer ${token}`;

  const discoveryResult = await request(`/api/uad/accounts/${account}/workfiles`, {
    authorization: bearer(validToken),
  });
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
      profile: "uad_redteam_protocol_fuzz_v1",
      checked_at: checkedAt,
      base_url: base,
      fixture_account_id: String(fixtureAccountId),
      request_count: requestCount,
      discovery,
      token_attacks: {},
      body_attacks: {},
      routing_attacks: {},
      recovery: {},
    });
  }

  const protectedPath = `/api/uad/workfiles/${encodeURIComponent(workfile.id)}`;
  const beforeResult = await request(protectedPath, { authorization: bearer(validToken) });
  const beforeRevision = Number(beforeResult.body?.workfile?.current_revision);
  const beforeReady = beforeResult.status === 200
    && beforeResult.safe
    && beforeResult.noStore
    && beforeResult.body?.workfile?.id === workfile.id
    && Number.isInteger(beforeRevision);

  const tokenInputs = {
    basic_scheme: `Basic ${Buffer.from("synthetic:redteam", "utf8").toString("base64")}`,
    malformed_segments: bearer("invalid.invalid"),
    corrupted_signature: bearer(corruptSignature(validToken)),
    algorithm_confusion: bearer(await getAccessToken("homenode_admin", {
      headerOverrides: { alg: "none" },
    })),
    unknown_signing_key: bearer(await getAccessToken("homenode_admin", {
      headerOverrides: { kid: "unknown-redteam-key" },
    })),
    embedded_jwks_redirect: bearer(await getAccessToken("homenode_admin", {
      headerOverrides: { kid: "attacker-redteam-key", jku: "https://attacker.invalid/jwks.json" },
    })),
    wrong_issuer: bearer(await getAccessToken("homenode_admin", {
      claimOverrides: { iss: "https://attacker.invalid" },
    })),
    wrong_audience: bearer(await getAccessToken("homenode_admin", {
      claimOverrides: { aud: "attacker-redteam-api" },
    })),
    expired: bearer(await getAccessToken("homenode_admin", {
      claimOverrides: { exp: 1, nbf: 0 },
    })),
    future_not_before: bearer(await getAccessToken("homenode_admin", {
      claimOverrides: { nbf: 4_102_444_800 },
    })),
    missing_subject: bearer(await getAccessToken("homenode_admin", {
      claimOverrides: { sub: undefined },
    })),
    large_malformed_token: bearer("a".repeat(12_000)),
  };
  const tokenAttacks = {};
  for (const [name, authorization] of Object.entries(tokenInputs)) {
    const result = await request(protectedPath, { authorization });
    tokenAttacks[name] = evidence(result, exactError(result, 401, "invalid_access_token"));
  }

  const sectionPath = `${protectedPath}/sections/assignment`;
  const bodyCases = {
    malformed_json: {
      headers: { "content-type": "application/json" },
      body: "{",
      status: 400,
      error: "invalid_json_body",
    },
    oversized_json: {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_050_000) }),
      status: 413,
      error: "request_body_too_large",
    },
    invalid_gzip: {
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: "not-a-gzip-stream",
      status: 400,
      error: "invalid_request_body",
    },
    unsupported_charset: {
      headers: { "content-type": "application/json; charset=iso-8859-1" },
      body: "{}",
      status: 415,
      error: "unsupported_request_encoding",
    },
    unsupported_media_type: {
      headers: { "content-type": "text/plain" },
      body: "{}",
      status: 415,
      error: "unsupported_media_type",
    },
  };
  const bodyAttacks = {};
  for (const [name, attack] of Object.entries(bodyCases)) {
    const result = await request(sectionPath, {
      method: "PATCH",
      authorization: bearer(validToken),
      headers: attack.headers,
      body: attack.body,
    });
    bodyAttacks[name] = evidence(result, exactError(result, attack.status, attack.error));
  }

  const unknownRouteResult = await request("/api/uad/__redteam_unknown_route__", {
    authorization: bearer(validToken),
  });
  const methodOverrideResult = await request("/api/uad/capabilities", {
    method: "POST",
    authorization: bearer(validToken),
    headers: { "content-type": "application/json", "x-http-method-override": "GET" },
    body: "{}",
  });
  const routingAttacks = Object.freeze({
    unknown_route: evidence(
      unknownRouteResult,
      exactError(unknownRouteResult, 404, "uad_route_not_found"),
    ),
    method_override: evidence(
      methodOverrideResult,
      exactError(methodOverrideResult, 404, "uad_route_not_found"),
    ),
  });

  const healthResult = await request("/health");
  const readinessResult = await request("/api/uad/readiness");
  const afterResult = await request(protectedPath, { authorization: bearer(validToken) });
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
      && Object.values(tokenAttacks).every((attack) => attack.ready)
      && Object.values(bodyAttacks).every((attack) => attack.ready)
      && Object.values(routingAttacks).every((attack) => attack.ready)
      && Object.values(recovery).every((check) => check.ready),
    profile: "uad_redteam_protocol_fuzz_v1",
    checked_at: checkedAt,
    base_url: base,
    fixture_account_id: String(fixtureAccountId),
    request_count: requestCount,
    discovery,
    pre_attack_fixture: evidence(beforeResult, beforeReady, { revision: beforeRevision }),
    token_attacks: Object.freeze(tokenAttacks),
    body_attacks: Object.freeze(bodyAttacks),
    routing_attacks: routingAttacks,
    recovery,
  });
}
