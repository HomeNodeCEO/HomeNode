import "dotenv/config";
import pg from "pg";

import { auditUadAssuranceGraph } from "../src/modules/uad/uadAssuranceGraph.js";
import { createRuntimeResilienceConfiguration } from "../src/security/runtimeResilience.js";

if (!process.env.DATABASE_URL) throw new Error("database_url_required");

const runtime = createRuntimeResilienceConfiguration();
const databaseUrl = new URL(process.env.DATABASE_URL);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /\.render\.com$/i.test(databaseUrl.hostname) ? { rejectUnauthorized: false } : undefined,
  ...runtime.database,
  max: 1,
  application_name: "homenode-uad-assurance-audit",
});

try {
  const result = await auditUadAssuranceGraph(pool);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally {
  await pool.end();
}
