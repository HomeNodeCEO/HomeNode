import assert from "node:assert/strict";
import test from "node:test";

import { StartupTimeoutError, withStartupTimeout } from "../src/startup/timeout";

test("startup operations complete before their deadline", async () => {
  assert.equal(await withStartupTimeout(Promise.resolve("ready"), 100, "startup_timed_out"), "ready");
});

test("stalled local storage yields a retryable error instead of an endless spinner", async () => {
  await assert.rejects(
    withStartupTimeout(new Promise<never>(() => undefined), 5, "offline_storage_open_timed_out"),
    (reason: unknown) => reason instanceof StartupTimeoutError && reason.code === "offline_storage_open_timed_out",
  );
});
