import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationName = "20261022_auth_session_retention.sql";
const migration = await readFile(new URL(`../migrations/${migrationName}`, import.meta.url), "utf8");
const runner = await readFile(new URL("../src/database/mobileMigrations.js", import.meta.url), "utf8");

test("web session retention migration indexes both cleanup predicates", () => {
  assert.match(
    migration,
    /web_sessions_expiry_cleanup_idx\s+ON app_auth\.web_sessions \(expires_at, id\)/,
  );
  assert.match(
    migration,
    /web_sessions_revoked_cleanup_idx\s+ON app_auth\.web_sessions \(revoked_at, id\)\s+WHERE revoked_at IS NOT NULL/,
  );
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|INDEX)/i);
});

test("application migrations register session retention after the session table", () => {
  const tableMigration = runner.indexOf('"20260928_web_auth_sessions.sql"');
  const retentionMigration = runner.indexOf(`"${migrationName}"`);
  assert.notEqual(tableMigration, -1);
  assert.notEqual(retentionMigration, -1);
  assert.ok(retentionMigration > tableMigration);
});
