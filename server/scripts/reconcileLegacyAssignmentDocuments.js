import "dotenv/config";
import pg from "pg";

import { reconcileLegacyAssignmentDocuments } from "../src/security/assignmentDocumentOwnership.js";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

try {
  const result = await reconcileLegacyAssignmentDocuments(pool, {
    accountId: option("account-id"),
    fileNumber: option("file-number"),
    documentIds: option("document-ids"),
    actor: option("actor"),
    confirm: process.argv.includes("--confirm"),
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
