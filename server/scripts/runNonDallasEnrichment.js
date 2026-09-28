import "dotenv/config";
import pg from "pg";

import { safeOperationalErrorCode } from "../src/security/safeOperationalErrorCode.js";
import { ensurePropertyEnrichmentSchema } from "../src/services/propertyEnrichment.js";
import { runNonDallasEnrichmentBatch } from "../src/services/nonDallasEnrichmentWorker.js";
import { TrestleClient } from "../src/services/trestleClient.js";
import { assertNonDallasEnrichmentCounty } from "../src/util/nonDallasEnrichment.js";

async function main() {
  const county = assertNonDallasEnrichmentCounty(process.argv[2]);
  const limit = Number(process.argv[3] || 25);
  const trestleClient = new TrestleClient();
  const status = trestleClient.status();
  if (!status.ready) {
    throw new Error(status.configured ? "trestle_disabled" : "trestle_credentials_missing");
  }
  if (!process.env.DATABASE_URL) throw new Error("database_url_missing");

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await ensurePropertyEnrichmentSchema(pool);
    const summary = await runNonDallasEnrichmentBatch({ pool, trestleClient, county, limit });
    console.log(JSON.stringify(summary));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  const code = safeOperationalErrorCode(error);
  console.error("[non-dallas-enrichment] failed",
    code === "unknown" ? "non_dallas_enrichment_failed" : code);
  process.exitCode = 1;
});

