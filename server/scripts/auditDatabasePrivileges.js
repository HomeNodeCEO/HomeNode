import "dotenv/config";
import pg from "pg";

import { createRuntimeResilienceConfiguration } from "../src/security/runtimeResilience.js";
import { auditDatabaseRuntimePrivileges } from "../src/security/databasePrivilegeAudit.js";

if (!process.env.DATABASE_URL) throw new Error("database_url_required");
const mode = String(process.env.DATABASE_PRIVILEGE_AUDIT_MODE || "report").trim().toLowerCase();
if (!["report", "enforce"].includes(mode)) throw new Error("invalid_database_privilege_audit_mode");

const databaseUrl = new URL(process.env.DATABASE_URL);
const runtime = createRuntimeResilienceConfiguration();
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\.render\.com$/i.test(databaseUrl.hostname) ? { rejectUnauthorized: false } : undefined,
  ...runtime.database,
  max: 1,
  application_name: "homenode-database-privilege-audit",
});

try {
  const result = await auditDatabaseRuntimePrivileges(pool);
  console.log(JSON.stringify({ ...result, mode }));
  if (mode === "enforce" && !result.least_privilege) process.exitCode = 1;
} finally {
  await pool.end();
}
