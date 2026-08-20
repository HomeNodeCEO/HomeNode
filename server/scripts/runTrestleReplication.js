import "dotenv/config";
import pg from "pg";

import { TrestleClient } from "../src/services/trestleClient.js";
import { runScheduledMaintenance } from "../src/services/scheduledMaintenance.js";
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
  const enrichment = property.skipped
    ? { skipped: true, reason: property.reason }
    : await runScheduledMaintenance(pool, {
        task: "sales",
        maximumRuntimeMinutes: Number(
          process.env.TRESTLE_ENRICHMENT_MAX_RUNTIME_MINUTES || 15
        ),
        locationMaximumBatches: Number(
          process.env.TRESTLE_LOCATION_MAX_BATCHES || 20
        ),
        locationBatchSize: Number(
          process.env.TRESTLE_LOCATION_BATCH_SIZE || 100
        ),
        locationSeedLimit: Number(
          process.env.TRESTLE_LOCATION_SEED_LIMIT || 10000
        ),
        influenceMaximumBatches: Number(
          process.env.TRESTLE_INFLUENCE_MAX_BATCHES || 20
        ),
        influenceBatchSize: Number(
          process.env.TRESTLE_INFLUENCE_BATCH_SIZE || 100
        ),
        influenceSeedLimit: Number(
          process.env.TRESTLE_INFLUENCE_SEED_LIMIT || 10000
        ),
      });
  const status = property.skipped && property.reason === "trestle_credentials_missing"
    ? client.status()
    : await getTrestleReplicationStatus(pool, client.status());
  console.log(JSON.stringify({ property, media, enrichment, status }, null, 2));
  if (!enrichment.skipped && !enrichment.ok) process.exitCode = 1;
} finally {
  await pool.end();
}
