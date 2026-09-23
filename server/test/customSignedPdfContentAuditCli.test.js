import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runCustomSignedPdfContentAudit } from "../scripts/auditCustomSignedPdfContent.js";

const DATABASE_URL = "postgresql://private-user:private-password@database.example/private-database";

function fixture() {
  const state = { ended: false, stdout: [], stderr: [], options: null };
  const pool = new EventEmitter();
  pool.end = async () => { state.ended = true; };
  const dependencies = {
    databaseUrl: DATABASE_URL,
    createPool: async (options) => { state.options = options; return pool; },
    audit: async () => ({ ok: true, artifact_count: 0 }),
    stdout: (line) => { assert.equal(state.ended, true); state.stdout.push(line); },
    stderr: (line) => state.stderr.push(line),
  };
  return { state, pool, dependencies };
}

test("emits aggregate byte-integrity results only after clean shutdown", async () => {
  const { state, dependencies } = fixture();
  assert.equal(await runCustomSignedPdfContentAudit(dependencies), 0);
  assert.equal(state.options.max, 1);
  assert.equal(state.options.connectionTimeoutMillis, 5_000);
  assert.equal(state.options.query_timeout, 12_000);
  assert.equal(state.options.idle_in_transaction_session_timeout, 20_000);
  assert.equal(state.options.connectionString, DATABASE_URL);
  assert.deepEqual(state.stdout.map(JSON.parse), [{ ok: true, artifact_count: 0 }]);
  assert.deepEqual(state.stderr, []);
});

test("reports content mismatch counts and exits nonzero", async () => {
  const { state, dependencies } = fixture();
  dependencies.audit = async () => ({ ok: false, content_digest_mismatch_count: 2 });
  assert.equal(await runCustomSignedPdfContentAudit(dependencies), 1);
  assert.deepEqual(state.stdout.map(JSON.parse), [{ ok: false, content_digest_mismatch_count: 2 }]);
});

for (const stage of ["config", "create", "audit", "close", "idle", "serialization"]) {
  test(`${stage} failure emits no partial result or private diagnostic`, async () => {
    const { state, pool, dependencies } = fixture();
    const problem = () => { throw new Error(DATABASE_URL); };
    if (stage === "config") dependencies.databaseUrl = "";
    if (stage === "create") dependencies.createPool = problem;
    if (stage === "audit") dependencies.audit = problem;
    if (stage === "close") pool.end = async () => { state.ended = true; problem(); };
    if (stage === "idle") dependencies.audit = async () => {
      pool.emit("error", new Error(DATABASE_URL));
      return { ok: true, artifact_count: 0 };
    };
    if (stage === "serialization") dependencies.audit = async () => ({ toJSON: problem });
    assert.equal(await runCustomSignedPdfContentAudit(dependencies), 1);
    assert.deepEqual(state.stdout, []);
    assert.deepEqual(state.stderr, ["custom_signed_pdf_content_audit_failed\n"]);
    assert.equal(state.ended, !["config", "create"].includes(stage));
  });
}
