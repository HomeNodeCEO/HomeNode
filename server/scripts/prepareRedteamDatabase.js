import "dotenv/config";
import pg from "pg";

import { normalizeOidcIssuer } from "../src/modules/mobile/auth.js";
import { saveUadSection } from "../src/modules/uad/editor.js";
import { createUadWorkfile } from "../src/modules/uad/workfiles.js";
import {
  seedSalesRichUadDatabaseFixture,
  seedSyntheticUadAssignmentClient,
} from "./lib/uadSalesRichDatabaseFixture.js";
import { seedSyntheticUadWorkfileFixture } from "./lib/uadSyntheticWorkfileFixture.js";
import {
  assertRedTeamDatabaseName,
  assertRedTeamFixtureAccountId,
  createRedTeamIsolationConfiguration,
  verifyRedTeamSyntheticBoundary,
} from "../src/security/redTeamIsolation.js";
import {
  parseRedTeamOidcSubjects,
  pruneStaleRedTeamOidcIssuers,
  REDTEAM_ORGANIZATIONS,
  REDTEAM_PERSONAS,
} from "../src/security/redTeamFixtures.js";

const isolation = createRedTeamIsolationConfiguration();
if (!isolation.enabled || !isolation.ready) throw new Error("redteam_isolation_not_enabled");
const oidcIssuer = normalizeOidcIssuer(process.env.OIDC_ISSUER);
const oidcSubjects = parseRedTeamOidcSubjects(process.env.REDTEAM_OIDC_SUBJECTS_JSON);
const fixtureAccountId = assertRedTeamFixtureAccountId(
  process.env.REDTEAM_FIXTURE_ACCOUNT_ID || "UAD-REDTEAM-SFR-0001",
);

const usesRender = /\.render\.com(?:[/:]|$)/i.test(process.env.DATABASE_URL || "");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 1,
  application_name: "homenode-redteam-fixtures",
});

const REDTEAM_ASSIGNMENT_DEFAULTS = Object.freeze([
  { context_key: "assignment", uid: "1000.0034", value: "PortfolioEvaluation" },
  { context_key: "assignment", uid: "1000.0158", value: "TraditionalAppraisal" },
  { context_key: "assignment", uid: "1000.0043", value: false },
  { context_key: "appraiser_inspection", uid: "2400.0081", value: "Physical" },
  { context_key: "appraiser_inspection", uid: "2400.0082", value: "Physical" },
  { context_key: "appraiser_inspection", uid: "2400.0080", value: "2026-01-15" },
]);

function organizationFor(persona) {
  const organization = REDTEAM_ORGANIZATIONS[persona.organization];
  if (!organization) throw new Error(`redteam_persona_organization_invalid:${persona.key}`);
  return organization;
}

