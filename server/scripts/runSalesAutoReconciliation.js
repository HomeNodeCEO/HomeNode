import "dotenv/config";
import pg from "pg";

import {
  auditSalesAutoReconciliation,
  runSalesAutoReconciliationBatch,
} from "../src/services/salesAutoReconciliation.js";

function option(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const apply = process.argv.includes("--apply");
const batchSize = boundedInteger(option("batch-size", "500"), 500, 1, 2_000);
const maximumBatches = boundedInteger(option("maximum-batches", "10"), 10, 1, 100);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  statement_timeout: 300_000,
  application_name: "homenode-sales-auto-reconciliation",
});

try {
  if (!apply) {
    console.log(JSON.stringify(
      await auditSalesAutoReconciliation(pool, { batchSize }),
      null,
      2,
    ));
  } else {
    const totals = {
      batches: 0,
      trusted_existing_links: 0,
      unique_exact_addresses: 0,
      inspected_unmatched_addresses: 0,
      resolved: 0,
    };
    for (let batch = 0; batch < maximumBatches; batch += 1) {
      const result = await runSalesAutoReconciliationBatch(pool, { batchSize });
      totals.batches += 1;
      for (const key of [
        "trusted_existing_links",
        "unique_exact_addresses",
        "inspected_unmatched_addresses",
        "resolved",
      ]) {
        totals[key] += Number(result[key] || 0);
      }
      if (!result.resolved) break;
    }
    console.log(JSON.stringify({ dry_run: false, ...totals }, null, 2));
  }
} finally {
  await pool.end();
}
