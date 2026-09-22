import { isIP } from "node:net";

import { ipKeyGenerator, rateLimit as createRateLimiter } from "express-rate-limit";

import { normalizePerformancePath } from "../util/requestPerformance.js";
import {
  authenticatedApiRateLimitKey,
  shouldSkipGlobalApiRateLimit,
} from "./httpSecurity.js";

function requireMiddleware(value, code) {
  if (typeof value !== "function") throw new TypeError(code);
  return value;
}

function rejectCompressedApiBody(req, res, next) {
  const encoding = String(req.get?.("content-encoding") || "").trim().toLowerCase();
  if (!encoding || encoding === "identity") return next();
  return res.set("cache-control", "no-store")
    .status(415)
    .json({ error: "unsupported_request_encoding" });
}

function usesRouteLocalBodyParser(req) {
  const path = String(req.originalUrl || req.url || "").split("?", 1)[0];
  if (/^\/api\/accounts\/[^/]+\/assignment-files\/[^/]+\/sales-imports(?:\/|$)/.test(path)) {
    return true;
  }
  if (!/^\/api\/accounts\/[^/]+\/neighborhood-cohort(?:\/|$)/.test(path)) return false;
  // Preserve the shared parser's existing bounded 415 response for malformed
  // charset declarations. Valid JSON is owned by the neighborhood 4 MB parser.
  return /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i
    .test(String(req.get?.("content-type") || "").trim());
}

function apiRateLimitAddress(req, httpSecurity) {
  // createHttpSecurityConfiguration accepts only CF-Connecting-IP here.
  // Render's Cloudflare edge overwrites that single-address header, while
  // req.ip is the shared proxy address unless trust-proxy is explicitly set.
  const forwarded = httpSecurity.rateLimitClientIpHeader
    ? String(req.get(httpSecurity.rateLimitClientIpHeader) || "").trim()
    : "";
  return ipKeyGenerator(isIP(forwarded) ? forwarded : req.ip);
}

export function createPreAuthenticationRateLimiterOptions({
  httpSecurity,
  logger = console,
} = {}) {
  if (!httpSecurity || typeof httpSecurity.apiRateLimitEnabled !== "boolean") {
    throw new TypeError("http_security_configuration_required");
  }
  return {
    windowMs: httpSecurity.apiRateLimitWindowMs,
    limit: httpSecurity.apiRateLimitMax,
    // Mobile and UAD own route-local pre-authentication limiters. Successful
    // application requests leave this IP bucket and enter the user bucket.
    skip(req) {
      if (!httpSecurity.apiRateLimitEnabled) return true;
      const path = String(req.originalUrl || req.path || req.url || "").split("?", 1)[0];
      const uadPath = path === "/api/uad" || path.startsWith("/api/uad/");
      if (uadPath) return Boolean(httpSecurity.rateLimitEnabled);
      return path === "/api/mobile" || path.startsWith("/api/mobile/");
    },
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => apiRateLimitAddress(req, httpSecurity),
    handler(req, res) {
      logger.warn?.("[security] pre-authentication rate limit exceeded", {
        method: String(req.method || "GET").toUpperCase(),
        path: normalizePerformancePath(req.path || req.originalUrl),
      });
      return res.set("cache-control", "no-store")
        .status(429)
        .json({ error: "authentication_rate_limit_exceeded" });
    },
  };
}

export function createApplicationRateLimiterOptions({
  httpSecurity,
  logger = console,
} = {}) {
  const preAuthenticationApiRateLimiterOptions =
    createPreAuthenticationRateLimiterOptions({ httpSecurity, logger });
  return {
    preAuthenticationApiRateLimiterOptions,
    globalApiRateLimiterOptions: {
      windowMs: httpSecurity.apiRateLimitWindowMs,
      limit: httpSecurity.apiRateLimitMax,
      // UAD and mobile own stricter route-local limiters and response headers.
      skip: (req) => shouldSkipGlobalApiRateLimit(req, httpSecurity),
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator(req) {
        return authenticatedApiRateLimitKey(req) || apiRateLimitAddress(req, httpSecurity);
      },
      handler(req, res) {
        logger.warn?.("[security] api rate limit exceeded", {
          method: String(req.method || "GET").toUpperCase(),
          path: normalizePerformancePath(req.path || req.originalUrl),
          authenticated: Boolean(authenticatedApiRateLimitKey(req)),
        });
        return res.status(429).json({ error: "api_rate_limit_exceeded" });
      },
    },
  };
}

export function createLegacyApplicationAuthenticationGate(authenticationPolicy) {
  if (
    !authenticationPolicy
    || typeof authenticationPolicy.authenticationRequired !== "boolean"
    || !["enforced", "development_legacy"].includes(authenticationPolicy.mode)
    || (authenticationPolicy.mode === "enforced" && !authenticationPolicy.authenticationRequired)
    || (authenticationPolicy.mode === "development_legacy" && authenticationPolicy.authenticationRequired)
  ) {
    throw new TypeError("application_authentication_policy_required");
  }
  if (authenticationPolicy.mode === "development_legacy") {
    return function localDevelopmentApplicationGate(_req, _res, next) {
      return next();
    };
  }
  return function legacyApplicationAuthenticationGate(req, res, next) {
    if (req.mobileAuth) return next();
    return res.set("cache-control", "no-store")
      .status(401)
      .json({ error: "authentication_required" });
  };
}

