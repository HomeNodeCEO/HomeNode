import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyAuthSessionRetentionPostMigration,
  AUTH_SESSION_RETENTION_MIGRATION_NAME,
} from "../src/database/authSessionRetentionMigration.js";
import { applyMobileMigrations } from "../src/database/mobileMigrations.js";

const migrationName = AUTH_SESSION_RETENTION_MIGRATION_NAME;
const migration = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), "utf8");
const runner = await readFile(new URL("../src/database/mobileMigrations.js", import.meta.url), "utf8");
const checksum = (value) => createHash("sha256")
  .update(value.replaceAll("\r\n", "\n"))
  .digest("hex");

test("web session retention migration delegates concurrent indexing to the runner", () => {
  assert.match(migration, /auth_session_retention_post_migration_required/);
  assert.doesNotMatch(migration, /\b(?:BEGIN|COMMIT)\b\s*;/i);
  assert.doesNotMatch(migration, /CREATE\s+INDEX/i);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|INDEX)/i);
  assert.match(runner, /applyAuthSessionRetentionPostMigration/);
});

test("application migrations register session retention after the session table", () => {
  const tableMigration = runner.indexOf('"20260928_web_auth_sessions.sql"');
  const retentionMigration = runner.indexOf(`"${migrationName}"`);
  assert.notEqual(tableMigration, -1);
  assert.notEqual(retentionMigration, -1);
  assert.ok(retentionMigration > tableMigration);
});

test("web session retention index is built concurrently for the purge expression", async () => {
  const calls = [];
  let transactionOpen = false;
  const client = {
    async query(sql) {
      const text = String(sql).trim();
      calls.push({ text, transactionOpen });
      if (text === "BEGIN") transactionOpen = true;
      if (text === "COMMIT" || text === "ROLLBACK") transactionOpen = false;
      if (/FROM pg_catalog\.pg_index/.test(text)) return { rows: [] };
      if (/CREATE INDEX CONCURRENTLY/.test(text)) assert.equal(transactionOpen, false);
      return { rows: [] };
    },
  };

  assert.deepEqual(
    await applyAuthSessionRetentionPostMigration(client, { logger: {} }),
    { index_ready: true },
  );
  const create = calls.find(({ text }) => /CREATE INDEX CONCURRENTLY/.test(text));
  assert.ok(create);
  assert.match(create.text, /web_sessions_retention_cleanup_idx/);
  assert.match(
    create.text,
    /LEAST\(expires_at, COALESCE\(revoked_at, expires_at\)\)/,
  );
  assert.match(create.text, /,\s*id\s*\)/);
});

test("an invalid interrupted retention index is replaced concurrently", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const text = String(sql).trim();
      statements.push(text);
      if (/FROM pg_catalog\.pg_index/.test(text)) {
        return { rows: [{ indisvalid: false, definition: "CREATE INDEX interrupted" }] };
      }
      return { rows: [] };
    },
  };

  await applyAuthSessionRetentionPostMigration(client, { logger: {} });
  assert.ok(statements.some((text) => text.startsWith("DROP INDEX CONCURRENTLY")));
  assert.ok(statements.some((text) => text.startsWith("CREATE INDEX CONCURRENTLY")));
});

test("a valid retention index makes the post-migration step idempotent", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      const text = String(sql).trim();
      statements.push(text);
      if (/FROM pg_catalog\.pg_index/.test(text)) {
        return {
          rows: [{
            indisvalid: true,
            definition: [
              "CREATE INDEX web_sessions_retention_cleanup_idx",
              "ON app_auth.web_sessions USING btree",
              "(LEAST(expires_at, COALESCE(revoked_at, expires_at)), id)",
            ].join(" "),
          }],
        };
      }
      return { rows: [] };
    },
  };

  await applyAuthSessionRetentionPostMigration(client, { logger: {} });
  assert.equal(statements.some((text) => /(?:CREATE|DROP) INDEX CONCURRENTLY/.test(text)), false);
});

test("the runner records retention migration only after concurrent indexing", async () => {
  const names = [...runner.matchAll(/"([^"\n]+\.sql)"/g)]
    .map((entry) => entry[1]);
  const ledger = new Map();
  for (const name of names.filter((name) => name !== migrationName)) {
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    ledger.set(name, checksum(sql));
  }
  const calls = [];
  let transactionOpen = false;
  const client = {
    async query(sql, parameters) {
      const text = String(sql).trim();
      calls.push(text);
      if (text === "BEGIN") transactionOpen = true;
      if (text === "COMMIT" || text === "ROLLBACK") transactionOpen = false;
      if (text.includes("SELECT checksum_sha256")) {
        const digest = ledger.get(parameters[0]);
        return { rows: digest ? [{ checksum_sha256: digest }] : [] };
      }
      if (/FROM pg_catalog\.pg_index/.test(text)) return { rows: [] };
      if (/CREATE INDEX CONCURRENTLY/.test(text)) assert.equal(transactionOpen, false);
      if (text.includes("INSERT INTO app.schema_migrations")) {
        assert.equal(transactionOpen, true);
        ledger.set(parameters[0], parameters[1]);
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { query: client.query, connect: async () => client };

  const result = await applyMobileMigrations(pool, { logger: {} });
  assert.deepEqual(result.at(-1), { migration_name: migrationName, status: "applied" });
  assert.equal(ledger.get(migrationName), checksum(migration));
  const schemaIndex = calls.findIndex((text) => text === migration.trim());
  const concurrentIndex = calls.findIndex((text) => /CREATE INDEX CONCURRENTLY/.test(text));
  const ledgerIndex = calls.findIndex((text) => text.includes("INSERT INTO app.schema_migrations"));
  assert.ok(schemaIndex < concurrentIndex);
  assert.ok(concurrentIndex < ledgerIndex);
});
