import "dotenv/config";
import pg from "pg";

import { ensurePropertyContextSchema } from "../src/services/propertyContextStore.js";
import { syncOfficialZoningDocuments } from "../src/services/zoningEvidence.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const externalRenderConnection = /\.render\.com(?:[/:]|$)/i.test(process.env.DATABASE_URL);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  application_name: "homenode-zoning-document-sync",
  ...(externalRenderConnection ? { ssl: { rejectUnauthorized: false } } : {}),
});

try {
  await ensurePropertyContextSchema(pool);
  const result = await syncOfficialZoningDocuments(pool);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  await pool.end();
}
