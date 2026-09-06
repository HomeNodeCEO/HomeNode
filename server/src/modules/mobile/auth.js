import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

const TOKEN_PATTERN = /^Bearer\s+([^\s]+)$/i;
const MAX_TOKEN_LENGTH = 16_384;
const DEFAULT_CACHE_MILLISECONDS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MILLISECONDS = 5_000;
const ORIGINAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ORIGINAL_RECORD_BYTES = 16_384;
// Neither proofs nor their minting operations are exported or attached to auth.
const verifiedClaimProofs = new WeakMap();
const originalMobileAttempts = new WeakMap();

function tokenDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function originalText(value, maximumUnits = Infinity) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumUnits
    && Buffer.byteLength(value) <= 2_000 && value.isWellFormed()
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function optionalTimeState(payload, key) {
  if (!Object.hasOwn(payload, key)) return "absent";
  return Number.isFinite(payload[key]) ? "finite" : "ignored_invalid";
}

function beginOriginalMobileAttempt(req, res) {
  originalMobileAttempts.get(req)?.retire(true);
  if (typeof req?.once !== "function" || typeof req?.removeListener !== "function"
    || typeof res?.once !== "function" || typeof res?.removeListener !== "function") return null;
  const attempt = { active: true, superseded: false, auth: null, record: null };
  const closed = () => Boolean(req.aborted || res.destroyed || res.writableEnded || res.writableFinished);
  const retire = (superseded = false) => {
    attempt.superseded ||= superseded;
    attempt.active = false;
    attempt.auth = null;
    attempt.record = null;
    req.removeListener("aborted", onClose);
    res.removeListener("finish", onClose);
    res.removeListener("close", onClose);
    if (originalMobileAttempts.get(req) === attempt) originalMobileAttempts.delete(req);
  };
  const onClose = () => retire();
  attempt.retire = retire;
  attempt.live = () => attempt.active && originalMobileAttempts.get(req) === attempt && !closed();
  originalMobileAttempts.set(req, attempt);
  req.once("aborted", onClose);
  res.once("finish", onClose);
  res.once("close", onClose);
  if (closed()) retire();
  return attempt;
}

/** Original request provenance only; not current authorization, MFA or a job credential. */
export function getOriginalMobileAuthentication(req) {
  const attempt = originalMobileAttempts.get(req);
  if (!attempt) return null;
  if (!attempt.live() || (attempt.auth && req.mobileAuth !== attempt.auth)) {
    attempt.retire();
    return null;
  }
  return attempt.record;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function providerUnavailable(code) {
  const error = new Error(code);
  error.statusCode = 503;
  return error;
}

function accessTokenError(diagnostic = "unspecified") {
  const error = new Error("invalid_access_token");
  error.statusCode = 401;
  error.diagnostic = diagnostic;
  return error;
}

function base64UrlJson(value, diagnostic) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw accessTokenError(diagnostic);
  }
}

function httpsUrl(value, code) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(code);
  }
  if (parsed.protocol !== "https:") throw new Error(code);
  return parsed.toString();
}

export function normalizeOidcIssuer(value) {
  const raw = String(value || "").trim();
  const parsed = new URL(httpsUrl(raw, "invalid_oidc_issuer"));
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("invalid_oidc_issuer");
  }
  const normalized = parsed.toString();
  return raw.endsWith("/") || parsed.pathname !== "/"
    ? normalized
    : normalized.slice(0, -1);
}

export function parseBearerToken(headerValue) {
  const match = TOKEN_PATTERN.exec(String(headerValue || "").trim());
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    throw accessTokenError("bearer_missing_or_malformed");
  }
  return match[1];
}

function audienceMatches(claim, expected) {
  if (typeof claim === "string") return claim === expected;
  return Array.isArray(claim) && claim.includes(expected);
}

