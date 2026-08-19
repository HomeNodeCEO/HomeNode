import "dotenv/config";
import pg from "pg";

import { TrestleClient } from "../src/services/trestleClient.js";
import {
  getTrestleReplicationStatus,
  runTrestleMediaBatch,
  runTrestlePropertyReplication,
} from "../src/services/trestleReplication.js";

if (!process.env.DATABASE_URL) throw new Error("database_url_missing");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.TRESTLE_DATABASE_POOL_SIZE || 4),
  connectionTimeoutMillis: Number(process.env.DATABASE_CONNECTION_TIMEOUT_MS || 10_000),
  application_name: "homenode-trestle-replication",
});
const client = new TrestleClient();

try {
  const property = await runTrestlePropertyReplication(pool, client);
  const media = property.skipped
    ? { skipped: true, reason: property.reason, claimed: 0, completed: 0 }
    : await runTrestleMediaBatch(pool, client, {
      batchSize: Number(process.env.TRESTLE_MEDIA_BATCH_SIZE || 10),
      maximumAttempts: Number(process.env.TRESTLE_MEDIA_MAXIMUM_ATTEMPTS || 5),
    });
  const status = property.skipped && property.reason === "trestle_credentials_missing"
    ? client.status()
    : await getTrestleReplicationStatus(pool, client.status());
  console.log(JSON.stringify({ property, media, status }, null, 2));
} finally {
  await pool.end();
}
