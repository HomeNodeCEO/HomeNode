import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { UAD_MIGRATION_NAMES } from "../src/database/uadMigrations.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationName = "20261004_uad_public_owner_sources.sql";

test("public owner source compatibility runs before the Section 2 owner backfill", () => {
  const compatibilityIndex = UAD_MIGRATION_NAMES.indexOf(migrationName);
  const backfillIndex = UAD_MIGRATION_NAMES.indexOf("20261005_uad_public_record_owners.sql");

  assert.ok(compatibilityIndex >= 0);
  assert.ok(backfillIndex > compatibilityIndex);
});

test("public owner source compatibility safely supplies legacy staging tables", () => {
  const migration = fs.readFileSync(
    path.resolve(directory, `../migrations/${migrationName}`),
    "utf8",
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS core\.owner_summary/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS core\.owner_parties/);
  assert.match(migration, /REFERENCES core\.accounts\(account_id\) ON DELETE CASCADE/);
  assert.match(migration, /owner_parties_account_year_idx/);
});
