import "dotenv/config";
import pg from "pg";

import {
  ensureCensusGeographySchema,
  getCensusGeographyStatus,
  runCensusGeographyBatch,
  seedCensusGeographyQueue,
} from "../src/services/censusGeography.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function option(name, fallback) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const batchSize = Math.min(Math.max(Number(option("batch-size", "1000")) || 1000, 1), 10_000);
const seedLimit = Math.min(Math.max(Number(option("seed-limit", "25000")) || 25_000, 1), 100_000);
const maximumBatches = Math.max(Number(option("maximum-batches", "0")) || 0, 0);

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await ensureCensusGeographySchema(pool);
  let processedBatches = 0;
  while (!maximumBatches || processedBatches < maximumBatches) {
    const seed = await seedCensusGeographyQueue(pool, { limit: seedLimit });
    const result = await runCensusGeographyBatch(pool, { batchSize });
    processedBatches += result.claimed ? 1 : 0;
    console.log("[census-geography]", {
      batch: processedBatches,
      seeded: seed.queued,
      ...result,
    });
    if (!seed.queued && !result.claimed) break;
  }
  console.log("[census-geography] status", await getCensusGeographyStatus(pool));
} finally {
  await pool.end();
}
