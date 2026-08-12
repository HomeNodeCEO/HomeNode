import "dotenv/config";
import pg from "pg";

import { runScheduledMaintenance } from "../src/services/scheduledMaintenance.js";

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.MAINTENANCE_DB_POOL_SIZE || 4),
  statement_timeout: Number(process.env.MAINTENANCE_STATEMENT_TIMEOUT_MS || 900_000),
  application_name: "homenode-scheduled-maintenance",
});

try {
  const result = await runScheduledMaintenance(pool, {
    task: option("task", "routine"),
    maximumRuntimeMinutes: option(
      "maximum-runtime-minutes",
      process.env.MAINTENANCE_MAX_RUNTIME_MINUTES || "45",
    ),
    censusMaximumBatches: option(
      "census-maximum-batches",
      process.env.MAINTENANCE_CENSUS_MAX_BATCHES || "3",
    ),
    locationMaximumBatches: option(
      "location-maximum-batches",
      process.env.MAINTENANCE_LOCATION_MAX_BATCHES || "4",
    ),
    influenceMaximumBatches: option(
      "influence-maximum-batches",
      process.env.MAINTENANCE_INFLUENCE_MAX_BATCHES || "4",
    ),
    influenceBatchSize: option(
      "influence-batch-size",
      process.env.MAINTENANCE_INFLUENCE_BATCH_SIZE || "100",
    ),
    influenceSeedLimit: option(
      "influence-seed-limit",
      process.env.MAINTENANCE_INFLUENCE_SEED_LIMIT || "10000",
    ),
    fetchConcurrency: process.env.PROPERTY_CONTEXT_FETCH_CONCURRENCY || "3",
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error("[scheduled-maintenance] failed", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
