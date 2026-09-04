import { createPublicKey, verify as verifySignature } from "node:crypto";

const TOKEN_PATTERN = /^Bearer\s+([^\s]+)$/i;
const MAX_TOKEN_LENGTH = 16_384;
const DEFAULT_CACHE_MILLISECONDS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MILLISECONDS = 5_000;

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
    validateClaims(payload, {
      issuer,
      audience,
      clientId,
      nowSeconds: Math.floor(now() / 1000),
      clockToleranceSeconds: tolerance,
    });
    return Object.freeze({ ...payload, iss: issuer, sub: payload.sub.trim() });
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

  return Object.freeze({ configured: true, issuer, audience, preflight, verify });
}

export function createMobileAuthenticator({ pool, verifier }) {
  if (!pool?.query) throw new Error("mobile_auth_pool_required");
  if (!verifier?.verify) throw new Error("mobile_oidc_verifier_required");

  return async function mobileAuthenticator(req, res, next) {
    if (!verifier.configured) {
      return res.status(503).json({ error: "mobile_oidc_not_configured" });
    }
    let claims;
    try {
      claims = await verifier.verify(parseBearerToken(req.get("authorization")));
    } catch (error) {
      if (error?.statusCode === 503) {
        return res.status(503).json({ error: String(error.message || "oidc_unavailable") });
      }
      console.warn(`[mobile] access token rejected reason=${error?.diagnostic || "unknown"}`);
      return res.status(401).json({ error: "invalid_access_token" });
    }
    try {
      const { rows } = await pool.query(
        `SELECT users.id AS user_id, users.email, users.display_name,
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
      if (!rows.length) return res.status(403).json({ error: "mobile_identity_not_provisioned" });
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
        return res.status(403).json({ error: "mobile_organization_membership_required" });
      }
      await pool.query(
        `UPDATE app_auth.oidc_identities
            SET last_authenticated_at = now(), updated_at = now()
          WHERE issuer = $1 AND subject = $2`,
        [claims.iss, claims.sub],
      );
      req.mobileAuth = Object.freeze({
        userId: rows[0].user_id,
        email: rows[0].email,
        displayName: rows[0].display_name,
        issuer: claims.iss,
        subject: claims.sub,
        organizations: [...organizations.values()],
      });
      return next();
    } catch (error) {
      console.error("[mobile] identity lookup failed", error?.message || error);
      return res.status(503).json({ error: "mobile_auth_unavailable" });
    }
  };
}
