export const REDTEAM_ORGANIZATIONS = Object.freeze({
  organizationA: Object.freeze({
    id: "10000000-0000-4000-8000-000000000001",
    legalName: "HomeNode Synthetic Red Team Organization A",
    displayName: "Red Team Organization A",
    addressLine1: "300 Synthetic Review Ave",
    city: "Dallas",
    stateCode: "TX",
    postalCode: "75201",
  }),
  organizationB: Object.freeze({
    id: "20000000-0000-4000-8000-000000000001",
    legalName: "HomeNode Synthetic Red Team Organization B",
    displayName: "Red Team Organization B",
    addressLine1: "400 Synthetic Review Ave",
    city: "Dallas",
    stateCode: "TX",
    postalCode: "75202",
  }),
});

export const REDTEAM_PERSONAS = Object.freeze([
  Object.freeze({ key: "assigned_appraiser_a", id: "10000000-0000-4000-8000-000000000101", organization: "organizationA", status: "active", active: true, roles: ["appraiser"] }),
  Object.freeze({ key: "unassigned_appraiser_a", id: "10000000-0000-4000-8000-000000000102", organization: "organizationA", status: "active", active: true, roles: ["appraiser"] }),
  Object.freeze({ key: "supervisor_a", id: "10000000-0000-4000-8000-000000000103", organization: "organizationA", status: "active", active: true, roles: ["supervisory_appraiser"] }),
  Object.freeze({ key: "reviewer_a", id: "10000000-0000-4000-8000-000000000104", organization: "organizationA", status: "active", active: true, roles: ["reviewer"] }),
  Object.freeze({ key: "organization_admin_a", id: "10000000-0000-4000-8000-000000000105", organization: "organizationA", status: "active", active: true, roles: ["organization_admin"] }),
  Object.freeze({ key: "appraiser_b", id: "20000000-0000-4000-8000-000000000101", organization: "organizationB", status: "active", active: true, roles: ["appraiser"] }),
  Object.freeze({ key: "organization_admin_b", id: "20000000-0000-4000-8000-000000000102", organization: "organizationB", status: "active", active: true, roles: ["organization_admin"] }),
  Object.freeze({ key: "homenode_admin", id: "10000000-0000-4000-8000-000000000106", organization: "organizationA", status: "active", active: true, roles: ["homenode_admin"] }),
  Object.freeze({ key: "inactive_user", id: "10000000-0000-4000-8000-000000000107", organization: "organizationA", status: "active", active: false, roles: ["appraiser"] }),
  Object.freeze({ key: "suspended_member", id: "10000000-0000-4000-8000-000000000108", organization: "organizationA", status: "suspended", active: true, roles: ["appraiser"] }),
  Object.freeze({ key: "member_without_role", id: "10000000-0000-4000-8000-000000000109", organization: "organizationA", status: "active", active: true, roles: [] }),
]);

function normalizedRedTeamIssuer(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("redteam_oidc_issuer_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !/red[\s_-]*team/i.test(parsed.hostname)
  ) {
    throw new Error("redteam_oidc_issuer_invalid");
  }
  const normalized = parsed.toString();
  return parsed.pathname === "/" && !String(value).trim().endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

export async function pruneStaleRedTeamOidcIssuers(client, issuerValue) {
  const issuer = normalizedRedTeamIssuer(issuerValue);
  const personaIds = REDTEAM_PERSONAS.map((persona) => persona.id);
  const current = await client.query(
    `SELECT count(*)::integer AS count,
            count(DISTINCT user_id)::integer AS distinct_users
       FROM app_auth.oidc_identities
      WHERE user_id = ANY($1::uuid[])
        AND issuer = $2`,
    [personaIds, issuer],
  );
  if (
    Number(current.rows[0]?.count || 0) !== REDTEAM_PERSONAS.length
    || Number(current.rows[0]?.distinct_users || 0) !== REDTEAM_PERSONAS.length
  ) {
    throw new Error("redteam_current_oidc_identity_set_incomplete");
  }
  const deleted = await client.query(
    `DELETE FROM app_auth.oidc_identities
      WHERE user_id = ANY($1::uuid[])
        AND issuer <> $2
      RETURNING user_id`,
    [personaIds, issuer],
  );
  return Number(deleted.rowCount || deleted.rows?.length || 0);
}

export function parseRedTeamOidcSubjects(rawValue) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawValue || ""));
  } catch {
    throw new Error("redteam_oidc_subjects_invalid_json");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("redteam_oidc_subjects_invalid");
  }
  const requiredKeys = new Set(REDTEAM_PERSONAS.map((persona) => persona.key));
  const suppliedKeys = Object.keys(parsed);
  if (suppliedKeys.some((key) => !requiredKeys.has(key))) {
    throw new Error("redteam_oidc_subjects_unknown_persona");
  }
  const subjects = {};
  for (const key of requiredKeys) {
    const subject = String(parsed[key] || "").trim();
    if (!subject || subject.length > 500) throw new Error(`redteam_oidc_subject_required:${key}`);
    subjects[key] = subject;
  }
  if (new Set(Object.values(subjects)).size !== requiredKeys.size) {
    throw new Error("redteam_oidc_subjects_must_be_unique");
  }
  return Object.freeze(subjects);
}
