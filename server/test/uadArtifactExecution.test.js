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
  assert.equal(first, duplicate);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executions, 1);
  assert.equal(gate.snapshot().active, 1);
  work.resolve({ ok: true });
  assert.deepEqual(await duplicate, { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.snapshot().completed, 1);
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
