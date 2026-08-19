import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

if (process.env.NODE_ENV !== "test") {
  throw new Error("prepareMobileCiDatabase may only run with NODE_ENV=test");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const assignmentMigration = await fs.readFile(
  path.resolve(scriptDirectory, "../migrations/005_assignment_files.sql"),
  "utf8",
);
const workfileMigration = await fs.readFile(
  path.resolve(scriptDirectory, "../migrations/20260828_custom_appraisal_workfiles.sql"),
  "utf8",
);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const identity = await pool.query("SELECT current_database() AS database_name");
  if (!String(identity.rows[0].database_name).endsWith("_test")) {
    throw new Error("CI database name must end with _test");
  }
  await pool.query(assignmentMigration);
  await pool.query(workfileMigration);
  console.log(JSON.stringify({ prepared: true, database: identity.rows[0].database_name }));
} finally {
  await pool.end();
}
