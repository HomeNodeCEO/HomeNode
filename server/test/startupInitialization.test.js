import assert from "node:assert/strict";
import test from "node:test";

import { createStartupInitializationRegistry } from "../src/security/startupInitialization.js";

test("startup initialization registry records required success without exposing operation values", async () => {
  const registry = createStartupInitializationRegistry();
  let release;
  const pending = registry.track("assignment_files_schema", () => new Promise((resolve) => {
    release = resolve;
  }));
  await Promise.resolve();
  assert.deepEqual(registry.snapshot(), {
    status: "pending",
    required: { ready: [], pending: ["assignment_files_schema"], failed: [] },
    optional: { ready: [], pending: [], failed: [] },
  });
  release("sensitive result");
  assert.equal(await pending, "sensitive result");
  assert.deepEqual(registry.snapshot().required, {
    ready: ["assignment_files_schema"],
    pending: [],
    failed: [],
  });
  assert.doesNotMatch(JSON.stringify(registry.snapshot()), /sensitive/i);
});

test("startup initialization registry records failures while preserving rejection handling", async () => {
  const registry = createStartupInitializationRegistry();
  const failure = registry.track("property_context_schema", async () => {
    throw new Error("postgresql://secret@internal");
  });
  await assert.rejects(failure, /postgresql:\/\/secret/);
  assert.deepEqual(registry.snapshot(), {
    status: "failed",
    required: { ready: [], pending: [], failed: ["property_context_schema"] },
    optional: { ready: [], pending: [], failed: [] },
  });
  assert.doesNotMatch(JSON.stringify(registry.snapshot()), /postgres|secret|internal/i);
});

test("optional startup initialization degrades the snapshot without failing required readiness", async () => {
  const registry = createStartupInitializationRegistry();
  await registry.track("census_geography_schema", async () => {
    throw new Error("provider unavailable");
  }, { required: false }).catch(() => {});
  assert.deepEqual(registry.snapshot(), {
    status: "degraded",
    required: { ready: [], pending: [], failed: [] },
    optional: { ready: [], pending: [], failed: ["census_geography_schema"] },
  });
});

test("startup initialization registry rejects unstable and duplicate codes", async () => {
  const registry = createStartupInitializationRegistry();
  assert.throws(
    () => registry.track("Not Safe", async () => {}),
    /startup_initialization_code_invalid/,
  );
  await registry.track("account_locations_schema", async () => {});
  assert.throws(
    () => registry.track("account_locations_schema", async () => {}),
    /startup_initialization_code_duplicate/,
  );
});
