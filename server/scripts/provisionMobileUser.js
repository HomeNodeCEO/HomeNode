import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

import { normalizeOidcIssuer } from "../src/modules/mobile/auth.js";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

function requiredOption(name, maximumLength) {
  const value = option(name);
  if (!value || value.length > maximumLength) throw new Error(`valid --${name} is required`);
  return value;
}

const email = requiredOption("email", 320).toLowerCase();
const displayName = requiredOption("display-name", 200);
const organizationLegalName = requiredOption("organization-legal-name", 300);
const organizationDisplayName = option("organization-display-name") || organizationLegalName;
const organizationDbaName = option("organization-dba-name") || null;
const issuer = normalizeOidcIssuer(requiredOption("issuer", 500));
const subject = requiredOption("subject", 500);
const providerKey = option("provider") || "workos";
const roles = [...new Set((option("roles") || "appraiser").split(",").map((role) => role.trim()).filter(Boolean))];

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (organizationDisplayName.length > 300) throw new Error("valid --organization-display-name is required");
if (organizationDbaName?.length > 300) throw new Error("valid --organization-dba-name is required");
if (!roles.length) throw new Error("at least one --roles value is required");
if (process.env.NODE_ENV === "production" && email.endsWith(".invalid")) {
  throw new Error("synthetic users cannot be provisioned in production");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();

try {
  await client.query("BEGIN");

  const organizationResult = await client.query(
    `SELECT id, active
       FROM app_auth.organizations
      WHERE lower(legal_name) = lower($1)
      FOR UPDATE`,
    [organizationLegalName],
  );
  if (organizationResult.rows.length > 1) throw new Error("organization legal name is ambiguous");
  if (organizationResult.rows[0] && !organizationResult.rows[0].active) {
    throw new Error("matching HomeNode organization is inactive");
  }

  const organizationId = organizationResult.rows[0]?.id || randomUUID();
  if (!organizationResult.rows.length) {
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
        JSON.stringify({ provisioned_by: "provisionMobileUser", identity_provider: providerKey }),
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
  if (userResult.rows.length > 1) throw new Error("HomeNode user email is ambiguous");
  if (userResult.rows[0] && !userResult.rows[0].active) {
    throw new Error("matching HomeNode user is inactive");
  }

  const userId = userResult.rows[0]?.id || randomUUID();
  if (!userResult.rows.length) {
    await client.query(
      `INSERT INTO app_auth.users (id, email, display_name, active, metadata)
       VALUES ($1, $2, $3, true, $4::jsonb)`,
      [userId, email, displayName, JSON.stringify({ provisioned_by: "provisionMobileUser", identity_provider: providerKey })],
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

  if (validRoles.has("appraiser")) {
    const profileResult = await client.query(
      "SELECT profile_status FROM app_auth.appraiser_profiles WHERE user_id = $1 FOR UPDATE",
      [userId],
    );
    if (profileResult.rows[0]?.profile_status === "inactive") {
      throw new Error("matching HomeNode appraiser profile is inactive");
    }
    if (!profileResult.rows.length) {
      await client.query(
        `INSERT INTO app_auth.appraiser_profiles (
           user_id, default_organization_id, signature_policy, profile_status, metadata
         ) VALUES ($1, $2, 'reauthentication', 'active', $3::jsonb)`,
        [userId, organizationId, JSON.stringify({ provisioned_by: "provisionMobileUser" })],
      );
    }
  }

  const identityResult = await client.query(
    `SELECT issuer, subject, user_id
       FROM app_auth.oidc_identities
      WHERE (issuer = $1 AND subject = $2) OR (user_id = $3 AND issuer = $1)
      FOR UPDATE`,
    [issuer, subject, userId],
  );
  if (identityResult.rows.some((identity) => identity.user_id !== userId)) {
    throw new Error("OIDC identity is already mapped to another HomeNode user");
  }
  if (identityResult.rows.some((identity) => identity.subject !== subject)) {
    throw new Error("HomeNode user is already mapped to another subject for this issuer");
  }

  await client.query(
    `INSERT INTO app_auth.oidc_identities (issuer, subject, user_id, provider_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (issuer, subject) DO UPDATE
       SET provider_key = EXCLUDED.provider_key, updated_at = now()`,
    [issuer, subject, userId, providerKey],
  );

  await client.query("COMMIT");
  console.log(JSON.stringify({
    provisioned: true,
    user_id: userId,
    email,
    organization_id: organizationId,
    organization_display_name: organizationDisplayName,
    roles,
    issuer,
    subject,
  }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

