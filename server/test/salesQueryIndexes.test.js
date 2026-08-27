import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync(
  new URL("../migrations/20260930_sales_query_indexes.sql", import.meta.url),
  "utf8",
);
const migrationRegistry = fs.readFileSync(
  new URL("../src/database/mobileMigrations.js", import.meta.url),
  "utf8",
);
const salesIngestionMigration = fs.readFileSync(
  new URL(
    "../../dcad-scraper-with-api/migrations/023_sales_query_indexes.sql",
    import.meta.url,
  ),
  "utf8",
);
const salesImporter = fs.readFileSync(
  new URL(
    "../../dcad-scraper-with-api/scraper/dcad/import_sales.py",
    import.meta.url,
  ),
  "utf8",
);
const accountHistory = fs.readFileSync(
  new URL("../src/services/accountSalesHistory.js", import.meta.url),
  "utf8",
);

test("shared migrations provision the legacy sales account-history index", () => {
  assert.match(
    migration,
    /CREATE INDEX IF NOT EXISTS sales_account_closing_date_idx\s+ON core\.sales \(account_id, closing_date DESC\)/i,
  );
  assert.match(migrationRegistry, /20260930_sales_query_indexes\.sql/);
  assert.match(
    salesIngestionMigration,
    /CREATE INDEX IF NOT EXISTS sales_account_closing_date_idx\s+ON core\.sales \(account_id, closing_date DESC\)/i,
  );
  assert.match(salesImporter, /023_sales_query_indexes\.sql/);
});

test("the index leading columns match the subject history query", () => {
  assert.match(accountHistory, /FROM core\.sales sale\s+WHERE sale\.account_id = \$1/i);
  assert.match(accountHistory, /sale\.closing_date AS activity_date/i);
});
