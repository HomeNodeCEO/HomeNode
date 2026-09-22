import assert from "node:assert/strict";
import test from "node:test";

import {
  createRelatedParcelLookupExecutionGate,
  isRelatedParcelLookupBusyError,
  relatedParcelLookupRequestKey,
} from "../src/services/relatedParcelLookupExecution.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("identical related-parcel requests share one DCAD operation across principals", async () => {
  const gate = createRelatedParcelLookupExecutionGate({
    maxConcurrent: 2,
    maxQueued: 1,
  });
  const work = deferred();
  let executions = 0;
  const operation = () => {
    executions += 1;
    return work.promise;
  };

  const first = gate.run("123 MAIN ST", "user-1", operation);
  const duplicate = gate.run("123 MAIN ST", "user-2", operation);
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  work.resolve({ status: "complete", result: { parcels: [] }, error: null });
  assert.deepEqual(await duplicate, {
    status: "complete",
    result: { parcels: [] },
    error: null,
  });
});

test("related-parcel gate bounds global and per-principal work", async () => {
  const gate = createRelatedParcelLookupExecutionGate({
    maxConcurrent: 2,
    maxQueued: 1,
    maxConcurrentPerPrincipal: 1,
    maxQueuedPerPrincipal: 1,
  });
  const firstWork = deferred();
  const otherWork = deferred();
  const first = gate.run("first", "user-1", () => firstWork.promise);
  const samePrincipalQueued = gate.run("second", "user-1", async () => "queued");
  const other = gate.run("third", "user-2", () => otherWork.promise);

  await assert.rejects(
    () => gate.run("fourth", "user-1", async () => "excess"),
    /related_parcel_lookup_principal_capacity_exceeded/,
  );
  await assert.rejects(
    () => gate.run("fifth", "user-3", async () => "excess"),
    /related_parcel_lookup_capacity_exceeded/,
  );
  assert.deepEqual(gate.snapshot(), {
    active: 2,
    queued: 1,
    in_flight: 3,
    cached: 0,
    cache_hits: 0,
    max_concurrent: 2,
    max_queued: 1,
    max_concurrent_per_principal: 1,
    max_queued_per_principal: 1,
    completed: 0,
    failed: 0,
    saturated: true,
  });

  firstWork.resolve("first");
  otherWork.resolve("other");
  assert.deepEqual(await Promise.all([first, other]), ["first", "other"]);
  assert.equal(await samePrincipalQueued, "queued");
  assert.equal(await other, "other");
});

test("successful and unavailable lookups use separate bounded cache lifetimes", async () => {
  let currentTime = 1_000;
  const gate = createRelatedParcelLookupExecutionGate({
    successCacheTtlMs: 10_000,
    unavailableCacheTtlMs: 1_000,
    now: () => currentTime,
  });
  let successExecutions = 0;
  let unavailableExecutions = 0;

  const success = () => Promise.resolve({
    status: "complete",
    result: { revision: ++successExecutions },
    error: null,
  });
  const unavailable = () => Promise.resolve({
    status: "unavailable",
    result: { parcels: [] },
    error: `outage-${++unavailableExecutions}`,
  });

  assert.equal((await gate.run("success", "user", success)).result.revision, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await gate.run("success", "user", success)).result.revision, 1);
  assert.equal(successExecutions, 1);

  assert.equal((await gate.run("unavailable", "user", unavailable)).error, "outage-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await gate.run("unavailable", "user", unavailable)).error, "outage-1");
  currentTime += 1_001;
  assert.equal((await gate.run("unavailable", "user", unavailable)).error, "outage-2");
  assert.equal(unavailableExecutions, 2);
});

test("related-parcel lookup keys and busy errors remain stable", () => {
  assert.equal(
    relatedParcelLookupRequestKey(" 123  Main St, Dallas, TX "),
    "123 MAIN ST",
  );
  assert.equal(
    isRelatedParcelLookupBusyError("related_parcel_lookup_queue_timeout"),
    true,
  );
  assert.equal(isRelatedParcelLookupBusyError("dcad_unavailable"), false);
});
