const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 300;

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
}

function rateLimitClientIpHeader(environment) {
  const configured = String(environment.UAD_RATE_LIMIT_CLIENT_IP_HEADER || "").trim().toLowerCase();
  if (!configured) return enabled(environment.RENDER) ? "cf-connecting-ip" : null;
  if (["none", "socket"].includes(configured)) return null;
  if (configured !== "cf-connecting-ip") throw new Error("invalid_rate_limit_client_ip_header");
  return configured;
}

function normalizedOrigin(value, { allowHttp = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("invalid_cors_origin");
  }
  const localHttp = parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(allowHttp && localHttp)) {
    throw new Error("invalid_cors_origin");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("invalid_cors_origin");
  }
  return parsed.origin;
}

export function createHttpSecurityConfiguration(environment = process.env) {
  const strict = enabled(environment.UAD_SECURITY_STRICT);
  const authenticationRequired = enabled(environment.UAD_AUTHENTICATION_REQUIRED);
  const rateLimitEnabled = strict || enabled(environment.UAD_RATE_LIMIT_ENABLED);
  const clientIpHeader = rateLimitClientIpHeader(environment);
  const allowHttpOrigins = !strict && environment.NODE_ENV !== "production";
  const origins = String(environment.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => normalizedOrigin(origin, { allowHttp: allowHttpOrigins }));

  if (strict && !authenticationRequired) {
    throw new Error("uad_strict_security_requires_authentication");
  }
  if (strict && origins.length === 0) {
    throw new Error("uad_strict_security_requires_cors_origins");
  }
  if (strict && enabled(environment.RENDER) && !clientIpHeader) {
    throw new Error("uad_strict_security_requires_render_client_ip_header");
  }

  return Object.freeze({
    strict,
    authenticationRequired,
    corsRestricted: origins.length > 0,
    corsOrigins: Object.freeze([...new Set(origins)]),
    rateLimitEnabled,
    rateLimitWindowMs: boundedInteger(
      environment.UAD_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      1_000,
      60 * 60 * 1_000,
    ),
    rateLimitMax: boundedInteger(environment.UAD_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX, 10, 10_000),
    rateLimitClientIpHeader: clientIpHeader,
    trustProxyHops: boundedInteger(environment.TRUST_PROXY_HOPS, 0, 0, 10),
  });
}

function appendVary(res, value) {
  const existing = String(res.getHeader("vary") || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!existing.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
    existing.push(value);
  }
  res.setHeader("vary", existing.join(", "));
}

function requestOriginHost(origin) {
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return null;
    }
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

export function createCorsMiddleware(configuration) {
  const allowed = new Set(configuration.corsOrigins);
  return function enforceCors(req, res, next) {
    const origin = String(req.get?.("origin") || "").trim();
    if (!origin) return next();
    const requestHost = String(req.get?.("host") || "").trim().toLowerCase();
    const sameOrigin = requestHost && requestOriginHost(origin) === requestHost;
    if (!sameOrigin && !allowed.has(origin)) {
      return res.status(403).json({ error: "cors_origin_denied" });
    }
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key");
    res.setHeader("access-control-max-age", "600");
    appendVary(res, "Origin");
    if (req.method === "OPTIONS") return res.status(204).end();
    return next();
  };
}

export function securityHeaders(_req, res, next) {
  res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("cross-origin-resource-policy", "same-site");
  res.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  next();
}
