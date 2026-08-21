import "dotenv/config";
import pg from "pg";

import {
  assertRedTeamDatabaseName,
  createRedTeamIsolationConfiguration,
  verifyRedTeamSyntheticBoundary,
} from "../src/security/redTeamIsolation.js";

const isolation = createRedTeamIsolationConfiguration();
if (!isolation.enabled || !isolation.ready) throw new Error("redteam_isolation_not_enabled");

const usesRender = /\.render\.com(?:[/:]|$)/i.test(process.env.DATABASE_URL || "");
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 1,
  connectionTimeoutMillis: 10_000,
  application_name: "homenode-redteam-preflight",
});

try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  assertRedTeamDatabaseName(identity.rows[0]?.database_name);
  await verifyRedTeamSyntheticBoundary(pool);
  console.log(JSON.stringify({ ready: true, environment: "redteam", synthetic_only: true }));
} finally {
  await pool.end();
}
