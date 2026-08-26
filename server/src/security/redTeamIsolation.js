const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);
const EXTERNAL_ENABLE_FLAGS = Object.freeze([
  "UAD_COMPLIANCE_API_ENABLED",
  "FANNIE_UAD_COMPLIANCE_ENABLED",
  "FREDDIE_UAD_COMPLIANCE_ENABLED",
  "TRESTLE_ENABLED",
  "TRESTLE_REPLICATION_ENABLED",
  "TRESTLE_MEDIA_ENABLED",
  "LOCATION_BACKFILL_ENABLED",
  "CENSUS_GEOGRAPHY_ENABLED",
]);
const FORBIDDEN_EXTERNAL_SECRETS = Object.freeze([
  "FANNIE_UAD_COMPLIANCE_CLIENT_ID",
  "FANNIE_UAD_COMPLIANCE_CLIENT_SECRET",
  "FREDDIE_UAD_COMPLIANCE_CLIENT_ID",
  "FREDDIE_UAD_COMPLIANCE_CLIENT_SECRET",
  "TRESTLE_CLIENT_ID",
  "TRESTLE_CLIENT_SECRET",
  "AZURE_DOCUMENT_INTELLIGENCE_KEY",
  "CENSUS_API_KEY",
  "SMTP_URL",
  "SMTP_CONNECTION_URL",
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
]);

function enabled(value) {
  return ENABLED_VALUES.has(String(value || "").trim().toLowerCase());
}

function explicitBoolean(valueToCheck) {
  const normalized = String(valueToCheck ?? "").trim().toLowerCase();
  if (ENABLED_VALUES.has(normalized)) return true;
  if (DISABLED_VALUES.has(normalized)) return false;
  return null;
}

function value(environment, key) {
  return String(environment[key] || "").trim();
}

function markedRedTeam(valueToCheck) {
  return String(valueToCheck || "").toLowerCase().includes("redteam");
}

function namedRedTeam(valueToCheck) {
  return /red[\s_-]*team/i.test(String(valueToCheck || ""));
}

const WORKOS_APPLICATION_ID_PATTERN = /^app_[A-Za-z0-9]+$/;
const WORKOS_CLIENT_ID_PATTERN = /^client_[A-Za-z0-9]+$/;

function databaseName(databaseUrl) {
  try {
    const parsed = new URL(databaseUrl);
    if (!/^postgres(?:ql)?:$/.test(parsed.protocol)) return null;
    return decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    return null;
  }
}

function redTeamCorsOrigins(rawOrigins) {
  const origins = String(rawOrigins || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!origins.length) return null;
  try {
    return origins.map((origin) => {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin || !markedRedTeam(parsed.hostname)) {
        throw new Error("invalid");
      }
      return parsed.origin;
    });
  } catch {
    return null;
  }
}

function parsedSecureUrl(rawValue) {
  try {
    const parsed = new URL(String(rawValue || "").trim());
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return null;
    return parsed;
  } catch {
    return null;
  }
}

function secureUrl(rawValue) {
  return Boolean(parsedSecureUrl(rawValue));
}

function workosRedTeamApplicationBoundary(environment) {
  if (value(environment, "REDTEAM_OIDC_PROVIDER").toLowerCase() !== "workos_authkit") return false;

  const issuer = parsedSecureUrl(environment.OIDC_ISSUER);
  const jwks = parsedSecureUrl(environment.OIDC_JWKS_URI);
  const audience = value(environment, "OIDC_AUDIENCE");
  if (!issuer || !jwks) return false;

  return WORKOS_CLIENT_ID_PATTERN.test(audience)
    && value(environment, "REDTEAM_OIDC_CLIENT_ID") === audience
    && WORKOS_APPLICATION_ID_PATTERN.test(value(environment, "REDTEAM_OIDC_APPLICATION_ID"))
    && namedRedTeam(value(environment, "REDTEAM_OIDC_APPLICATION_NAME"))
    && issuer.origin === jwks.origin
    && issuer.pathname === "/"
    && !issuer.search
    && jwks.pathname === "/oauth2/jwks"
    && !jwks.search;
}

function staticRedTeamIssuerBoundary(environment) {
  if (value(environment, "REDTEAM_OIDC_PROVIDER").toLowerCase() !== "static_redteam") return false;

  const issuer = parsedSecureUrl(environment.OIDC_ISSUER);
  const jwks = parsedSecureUrl(environment.OIDC_JWKS_URI);
  const audience = value(environment, "OIDC_AUDIENCE");
  if (!issuer || !jwks) return false;

  return issuer.hostname.endsWith(".invalid")
    && namedRedTeam(issuer.hostname)
    && issuer.pathname === "/"
    && !issuer.search
    && namedRedTeam(audience)
    && namedRedTeam(jwks.toString());
}

export function assertRedTeamDatabaseName(name) {
  if (!markedRedTeam(name)) throw new Error("redteam_database_identity_mismatch");
  return String(name);
}

export function assertRedTeamFixtureAccountId(accountId) {
  const normalized = String(accountId || "").trim();
  if (!/^UAD-REDTEAM-[A-Z0-9-]+$/.test(normalized) || normalized.length > 64) {
    throw new Error("redteam_fixture_account_invalid");
  }
  return normalized;
}

