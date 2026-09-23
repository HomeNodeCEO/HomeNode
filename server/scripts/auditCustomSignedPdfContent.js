import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { auditCustomSignedPdfContent } from "../src/services/customSignedPdfContentAudit.js";

export async function runCustomSignedPdfContentAudit({
  databaseUrl = process.env.DATABASE_URL,
  createPool = (options) => new pg.Pool(options),
  audit = auditCustomSignedPdfContent,
  stdout = (line) => process.stdout.write(line),
  stderr = (line) => process.stderr.write(line),
} = {}) {
  let pool;
  let result;
  let output;
  let failed = false;
  try {
    if (!databaseUrl) throw new Error("database_url_required");
    pool = await createPool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 1_000,
      allowExitOnIdle: true,
      query_timeout: 12_000,
      idle_in_transaction_session_timeout: 20_000,
      application_name: "homenode-custom-signed-pdf-content-audit",
    });
    pool.on("error", () => { failed = true; });
    result = await audit(pool);
    output = JSON.stringify(result);
    if (!output) failed = true;
  } catch {
    failed = true;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        failed = true;
      }
    }
  }
  if (failed) {
    stderr("custom_signed_pdf_content_audit_failed\n");
    return 1;
  }
  stdout(`${output}\n`);
  return result.ok ? 0 : 1;
}

const isCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  await import("dotenv/config");
  process.exitCode = await runCustomSignedPdfContentAudit();
}
