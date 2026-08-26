function count(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function summarizeDatabasePrivilegeAudit(row = {}) {
  const checks = Object.freeze({
    not_superuser: row.is_superuser !== true,
    cannot_create_roles: row.can_create_roles !== true,
    cannot_create_databases: row.can_create_databases !== true,
    cannot_replicate: row.can_replicate !== true,
    cannot_bypass_row_security: row.can_bypass_row_security !== true,
    owns_no_application_schemas: count(row.owned_schema_count) === 0,
    cannot_create_in_application_schemas: count(row.creatable_schema_count) === 0,
  });
  return Object.freeze({
    least_privilege: Object.values(checks).every(Boolean),
    profile: "homenode_runtime_database_privileges_v1",
    checked_at: new Date().toISOString(),
    checks,
    owned_application_schema_count: count(row.owned_schema_count),
    creatable_application_schema_count: count(row.creatable_schema_count),
  });
}

export async function auditDatabaseRuntimePrivileges(pool) {
  const result = await pool.query(`
    WITH login AS (
      SELECT oid, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = current_user
    ), application_schemas AS (
      SELECT oid, nspowner, nspname
        FROM pg_namespace
       WHERE nspname = ANY(ARRAY['app', 'app_auth', 'appraisal', 'core', 'uad_ref']::text[])
    )
    SELECT
      login.rolsuper AS is_superuser,
      login.rolcreaterole AS can_create_roles,
      login.rolcreatedb AS can_create_databases,
      login.rolreplication AS can_replicate,
      login.rolbypassrls AS can_bypass_row_security,
      (SELECT count(*)::integer FROM application_schemas WHERE nspowner = login.oid) AS owned_schema_count,
      (SELECT count(*)::integer FROM application_schemas WHERE has_schema_privilege(current_user, nspname, 'CREATE')) AS creatable_schema_count
    FROM login
  `);
  if (!result.rows.length) throw new Error("database_runtime_role_not_found");
  return summarizeDatabasePrivilegeAudit(result.rows[0]);
}
