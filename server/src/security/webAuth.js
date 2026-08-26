import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";

const SESSION_COOKIE = "__Host-homenode_session";
const TRANSACTION_COOKIE = "__Host-homenode_auth_tx";
const SESSION_SECONDS = 8 * 60 * 60;

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

function cookie(name, value, { maxAge = null } = {}) {
  const pieces = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "Secure", "SameSite=Lax"];
  if (maxAge != null) pieces.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return pieces.join("; ");
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
  if (!transaction?.state || !transaction?.verifier || Number(transaction.expires_at) < now) {
    throw new Error("expired_auth_transaction");
  }
  return transaction;
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

export function createWebSessionAuthenticator({ pool }) {
  return async function webSessionAuthenticator(req, res, next) {
    if (req.mobileAuth || /^Bearer\s+/i.test(String(req.get?.("authorization") || ""))) return next();
    const token = cookies(req).get(SESSION_COOKIE);
    if (!token) return next();
    try {
      const identity = await loadSessionIdentity(pool, token);
      if (identity) req.mobileAuth = identity;
      else res.append("set-cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
      return next();
    } catch {
      return res.status(503).json({ error: "authentication_unavailable" });
    }
  };
}

export function createWebAuthRouter({ pool, verifier, environment = process.env, fetchImpl = globalThis.fetch }) {
  const router = express.Router();
  const clientId = String(environment.OIDC_WEB_CLIENT_ID || "").trim();
  const clientSecret = String(environment.OIDC_WEB_CLIENT_SECRET || "").trim();
  const redirectUri = String(environment.OIDC_WEB_REDIRECT_URI || "").trim();
  const frontendUrl = String(environment.WEB_APP_URL || "").trim();
  const sessionSecret = String(environment.APP_SESSION_SECRET || "").trim();
  const configured = Boolean(
    verifier?.configured
    && clientId
    && clientSecret
    && redirectUri
    && frontendUrl
    && sessionSecret.length >= 32
  );
  // Configuration and enforcement are deliberately separate rollout stages.
  // WorkOS can be provisioned and tested without replacing the editor-key
  // workflow until APPLICATION_AUTHENTICATION_REQUIRED is explicitly enabled.
  const required = enabled(environment.APPLICATION_AUTHENTICATION_REQUIRED);
  let discovery = null;

  async function getDiscovery() {
    if (discovery) return discovery;
    const response = await fetchImpl(`${verifier.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!response.ok) throw new Error("oidc_discovery_unavailable");
    const value = await response.json();
    if (value.issuer !== verifier.issuer || !value.authorization_endpoint || !value.token_endpoint) {
      throw new Error("invalid_oidc_discovery");
    }
    discovery = value;
    return discovery;
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
      const challenge = base64url(createHash("sha256").update(verifierValue).digest());
      res.append("set-cookie", cookie(TRANSACTION_COOKIE, signTransaction({
        state,
        verifier: verifierValue,
        expires_at: Date.now() + 10 * 60 * 1000,
      }, sessionSecret), { maxAge: 600 }));
      const url = new URL(metadata.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "openid profile email");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return res.redirect(302, url.toString());
    } catch {
      return res.status(503).json({ error: "web_auth_unavailable" });
    }
  });

  router.get("/callback", async (req, res) => {
    res.append("set-cookie", cookie(TRANSACTION_COOKIE, "", { maxAge: 0 }));
    if (!configured) return res.status(503).json({ error: "web_auth_not_configured" });
    try {
      const transaction = readTransaction(cookies(req).get(TRANSACTION_COOKIE), sessionSecret);
      if (!req.query.code || req.query.state !== transaction.state) throw new Error("invalid_auth_callback");
      const metadata = await getDiscovery();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: String(req.query.code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: transaction.verifier,
      });
      const response = await fetchImpl(metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      });
      if (!response.ok) throw new Error("token_exchange_failed");
      const tokens = await response.json();
      const claims = await verifier.verify(tokens.access_token);
      const identity = await loadIdentity(pool, claims.iss, claims.sub);
      const token = base64url(randomBytes(32));
      await pool.query(
        `INSERT INTO app_auth.web_sessions
           (id, token_sha256, user_id, expires_at, created_ip_sha256, created_user_agent)
         VALUES ($1, $2, $3, now() + ($4 * interval '1 second'), $5, $6)`,
        [randomUUID(), sha256(token), identity.userId, SESSION_SECONDS,
          req.ip ? sha256(String(req.ip)) : null, String(req.get("user-agent") || "").slice(0, 500)],
      );
      res.append("set-cookie", cookie(SESSION_COOKIE, token, { maxAge: SESSION_SECONDS }));
      return res.redirect(302, frontendUrl);
    } catch (error) {
      const code = ["identity_not_provisioned", "organization_membership_required"].includes(error?.message)
        ? "account_not_provisioned"
        : "authentication_failed";
      return res.status(code === "account_not_provisioned" ? 403 : 401).json({ error: code });
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
    res.append("set-cookie", cookie(SESSION_COOKIE, "", { maxAge: 0 }));
    return res.status(204).end();
  });

  return router;
}

export const WEB_SESSION_COOKIE = SESSION_COOKIE;
