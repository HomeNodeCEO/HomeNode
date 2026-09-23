import "dotenv/config";
import pg from "pg";

import { auditCustomSignedArtifacts } from "../src/services/customSignedArtifactAudit.js";

if (!process.env.DATABASE_URL) throw new Error("database_url_required");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  application_name: "homenode-custom-signed-artifact-audit",
});

try {
  const result = await auditCustomSignedArtifacts(pool);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch {
  console.error("custom_signed_artifact_audit_failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
