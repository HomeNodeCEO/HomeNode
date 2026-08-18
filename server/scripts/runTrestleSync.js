import "dotenv/config";
import pg from "pg";

import {
  parcelMatchCacheStatus,
  refreshParcelMatchCache,
} from "../src/services/providerIngestion.js";
import { runTrestleIncrementalSync } from "../src/services/trestleSync.js";

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.TRESTLE_DB_POOL_SIZE || 4),
  statement_timeout: Number(process.env.TRESTLE_STATEMENT_TIMEOUT_MS || 900_000),
  application_name: "homenode-trestle-sync",
});

try {
  const cacheMode = String(process.env.TRESTLE_REFRESH_MATCH_CACHE || "auto").toLowerCase();
  const cacheStatus = await parcelMatchCacheStatus(pool);
  if (
    /^(1|true|yes)$/.test(cacheMode) ||
    (cacheMode === "auto" && cacheStatus.cached_accounts < 1000)
  ) {
    const cache = await refreshParcelMatchCache(pool, {
      limit: option("cache-limit", process.env.TRESTLE_MATCH_CACHE_LIMIT || "1000000"),
      ensureSchema: false,
    });
    console.log(JSON.stringify({ parcel_match_cache: cache }));
  } else {
    console.log(JSON.stringify({ parcel_match_cache: cacheStatus }));
  }
  const result = await runTrestleIncrementalSync(pool, {
    maximumPages: option("maximum-pages", process.env.TRESTLE_MAXIMUM_PAGES || "10"),
    pageSize: option("page-size", process.env.TRESTLE_PAGE_SIZE || "1000"),
    postIngestBatchesPerPage: option(
      "post-ingest-batches",
      process.env.TRESTLE_POST_INGEST_BATCHES || "2",
    ),
    postIngestBatchSize: option(
      "post-ingest-batch-size",
      process.env.TRESTLE_POST_INGEST_BATCH_SIZE || "500",
    ),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error("[trestle-sync] failed", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
