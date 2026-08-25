import { createPrivateKey, randomUUID, sign } from "node:crypto";

import { REDTEAM_ORGANIZATIONS, REDTEAM_PERSONAS, parseRedTeamOidcSubjects } from "../../security/redTeamFixtures.js";
import { REDTEAM_API_ORIGIN, normalizeUadRedTeamApiUrl } from "./uadRedTeamBaseline.js";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16_384;
const ORGANIZATION_LABELS = Object.freeze({
  organization_a: REDTEAM_ORGANIZATIONS.organizationA.id,
  organization_b: REDTEAM_ORGANIZATIONS.organizationB.id,
});

export const REDTEAM_AUTHORIZATION_PERSONAS = Object.freeze([
  ...REDTEAM_PERSONAS.map((persona) => persona.key),
  "unprovisioned_user",
]);

const EXPECTATIONS = Object.freeze({
  assigned_appraiser_a: Object.freeze({ list: ["organization_a"], read: ["organization_a"], write: ["organization_a"] }),
  unassigned_appraiser_a: Object.freeze({ list: [], read: [], write: [] }),
  supervisor_a: Object.freeze({ list: [], read: [], write: [] }),
  reviewer_a: Object.freeze({ list: ["organization_a"], read: ["organization_a"], write: [] }),
  organization_admin_a: Object.freeze({ list: ["organization_a"], read: ["organization_a"], write: ["organization_a"] }),
  appraiser_b: Object.freeze({ list: ["organization_b"], read: ["organization_b"], write: ["organization_b"] }),
  organization_admin_b: Object.freeze({ list: ["organization_b"], read: ["organization_b"], write: ["organization_b"] }),
  homenode_admin: Object.freeze({ list: ["organization_a", "organization_b"], read: ["organization_a", "organization_b"], write: ["organization_a", "organization_b"] }),
  inactive_user: Object.freeze({ authenticationError: "mobile_identity_not_provisioned" }),
  suspended_member: Object.freeze({ authenticationError: "mobile_organization_membership_required" }),
  member_without_role: Object.freeze({ listError: "uad_access_denied", read: [], write: [] }),
  unprovisioned_user: Object.freeze({ authenticationError: "mobile_identity_not_provisioned" }),
});

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
      return { body: null, error: "response_too_large" };
    }
    try {
      return { body: bodyText ? JSON.parse(bodyText) : null, error: null };
    } catch {
      return { body: null, error: "response_not_json" };
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
      return { body: null, error: "response_too_large" };
    }
    chunks.push(Buffer.from(value));
  }
  try {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    return { body: bodyText ? JSON.parse(bodyText) : null, error: null };
  } catch {
    return { body: null, error: "response_not_json" };
  }
}

async function probe(fetchImpl, url, token, { timeoutMs, method = "GET", body } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { status: null, body: null, error: "request_failed" };
  }
  const parsed = await readBoundedJson(response);
  return {
    status: response.status,
    body: parsed.body,
    error: parsed.error || safeErrorCode(parsed.body?.error),
  };
}

function exactFailure(result, status, error) {
  return result.status === status && result.error === error;
}

function evidence(result, extra = {}) {
  return Object.freeze({
    ready: Boolean(extra.ready),
    http_status: result.status,
    error_code: result.error,
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "ready")),
  });
}

function validateToken(token) {
  const normalized = String(token || "").trim();
  if (!normalized || normalized.length > MAX_TOKEN_LENGTH || /\s/.test(normalized)) {
    throw new Error("invalid_uad_redteam_access_token");
  }
  return normalized;
}

function workfileLabel(workfile) {
  return Object.entries(ORGANIZATION_LABELS)
    .find(([, organizationId]) => workfile?.organization_id === organizationId)?.[0] || null;
}

