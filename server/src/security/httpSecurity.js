const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 300;
const DEFAULT_API_RATE_LIMIT_MAX = 600;
const DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_MS = 15 * 60_000;
const DEFAULT_SIGNUP_RATE_LIMIT_MAX = 10;

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
  // APPLICATION_AUTHENTICATION_REQUIRED is the single browser-application
  // activation switch. Keep the older UAD-specific switch as a compatible,
  // stricter override for isolated UAD deployments.
  const authenticationRequired = enabled(environment.UAD_AUTHENTICATION_REQUIRED)
    || enabled(environment.APPLICATION_AUTHENTICATION_REQUIRED);
  const rateLimitEnabled = strict || enabled(environment.UAD_RATE_LIMIT_ENABLED);
  const apiRateLimitEnabled = environment.NODE_ENV === "production"
    || enabled(environment.API_RATE_LIMIT_ENABLED);
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
    apiRateLimitEnabled,
    apiRateLimitWindowMs: boundedInteger(
      environment.API_RATE_LIMIT_WINDOW_MS,
      DEFAULT_RATE_LIMIT_WINDOW_MS,
      1_000,
      60 * 60 * 1_000,
    ),
    apiRateLimitMax: boundedInteger(
      environment.API_RATE_LIMIT_MAX,
      DEFAULT_API_RATE_LIMIT_MAX,
      10,
      20_000,
    ),
    signupRateLimitWindowMs: boundedInteger(
      environment.SIGNUP_RATE_LIMIT_WINDOW_MS,
      DEFAULT_SIGNUP_RATE_LIMIT_WINDOW_MS,
      60_000,
      24 * 60 * 60_000,
    ),
    signupRateLimitMax: boundedInteger(
      environment.SIGNUP_RATE_LIMIT_MAX,
      DEFAULT_SIGNUP_RATE_LIMIT_MAX,
      1,
      100,
    ),
    rateLimitClientIpHeader: clientIpHeader,
    trustProxyHops: boundedInteger(environment.TRUST_PROXY_HOPS, 0, 0, 10),
  });
}

export function shouldSkipGlobalApiRateLimit(req, configuration) {
  if (!configuration.apiRateLimitEnabled) return true;
  const path = String(req?.path || req?.originalUrl || req?.url || "").split("?", 1)[0];
  return path === "/api/uad"
    || path.startsWith("/api/uad/")
    || path === "/api/mobile"
    || path.startsWith("/api/mobile/");
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
  const allowedOrigins = [...configuration.corsOrigins];
  return function enforceCors(req, res, next) {
    const origin = String(req.get?.("origin") || "").trim();
    if (!origin) return next();
    const requestHost = String(req.get?.("host") || "").trim().toLowerCase();
    const sameOrigin = requestHost && requestOriginHost(origin) === requestHost;
    // Same-origin requests do not need CORS response headers. For an allowed
    // cross-origin request, emit the canonical server-configured value rather
    // than reflecting the request header back to the browser.
    if (sameOrigin) return next();
    const allowedOrigin = allowedOrigins.find((candidate) => candidate === origin);
    if (!allowedOrigin) {
      return res.status(403).json({ error: "cors_origin_denied" });
    }
    res.setHeader("access-control-allow-origin", allowedOrigin);
    res.setHeader("access-control-allow-credentials", "true");
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

export function jsonErrorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);
  res.set("cache-control", "no-store");
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json_body" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "request_body_too_large" });
  }
  if (error?.type === "encoding.unsupported" || error?.type === "charset.unsupported") {
    return res.status(415).json({ error: "unsupported_request_encoding" });
  }
  if (["request.aborted", "request.size.invalid"].includes(error?.type)) {
    return res.status(400).json({ error: "invalid_request_body" });
  }
  console.error("[api] unhandled request error");
  return res.status(500).json({ error: "internal_server_error" });
}
