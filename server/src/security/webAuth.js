import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { createApplicationAuthenticationPolicy } from "./applicationAuthenticationPolicy.js";

const SESSION_COOKIE = "__Host-homenode_session";
const TRANSACTION_COOKIE = "__Host-homenode_auth_tx";
const SESSION_SECONDS = 8 * 60 * 60;
const TRANSACTION_COOKIE_OPTIONS = Object.freeze({
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
});
const SAFE_SESSION_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_OIDC_HTTP_TIMEOUT_MS = 5_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

async function fetchWithDeadline(fetchImpl, url, init, timeoutMs, errorCode, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    clearTimeout(timer);
    throw new Error(errorCode);
  }
  try {
    return consume ? await consume(response) : response;
  } finally {
    clearTimeout(timer);
  }
}

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function cookies(req) {
  const result = new Map();
  for (const part of String(req.get?.("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    result.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
  }
  return result;
}

function webSessionSecurity(environment) {
  const crossSite = enabled(environment.WEB_SESSION_CROSS_SITE);
  let frontendOrigin = null;
  try {
    const parsed = new URL(String(environment.WEB_APP_URL || "").trim());
    if (!parsed.username && !parsed.password && ["http:", "https:"].includes(parsed.protocol)) {
      frontendOrigin = parsed.origin;
    }
  } catch {
    // An incomplete WEB_APP_URL is already excluded from configured auth below.
  }
  if (crossSite) {
    if (!frontendOrigin?.startsWith("https://")) {
      throw new Error("cross_site_web_session_requires_https_web_app_url");
    }
    const corsOrigins = String(environment.CORS_ORIGIN || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!corsOrigins.includes(frontendOrigin)) {
      throw new Error("cross_site_web_session_requires_exact_cors_origin");
    }
  }
  return Object.freeze({
    crossSite,
    frontendOrigin,
    cookieOptions: Object.freeze({
      ...TRANSACTION_COOKIE_OPTIONS,
      sameSite: crossSite ? "none" : "lax",
    }),
  });
}

function setBrowserCookie(res, name, value, maxAgeSeconds, options = TRANSACTION_COOKIE_OPTIONS) {
  res.cookie(name, value, {
    ...options,
    maxAge: Math.max(1, Math.floor(maxAgeSeconds)) * 1_000,
  });
}

function clearBrowserCookie(res, name, options = TRANSACTION_COOKIE_OPTIONS) {
  res.clearCookie(name, options);
}

function signTransaction(value, secret) {
  const body = base64url(JSON.stringify(value));
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function readTransaction(value, secret, now = Date.now()) {
  const [body, signature, extra] = String(value || "").split(".");
  if (!body || !signature || extra) throw new Error("invalid_auth_transaction");
  const expected = createHmac("sha256", secret).update(body).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("invalid_auth_transaction");
  }
  const transaction = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (
    !transaction?.state
    || !transaction?.verifier
    || !transaction?.nonce
    || Number(transaction.expires_at) < now
  ) {
    throw new Error("expired_auth_transaction");
  }
  return transaction;
}

function secureStringEqual(actual, expected) {
  const actualBytes = Buffer.from(String(actual || ""), "utf8");
  const expectedBytes = Buffer.from(String(expected || ""), "utf8");
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function idTokenError(diagnostic) {
  const error = new Error("invalid_id_token");
  error.diagnostic = diagnostic;
  return error;
}

const SAFE_AUTH_FAILURES = new Set([
  "expired_auth_transaction",
  "identity_not_provisioned",
  "invalid_auth_callback",
  "invalid_auth_transaction",
  "invalid_oidc_discovery",
  "oidc_discovery_unavailable",
  "organization_membership_required",
  "token_exchange_unavailable",
  "token_exchange_failed",
]);

function safeDiagnostic(value, fallback = "unexpected_error") {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_:-]{1,120}$/.test(normalized) ? normalized : fallback;
}

function authFailureReason(error) {
  if (error?.diagnostic) return safeDiagnostic(error.diagnostic);
  return SAFE_AUTH_FAILURES.has(error?.message) ? error.message : "unexpected_error";
}

async function tokenExchangeFailure(response) {
  let providerCode = "provider_error";
  try {
    const value = await response.json();
    providerCode = safeDiagnostic(value?.error, providerCode);
  } catch {
    // Provider bodies are optional and never copied into logs or client responses.
  }
  const error = new Error("token_exchange_failed");
  error.diagnostic = `http_${Number(response?.status) || 0}:${providerCode}`;
  return error;
}

async function loadIdentity(pool, issuer, subject) {
  const { rows } = await pool.query(
    `SELECT users.id AS user_id, users.email, users.display_name,
            memberships.organization_id, organizations.display_name AS organization_display_name,
            roles.role_code
       FROM app_auth.oidc_identities identities
       JOIN app_auth.users users ON users.id = identities.user_id AND users.active = true
       LEFT JOIN app_auth.organization_memberships memberships
         ON memberships.user_id = users.id AND memberships.status = 'active'
       LEFT JOIN app_auth.membership_roles roles
         ON roles.organization_id = memberships.organization_id AND roles.user_id = memberships.user_id
       LEFT JOIN app_auth.organizations organizations ON organizations.id = memberships.organization_id
      WHERE identities.issuer = $1 AND identities.subject = $2
      ORDER BY memberships.organization_id, roles.role_code`,
    [issuer, subject],
  );
  if (!rows.length) throw new Error("identity_not_provisioned");
  const organizations = new Map();
  for (const row of rows) {
    if (!row.organization_id) continue;
    const entry = organizations.get(row.organization_id) || {
      organizationId: row.organization_id,
      displayName: row.organization_display_name,
      roles: [],
    };
    if (row.role_code && !entry.roles.includes(row.role_code)) entry.roles.push(row.role_code);
    organizations.set(row.organization_id, entry);
  }
  if (!organizations.size) throw new Error("organization_membership_required");
  return Object.freeze({
    userId: rows[0].user_id,
    email: rows[0].email,
    displayName: rows[0].display_name,
    issuer,
    subject,
    organizations: [...organizations.values()],
  });
}

async function loadSessionIdentity(pool, token) {
  const { rows } = await pool.query(
    `SELECT users.id AS user_id, users.email, users.display_name,
            memberships.organization_id, organizations.display_name AS organization_display_name,
            roles.role_code
       FROM app_auth.web_sessions sessions
       JOIN app_auth.users users ON users.id = sessions.user_id AND users.active = true
       LEFT JOIN app_auth.organization_memberships memberships
         ON memberships.user_id = users.id AND memberships.status = 'active'
       LEFT JOIN app_auth.membership_roles roles
         ON roles.organization_id = memberships.organization_id AND roles.user_id = memberships.user_id
       LEFT JOIN app_auth.organizations organizations ON organizations.id = memberships.organization_id
      WHERE sessions.token_sha256 = $1 AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
      ORDER BY memberships.organization_id, roles.role_code`,
    [sha256(token)],
  );
  if (!rows.length) return null;
  const organizations = new Map();
  for (const row of rows) {
    if (!row.organization_id) continue;
    const entry = organizations.get(row.organization_id) || {
      organizationId: row.organization_id,
      displayName: row.organization_display_name,
      roles: [],
    };
    if (row.role_code && !entry.roles.includes(row.role_code)) entry.roles.push(row.role_code);
    organizations.set(row.organization_id, entry);
  }
  if (!organizations.size) return null;
  return Object.freeze({
    userId: rows[0].user_id,
    email: rows[0].email,
    displayName: rows[0].display_name,
    organizations: [...organizations.values()],
  });
}

export function createWebSessionAuthenticator({ pool, environment = process.env }) {
  const sessionSecurity = webSessionSecurity(environment);
  return async function webSessionAuthenticator(req, res, next) {
    if (req.mobileAuth || /^Bearer\s+/i.test(String(req.get?.("authorization") || ""))) return next();
    const token = cookies(req).get(SESSION_COOKIE);
    if (!token) return next();
    if (!SAFE_SESSION_METHODS.has(String(req.method || "GET").toUpperCase())) {
      const origin = String(req.get?.("origin") || "").trim();
      if (!sessionSecurity.frontendOrigin || origin !== sessionSecurity.frontendOrigin) {
        return res.set("cache-control", "no-store")
          .status(403)
          .json({ error: "csrf_origin_denied" });
      }
    }
    try {
      const identity = await loadSessionIdentity(pool, token);
      if (identity) req.mobileAuth = identity;
      else clearBrowserCookie(res, SESSION_COOKIE, sessionSecurity.cookieOptions);
      return next();
    } catch {
      return res.status(503).json({ error: "authentication_unavailable" });
    }
  };
}

export function createWebAuthRouter({
  pool,
  verifier,
  environment = process.env,
  authenticationPolicy = createApplicationAuthenticationPolicy(environment),
  fetchImpl = globalThis.fetch,
  logger = console,
  rateLimiterOptions = {
    windowMs: 60_000,
    limit: 600,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  },
}) {
  const router = express.Router();
  // Keep the limiter on the router that owns these handlers. Besides making
  // the protection explicit to static analysis, this prevents a later mount
  // reordering from silently placing token exchange and session revocation
  // outside the application-wide API limiter.
  router.use(rateLimit(rateLimiterOptions));
  const clientId = String(environment.OIDC_WEB_CLIENT_ID || "").trim();
  const clientSecret = String(environment.OIDC_WEB_CLIENT_SECRET || "").trim();
  const redirectUri = String(environment.OIDC_WEB_REDIRECT_URI || "").trim();
  const frontendUrl = String(environment.WEB_APP_URL || "").trim();
  const sessionSecret = String(environment.APP_SESSION_SECRET || "").trim();
  const sessionSecurity = webSessionSecurity(environment);
  const oidcHttpTimeoutMs = boundedInteger(
    environment.OIDC_HTTP_TIMEOUT_MS,
    DEFAULT_OIDC_HTTP_TIMEOUT_MS,
    100,
    30_000,
  );
  const configured = Boolean(
    verifier?.configured
    && clientId
    && clientSecret
    && redirectUri
    && frontendUrl
    && sessionSecret.length >= 32
  );
  // Local development may still select the explicit legacy composition mode.
  // Production startup requires enforcement and sensitive routes never accept
  // the retired shared editor-key credential as an authentication substitute.
  const required = authenticationPolicy.authenticationRequired;
  let discovery = null;
  let discoveryPromise = null;

  async function getDiscovery() {
    if (discovery) return discovery;
    if (!discoveryPromise) {
      discoveryPromise = (async () => {
        const value = await fetchWithDeadline(
          fetchImpl,
          `${verifier.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
          undefined,
          oidcHttpTimeoutMs,
          "oidc_discovery_unavailable",
          async (response) => {
            if (!response.ok) throw new Error("oidc_discovery_unavailable");
            try {
              return await response.json();
            } catch {
              throw new Error("invalid_oidc_discovery");
            }
          },
        );
        if (value.issuer !== verifier.issuer || !value.authorization_endpoint || !value.token_endpoint) {
          throw new Error("invalid_oidc_discovery");
        }
        discovery = value;
        return discovery;
      })();
    }
    const pending = discoveryPromise;
    try {
      return await pending;
    } finally {
      if (discoveryPromise === pending) discoveryPromise = null;
    }
  }

  router.get("/status", (_req, res) => res
    .set("cache-control", "no-store")
    .json({ configured, required: Boolean(configured && required) }));

  router.get("/login", async (_req, res) => {
    if (!configured) return res.status(503).json({ error: "web_auth_not_configured" });
    try {
      const metadata = await getDiscovery();
      const state = base64url(randomBytes(24));
      const verifierValue = base64url(randomBytes(48));
      const nonce = base64url(randomBytes(32));
      const challenge = base64url(createHash("sha256").update(verifierValue).digest());
      setBrowserCookie(res, TRANSACTION_COOKIE, signTransaction({
        state,
        verifier: verifierValue,
        nonce,
        expires_at: Date.now() + 10 * 60 * 1000,
      }, sessionSecret), 600);
      const url = new URL(metadata.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "openid profile email");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return res.redirect(302, url.toString());
    } catch {
      return res.status(503).json({ error: "web_auth_unavailable" });
    }
  });

  router.get("/callback", async (req, res) => {
    clearBrowserCookie(res, TRANSACTION_COOKIE);
    if (!configured) return res.status(503).json({ error: "web_auth_not_configured" });
    let stage = "transaction";
    try {
      const transaction = readTransaction(cookies(req).get(TRANSACTION_COOKIE), sessionSecret);
      if (!req.query.code || req.query.state !== transaction.state) throw new Error("invalid_auth_callback");
      stage = "discovery";
      const metadata = await getDiscovery();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: String(req.query.code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: transaction.verifier,
      });
      stage = "token_exchange";
      const tokens = await fetchWithDeadline(
        fetchImpl,
        metadata.token_endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body,
        },
        oidcHttpTimeoutMs,
        "token_exchange_unavailable",
        async (response) => {
          if (!response.ok) throw await tokenExchangeFailure(response);
          return response.json();
        },
      );
      stage = "token_verification";
      if (!tokens?.id_token) throw idTokenError("id_token_missing");
      const claims = await verifier.verify(tokens.id_token);
      if (!secureStringEqual(claims.nonce, transaction.nonce)) {
        throw idTokenError("nonce_mismatch");
      }
      stage = "identity_lookup";
      const identity = await loadIdentity(pool, claims.iss, claims.sub);
      const token = base64url(randomBytes(32));
      stage = "session_create";
      await pool.query(
        `INSERT INTO app_auth.web_sessions
           (id, token_sha256, user_id, expires_at, created_ip_sha256, created_user_agent)
         VALUES ($1, $2, $3, now() + ($4 * interval '1 second'), $5, $6)`,
        [randomUUID(), sha256(token), identity.userId, SESSION_SECONDS,
          req.ip ? sha256(String(req.ip)) : null, String(req.get("user-agent") || "").slice(0, 500)],
      );
      setBrowserCookie(res, SESSION_COOKIE, token, SESSION_SECONDS, sessionSecurity.cookieOptions);
      return res.redirect(302, frontendUrl);
    } catch (error) {
      logger.warn?.(`[web-auth] callback failed stage=${stage} reason=${authFailureReason(error)}`);
      const accountUnavailable = ["identity_not_provisioned", "organization_membership_required"]
        .includes(error?.message);
      const providerUnavailable = ["oidc_discovery_unavailable", "token_exchange_unavailable"]
        .includes(error?.message);
      const code = accountUnavailable
        ? "account_not_provisioned"
        : providerUnavailable
          ? "authentication_unavailable"
          : "authentication_failed";
      const status = accountUnavailable ? 403 : providerUnavailable ? 503 : 401;
      return res.status(status).json({ error: code });
    }
  });

  router.post("/logout", async (req, res) => {
    const token = cookies(req).get(SESSION_COOKIE);
    if (token) {
      await pool.query(
        `UPDATE app_auth.web_sessions SET revoked_at = now() WHERE token_sha256 = $1 AND revoked_at IS NULL`,
        [sha256(token)],
      ).catch(() => {});
    }
    clearBrowserCookie(res, SESSION_COOKIE, sessionSecurity.cookieOptions);
    return res.status(204).end();
  });

  return router;
}

export const WEB_SESSION_COOKIE = SESSION_COOKIE;
