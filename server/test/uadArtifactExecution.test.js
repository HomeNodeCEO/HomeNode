import assert from "node:assert/strict";
import test from "node:test";

import { createUadArtifactExecutionGate } from "../src/modules/uad/uadArtifactExecution.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("artifact execution is single-flight for duplicate workfile operations", async () => {
  const gate = createUadArtifactExecutionGate({ maxConcurrent: 1, maxQueued: 2 });
  const work = deferred();
  let executions = 0;
  const operation = () => {
    executions += 1;
    return work.promise;
  };
  const first = gate.run("pdf:workfile-1", operation);
  const duplicate = gate.run("pdf:workfile-1", operation);
  assert.notEqual(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  assert.equal(gate.snapshot().active, 1);
  work.resolve({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await duplicate, { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.snapshot().completed, 1);
});

test("one disconnected subscriber does not cancel a duplicate request that is still waiting", async () => {
  const gate = createUadArtifactExecutionGate({ maxConcurrent: 1, maxQueued: 1 });
  const work = deferred();
  const started = deferred();
  const firstController = new AbortController();
  const secondController = new AbortController();
  let executionSignal;
  const operation = (signal) => {
    executionSignal = signal;
    started.resolve();
    return work.promise;
  };
  const first = gate.run("package:workfile-1", operation, { signal: firstController.signal });
  const second = gate.run("package:workfile-1", operation, { signal: secondController.signal });
  await started.promise;
  firstController.abort();
  await assert.rejects(() => first, /uad_artifact_request_aborted/);
  assert.equal(executionSignal.aborted, false);
  work.resolve("complete");
  assert.equal(await second, "complete");
  assert.equal(gate.snapshot().completed, 1);
});

test("artifact execution aborts underlying work after every subscriber disconnects", async () => {
  const gate = createUadArtifactExecutionGate({ maxConcurrent: 1, maxQueued: 1 });
  const controller = new AbortController();
  const started = deferred();
  let executionSignal;
  const request = gate.run("package:workfile-1", (signal) => {
    executionSignal = signal;
    started.resolve();
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(() => request, /uad_artifact_request_aborted/);
  assert.equal(executionSignal.aborted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.snapshot().active, 0);
  assert.equal(gate.snapshot().failed, 1);
});

test("a disconnected queued request is removed before it consumes execution capacity", async () => {
  const gate = createUadArtifactExecutionGate({ maxConcurrent: 1, maxQueued: 1 });
  const active = deferred();
  const first = gate.run("pdf:first", () => active.promise);
  const controller = new AbortController();
  const queued = gate.run("package:second", async () => "second", { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => queued, /uad_artifact_request_aborted/);
  assert.equal(gate.snapshot().queued, 0);
  const replacement = gate.run("package:third", async () => "third");
  active.resolve("first");
  assert.equal(await first, "first");
  assert.equal(await replacement, "third");
});

test("artifact execution rejects excess work instead of exhausting server resources", async () => {
  const gate = createUadArtifactExecutionGate({ maxConcurrent: 1, maxQueued: 1 });
  const active = deferred();
  const first = gate.run("pdf:first", () => active.promise);
  const second = gate.run("package:second", async () => "second");
  await assert.rejects(
    () => gate.run("pdf:third", async () => "third"),
    /uad_artifact_capacity_exceeded/,
  );
  assert.deepEqual(gate.snapshot(), {
    ready: false,
    closed: false,
    saturated: true,
    active: 1,
    queued: 1,
    max_concurrent: 1,
    max_queued: 1,
    completed: 0,
    failed: 0,
  });
  active.resolve("first");
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(gate.snapshot().ready, true);
  assert.equal(gate.snapshot().saturated, false);
});

test("artifact shutdown stops queued generation while allowing active cleanup", async () => {
  const gate = createUadArtifactExecutionGate({ maxConcurrent: 1, maxQueued: 1, logger: {} });
  const active = deferred();
  const first = gate.run("pdf:first", () => active.promise);
  const queued = gate.run("package:second", async () => "second");
  assert.equal(gate.close(), true);
  await assert.rejects(() => queued, /uad_artifact_executor_shutting_down/);
  await assert.rejects(
    () => gate.run("xml:third", async () => "third"),
    /uad_artifact_executor_shutting_down/,
  );
  active.resolve("first");
  assert.equal(await first, "first");
  assert.equal(gate.snapshot().ready, false);
});
