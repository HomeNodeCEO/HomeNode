import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ApiError } from "../src/api/client";
import { isDefinitiveRefreshFailure } from "../src/auth/policy";
import {
  MOBILE_API_REQUEST_TIMEOUT_MS,
  MOBILE_PHOTO_UPLOAD_TIMEOUT_MS,
  RequestTimeoutError,
  runWithRequestTimeout,
} from "../src/offline/requestTimeout";
import {
  circuitAllowsSync,
  emptySyncLaneResult,
  initialSyncCircuit,
  recordSyncFailure,
  updateSyncCircuit,
} from "../src/offline/syncPolicy";

test("keeps the device session for transient identity-provider outages", () => {
  assert.equal(isDefinitiveRefreshFailure(new Error("Network request failed")), false);
  assert.equal(isDefinitiveRefreshFailure({ error: "temporarily_unavailable" }), false);
  assert.equal(isDefinitiveRefreshFailure({ error: "invalid_grant" }), true);
  assert.equal(isDefinitiveRefreshFailure({ params: { error: "invalid_grant" } }), true);
  assert.equal(isDefinitiveRefreshFailure(new Error("Refresh token revoked")), true);
});

test("bounds API and direct photo-upload requests", async () => {
  assert.equal(MOBILE_API_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(MOBILE_PHOTO_UPLOAD_TIMEOUT_MS, 120_000);
  assert.equal(await runWithRequestTimeout(50, async () => "ok"), "ok");
  await assert.rejects(
    runWithRequestTimeout(5, (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })),
    (reason) => reason instanceof RequestTimeoutError,
  );
});

test("opens and resets a lane circuit only for transient service failures", () => {
  const transient = emptySyncLaneResult();
  transient.attempted = 1;
  recordSyncFailure(transient, new ApiError(503, "service_unavailable"));
  const open = updateSyncCircuit(initialSyncCircuit(), transient, 1_000, 0.5);
  assert.equal(open.consecutiveFailures, 1);
  assert.equal(circuitAllowsSync(open, 1_001), false);

  const success = emptySyncLaneResult();
  success.attempted = 1;
  success.succeeded = 1;
  assert.deepEqual(updateSyncCircuit(open, success, open.nextAttemptAt), initialSyncCircuit());

  const validation = emptySyncLaneResult();
  validation.attempted = 1;
  recordSyncFailure(validation, new ApiError(400, "invalid_request"));
  assert.deepEqual(updateSyncCircuit(initialSyncCircuit(), validation, 2_000), initialSyncCircuit());
});

test("uses one active-app scheduler for field, photo, and sketch queues", () => {
  const coordinator = readFileSync(new URL("../src/offline/syncEngine.ts", import.meta.url), "utf8");
  const photoSync = readFileSync(new URL("../src/photos/sync.ts", import.meta.url), "utf8");
  const sketchSync = readFileSync(new URL("../src/sketch/sync.ts", import.meta.url), "utf8");
  assert.match(coordinator, /synchronizeDueOperations/);
  assert.match(coordinator, /synchronizeDuePhotos/);
  assert.match(coordinator, /synchronizeDueSketches/);
  assert.match(coordinator, /MOBILE_SYNC_ACTIVE_INTERVAL_MS/);
  assert.doesNotMatch(photoSync, /setInterval|AppState/);
  assert.doesNotMatch(sketchSync, /setInterval|AppState/);
});
