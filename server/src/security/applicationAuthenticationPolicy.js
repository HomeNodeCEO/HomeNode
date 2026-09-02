const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXPIRING_WITHIN_DAYS = 7;

function startupError(code) {
  return new Error(code);
}

function legacyEnabled(value) {
  return TRUE_VALUES.has(String(value || "").trim().toLowerCase());
}

function validIsoDate(value) {
  const normalized = String(value || "");
  const match = ISO_DATE_PATTERN.exec(normalized);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1] ? normalized : null;
}

function dateFromClock(now) {
  const value = typeof now === "function" ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("application_authentication_clock_invalid");
  return date;
}

function utcDay(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
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
  { now = () => new Date() } = {},
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

  const configuredUntil = environment.LEGACY_AUTH_ROLLOUT_UNTIL;
  if (configuredUntil === undefined || configuredUntil === null || String(configuredUntil).trim() === "") {
    throw startupError("legacy_auth_rollout_until_required");
  }
  const legacyRolloutUntil = validIsoDate(configuredUntil);
  if (!legacyRolloutUntil) throw startupError("legacy_auth_rollout_until_invalid");
  const today = dateFromClock(now).toISOString().slice(0, 10);
  if (legacyRolloutUntil <= today) throw startupError("legacy_auth_rollout_expired");

  return policy({
    mode: "production_rollout",
    authenticationRequired: false,
    legacyRolloutUntil,
  });
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
  { now = () => new Date() } = {},
) {
  if (!authenticationPolicy || typeof authenticationPolicy.authenticationRequired !== "boolean") {
    throw new TypeError("application_authentication_policy_required");
  }
  if (authenticationPolicy.mode === "enforced") {
    return Object.freeze({ status: "ready", mode: "enforced", warnings: Object.freeze([]) });
  }
  if (authenticationPolicy.mode !== "production_rollout") {
    return Object.freeze({
      status: "development",
      mode: authenticationPolicy.mode,
      warnings: Object.freeze([]),
    });
  }

  const today = dateFromClock(now).toISOString().slice(0, 10);
  const remainingDays = utcDay(authenticationPolicy.legacyRolloutUntil) - utcDay(today);
  const warnings = ["legacy_auth_rollout_active"];
  if (remainingDays <= 0) warnings.push("legacy_auth_rollout_expired");
  else if (remainingDays <= EXPIRING_WITHIN_DAYS) warnings.push("legacy_auth_rollout_expiring");
  return Object.freeze({
    status: "degraded",
    mode: "production_rollout",
    warnings: Object.freeze(warnings),
  });
}