function validateClaims(payload, {
  issuer,
  audience,
  clientId,
  nowSeconds,
  clockToleranceSeconds,
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw accessTokenError("payload_not_object");
  }
  if (payload.iss !== issuer) throw accessTokenError("issuer_mismatch");
  if (!audienceMatches(payload.aud, audience)) throw accessTokenError("audience_mismatch");
  if (clientId && payload.client_id !== clientId) {
    throw accessTokenError("client_id_mismatch");
  }
  if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 500) {
    throw accessTokenError("subject_missing_or_invalid");
  }
  if (!Number.isFinite(payload.exp) || payload.exp < nowSeconds - clockToleranceSeconds) {
    throw accessTokenError("expired_or_missing_expiration");
  }
  if (Number.isFinite(payload.nbf) && payload.nbf > nowSeconds + clockToleranceSeconds) {
    throw accessTokenError("not_yet_valid");
  }
  if (Number.isFinite(payload.iat) && payload.iat > nowSeconds + clockToleranceSeconds) {
    throw accessTokenError("issued_in_future");
  }
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== audience) {
    throw accessTokenError("authorized_party_mismatch");
  }
}

export function createOidcAccessTokenVerifier({
  issuer: issuerValue,
  audience: audienceValue,
  clientId: clientIdValue,
  jwksUri: jwksUriValue,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  clockToleranceSeconds = 60,
  cacheMilliseconds = DEFAULT_CACHE_MILLISECONDS,
  fetchTimeoutMilliseconds = DEFAULT_FETCH_TIMEOUT_MILLISECONDS,
} = {}) {
  const configured = Boolean(issuerValue && audienceValue);
  if (!configured) {
    return Object.freeze({
      configured: false,
      async preflight() {
        return Object.freeze({ configured: false });
      },
      async verify() {
        const error = new Error("mobile_oidc_not_configured");
        error.statusCode = 503;
        throw error;
      },
    });
  }

  const issuer = normalizeOidcIssuer(issuerValue);
  const audience = String(audienceValue).trim();
  if (!audience || audience.length > 500) throw new Error("invalid_oidc_audience");
  const clientId = String(clientIdValue || "").trim();
  if (clientId.length > 500) throw new Error("invalid_oidc_client_id");
  if (typeof fetchImpl !== "function") throw new Error("oidc_fetch_unavailable");
  const configuredJwksUri = jwksUriValue
    ? httpsUrl(jwksUriValue, "invalid_oidc_jwks_uri")
    : null;
  const tolerance = Math.max(0, Math.min(300, Number(clockToleranceSeconds) || 0));
  const fetchTimeout = boundedInteger(
    fetchTimeoutMilliseconds,
    DEFAULT_FETCH_TIMEOUT_MILLISECONDS,
    100,
    30_000,
  );
  let discoveryCache = null;
  let jwksCache = null;
  let discoveryPromise = null;
  let jwksPromise = null;

  async function fetchJson(url, code) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeout);
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response?.ok) throw providerUnavailable(code);
      return await response.json();
    } catch {
      throw providerUnavailable(code);
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveJwksUri() {
    if (configuredJwksUri) return configuredJwksUri;
    const nowMilliseconds = now();
    if (discoveryCache && discoveryCache.expiresAt > nowMilliseconds) {
      return discoveryCache.jwksUri;
    }
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        const discovery = await fetchJson(
          `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
          "oidc_discovery_unavailable",
        );
        if (discovery?.issuer !== issuer) {
          throw providerUnavailable("oidc_discovery_issuer_mismatch");
        }
        let jwksUri;
        try {
          jwksUri = httpsUrl(discovery?.jwks_uri, "invalid_oidc_jwks_uri");
        } catch {
          throw providerUnavailable("invalid_oidc_jwks_uri");
        }
        discoveryCache = { jwksUri, expiresAt: now() + cacheMilliseconds };
        return jwksUri;
      })();
    }
    const pending = discoveryPromise;
    try {
      return await pending;
    } finally {
      if (discoveryPromise === pending) discoveryPromise = null;
    }
  }

  async function keys({ refresh = false } = {}) {
    const nowMilliseconds = now();
    if (!refresh && jwksCache && jwksCache.expiresAt > nowMilliseconds) return jwksCache.keys;
    if (!jwksPromise) {
      jwksPromise = (async () => {
        const jwks = await fetchJson(await resolveJwksUri(), "oidc_jwks_unavailable");
        if (!Array.isArray(jwks?.keys)) throw providerUnavailable("invalid_oidc_jwks");
        const imported = new Map();
        for (const jwk of jwks.keys) {
          if (jwk?.kty !== "RSA" || !jwk.kid || (jwk.use && jwk.use !== "sig")) continue;
          if (jwk.alg && jwk.alg !== "RS256") continue;
          try {
            imported.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
          } catch {
            // Ignore malformed or unsupported keys. A usable matching key is required below.
          }
        }
        jwksCache = { keys: imported, expiresAt: now() + cacheMilliseconds };
        return imported;
      })();
    }
    const pending = jwksPromise;
    try {
      return await pending;
    } finally {
      if (jwksPromise === pending) jwksPromise = null;
    }
  }

  async function verify(tokenValue) {
    const token = String(tokenValue || "");
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      throw accessTokenError("token_missing_or_too_large");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) {
      throw accessTokenError("jwt_format_invalid");
    }
    const header = base64UrlJson(parts[0], "jwt_header_invalid");
    const payload = base64UrlJson(parts[1], "jwt_payload_invalid");
    if (header?.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
      throw accessTokenError("jwt_header_unsupported");
    }
    let key = (await keys()).get(header.kid);
    if (!key) key = (await keys({ refresh: true })).get(header.kid);
    if (!key) throw accessTokenError("signing_key_not_found");
    let valid = false;
    try {
      valid = verifySignature(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
        key,
        Buffer.from(parts[2], "base64url"),
      );
    } catch {
      throw accessTokenError("signature_verification_failed");
    }
    if (!valid) throw accessTokenError("signature_invalid");
    const nowSeconds = Math.floor(now() / 1000);
    validateClaims(payload, {
      issuer,
      audience,
      clientId,
      nowSeconds,
      clockToleranceSeconds: tolerance,
    });
    const claims = Object.freeze({ ...payload, iss: issuer, sub: payload.sub.trim() });
    // Unsupported audit values do not change ordinary token acceptance.
    if (originalText(issuer) && originalText(claims.sub, 500) && originalText(audience, 500)
      && (!clientId || originalText(clientId, 500)) && Number.isSafeInteger(nowSeconds)) {
      const record = Object.freeze({
        version: 1,
        transport: "oidc_bearer",
        issuer,
        subject: claims.sub,
        token_sha256: tokenDigest(token),
        verification_policy: "homenode-rs256-access-token-v1",
        expected_audience: audience,
        expected_client_id: clientId || null,
        clock_tolerance_seconds: tolerance,
        signature_algorithm: "RS256",
        signing_key_id_sha256: tokenDigest(header.kid),
        verified_at_unix_seconds: nowSeconds,
        expires_at_unix_seconds: payload.exp,
        not_before_state: optionalTimeState(payload, "nbf"),
        not_before_unix_seconds: Number.isFinite(payload.nbf) ? payload.nbf : null,
        issued_at_state: optionalTimeState(payload, "iat"),
        issued_at_unix_seconds: Number.isFinite(payload.iat) ? payload.iat : null,
      });
      verifiedClaimProofs.set(claims, { verifier: verifierInstance, record });
    }
    return claims;
  }

  async function preflight() {
    const jwksUri = await resolveJwksUri();
    const importedKeys = await keys({ refresh: true });
    if (!importedKeys.size) {
      const error = new Error("oidc_jwks_has_no_supported_keys");
      error.statusCode = 503;
      throw error;
    }
    return Object.freeze({
      configured: true,
      issuer,
      audience,
      jwksUri,
      signingAlgorithm: "RS256",
      supportedKeyCount: importedKeys.size,
    });
  }

  const verifierInstance = Object.freeze({ configured: true, issuer, audience, preflight, verify });
  return verifierInstance;
}

export function createMobileAuthenticator({ pool, verifier }) {
  if (!pool?.query) throw new Error("mobile_auth_pool_required");
  if (!verifier?.verify) throw new Error("mobile_oidc_verifier_required");

  return async function mobileAuthenticator(req, res, next) {
    const originalAttempt = beginOriginalMobileAttempt(req, res);
    if (!verifier.configured) {
      originalAttempt?.retire();
      return res.status(503).json({ error: "mobile_oidc_not_configured" });
    }
    let claims;
    let originalProof;
    try {
      const token = parseBearerToken(req.get("authorization"));
      claims = await verifier.verify(token);
      const proof = verifiedClaimProofs.get(claims);
      if (proof?.verifier === verifier && proof.record.token_sha256 === tokenDigest(token)) {
        originalProof = proof.record;
      }
    } catch (error) {
      originalAttempt?.retire();
      if (error?.statusCode === 503) {
        return res.status(503).json({ error: String(error.message || "oidc_unavailable") });
      }
      console.warn(`[mobile] access token rejected reason=${error?.diagnostic || "unknown"}`);
      return res.status(401).json({ error: "invalid_access_token" });
    }
    try {
      const { rows } = await pool.query(
        `SELECT identities.id AS identity_id, users.id AS user_id, users.email, users.display_name,
                memberships.organization_id, organizations.display_name AS organization_display_name,
                roles.role_code
           FROM app_auth.oidc_identities identities
           JOIN app_auth.users users
             ON users.id = identities.user_id AND users.active = true
           LEFT JOIN app_auth.organization_memberships memberships
             ON memberships.user_id = users.id AND memberships.status = 'active'
           LEFT JOIN app_auth.membership_roles roles
             ON roles.organization_id = memberships.organization_id
            AND roles.user_id = memberships.user_id
           LEFT JOIN app_auth.organizations organizations
             ON organizations.id = memberships.organization_id
          WHERE identities.issuer = $1 AND identities.subject = $2
          ORDER BY memberships.organization_id, roles.role_code`,
        [claims.iss, claims.sub],
      );
      if (!rows.length) {
        originalAttempt?.retire();
        return res.status(403).json({ error: "mobile_identity_not_provisioned" });
      }
      const organizations = new Map();
      for (const row of rows) {
        if (!row.organization_id) continue;
        const organization = organizations.get(row.organization_id) || {
          organizationId: row.organization_id,
          displayName: row.organization_display_name,
          roles: [],
        };
        if (row.role_code && !organization.roles.includes(row.role_code)) {
          organization.roles.push(row.role_code);
        }
        organizations.set(row.organization_id, organization);
      }
      if (!organizations.size) {
        originalAttempt?.retire();
        return res.status(403).json({ error: "mobile_organization_membership_required" });
      }
      await pool.query(
        `UPDATE app_auth.oidc_identities
            SET last_authenticated_at = now(), updated_at = now()
          WHERE issuer = $1 AND subject = $2`,
        [claims.iss, claims.sub],
      );
      // A superseded successful lookup must not overwrite a newer attempt's identity.
      if (originalAttempt?.superseded) return next();
      req.mobileAuth = Object.freeze({
        userId: rows[0].user_id,
        email: rows[0].email,
        displayName: rows[0].display_name,
        issuer: claims.iss,
        subject: claims.sub,
        organizations: [...organizations.values()],
      });
      if (originalAttempt?.live() && originalProof
        && typeof rows[0].user_id === "string" && ORIGINAL_UUID.test(rows[0].user_id)
        && typeof rows[0].identity_id === "string" && ORIGINAL_UUID.test(rows[0].identity_id)) {
        const record = Object.freeze({ ...originalProof,
          user_id: rows[0].user_id, identity_id: rows[0].identity_id });
        if (Buffer.byteLength(JSON.stringify(record)) <= MAX_ORIGINAL_RECORD_BYTES) {
          originalAttempt.auth = req.mobileAuth;
          originalAttempt.record = record;
        } else originalAttempt.retire();
      } else originalAttempt?.retire();
      return next();
    } catch (error) {
      originalAttempt?.retire();
      console.error("[mobile] identity lookup failed", error?.message || error);
      return res.status(503).json({ error: "mobile_auth_unavailable" });
    }
  };
}