export async function verifyRedTeamSyntheticBoundary(pool) {
  const relations = await pool.query(
    `SELECT relation_name, to_regclass(relation_name) IS NOT NULL AS available
       FROM unnest($1::text[]) AS requested(relation_name)`,
    [[
      "app_auth.organizations",
      "app_auth.users",
      "core.accounts",
      "appraisal.uad_workfiles",
      "app.report_files",
    ]],
  );
  const available = new Set(relations.rows.filter((row) => row.available).map((row) => row.relation_name));
  const counts = {};
  if (available.has("app_auth.organizations")) {
    const result = await pool.query(
      "SELECT count(*)::integer AS count FROM app_auth.organizations WHERE COALESCE(metadata->>'synthetic', 'false') <> 'true'",
    );
    counts.organizations = Number(result.rows[0]?.count || 0);
  }
  if (available.has("app_auth.users")) {
    const result = await pool.query(
      "SELECT count(*)::integer AS count FROM app_auth.users WHERE COALESCE(metadata->>'synthetic', 'false') <> 'true'",
    );
    counts.users = Number(result.rows[0]?.count || 0);
  }
  if (available.has("core.accounts")) {
    const result = await pool.query(
      "SELECT count(*)::integer AS count FROM core.accounts WHERE account_id !~ '^UAD-(STAGING|REDTEAM)-'",
    );
    counts.accounts = Number(result.rows[0]?.count || 0);
  }
  if (available.has("appraisal.uad_workfiles")) {
    const result = await pool.query(
      "SELECT count(*)::integer AS count FROM appraisal.uad_workfiles WHERE account_id !~ '^UAD-(STAGING|REDTEAM)-'",
    );
    counts.uad_workfiles = Number(result.rows[0]?.count || 0);
  }
  if (available.has("app.report_files")) {
    const result = await pool.query(
      "SELECT count(*)::integer AS count FROM app.report_files WHERE account_id !~ '^UAD-(STAGING|REDTEAM)-'",
    );
    counts.report_files = Number(result.rows[0]?.count || 0);
  }
  if (Object.values(counts).some((count) => count > 0)) {
    throw new Error("redteam_database_contains_nonsynthetic_records");
  }
  return Object.freeze({ checked: true, relation_count: available.size, synthetic_only: true });
}

export function createRedTeamIsolationConfiguration(environment = process.env) {
  const deployment = value(environment, "HOMENODE_DEPLOYMENT_ENVIRONMENT").toLowerCase();
  const strictRequested = enabled(environment.REDTEAM_ISOLATION_STRICT);
  const redTeamRequested = deployment === "redteam" || strictRequested;
  if (!redTeamRequested) {
    return Object.freeze({ enabled: false, ready: false, external_status_enabled: true });
  }

  const failures = [];
  if (deployment !== "redteam") failures.push("deployment_marker");
  if (!strictRequested) failures.push("strict_marker");
  if (value(environment, "NODE_ENV") !== "production") failures.push("node_environment");
  if (value(environment, "REDTEAM_DATA_CLASSIFICATION").toLowerCase() !== "synthetic_only") {
    failures.push("data_classification");
  }
  if (!enabled(environment.UAD_SECURITY_STRICT)) failures.push("uad_security_strict");
  if (!enabled(environment.UAD_AUTHENTICATION_REQUIRED)) failures.push("authentication_required");
  if (!enabled(environment.UAD_RATE_LIMIT_ENABLED)) failures.push("rate_limit_required");
  // The workspace switch must be explicit, but false is a valid fail-closed
  // red-team state. This lets the isolated service boot and expose only its
  // public readiness/capability diagnostics during a kill-switch event.
  if (explicitBoolean(environment.UAD_WORKSPACE_ENABLED) === null) {
    failures.push("workspace_switch_explicit");
  }
  if (!enabled(environment.MOBILE_INSPECTION_ENABLED)) failures.push("mobile_workspace_required");

  const configuredDatabaseName = databaseName(value(environment, "DATABASE_URL"));
  if (!configuredDatabaseName || !markedRedTeam(configuredDatabaseName)) failures.push("database_marker");
  if (!markedRedTeam(value(environment, "R2_BUCKET"))) failures.push("r2_bucket_marker");
  if (value(environment, "UAD_R2_BUCKET")
      && !markedRedTeam(value(environment, "UAD_R2_BUCKET"))) {
    failures.push("uad_r2_bucket_marker");
  }
  for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    if (!value(environment, key)) failures.push(`${key.toLowerCase()}_required`);
  }
  if (!redTeamCorsOrigins(environment.CORS_ORIGIN)) failures.push("cors_redteam_origin");
  if (!secureUrl(environment.OIDC_ISSUER)) failures.push("oidc_issuer_https");
  const oidcProvider = value(environment, "REDTEAM_OIDC_PROVIDER").toLowerCase();
  const oidcAudienceIsolated = oidcProvider === "workos_authkit"
    ? workosRedTeamApplicationBoundary(environment)
    : staticRedTeamIssuerBoundary(environment);
  if (!oidcAudienceIsolated) failures.push("oidc_audience_marker");
  if (!secureUrl(environment.OIDC_JWKS_URI)) failures.push("oidc_jwks_https");

  if (value(environment, "DOCUMENT_OCR_PROVIDER").toLowerCase() !== "disabled") {
    failures.push("document_ocr_disabled");
  }
  for (const key of EXTERNAL_ENABLE_FLAGS) {
    if (enabled(environment[key])) failures.push(`${key.toLowerCase()}_disabled`);
  }
  for (const key of FORBIDDEN_EXTERNAL_SECRETS) {
    if (value(environment, key)) failures.push(`${key.toLowerCase()}_absent`);
  }

  if (failures.length) {
    throw new Error(`redteam_isolation_failed:${[...new Set(failures)].join(",")}`);
  }
  return Object.freeze({
    enabled: true,
    ready: true,
    synthetic_only: true,
    external_status_enabled: false,
  });
}
