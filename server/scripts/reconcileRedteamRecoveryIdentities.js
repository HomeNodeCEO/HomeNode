import "dotenv/config";
import pg from "pg";

import { normalizeOidcIssuer } from "../src/modules/mobile/auth.js";
import {
  createRedTeamRecoveryConfiguration,
  verifyRedTeamRecoveryDatabase,
} from "../src/security/redTeamRecovery.js";
import { pruneStaleRedTeamOidcIssuers } from "../src/security/redTeamFixtures.js";
import { verifyRedTeamSyntheticBoundary } from "../src/security/redTeamIsolation.js";

if (process.env.REDTEAM_RECOVERY_ALLOW_IDENTITY_PRUNE !== "true") {
  throw new Error("redteam_recovery_identity_prune_not_authorized");
}
const recovery = createRedTeamRecoveryConfiguration();
const oidcIssuer = normalizeOidcIssuer(process.env.REDTEAM_RECOVERY_OIDC_ISSUER);
const usesRender = /\.render\.com$/i.test(new URL(recovery.connectionString).hostname);
const pool = new pg.Pool({
  connectionString: recovery.connectionString,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 1,
  connectionTimeoutMillis: 10_000,
  query_timeout: 15_000,
  application_name: "homenode-redteam-recovery-identity-reconciler",
});

try {
  await verifyRedTeamSyntheticBoundary(pool);
  const client = await pool.connect();
  let removed = 0;
  try {
    await client.query("BEGIN");
    removed = await pruneStaleRedTeamOidcIssuers(client, oidcIssuer);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const verified = await verifyRedTeamRecoveryDatabase(pool);
  console.log(JSON.stringify({
    reconciled: true,
    stale_oidc_identities_removed: removed,
    recovery_service_id: recovery.serviceId,
    ...verified,
  }));
} finally {
  await pool.end();
}
