import "dotenv/config";
import pg from "pg";

import {
  syncDcadPropertyContext,
  syncTigerRoadContext,
} from "../src/services/propertyContextSync.js";

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const source = String(argument("source", "all")).trim().toLowerCase();
const mode = String(argument("mode", "incremental")).trim().toLowerCase();
const validSources = new Set(["all", "parcels", "roads"]);
if (!validSources.has(source)) {
  throw new Error("source must be all, parcels, or roads");
}
if (!["full", "incremental"].includes(mode)) {
  throw new Error("mode must be full or incremental");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PROPERTY_CONTEXT_DB_POOL_SIZE || 4),
  statement_timeout: Number(process.env.PROPERTY_CONTEXT_STATEMENT_TIMEOUT_MS || 600_000),
  application_name: "homenode-property-context-sync",
});

try {
  const results = [];
  if (source === "all" || source === "parcels") {
    results.push(await syncDcadPropertyContext(pool, {
      mode,
      batchSize: Number(process.env.PROPERTY_CONTEXT_PARCEL_BATCH_SIZE || 2_000),
      concurrency: Number(process.env.PROPERTY_CONTEXT_FETCH_CONCURRENCY || 3),
    }));
  }
  if (source === "all" || source === "roads") {
    results.push(...await syncTigerRoadContext(pool, {
      batchSize: Number(process.env.PROPERTY_CONTEXT_ROAD_BATCH_SIZE || 5_000),
      concurrency: Number(process.env.PROPERTY_CONTEXT_FETCH_CONCURRENCY || 3),
    }));
  }
  console.log(JSON.stringify({ ok: true, source, mode, results }, null, 2));
} catch (error) {
  console.error("[property-context] synchronization failed", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}

