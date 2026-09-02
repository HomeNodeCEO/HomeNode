import { rateLimit as createRateLimiter } from "express-rate-limit";

function requireMiddleware(value, code) {
  if (typeof value !== "function") throw new TypeError(code);
  return value;
}

export function createLegacyApplicationAuthenticationGate(authenticationPolicy) {
  if (!authenticationPolicy || typeof authenticationPolicy.authenticationRequired !== "boolean") {
    throw new TypeError("application_authentication_policy_required");
  }
  return function legacyApplicationAuthenticationGate(req, res, next) {
    if (!authenticationPolicy.authenticationRequired || req.mobileAuth) return next();
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
  if (!globalApiRateLimiterOptions || typeof globalApiRateLimiterOptions !== "object") {
    throw new TypeError("global_api_rate_limiter_options_required");
  }
  const rateLimit = createRateLimiter(globalApiRateLimiterOptions);
  const routeWebAuth = requireMiddleware(webAuthRouter, "web_auth_router_required");
  if (typeof buildSession !== "function") throw new TypeError("application_session_builder_required");
  if (typeof loadAuthReadiness !== "function") {
    throw new TypeError("application_auth_readiness_loader_required");
  }

  // Browser sessions are hydrated first so UAD may authorize either the web
  // session or its native bearer token. UAD owns its bounded binary parsers,
  // so it must remain ahead of the legacy global JSON parser.
  app.use("/api", hydrateWebSession);
  app.use("/api/uad", routeUad);
  app.use("/api/uad", handleUadBodyError);
  app.use(parseJson);

  // Native mobile owns independent bearer authentication and intentionally
  // remains ahead of the legacy application gate.
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

  // Browser bootstrap routes and the remaining legacy API surface are each
  // rate-limited exactly once. Keep the protected audit handlers explicit so
  // automated security review can verify their authorization boundary.
  app.use("/api/auth", rateLimit, routeWebAuth);
  app.use("/api", rateLimit);
  app.use("/api", createLegacyApplicationAuthenticationGate(authenticationPolicy));
  return app;
}
