const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 300;
const MAX_TRACKED_CLIENTS = 10_000;

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(parsed, maximum));
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
    trustProxyHops: boundedInteger(environment.TRUST_PROXY_HOPS, 0, 0, 10),
  });
}

export function corsOriginPolicy(configuration) {
  if (!configuration.corsRestricted) return true;
  const allowed = new Set(configuration.corsOrigins);
  return function originPolicy(origin, callback) {
    if (!origin || allowed.has(origin)) return callback(null, true);
    const error = new Error("cors_origin_denied");
    error.statusCode = 403;
    return callback(error);
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

function requestClientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "unknown").slice(0, 200);
}

export function createFixedWindowRateLimiter({
  enabled: limiterEnabled,
  windowMs,
  maximum,
  now = () => Date.now(),
} = {}) {
  if (!limiterEnabled) return (_req, _res, next) => next();
  const ttl = boundedInteger(windowMs, DEFAULT_RATE_LIMIT_WINDOW_MS, 1_000, 60 * 60 * 1_000);
  const limit = boundedInteger(maximum, DEFAULT_RATE_LIMIT_MAX, 10, 10_000);
  const clients = new Map();

  return function fixedWindowRateLimiter(req, res, next) {
    const currentTime = now();
    const key = requestClientKey(req);
    let state = clients.get(key);
    if (!state || state.resetAt <= currentTime) {
      state = { count: 0, resetAt: currentTime + ttl };
      clients.set(key, state);
    }
    state.count += 1;
    const remaining = Math.max(0, limit - state.count);
    res.setHeader("ratelimit-limit", String(limit));
    res.setHeader("ratelimit-remaining", String(remaining));
    res.setHeader("ratelimit-reset", String(Math.ceil(state.resetAt / 1000)));

    if (clients.size > MAX_TRACKED_CLIENTS) {
      for (const [clientKey, clientState] of clients) {
        if (clientState.resetAt <= currentTime || clients.size > MAX_TRACKED_CLIENTS) {
          clients.delete(clientKey);
        }
      }
    }

    if (state.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((state.resetAt - currentTime) / 1000));
      res.setHeader("retry-after", String(retryAfterSeconds));
      return res.status(429).json({ error: "rate_limit_exceeded" });
    }
    return next();
  };
}

