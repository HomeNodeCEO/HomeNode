import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function requiredOption(name, maximumLength) {
  const value = option(name);
  if (!value || value.length > maximumLength) throw new Error(`valid --${name} is required`);
  return value;
}

function normalizeDate(value, name) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`valid --${name} is required`);
  }
  return value;
}

const apply = process.argv.includes("--apply");
const email = requiredOption("email", 320).toLowerCase();
const displayName = requiredOption("display-name", 200);
const organizationLegalName = requiredOption("organization-legal-name", 300);
const organizationDisplayName = option("organization-display-name") || organizationLegalName;
const organizationDbaName = option("organization-dba-name") || null;
const roles = [...new Set((option("roles") || "appraiser,organization_admin")
  .split(",").map((role) => role.trim()).filter(Boolean))];
const signaturePolicy = option("signature-policy") || "session";
const licenseJurisdiction = option("license-jurisdiction").toUpperCase();
const licenseNumber = option("license-number");
const licenseType = option("license-type");
const licenseExpiresOn = normalizeDate(option("license-expires-on"), "license-expires-on");
const licenseValues = [licenseJurisdiction, licenseNumber, licenseType, licenseExpiresOn];

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("valid --email is required");
if (organizationDisplayName.length > 300) throw new Error("valid --organization-display-name is required");
if (organizationDbaName?.length > 300) throw new Error("valid --organization-dba-name is required");
if (!roles.length) throw new Error("at least one --roles value is required");
if (!new Set(["session", "reauthentication"]).has(signaturePolicy)) {
  throw new Error("--signature-policy must be session or reauthentication");
}
if (licenseValues.some(Boolean) && !licenseValues.every(Boolean)) {
  throw new Error("license jurisdiction, number, type, and expiration must be supplied together");
}
if (process.env.NODE_ENV === "production" && email.endsWith(".invalid")) {
  throw new Error("synthetic users cannot be provisioned in production");
}
if (apply && process.env.NODE_ENV === "production"
    && option("confirm-production") !== organizationLegalName) {
  throw new Error("--confirm-production must exactly match --organization-legal-name");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('application-auth-bootstrap'))");

  const organizationResult = await client.query(
    `SELECT id, active
       FROM app_auth.organizations
      WHERE lower(legal_name) = lower($1)
      FOR UPDATE`,
    [organizationLegalName],
  );
  if (organizationResult.rowCount > 1) throw new Error("organization legal name is ambiguous");
  if (organizationResult.rows[0] && !organizationResult.rows[0].active) {
    throw new Error("matching HomeNode organization is inactive");
  }
  const organizationId = organizationResult.rows[0]?.id || randomUUID();
  if (!organizationResult.rowCount) {
    await client.query(
      `INSERT INTO app_auth.organizations (
         id, legal_name, display_name, dba_name, contact_email, active, metadata
       ) VALUES ($1, $2, $3, $4, $5, true, $6::jsonb)`,
      [
        organizationId,
        organizationLegalName,
        organizationDisplayName,
        organizationDbaName,
        email,
        JSON.stringify({ provisioned_by: "bootstrapApplicationOrganization" }),
      ],
    );
  }

  const userResult = await client.query(
    `SELECT id, active
       FROM app_auth.users
      WHERE lower(email) = $1
      FOR UPDATE`,
    [email],
  );
  if (userResult.rowCount > 1) throw new Error("HomeNode user email is ambiguous");
  if (userResult.rows[0] && !userResult.rows[0].active) {
    throw new Error("matching HomeNode user is inactive");
  }
  const userId = userResult.rows[0]?.id || randomUUID();
  if (!userResult.rowCount) {
    await client.query(
      `INSERT INTO app_auth.users (id, email, display_name, active, metadata)
       VALUES ($1, $2, $3, true, $4::jsonb)`,
      [userId, email, displayName, JSON.stringify({ provisioned_by: "bootstrapApplicationOrganization" })],
    );
  }

  await client.query(
    `INSERT INTO app_auth.organization_memberships (organization_id, user_id, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (organization_id, user_id) DO UPDATE
       SET status = 'active', updated_at = now()`,
    [organizationId, userId],
  );
  const roleResult = await client.query(
    "SELECT code FROM app_auth.roles WHERE code = ANY($1::text[])",
    [roles],
  );
  const validRoles = new Set(roleResult.rows.map((row) => row.code));
  const invalidRoles = roles.filter((role) => !validRoles.has(role));
  if (invalidRoles.length) throw new Error(`unknown HomeNode role: ${invalidRoles.join(",")}`);
  for (const role of roles) {
    await client.query(
      `INSERT INTO app_auth.membership_roles (organization_id, user_id, role_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id, role_code) DO NOTHING`,
      [organizationId, userId, role],
    );
  }

  if (validRoles.has("appraiser") || validRoles.has("supervisory_appraiser")) {
    await client.query(
      `INSERT INTO app_auth.appraiser_profiles (
         user_id, default_organization_id, signature_policy, profile_status, metadata
       ) VALUES ($1, $2, $3, 'active', $4::jsonb)
       ON CONFLICT (user_id) DO UPDATE
         SET default_organization_id = COALESCE(app_auth.appraiser_profiles.default_organization_id, EXCLUDED.default_organization_id),
             signature_policy = EXCLUDED.signature_policy,
             profile_status = 'active',
             updated_at = now()`,
      [userId, organizationId, signaturePolicy, JSON.stringify({ provisioned_by: "bootstrapApplicationOrganization" })],
    );
  }
  if (licenseValues.every(Boolean)) {
    await client.query(
      `INSERT INTO app_auth.appraiser_licenses (
         id, user_id, jurisdiction, license_number, license_type, expires_on, status, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb)
       ON CONFLICT (user_id, jurisdiction, license_number) DO UPDATE
         SET license_type = EXCLUDED.license_type,
             expires_on = EXCLUDED.expires_on,
             status = 'active',
             updated_at = now()`,
      [
        randomUUID(),
        userId,
        licenseJurisdiction,
        licenseNumber,
        licenseType,
        licenseExpiresOn,
        JSON.stringify({ provisioned_by: "bootstrapApplicationOrganization" }),
      ],
    );
  }

  if (apply) await client.query("COMMIT");
  else await client.query("ROLLBACK");
  console.log(JSON.stringify({
    mode: apply ? "applied" : "dry_run",
    organization_id: organizationId,
    organization_legal_name: organizationLegalName,
    organization_display_name: organizationDisplayName,
    user_id: userId,
    email,
    roles,
    signature_policy: signaturePolicy,
    license_configured: licenseValues.every(Boolean),
    oidc_identity_configured: false,
  }));
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  client.release();
  await pool.end();
}
