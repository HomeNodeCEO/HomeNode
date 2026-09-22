import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import {
  applyMarketSpatialPostMigration,
  MARKET_SPATIAL_BACKFILL_SQL,
  MARKET_SPATIAL_MIGRATION_NAME,
} from "../src/database/marketSpatialMigration.js";
import { applyMobileMigrations } from "../src/database/mobileMigrations.js";

const migration = await fs.readFile(
  new URL(`../migrations/${MARKET_SPATIAL_MIGRATION_NAME}`, import.meta.url),
  "utf8",
);
const migrationRegistry = await fs.readFile(
  new URL("../src/database/mobileMigrations.js", import.meta.url),
  "utf8",
);
const checksum = (value) => createHash("sha256")
  .update(value.replaceAll("\r\n", "\n"))
  .digest("hex");

test("market spatial schema is registered without transaction-bound repair or index work", () => {
  const registeredNames = [...migrationRegistry.matchAll(/"(20\d{6}_[^"]+\.sql)"/g)]
    .map((match) => match[1]);
  assert.equal(registeredNames.at(-1), MARKET_SPATIAL_MIGRATION_NAME);
  assert.match(migration, /set_config\('lock_timeout'/);
  assert.match(migration, /set_config\('statement_timeout'/);
  assert.match(migration, /account_locations_sync_geom/);
  assert.doesNotMatch(migration, /UPDATE\s+core\.account_locations/i);
  assert.doesNotMatch(migration, /CREATE\s+INDEX/i);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|SCHEMA|DATABASE)/i);
  assert.match(migrationRegistry, /applyMarketSpatialPostMigration/);
});

test("market spatial repair commits every bounded batch before concurrent indexing", async () => {
  const calls = [];
  const batches = [1_000, 7, 0];
  let transactionOpen = false;
  const client = {
    async query(sql) {
      const text = String(sql).trim();
      calls.push({ text, transactionOpen });
      if (text === "BEGIN") transactionOpen = true;
      if (text === "COMMIT" || text === "ROLLBACK") transactionOpen = false;
      if (sql === MARKET_SPATIAL_BACKFILL_SQL) {
        assert.equal(transactionOpen, true);
        const rowCount = batches.shift();
        return { rowCount, rows: Array(Math.min(rowCount, 10)).fill({}) };
      }
      if (/FROM pg_catalog\.pg_index/.test(text)) {
        assert.equal(transactionOpen, false);
        return { rows: [] };
      }
      if (/CREATE INDEX CONCURRENTLY/.test(text)) assert.equal(transactionOpen, false);
      return { rows: [] };
    },
  };

  const result = await applyMarketSpatialPostMigration(client, { logger: {} });
  assert.deepEqual(result, { updated_rows: 1007, batches: 2 });
  assert.equal(calls.filter(({ text }) => text === "BEGIN").length, 3);
  assert.equal(calls.filter(({ text }) => text === "COMMIT").length, 3);
  assert.equal(calls.filter(({ text }) => text.includes("LIMIT 1000")).length, 3);
  assert.ok(calls.some(({ text }) => /indrelid = 'core\.account_locations'::regclass/.test(text)));
  assert.equal(calls.filter(({ text }) => /CREATE INDEX CONCURRENTLY/.test(text)).length, 1);
});

test("a mismatched or invalid existing spatial index is replaced concurrently", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const text = String(sql).trim();
      statements.push(text);
      if (sql === MARKET_SPATIAL_BACKFILL_SQL) return { rowCount: 0, rows: [] };
      if (/FROM pg_catalog\.pg_index/.test(text)) {
        return { rows: [{ indisvalid: false, definition: "CREATE INDEX stale" }] };
      }
      return { rows: [] };
    },
  };
  await applyMarketSpatialPostMigration(client, { logger: {} });
  assert.ok(statements.some((text) => text.startsWith("DROP INDEX CONCURRENTLY")));
  assert.ok(statements.some((text) => text.startsWith("CREATE INDEX CONCURRENTLY")));
});

test("the runner records completion only after resumable repair and concurrent indexing", async () => {
  const names = [...migrationRegistry.matchAll(/"([^"\n]+\.sql)"/g)]
    .map((entry) => entry[1]);
  const ledger = new Map();
  for (const name of names.filter((name) => name !== MARKET_SPATIAL_MIGRATION_NAME)) {
    const sql = await fs.readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    ledger.set(name, checksum(sql));
  }
  const calls = [];
  let transactionOpen = false;
  const client = {
    async query(sql, parameters) {
      const text = String(sql).trim();
      calls.push({ text, parameters, transactionOpen });
      if (text === "BEGIN") transactionOpen = true;
      if (text === "COMMIT" || text === "ROLLBACK") transactionOpen = false;
      if (text.includes("SELECT checksum_sha256")) {
        const digest = ledger.get(parameters[0]);
        return { rows: digest ? [{ checksum_sha256: digest }] : [] };
      }
      if (sql === MARKET_SPATIAL_BACKFILL_SQL) return { rowCount: 0, rows: [] };
      if (/FROM pg_catalog\.pg_index/.test(text)) return { rows: [] };
      if (text.includes("INSERT INTO app.schema_migrations")) {
        assert.equal(transactionOpen, true);
        ledger.set(parameters[0], parameters[1]);
      }
      if (/CREATE INDEX CONCURRENTLY/.test(text)) assert.equal(transactionOpen, false);
      return { rows: [] };
    },
    release() {},
  };
  const pool = { query: client.query, connect: async () => client };

  const results = await applyMobileMigrations(pool, { logger: {} });
  assert.deepEqual(results.at(-1), {
    migration_name: MARKET_SPATIAL_MIGRATION_NAME,
    status: "applied",
  });
  assert.equal(ledger.get(MARKET_SPATIAL_MIGRATION_NAME), checksum(migration));
  const schemaIndex = calls.findIndex(({ text }) => text === migration.trim());
  const backfillIndex = calls.findIndex(({ text }) => text.includes("LIMIT 1000"));
  const concurrentIndex = calls.findIndex(({ text }) => /CREATE INDEX CONCURRENTLY/.test(text));
  const ledgerIndex = calls.findIndex(({ text }) => text.includes("INSERT INTO app.schema_migrations"));
  assert.ok(schemaIndex < backfillIndex);
  assert.ok(backfillIndex < concurrentIndex);
  assert.ok(concurrentIndex < ledgerIndex);
});
