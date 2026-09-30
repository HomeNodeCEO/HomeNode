import assert from "node:assert/strict";
import test from "node:test";

import { applyUadMigrations } from "../src/database/uadMigrations.js";
import { applyMobileMigrations } from "../src/database/mobileMigrations.js";

function migrationPool({ acquisition = "succeeded", unlock = "succeeded" } = {}) {
  const queries = [];
  const releases = [];
  const client = {
    async query(sql) {
      const statement = String(sql);
      queries.push(statement);
      if (statement.includes("pg_advisory_lock")) {
        if (acquisition === "rejected") throw new Error("lock query interrupted");
        return { rows: [{ pg_advisory_lock: null }] };
      }
      if (statement.includes("pg_advisory_unlock")) {
        if (unlock === "rejected") throw new Error("unlock query interrupted");
        if (unlock === "missing") return { rows: [] };
        return { rows: [{ pg_advisory_unlock: unlock === "succeeded" }] };
      }
      if (statement.includes("SELECT checksum_sha256")) {
        // Stop before executing a migration while exercising the lock lifecycle.
        return { rows: [{ checksum_sha256: "deliberately-different" }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release(error) { releases.push(error); },
  };
  return {
    queries,
    releases,
    pool: {
      async query() { return { rows: [], rowCount: 0 }; },
      async connect() { return client; },
    },
  };
}

for (const [name, apply, lockCode] of [
  ["UAD", applyUadMigrations, "uad_migration_lock_state_unverified"],
  ["mobile", applyMobileMigrations, "mobile_migration_lock_state_unverified"],
]) {
  test(`${name} migration runner retires a client if advisory-lock acquisition fails`, async () => {
    const { pool, queries, releases } = migrationPool({ acquisition: "rejected" });
    await assert.rejects(apply(pool), /lock query interrupted/);
    assert.equal(queries.some((sql) => sql.includes("pg_advisory_unlock")), false);
    assert.equal(releases.length, 1);
    assert.equal(releases[0]?.message, lockCode);
  });

  for (const unlock of ["succeeded", "rejected", "not_owned", "missing"]) {
    test(`${name} migration runner handles advisory unlock ${unlock} without masking the migration error`, async () => {
      const { pool, queries, releases } = migrationPool({ unlock });
      await assert.rejects(apply(pool), /migration_checksum_mismatch/);
      assert.equal(queries.filter((sql) => sql.includes("pg_advisory_unlock")).length, 1);
      assert.equal(releases.length, 1);
      assert.equal(releases[0]?.message, unlock === "succeeded" ? undefined : lockCode);
    });
  }
}
