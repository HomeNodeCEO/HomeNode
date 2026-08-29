import assert from "node:assert/strict";
import test from "node:test";

import { networkAvailable, retryDelayMs, stableJson } from "../src/offline/model";
import { isUnreadableSqliteDatabaseError, offlineDatabasePolicy } from "../src/offline/databaseRecovery";

test("recognizes native SQLite error 26 through wrapped causes", () => {
  assert.equal(isUnreadableSqliteDatabaseError(new Error("file is not a database")), true);
  assert.equal(isUnreadableSqliteDatabaseError({
    message: "prepareAsync failed",
    cause: { message: "SQLiteErrorException: Error code 26" },
  }), true);
  assert.equal(isUnreadableSqliteDatabaseError(new Error("database is busy")), false);
});

test("quarantines the unreadable iOS cache in a new app-protected database generation", () => {
  assert.deepEqual(offlineDatabasePolicy("ios"), {
    databaseName: "homenode-field-ios-v2.db",
    activeDatabaseNameKey: "homenode.mobile.active-offline-database.ios-v2",
    recoveryGeneration: "ios-v2",
    useSqlCipher: false,
  });
  assert.equal(offlineDatabasePolicy("android").useSqlCipher, true);
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

