import assert from "node:assert/strict";
import test from "node:test";

import { networkAvailable, retryDelayMs, stableJson } from "../src/offline/model";
import {
  assertDatabaseSnapshotsEqual,
  sqliteIdentifier,
  sqliteStringLiteral,
  type OfflineDatabaseSnapshot,
} from "../src/offline/databaseEncryption";
import { isUnreadableSqliteDatabaseError, offlineDatabasePolicy } from "../src/offline/databaseRecovery";

test("recognizes native SQLite error 26 through wrapped causes", () => {
  assert.equal(isUnreadableSqliteDatabaseError(new Error("file is not a database")), true);
  assert.equal(isUnreadableSqliteDatabaseError({
    message: "prepareAsync failed",
    cause: { message: "SQLiteErrorException: Error code 26" },
  }), true);
  assert.equal(isUnreadableSqliteDatabaseError(new Error("database is busy")), false);
});

test("migrates the legacy iOS cache into a SQLCipher-protected database generation", () => {
  assert.deepEqual(offlineDatabasePolicy("ios"), {
    databaseName: "homenode-field-ios-v3.db",
    activeDatabaseNameKey: "homenode.mobile.active-offline-database.ios-v3",
    recoveryGeneration: "ios-v3",
    useSqlCipher: true,
    legacyPlaintext: {
      databaseName: "homenode-field-ios-v2.db",
      activeDatabaseNameKey: "homenode.mobile.active-offline-database.ios-v2",
    },
  });
  assert.deepEqual(offlineDatabasePolicy("android"), {
    databaseName: "homenode-field-v1.db",
    activeDatabaseNameKey: "homenode.mobile.active-offline-database.v1",
    recoveryGeneration: "recovered",
    useSqlCipher: true,
    legacyPlaintext: null,
  });
});

test("SQLCipher migration SQL quotes values and rejects attacker-shaped identifiers", () => {
  assert.equal(sqliteStringLiteral("a'b"), "'a''b'");
  assert.equal(sqliteIdentifier("photo_drafts"), '"photo_drafts"');
  assert.throws(() => sqliteIdentifier('photo_drafts"; DROP TABLE photo_drafts; --'), {
    message: "mobile_offline_database_schema_invalid",
  });
});

test("SQLCipher migration verifies schema, row counts, and user version before activation", () => {
  const snapshot: OfflineDatabaseSnapshot = {
    autoVacuum: 0,
    schema: [{ type: "table", name: "field_drafts", tableName: "field_drafts", sql: "CREATE TABLE field_drafts (id TEXT)" }],
    sequences: { sync_queue: 9 },
    tableCounts: { field_drafts: 3 },
    userVersion: 7,
  };
  assert.doesNotThrow(() => assertDatabaseSnapshotsEqual(snapshot, snapshot));
  assert.throws(() => assertDatabaseSnapshotsEqual(snapshot, {
    ...snapshot,
    tableCounts: { field_drafts: 2 },
  }), { message: "mobile_offline_database_migration_verification_failed" });
  assert.throws(() => assertDatabaseSnapshotsEqual(snapshot, {
    ...snapshot,
    sequences: { sync_queue: 8 },
  }), { message: "mobile_offline_database_migration_verification_failed" });
});

test("offline payloads use deterministic canonical JSON", () => {
  assert.equal(stableJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  assert.equal(stableJson({ a: [true, null], z: 1 }), '{"a":[true,null],"z":1}');
  assert.throws(() => stableJson(Number.NaN), /invalid_json_value/);
});

test("retry policy backs off with bounded jitter", () => {
  assert.equal(retryDelayMs(1, 0), 1500);
  assert.equal(retryDelayMs(1, 1), 2500);
  assert.ok(retryDelayMs(10, 0.5) <= 300_000);
  assert.ok(retryDelayMs(4, 0.5) > retryDelayMs(3, 0.5));
});

test("network state treats explicit offline signals as unavailable", () => {
  assert.equal(networkAvailable({ isConnected: true, isInternetReachable: true }), true);
  assert.equal(networkAvailable({ isConnected: false }), false);
  assert.equal(networkAvailable({ isConnected: true, isInternetReachable: false }), false);
});
