import "dotenv/config";
import pg from "pg";

import { backfillCollinSalesQueue } from "../src/services/collinSalesBackfill.js";
import { ensureSalesReconciliationSchema } from "../src/services/salesReconciliation.js";

function hasFlag(name) {
  return process.argv.includes(name);
}

function numericArgument(name, fallback = null) {
  const prefix = `${name}=`;
  const raw = process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    application_name: "homenode-collin-sales-backfill",
  });
  try {
    await ensureSalesReconciliationSchema(pool);
    const summary = await backfillCollinSalesQueue(pool, {
      apply: hasFlag("--apply"),
      batchSize: numericArgument("--batch-size", 500),
      maximumRows: numericArgument("--limit"),
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (Object.keys(summary.errors).length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