export function mountApplicationRouteBoundary(app, {
  authenticationPolicy,
  webSessionAuthenticator,
  uadRouter,
  uadBodyParserErrorHandler,
  jsonBodyParser,
  mobileRouter,
  optionalApplicationAuthenticator,
  preAuthenticationRateLimiterOptions,
  globalApiRateLimiterOptions,
  webAuthRouter,
  buildSession,
  loadAuthReadiness,
  logger = console,
} = {}) {
  if (!app?.use || !app?.get) throw new TypeError("application_route_boundary_app_required");
  const hydrateWebSession = requireMiddleware(
    webSessionAuthenticator,
    "web_session_authenticator_required",
  );
  const routeUad = requireMiddleware(uadRouter, "uad_router_required");
  const handleUadBodyError = requireMiddleware(
    uadBodyParserErrorHandler,
    "uad_body_parser_error_handler_required",
  );
  const parseJson = requireMiddleware(jsonBodyParser, "json_body_parser_required");
  const routeMobile = requireMiddleware(mobileRouter, "mobile_router_required");
  const hydrateBearer = requireMiddleware(
    optionalApplicationAuthenticator,
    "optional_application_authenticator_required",
  );
  if (!preAuthenticationRateLimiterOptions
    || typeof preAuthenticationRateLimiterOptions !== "object") {
    throw new TypeError("pre_authentication_rate_limiter_options_required");
  }
  if (!globalApiRateLimiterOptions || typeof globalApiRateLimiterOptions !== "object") {
    throw new TypeError("global_api_rate_limiter_options_required");
  }
  const preAuthenticationRateLimit = createRateLimiter(preAuthenticationRateLimiterOptions);
  const rateLimit = createRateLimiter(globalApiRateLimiterOptions);
  const routeWebAuth = requireMiddleware(webAuthRouter, "web_auth_router_required");
  if (typeof buildSession !== "function") throw new TypeError("application_session_builder_required");
  if (typeof loadAuthReadiness !== "function") {
    throw new TypeError("application_auth_readiness_loader_required");
  }

  // Browser login, callback, status, and logout own a route-local limiter and
  // do not need application-session hydration. Unmatched auth routes (notably
  // /me and /readiness) continue through the application boundary below.
  app.use("/api/auth", routeWebAuth);

  // Bound forged bearer tokens and session cookies before signature work or a
  // database lookup. Successful responses are removed from this IP bucket and
  // remain subject to the authenticated per-user limiter below.
  app.use("/api", preAuthenticationRateLimit);

  // Browser sessions are then hydrated so UAD may authorize either the web
  // session or its native bearer token. UAD and mobile own their bounded body
  // parsers, so both remain ahead of the legacy global JSON parser.
  app.use("/api", hydrateWebSession);
  app.use("/api/uad", routeUad);
  app.use("/api/uad", handleUadBodyError);

  // Native mobile owns independent bearer authentication and intentionally
  // remains ahead of the legacy application gate and parser.
  app.use("/api/mobile", routeMobile);
  app.use("/api", hydrateBearer);

  app.get("/api/auth/me", rateLimit, (req, res) => {
    res.set("cache-control", "no-store");
    if (!req.mobileAuth) return res.status(401).json({ error: "authentication_required" });
    return res.json({ ok: true, session: buildSession(req.mobileAuth) });
  });

  app.get("/api/auth/readiness", rateLimit, async (req, res) => {
    res.set("cache-control", "no-store");
    if (!req.mobileAuth) return res.status(401).json({ error: "authentication_required" });
    try {
      const readiness = await loadAuthReadiness(req.mobileAuth);
      return res.json({ ok: true, readiness });
    } catch (error) {
      if (error?.code === "auth_readiness_access_denied") {
        return res.status(403).json({ error: "auth_readiness_access_denied" });
      }
      logger.warn?.("[auth] readiness audit unavailable");
      return res.status(503).json({ error: "auth_readiness_unavailable" });
    }
  });

  // Authenticated users retain independent per-user limits. Anonymous failures
  // have already been charged to the pre-authentication IP bucket above.
  app.use("/api", (req, res, next) => (
    req.mobileAuth ? rateLimit(req, res, next) : next()
  ));
  app.use("/api", createLegacyApplicationAuthenticationGate(authenticationPolicy));
  // Authentication and throttling must settle before JSON decompression or
  // buffering. Browser/native clients send JSON request bytes directly.
  app.use("/api", rejectCompressedApiBody);
  app.use("/api", (req, res, next) => (
    usesRouteLocalBodyParser(req) ? next() : parseJson(req, res, next)
  ));
  return app;
}
