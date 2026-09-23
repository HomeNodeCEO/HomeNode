import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import pg from "pg";

import { runCustomSignedArtifactAudit } from "../scripts/auditCustomSignedArtifacts.js";

const DATABASE_URL = "postgresql://private-user:private-password@database.example/private-database";

function fixture() {
  const state = { ended: false, stdout: [], stderr: [], options: null };
  const pool = new EventEmitter();
  pool.end = async () => { state.ended = true; };
  const dependencies = {
    databaseUrl: DATABASE_URL,
    createPool: async (options) => { state.options = options; return pool; },
    audit: async () => ({ ok: true, signed_snapshot_count: 0 }),
    stdout: (line) => { assert.equal(state.ended, true); state.stdout.push(line); },
    stderr: (line) => state.stderr.push(line),
  };
  return { state, pool, dependencies };
}

test("emits aggregate results only after pool shutdown", async () => {
  const { state, dependencies } = fixture();
  assert.equal(await runCustomSignedArtifactAudit(dependencies), 0);
  assert.equal(state.options.max, 1);
  assert.equal(state.options.connectionTimeoutMillis, 5_000);
  assert.equal(state.options.query_timeout, 6_000);
  assert.equal(state.options.idle_in_transaction_session_timeout, 10_000);
  assert.equal(state.options.connectionString, DATABASE_URL);
  assert.deepEqual(state.options.ssl, { rejectUnauthorized: true });
  assert.deepEqual(new pg.Client(state.options).connectionParameters.ssl, { rejectUnauthorized: true });
  assert.deepEqual(state.stdout.map(JSON.parse), [{ ok: true, signed_snapshot_count: 0 }]);
  assert.deepEqual(state.stderr, []);
});

test("remote audit rejects insecure URL overrides before creating a pool", async () => {
  for (const suffix of ["?sslmode=disable", "?sslmode=no-verify", "?ssl=false", "?connectionTimeoutMillis=0"]) {
    const { state, dependencies } = fixture();
    dependencies.databaseUrl = `${DATABASE_URL}${suffix}`;
    assert.equal(await runCustomSignedArtifactAudit(dependencies), 1);
    assert.equal(state.options, null);
    assert.deepEqual(state.stdout, []);
    assert.deepEqual(state.stderr, ["custom_signed_artifact_audit_failed\n"]);
  }
});

test("legacy sslmode=require URL cannot override verified TLS", async () => {
  const { state, dependencies } = fixture();
  dependencies.databaseUrl = `${DATABASE_URL}?sslmode=require`;
  assert.equal(await runCustomSignedArtifactAudit(dependencies), 0);
  assert.equal(new URL(state.options.connectionString).search, "");
  assert.deepEqual(new pg.Client(state.options).connectionParameters.ssl, { rejectUnauthorized: true });
});

test("reports parity gaps with counts and a nonzero exit", async () => {
  const { state, dependencies } = fixture();
  dependencies.audit = async () => ({ ok: false, missing_artifact_count: 2 });
  assert.equal(await runCustomSignedArtifactAudit(dependencies), 1);
  assert.deepEqual(state.stdout.map(JSON.parse), [{ ok: false, missing_artifact_count: 2 }]);
  assert.deepEqual(state.stderr, []);
});

for (const stage of ["config", "create", "audit", "close", "idle", "serialization"]) {
  test(`${stage} failure is secret-free and never prints partial counts`, async () => {
    const { state, pool, dependencies } = fixture();
    const problem = () => { throw new Error(DATABASE_URL); };
    if (stage === "config") dependencies.databaseUrl = "";
    if (stage === "create") dependencies.createPool = problem;
    if (stage === "audit") dependencies.audit = problem;
    if (stage === "close") pool.end = async () => { state.ended = true; problem(); };
    if (stage === "idle") dependencies.audit = async () => {
      pool.emit("error", new Error(DATABASE_URL));
      return { ok: true, signed_snapshot_count: 0 };
    };
    if (stage === "serialization") dependencies.audit = async () => ({ toJSON: problem });
    assert.equal(await runCustomSignedArtifactAudit(dependencies), 1);
    assert.deepEqual(state.stdout, []);
    assert.deepEqual(state.stderr, ["custom_signed_artifact_audit_failed\n"]);
    assert.equal(state.ended, !["config", "create"].includes(stage));
  });
}
