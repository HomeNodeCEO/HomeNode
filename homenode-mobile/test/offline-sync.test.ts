import assert from "node:assert/strict";
import test from "node:test";

import { networkAvailable, retryDelayMs, stableJson } from "../src/offline/model";

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

