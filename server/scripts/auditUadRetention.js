import "dotenv/config";
import pg from "pg";

import { auditUadRetention } from "../src/modules/uad/uadRetentionAudit.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const usesRender = /\.render\.com(?:[/:]|$)/i.test(process.env.DATABASE_URL);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: usesRender ? { rejectUnauthorized: false } : undefined,
  max: 1,
  application_name: "homenode-uad-retention-audit",
});

try {
  const result = await auditUadRetention(pool, {
    reviewDays: process.env.UAD_RETENTION_REVIEW_DAYS,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
