import "dotenv/config";
import pg from "pg";

import { applyUadMigrations } from "../src/database/uadMigrations.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const usesRender = /\.render\.com(?:[/:]|$)/i.test(process.env.DATABASE_URL);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 2,
  application_name: "homenode-uad-migrations",
});

try {
  const results = await applyUadMigrations(pool);
  console.log(JSON.stringify({ migrations: results }));
} finally {
  await pool.end();
}
