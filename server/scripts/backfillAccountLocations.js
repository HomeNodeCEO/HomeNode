import "dotenv/config";
import pg from "pg";
import {
  ensureAccountLocationsTable,
  refreshAccountLocations,
} from "../src/services/accountLocations.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const requestedAccountId = option("account-id");
const requestedLimit = Number(option("limit", "0"));
const force = process.argv.includes("--force");
const batchSize = Math.min(Math.max(Number(option("batch-size", "50")) || 50, 1), 100);

try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  await ensureAccountLocationsTable(pool);

  const params = [];
  const where = [
    "v.primary_account_id IS NOT NULL",
    "(account.county IS NULL OR account.county ILIKE '%dallas%')",
  ];
  if (requestedAccountId) {
    params.push(requestedAccountId);
    where.push(`v.primary_account_id = $${params.length}`);
  }
  if (!force) {
    where.push(`(
      location.account_id IS NULL
      OR location.status <> 'matched'
      OR location.geocoded_at < now() - interval '365 days'
    )`);
  }
  const limitSql =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? `LIMIT ${Math.floor(requestedLimit)}`
      : "";
  const { rows } = await pool.query(
    `
      SELECT DISTINCT
        v.primary_account_id AS account_id,
        account.address,
        account.county
      FROM core.v_sales_enriched v
      JOIN core.accounts account ON account.account_id = v.primary_account_id
      LEFT JOIN core.account_locations location
        ON location.account_id = v.primary_account_id
      WHERE ${where.join(" AND ")}
      ORDER BY v.primary_account_id
      ${limitSql}
    `,
    params,
  );

  if (requestedAccountId && !rows.some((row) => row.account_id === requestedAccountId)) {
    const subject = await pool.query(
      `SELECT account_id, address, county FROM core.accounts WHERE account_id = $1`,
      [requestedAccountId],
    );
    rows.push(...subject.rows);
  }

  console.log(`[locations] ${rows.length} account(s) queued`);
  const summary = await refreshAccountLocations(pool, rows, {
    batchSize,
    onBatch: ({ completed, total, summary: progress }) => {
      console.log(
        `[locations] ${completed}/${total} matched=${progress.matched} not_found=${progress.notFound} invalid=${progress.invalid} skipped_county=${progress.skippedUnsupportedCounty}`,
      );
    },
  });
  console.log("[locations] complete", summary);
} finally {
  await pool.end();
}
