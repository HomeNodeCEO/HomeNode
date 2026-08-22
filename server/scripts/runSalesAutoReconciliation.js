import "dotenv/config";
import pg from "pg";

import {
  auditSalesAutoReconciliation,
  runSalesAutoReconciliationBatch,
} from "../src/services/salesAutoReconciliation.js";
import {
  getAccountAddressAliasStatus,
  seedAccountAddressAliasBatch,
} from "../src/services/accountAddressAliases.js";
import {
  auditFuzzySalesAddressCandidates,
  runFuzzySalesAddressReconciliationBatch,
} from "../src/services/salesFuzzyAddressAudit.js";

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
const seedOnly = process.argv.includes("--seed-only");
const fuzzySample = process.argv.includes("--fuzzy-sample");
const fuzzyStratified = process.argv.includes("--fuzzy-stratified");
const fuzzyApply = process.argv.includes("--fuzzy-apply");
const batchSize = boundedInteger(option("batch-size", "500"), 500, 1, 2_000);
const maximumBatches = boundedInteger(option("maximum-batches", "10"), 10, 1, 100);
const aliasBatchSize = boundedInteger(option("alias-batch-size", "10000"), 10_000, 1, 25_000);
const aliasMaximumBatches = boundedInteger(
  option("alias-maximum-batches", "100"),
  100,
  1,
  200,
);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  statement_timeout: 300_000,
  application_name: "homenode-sales-auto-reconciliation",
});

try {
  const aliasSeed = { batches: 0, scanned: 0, written: 0, completed: false };
  if (apply || seedOnly) {
    for (let batch = 0; batch < aliasMaximumBatches; batch += 1) {
      const result = await seedAccountAddressAliasBatch(pool, { batchSize: aliasBatchSize });
      aliasSeed.batches += 1;
      aliasSeed.scanned += Number(result.scanned || 0);
      aliasSeed.written += Number(result.written || 0);
      aliasSeed.completed = Boolean(result.completed) || result.reason === "alias_index_current";
      if (result.skipped || result.completed || !result.scanned) break;
    }
  }
  const aliasStatus = await getAccountAddressAliasStatus(pool);
  if (fuzzyApply) {
    console.log(JSON.stringify(await runFuzzySalesAddressReconciliationBatch(pool, {
      batchSize: boundedInteger(option("batch-size", "100"), 100, 1, 500),
      candidatesPerSale: boundedInteger(
        option("candidates-per-sale", "250"),
        250,
        10,
        1_000,
      ),
      // A fuzzy save requires two explicit flags. --fuzzy-apply alone is an
      // evidence-only rehearsal and cannot open a write transaction.
      dryRun: !apply,
    }), null, 2));
  } else if (fuzzySample) {
    console.log(JSON.stringify(await auditFuzzySalesAddressCandidates(pool, {
      sampleSize: boundedInteger(option("sample-size", "20"), 20, 1, 500),
      candidatesPerSale: boundedInteger(
        option("candidates-per-sale", "250"),
        250,
        10,
        1_000,
      ),
      stratified: fuzzyStratified,
    }), null, 2));
  } else if (seedOnly) {
    console.log(JSON.stringify({ alias_seed: aliasSeed, alias_status: aliasStatus }, null, 2));
  } else if (!apply) {
    console.log(JSON.stringify({
      ...(await auditSalesAutoReconciliation(pool, { batchSize })),
      alias_status: aliasStatus,
    }, null, 2));
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
    console.log(JSON.stringify({
      dry_run: false,
      alias_seed: aliasSeed,
      alias_status: aliasStatus,
      ...totals,
    }, null, 2));
  }
} finally {
  await pool.end();
}

