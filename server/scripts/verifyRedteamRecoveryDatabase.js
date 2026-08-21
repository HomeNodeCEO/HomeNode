import "dotenv/config";
import pg from "pg";

import {
  createRedTeamRecoveryConfiguration,
  verifyRedTeamRecoveryDatabase,
} from "../src/security/redTeamRecovery.js";

const recovery = createRedTeamRecoveryConfiguration();
const usesRender = /\.render\.com$/i.test(new URL(recovery.connectionString).hostname);
const pool = new pg.Pool({
  connectionString: recovery.connectionString,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 1,
  connectionTimeoutMillis: 10_000,
  query_timeout: 15_000,
  application_name: "homenode-redteam-recovery-verifier",
});

try {
  const result = await verifyRedTeamRecoveryDatabase(pool);
  console.log(JSON.stringify({
    ...result,
    recovery_service_id: recovery.serviceId,
  }));
} finally {
  await pool.end();
}