async function upsertOrganizations(client) {
  for (const organization of Object.values(REDTEAM_ORGANIZATIONS)) {
    await client.query(
      `INSERT INTO app_auth.organizations (
         id, legal_name, display_name, address_line_1, city, state_code,
         postal_code, country_code, active, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'US', true, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         legal_name = EXCLUDED.legal_name,
         display_name = EXCLUDED.display_name,
         address_line_1 = EXCLUDED.address_line_1,
         city = EXCLUDED.city,
         state_code = EXCLUDED.state_code,
         postal_code = EXCLUDED.postal_code,
         country_code = EXCLUDED.country_code,
         active = true,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [
        organization.id,
        organization.legalName,
        organization.displayName,
        organization.addressLine1,
        organization.city,
        organization.stateCode,
        organization.postalCode,
        JSON.stringify({ synthetic: true, environment: "redteam" }),
      ],
    );
  }
}

async function assertAssignedAppraiserCredentialFixture(client) {
  const assigned = REDTEAM_PERSONAS.find((persona) => persona.key === "assigned_appraiser_a");
  const result = await client.query(
    `SELECT users.active AS user_active,
            profile.profile_status,
            organization.address_line_1, organization.city,
            organization.state_code, organization.postal_code,
            license.status AS license_status, license.expires_on
       FROM app_auth.users users
       JOIN app_auth.appraiser_profiles profile ON profile.user_id = users.id
       JOIN app_auth.organizations organization ON organization.id = profile.default_organization_id
       JOIN app_auth.appraiser_licenses license ON license.user_id = users.id
      WHERE users.id = $1 AND license.status = 'active'
      ORDER BY license.expires_on DESC
      LIMIT 1`,
    [assigned.id],
  );
  const row = result.rows[0];
  const licenseExpiration = row?.expires_on ? new Date(row.expires_on).getTime() : Number.NaN;
  if (!row
    || row.user_active !== true
    || row.profile_status !== "active"
    || !row.address_line_1
    || !row.city
    || !row.state_code
    || !row.postal_code
    || row.license_status !== "active"
    || !Number.isFinite(licenseExpiration)
    || licenseExpiration < Date.now()) {
    throw new Error("redteam_assigned_appraiser_credentials_incomplete");
  }
}

async function upsertPersonas(client) {
  for (const persona of REDTEAM_PERSONAS) {
    const organization = organizationFor(persona);
    const email = `${persona.key.replaceAll("_", "-")}@redteam.homenode.invalid`;
    const displayName = persona.key.split("_").map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(" ");
    await client.query(
      `INSERT INTO app_auth.users (id, email, display_name, active, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         active = EXCLUDED.active,
         metadata = EXCLUDED.metadata,
         updated_at = now()`,
      [persona.id, email, displayName, persona.active, JSON.stringify({ synthetic: true, environment: "redteam", persona: persona.key })],
    );
    await client.query(
      `INSERT INTO app_auth.organization_memberships (organization_id, user_id, status)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET
         status = EXCLUDED.status, updated_at = now()`,
      [organization.id, persona.id, persona.status],
    );
    await client.query(
      "DELETE FROM app_auth.membership_roles WHERE organization_id = $1 AND user_id = $2",
      [organization.id, persona.id],
    );
    for (const role of persona.roles) {
      await client.query(
        `INSERT INTO app_auth.membership_roles (organization_id, user_id, role_code)
         VALUES ($1, $2, $3)`,
        [organization.id, persona.id, role],
      );
    }
    if (persona.roles.some((role) => ["appraiser", "supervisory_appraiser"].includes(role))) {
      await client.query(
        `INSERT INTO app_auth.appraiser_profiles (
           user_id, default_organization_id, signature_policy, profile_status, metadata
         ) VALUES ($1, $2, 'session', $3, $4::jsonb)
         ON CONFLICT (user_id) DO UPDATE SET
           default_organization_id = EXCLUDED.default_organization_id,
           signature_policy = EXCLUDED.signature_policy,
           profile_status = EXCLUDED.profile_status,
           metadata = EXCLUDED.metadata,
           updated_at = now()`,
        [persona.id, organization.id, persona.active ? "active" : "inactive", JSON.stringify({ synthetic: true, environment: "redteam" })],
      );
      const licenseId = `${persona.id.slice(0, -3)}9${persona.id.slice(-2)}`;
      await client.query(
        `INSERT INTO app_auth.appraiser_licenses (
           id, user_id, jurisdiction, license_number, license_type,
           issued_on, expires_on, status, metadata
         ) VALUES ($1, $2, 'TX', $3, 'Certified Residential',
                   DATE '2025-01-01', DATE '2028-12-31', $4, $5::jsonb)
         ON CONFLICT (user_id, jurisdiction, license_number) DO UPDATE SET
           status = EXCLUDED.status,
           metadata = EXCLUDED.metadata,
           updated_at = now()`,
        [licenseId, persona.id, `REDTEAM-${persona.key.toUpperCase()}`, persona.active ? "active" : "inactive", JSON.stringify({ synthetic: true, environment: "redteam", uad_license_type: "CertifiedResidential" })],
      );
    }
    const identity = await client.query(
      `SELECT subject, user_id
         FROM app_auth.oidc_identities
        WHERE (issuer = $1 AND subject = $2) OR (issuer = $1 AND user_id = $3)
        FOR UPDATE`,
      [oidcIssuer, oidcSubjects[persona.key], persona.id],
    );
    if (identity.rows.some((row) => row.user_id !== persona.id || row.subject !== oidcSubjects[persona.key])) {
      throw new Error(`redteam_oidc_identity_conflict:${persona.key}`);
    }
    await client.query(
      `INSERT INTO app_auth.oidc_identities (issuer, subject, user_id, provider_key)
       VALUES ($1, $2, $3, 'redteam')
       ON CONFLICT (issuer, subject) DO UPDATE SET
         provider_key = EXCLUDED.provider_key,
         updated_at = now()`,
      [oidcIssuer, oidcSubjects[persona.key], persona.id],
    );
  }
  return pruneStaleRedTeamOidcIssuers(client, oidcIssuer);
}

async function ensureWorkfile(accountId, fileNumber, organizationId, appraiserId) {
  const existing = await pool.query(
    `SELECT id, organization_id, assigned_appraiser_user_id
       FROM appraisal.uad_workfiles
      WHERE lower(file_number) = lower($1)
      ORDER BY created_at, id
      LIMIT 1`,
    [fileNumber],
  );
  if (existing.rows.length) {
    const workfile = existing.rows[0];
    if (workfile.organization_id !== organizationId || workfile.assigned_appraiser_user_id !== appraiserId) {
      throw new Error("redteam_fixture_workfile_scope_mismatch");
    }
    return workfile.id;
  }
  const workfile = await createUadWorkfile(pool, accountId, {
    file_number: fileNumber,
    assignment_purpose: "Synthetic authorization and tenant-isolation testing",
    organization_id: organizationId,
    assigned_appraiser_user_id: appraiserId,
    actor_user_id: appraiserId,
  });
  return workfile.id;
}

async function ensureRedTeamAssignmentBaseline(workfileId) {
  await seedSyntheticUadAssignmentClient(pool, workfileId, {
    namespace: "uad-redteam-assignment-baseline",
    sourceReference: "synthetic_redteam_assignment_baseline",
  });
  const workfile = await pool.query(
    "SELECT current_revision FROM appraisal.uad_workfiles WHERE id = $1",
    [workfileId],
  );
  if (workfile.rows.length !== 1) throw new Error("redteam_fixture_workfile_missing");
  const values = await pool.query(
    `SELECT field_context, uad_uid, value
       FROM appraisal.uad_field_values
      WHERE workfile_id = $1
        AND entity_id IS NULL
        AND (field_context, uad_uid) IN (
          ('assignment', '1000.0034'),
          ('assignment', '1000.0158'),
          ('assignment', '1000.0043'),
          ('appraiser_inspection', '2400.0081'),
          ('appraiser_inspection', '2400.0082'),
          ('appraiser_inspection', '2400.0080')
        )`,
    [workfileId],
  );
  const existing = new Set(values.rows
    .filter((row) => row.value !== null && row.value !== "")
    .map((row) => `${row.field_context}:${row.uad_uid}`));
  const missing = REDTEAM_ASSIGNMENT_DEFAULTS.filter(
    (field) => !existing.has(`${field.context_key}:${field.uid}`),
  );
  if (!missing.length) return false;
  await saveUadSection(pool, workfileId, "assignment", {
    expected_revision: Number(workfile.rows[0].current_revision),
    values: missing,
  });
  return true;
}

try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  assertRedTeamDatabaseName(identity.rows[0]?.database_name);
  await verifyRedTeamSyntheticBoundary(pool);
  const fixture = await pool.query("SELECT account_id FROM core.accounts WHERE account_id = $1", [fixtureAccountId]);
  if (fixture.rows.length !== 1) throw new Error("redteam_fixture_account_missing");

  const client = await pool.connect();
  let staleOidcIdentitiesRemoved = 0;
  try {
    await client.query("BEGIN");
    await upsertOrganizations(client);
    staleOidcIdentitiesRemoved = await upsertPersonas(client);
    await assertAssignedAppraiserCredentialFixture(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const assignedA = REDTEAM_PERSONAS.find((persona) => persona.key === "assigned_appraiser_a");
  const appraiserB = REDTEAM_PERSONAS.find((persona) => persona.key === "appraiser_b");
  const organizationAWorkfile = await ensureWorkfile(
    fixtureAccountId,
    "HN-REDTEAM-ORG-A-0001",
    REDTEAM_ORGANIZATIONS.organizationA.id,
    assignedA.id,
  );
  const organizationBWorkfile = await ensureWorkfile(
    fixtureAccountId,
    "HN-REDTEAM-ORG-B-0001",
    REDTEAM_ORGANIZATIONS.organizationB.id,
    appraiserB.id,
  );
  const organizationADeliveryWorkfile = await ensureWorkfile(
    fixtureAccountId,
    "HN-REDTEAM-DELIVERY-A-0001",
    REDTEAM_ORGANIZATIONS.organizationA.id,
    assignedA.id,
  );
  const assignmentBaselinesCreated = [
    await ensureRedTeamAssignmentBaseline(organizationAWorkfile),
    await ensureRedTeamAssignmentBaseline(organizationBWorkfile),
  ].filter(Boolean).length;
  const deliveryStatus = await pool.query(
    "SELECT status FROM appraisal.uad_workfiles WHERE id = $1",
    [organizationADeliveryWorkfile],
  );
  const salesRichDeliveryFixture = ["signed", "exported", "submitted"].includes(deliveryStatus.rows[0]?.status)
    ? { preserved: true, comparable_count: 3 }
    : {
        preserved: false,
        canonical_fixture: await seedSyntheticUadWorkfileFixture(pool, organizationADeliveryWorkfile, {
          namespace: "uad-redteam-delivery-a",
          sourceReference: "synthetic_redteam_canonical_fixture",
        }),
        ...await seedSalesRichUadDatabaseFixture(pool, organizationADeliveryWorkfile, {
          namespace: "uad-redteam-delivery-a",
          sourceReference: "synthetic_redteam_delivery",
        }),
      };
  console.log(JSON.stringify({
    prepared: true,
    environment: "redteam",
    synthetic_only: true,
    organizations: Object.keys(REDTEAM_ORGANIZATIONS).length,
    personas: REDTEAM_PERSONAS.length,
    stale_oidc_identities_removed: staleOidcIdentitiesRemoved,
    workfiles: [organizationAWorkfile, organizationBWorkfile, organizationADeliveryWorkfile].length,
    assignment_baselines_created: assignmentBaselinesCreated,
    sales_rich_delivery_fixture: salesRichDeliveryFixture,
  }));
} finally {
  await pool.end();
}