function discoverWorkfiles(result) {
  if (result.status !== 200 || result.error || !Array.isArray(result.body?.workfiles)) return null;
  const discovered = {};
  for (const workfile of result.body.workfiles) {
    const label = workfile.file_number === "HN-REDTEAM-ORG-A-0001"
      ? "organization_a"
      : workfile.file_number === "HN-REDTEAM-ORG-B-0001"
        ? "organization_b"
        : null;
    if (!label) continue;
    if (
      discovered[label]
      || workfileLabel(workfile) !== label
      || typeof workfile?.id !== "string"
    ) return null;
    discovered[label] = workfile.id;
  }
  return Object.keys(discovered).length === Object.keys(ORGANIZATION_LABELS).length
    ? Object.freeze(discovered)
    : null;
}

function expectedAccessError(expectation) {
  return expectation.authenticationError || "uad_workfile_access_denied";
}

export async function runUadRedTeamAuthorizationMatrix({
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
  const tokens = new Map();
  for (const persona of REDTEAM_AUTHORIZATION_PERSONAS) {
    tokens.set(persona, validateToken(await getAccessToken(persona)));
  }

  let requestCount = 0;
  const request = async (persona, path, options) => {
    requestCount += 1;
    return probe(fetchImpl, `${base}${path}`, tokens.get(persona), { timeoutMs: timeout, ...options });
  };

  const discoveryResponse = await request(
    "homenode_admin",
    `/api/uad/accounts/${account}/workfiles`,
  );
  const targets = discoverWorkfiles(discoveryResponse);
  const discovery = evidence(discoveryResponse, {
    ready: Boolean(targets),
    workfile_count: Array.isArray(discoveryResponse.body?.workfiles)
      ? discoveryResponse.body.workfiles.length
      : null,
  });
  if (!targets) {
    return Object.freeze({
      ok: false,
      profile: "uad_redteam_authenticated_authorization_v1",
      checked_at: checkedAt,
      base_url: base,
      fixture_account_id: String(fixtureAccountId),
      request_count: requestCount,
      discovery,
      personas: {},
    });
  }

  const personaEvidence = {};
  for (const persona of REDTEAM_AUTHORIZATION_PERSONAS) {
    const expectation = EXPECTATIONS[persona];
    const identityResponse = await request(persona, "/api/mobile/me");
    const listResponse = await request(persona, `/api/uad/accounts/${account}/workfiles`);
    const expectedAuthenticationError = expectation.authenticationError;
    const identityReady = expectedAuthenticationError
      ? exactFailure(identityResponse, 403, expectedAuthenticationError)
      : identityResponse.status === 200 && !identityResponse.error;

    const listedWorkfiles = Array.isArray(listResponse.body?.workfiles)
      ? listResponse.body.workfiles
      : [];
    const listLabels = listedWorkfiles.map(workfileLabel).filter(Boolean);
    const expectedListError = expectedAuthenticationError || expectation.listError;
    const expectedLabels = expectation.list || [];
    const listReady = expectedListError
      ? exactFailure(listResponse, 403, expectedListError)
      : listResponse.status === 200
        && !listResponse.error
        && Array.isArray(listResponse.body?.workfiles)
        && listLabels.length === listedWorkfiles.length
        && listLabels.every((label) => expectedLabels.includes(label))
        && expectedLabels.every((label) => (
          listedWorkfiles.some((workfile) => workfile.id === targets[label])
        ));

    const targetEvidence = {};
    for (const label of Object.keys(ORGANIZATION_LABELS)) {
      const workfileId = targets[label];
      const readResponse = await request(persona, `/api/uad/workfiles/${workfileId}`);
      const writeResponse = await request(
        persona,
        `/api/uad/workfiles/${workfileId}/sections/__redteam_probe__`,
        { method: "PATCH", body: {} },
      );
      const canRead = !expectedAuthenticationError && (expectation.read || []).includes(label);
      const canWrite = !expectedAuthenticationError && (expectation.write || []).includes(label);
      const deniedError = expectedAccessError(expectation);
      const readReady = canRead
        ? readResponse.status === 200
          && !readResponse.error
          && readResponse.body?.workfile?.id === workfileId
        : exactFailure(readResponse, 403, deniedError);
      // A missing expected revision is rejected after authorization middleware
      // and before persistence. It proves write access without mutating the fixture.
      const writeReady = canWrite
        ? exactFailure(writeResponse, 400, "invalid_uad_expected_revision")
        : exactFailure(writeResponse, 403, deniedError);
      targetEvidence[label] = Object.freeze({
        read: evidence(readResponse, { ready: readReady }),
        write_probe: evidence(writeResponse, { ready: writeReady }),
      });
    }

    const entry = Object.freeze({
      ready: identityReady
        && listReady
        && Object.values(targetEvidence).every((target) => target.read.ready && target.write_probe.ready),
      identity: evidence(identityResponse, { ready: identityReady }),
      list: evidence(listResponse, { ready: listReady, workfile_count: listLabels.length }),
      targets: Object.freeze(targetEvidence),
    });
    personaEvidence[persona] = entry;
  }

  return Object.freeze({
    ok: discovery.ready && Object.values(personaEvidence).every((persona) => persona.ready),
    profile: "uad_redteam_authenticated_authorization_v1",
    checked_at: checkedAt,
    base_url: base,
    fixture_account_id: String(fixtureAccountId),
    request_count: requestCount,
    discovery,
    personas: Object.freeze(personaEvidence),
  });
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function normalizeSyntheticIssuer(value) {
  const parsed = new URL(String(value || "").trim());
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || !parsed.hostname.includes("redteam")
    || !parsed.hostname.endsWith(".invalid")
  ) throw new Error("invalid_uad_redteam_oidc_issuer");
  return parsed.origin;
}

export function createRedTeamAccessTokenFactory({
  privateKeyPem,
  keyId,
  issuer,
  audience,
  subjectsJson,
  unprovisionedSubject = "uad-redteam-unprovisioned-user",
  now = () => Date.now(),
} = {}) {
  const normalizedIssuer = normalizeSyntheticIssuer(issuer);
  const normalizedAudience = String(audience || "").trim();
  if (!normalizedAudience || normalizedAudience.length > 500 || !/red.?team/i.test(normalizedAudience)) {
    throw new Error("invalid_uad_redteam_oidc_audience");
  }
  const normalizedKeyId = String(keyId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(normalizedKeyId) || !/red.?team/i.test(normalizedKeyId)) {
    throw new Error("invalid_uad_redteam_jwt_key_id");
  }
  const subjects = parseRedTeamOidcSubjects(subjectsJson);
  const negativeSubject = String(unprovisionedSubject || "").trim();
  if (!negativeSubject || negativeSubject.length > 500 || Object.values(subjects).includes(negativeSubject)) {
    throw new Error("invalid_uad_redteam_unprovisioned_subject");
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(String(privateKeyPem || "").replaceAll("\\n", "\n"));
  } catch {
    throw new Error("invalid_uad_redteam_private_key");
  }
  if (
    privateKey.asymmetricKeyType !== "rsa"
    || Number(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2_048
  ) throw new Error("invalid_uad_redteam_private_key");

  return async function accessTokenFor(persona, { headerOverrides = {}, claimOverrides = {} } = {}) {
    if (!REDTEAM_AUTHORIZATION_PERSONAS.includes(persona)) {
      throw new Error("invalid_uad_redteam_persona");
    }
    const issuedAt = Math.floor(now() / 1_000);
    const header = encodedJson({
      alg: "RS256",
      typ: "JWT",
      kid: normalizedKeyId,
      ...(headerOverrides && typeof headerOverrides === "object" && !Array.isArray(headerOverrides)
        ? headerOverrides
        : {}),
    });
    const payload = encodedJson({
      iss: normalizedIssuer,
      aud: normalizedAudience,
      sub: persona === "unprovisioned_user" ? negativeSubject : subjects[persona],
      iat: issuedAt,
      nbf: issuedAt - 5,
      exp: issuedAt + 10 * 60,
      jti: randomUUID(),
      ...(claimOverrides && typeof claimOverrides === "object" && !Array.isArray(claimOverrides)
        ? claimOverrides
        : {}),
    });
    const unsigned = `${header}.${payload}`;
    const signature = sign("RSA-SHA256", Buffer.from(unsigned, "ascii"), privateKey).toString("base64url");
    return `${unsigned}.${signature}`;
  };
}
