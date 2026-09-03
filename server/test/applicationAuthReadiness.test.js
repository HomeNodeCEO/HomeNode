import assert from "node:assert/strict";
import test from "node:test";
import {
  getApplicationAuthReadiness,
  loadApplicationAuthRolloutReadiness,
} from "../src/security/applicationAuthReadiness.js";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000901";

const zeroOwnership = Object.freeze({
  custom_assignment_files_unassigned: 0,
  custom_report_files_unassigned: 0,
  uad_workfiles_unassigned: 0,
  uad_report_files_unassigned: 0,
  property_tax_report_files_unassigned: 0,
  appraisal_cases_unassigned: 0,
  custom_assignment_files_missing_appraiser: 0,
  uad_workfiles_missing_appraiser: 0,
  property_tax_files_missing_appraiser: 0,
  custom_assignment_files_invalid_appraiser_credentials: 0,
  uad_workfiles_invalid_appraiser_credentials: 0,
  property_tax_files_invalid_appraiser_credentials: 0,
  documents_without_owned_assignment: 0,
});

const zeroConsistency = Object.freeze({
  custom_registry_mismatches: 0,
  uad_registry_mismatches: 0,
  property_tax_registry_mismatches: 0,
  appraisal_case_registry_mismatches: 0,
});

const zeroRegistry = Object.freeze({
  custom_targets_without_registry: 0,
  uad_targets_without_registry: 0,
  property_tax_targets_without_registry: 0,
  property_tax_registry_without_target: 0,
  property_tax_files_missing_current_history: 0,
  property_tax_current_history_mismatches: 0,
  property_tax_authenticated_events_missing_actor: 0,
  appraisal_reports_missing_case: 0,
  appraisal_reports_missing_snapshot: 0,
});

function createPool({ ownership = {}, organization = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("AS active_organizations")) {
        return { rows: [{
          active_organizations: 1,
          active_users: 1,
          active_memberships: 1,
          oidc_identities: 1,
          active_web_sessions: 1,
        }] };
      }
      if (sql.includes("AS custom_assignment_files_unassigned")) {
        return { rows: [{ ...zeroOwnership, ...ownership }] };
      }
      if (sql.includes("AS custom_registry_mismatches")) {
        return { rows: [{ ...zeroConsistency }] };
      }
      if (sql.includes("AS custom_targets_without_registry")) {
        return { rows: [{ ...zeroRegistry }] };
      }
      if (sql.includes("FROM app_auth.organizations organization")) {
        return { rows: [{
          organization_id: ORGANIZATION_ID,
          legal_name: "Freeman Appraisal Services, LLC",
          display_name: "HomeNode Real Estate",
          active: true,
          active_memberships: 1,
          mapped_identities: 1,
          active_appraiser_profiles: 1,
          valid_appraiser_licenses: 1,
          custom_assignment_files: 2,
          custom_assignment_files_missing_appraiser: 0,
          uad_workfiles: 2,
          uad_workfiles_missing_appraiser: 0,
          property_tax_files: 1,
          property_tax_files_missing_appraiser: 0,
          ...organization,
        }] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

test("readiness is restricted to an authenticated organization or HomeNode administrator", async () => {
  const pool = createPool();
  await assert.rejects(
    getApplicationAuthReadiness(pool, {
      userId: "user-1",
      organizations: [{ organizationId: ORGANIZATION_ID, roles: ["appraiser"] }],
    }),
    (error) => error?.code === "auth_readiness_access_denied",
  );
  assert.equal(pool.calls.length, 0);
});

test("readiness passes only when identity, ownership, consistency, and registry gates are clean", async () => {
  const pool = createPool();
  const result = await getApplicationAuthReadiness(pool, {
    userId: "user-1",
    organizations: [{ organizationId: ORGANIZATION_ID, roles: ["appraiser", "organization_admin"] }],
  });

  assert.equal(result.activation_ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.organizations[0].valid_appraiser_licenses, 1);
  assert.ok(pool.calls.every(({ sql }) => !/password|client_secret|session_secret/i.test(sql)));
  const ownershipSql = pool.calls.find(({ sql }) =>
    sql.includes("AS documents_without_owned_assignment"))?.sql || "";
  assert.match(ownershipSql, /LEFT JOIN appraisal\.uad_workfiles workfile/);
  assert.match(
    ownershipSql,
    /document\.assignment_file_id IS NULL AND document\.uad_workfile_id IS NULL/,
  );
  assert.match(ownershipSql, /workfile\.organization_id IS NULL/);
  const registrySql = pool.calls.find(({ sql }) =>
    sql.includes("AS property_tax_targets_without_registry"))?.sql || "";
  assert.match(registrySql, /app\.tax_protest_file_history history/);
  assert.match(registrySql, /history\.revision = protest\.revision/);
  assert.match(registrySql, /history\.workfile_data IS DISTINCT FROM protest\.workfile_data/);
  assert.match(registrySql, /authentication_mode.*authenticated/);
  assert.match(registrySql, /event\.actor_user_id IS NULL/);
});

test("readiness returns bounded blocker codes and counts without database diagnostics", async () => {
  const pool = createPool({
    ownership: { uad_workfiles_unassigned: 2 },
    organization: { valid_appraiser_licenses: 0 },
  });
  const result = await loadApplicationAuthRolloutReadiness(pool, {
    organizationIds: [ORGANIZATION_ID],
  });

  assert.equal(result.activation_ready, false);
  assert.deepEqual(
    result.blockers.map(({ code, count }) => ({ code, count })),
    [
      { code: "uad_workfiles_unassigned", count: 2 },
      { code: "organization_valid_appraiser_license_missing", count: 1 },
    ],
  );
  assert.doesNotMatch(JSON.stringify(result), /postgres|stack|sql|secret/i);
});

test("readiness blocks missing Property Tax registry, history, and authenticated actor evidence", async () => {
  const pool = createPool();
  const originalQuery = pool.query.bind(pool);
  pool.query = async (sql, parameters = []) => {
    const result = await originalQuery(sql, parameters);
    if (sql.includes("AS custom_targets_without_registry")) {
      return { rows: [{
        ...zeroRegistry,
        property_tax_targets_without_registry: 1,
        property_tax_current_history_mismatches: 2,
        property_tax_authenticated_events_missing_actor: 1,
      }] };
    }
    return result;
  };

  const result = await loadApplicationAuthRolloutReadiness(pool, {
    organizationIds: [ORGANIZATION_ID],
  });
  assert.equal(result.activation_ready, false);
  assert.deepEqual(
    result.blockers.filter(({ group }) => group === "registry")
      .map(({ code, count }) => ({ code, count })),
    [
      { code: "property_tax_targets_without_registry", count: 1 },
      { code: "property_tax_current_history_mismatches", count: 2 },
      { code: "property_tax_authenticated_events_missing_actor", count: 1 },
    ],
  );
});
