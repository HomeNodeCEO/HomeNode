const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function startupError(code) {
  return new Error(code);
}

function legacyEnabled(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

function policy(value) {
  return Object.freeze({
    mode: value.mode,
    authenticationRequired: value.authenticationRequired,
    legacyRolloutUntil: value.legacyRolloutUntil || null,
  });
}

function redTeamBearerOnlyConfigured(environment) {
  return environment.APPLICATION_AUTHENTICATION_BEARER_ONLY === "true"
    && String(environment.HOMENODE_DEPLOYMENT_ENVIRONMENT || "").trim().toLowerCase() === "redteam"
    && environment.REDTEAM_ISOLATION_STRICT === "true"
    && String(environment.REDTEAM_DATA_CLASSIFICATION || "").trim().toLowerCase() === "synthetic_only"
    && environment.UAD_SECURITY_STRICT === "true"
    && environment.UAD_AUTHENTICATION_REQUIRED === "true"
    && Boolean(String(environment.OIDC_ISSUER || "").trim())
    && Boolean(String(environment.OIDC_AUDIENCE || "").trim())
    && Boolean(String(environment.OIDC_JWKS_URI || "").trim());
}

export function createApplicationAuthenticationPolicy(
  environment = process.env,
) {
  const production = String(environment.NODE_ENV || "").trim().toLowerCase() === "production";
  const raw = environment.APPLICATION_AUTHENTICATION_REQUIRED;
  const normalized = String(raw ?? "");

  if (!production) {
    const authenticationRequired = legacyEnabled(raw);
    return policy({
      mode: authenticationRequired ? "enforced" : "development_legacy",
      authenticationRequired,
    });
  }

  if (raw === undefined || raw === null || normalized.trim() === "") {
    throw startupError("application_authentication_setting_required");
  }
  if (normalized !== "true" && normalized !== "false") {
    throw startupError("application_authentication_setting_invalid");
  }
  if (normalized === "true") {
    return policy({ mode: "enforced", authenticationRequired: true });
  }
  throw startupError("application_authentication_required_in_production");
}

export function assertApplicationAuthenticationStartup({
  authenticationPolicy,
  environment = process.env,
  webOidcConfigured = false,
} = {}) {
  if (!authenticationPolicy || typeof authenticationPolicy.authenticationRequired !== "boolean") {
    throw new TypeError("application_authentication_policy_required");
  }
  if (!authenticationPolicy.authenticationRequired) return authenticationPolicy;
  // The disposable red-team application intentionally has no human login.
  // Its browser harness injects short-lived synthetic bearer tokens, and the
  // application route boundary authorizes those tokens through the same OIDC
  // identity and organization model as mobile/UAD. This exception remains
  // fail-closed unless every isolated red-team marker and OIDC input is exact.
  if (redTeamBearerOnlyConfigured(environment)) return authenticationPolicy;
  if (
    !webOidcConfigured
    || !String(environment.OIDC_CLIENT_ID || "").trim()
    || !String(environment.OIDC_WEB_CLIENT_ID || "").trim()
    || !String(environment.OIDC_WEB_CLIENT_SECRET || "").trim()
    || !String(environment.OIDC_WEB_REDIRECT_URI || "").trim()
    || !String(environment.WEB_APP_URL || "").trim()
    || String(environment.APP_SESSION_SECRET || "").trim().length < 32
    || String(environment.APP_SIGNING_SECRET || "").trim().length < 32
  ) {
    throw startupError("application_authentication_required_but_not_configured");
  }
  return authenticationPolicy;
}

export function applicationAuthenticationOperationalState(
  authenticationPolicy,
) {
  if (!authenticationPolicy || typeof authenticationPolicy.authenticationRequired !== "boolean") {
    throw new TypeError("application_authentication_policy_required");
  }
  if (authenticationPolicy.mode === "enforced") {
    return Object.freeze({ status: "ready", mode: "enforced", warnings: Object.freeze([]) });
  }
  return Object.freeze({
    status: "development",
    mode: authenticationPolicy.mode,
    warnings: Object.freeze([]),
  });
}
