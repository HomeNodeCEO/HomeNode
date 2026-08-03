import "dotenv/config";
import pg from "pg";

import { ensurePropertyEnrichmentSchema } from "../src/services/propertyEnrichment.js";
import {
  enrichNonDallasAccount,
  listEnrichmentCandidates,
} from "../src/services/nonDallasEnrichmentWorker.js";
import { TrestleClient } from "../src/services/trestleClient.js";
import { assertNonDallasEnrichmentCounty } from "../src/util/nonDallasEnrichment.js";

const county = assertNonDallasEnrichmentCounty(process.argv[2]);
const limit = Number(process.argv[3] || 25);
const trestleClient = new TrestleClient();
const status = trestleClient.status();
if (!status.ready) {
  throw new Error(status.configured ? "trestle_disabled" : "trestle_credentials_missing");
}
if (!process.env.DATABASE_URL) throw new Error("database_url_missing");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await ensurePropertyEnrichmentSchema(pool);
const { rows: runRows } = await pool.query(
  `INSERT INTO app.enrichment_runs (county, provider, status, started_at)
   VALUES ($1,'trestle','running',now()) RETURNING id`,
  [county],
);
const runId = runRows[0].id;
let processed = 0;
let resolved = 0;
let review = 0;
let errors = 0;
try {
  const candidates = await listEnrichmentCandidates(pool, { county, limit });
  for (const accountId of candidates) {
    try {
      const result = await enrichNonDallasAccount({ pool, trestleClient, accountId });
      processed += 1;
      review += Object.values(result.resolved).filter((item) => item.review_required).length;
      resolved += Object.values(result.resolved).filter((item) => !item.review_required).length;
    } catch (error) {
      errors += 1;
      console.error(`[non-dallas-enrichment] ${accountId}:`, error?.message || error);
    }
  }
  await pool.query(
    `UPDATE app.enrichment_runs
     SET status = 'completed', processed_count = $2, resolved_count = $3,
         review_count = $4, error_count = $5, completed_at = now()
     WHERE id = $1`,
    [runId, processed, resolved, review, errors],
  );
  console.log(JSON.stringify({ run_id: runId, county, processed, resolved, review, errors }));
} catch (error) {
  await pool.query(
    `UPDATE app.enrichment_runs
     SET status = 'failed', processed_count = $2, resolved_count = $3,
         review_count = $4, error_count = $5, completed_at = now(),
         details = $6::jsonb
     WHERE id = $1`,
    [runId, processed, resolved, review, errors + 1, JSON.stringify({ error: error?.message || String(error) })],
  ).catch(() => {});
  throw error;
} finally {
  await pool.end();
}

