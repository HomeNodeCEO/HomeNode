import test from "node:test";
import assert from "node:assert/strict";
import { cleanupFailedUadSketchRender } from "../src/modules/uad/sketchExhibitCleanup.js";

const WORKFILE = "10000000-0000-4000-8000-000000000001";
const ASSET = "10000000-0000-4000-8000-000000000002";
const SKETCH = "10000000-0000-4000-8000-000000000003";
const args = { workfileId: WORKFILE, assetId: ASSET, sketchId: SKETCH, expectedRevision: 1 };
const asset = () => ({ id: ASSET, workfile_id: WORKFILE, status: "verified", section_number: 7,
  verified_at: "2026-09-05T12:00:00.000Z", capture_metadata: {
    source: "homenode_web_sketch_editor", source_uad_sketch_id: SKETCH,
    source_uad_sketch_revision: 1, uad_sketch_editor_revision: `${SKETCH}:2`, retained_source_asset_id: "retained",
  } });

// Protocol evidence only; actual PostgreSQL locking/rollback is checked by the
// guarded native lifecycle suite. Unexpected queries remain visible even when
// production deliberately suppresses best-effort compensation failures.
function fixture({ responses = {}, failAt, rollbackFailure = false, releaseFailure = false } = {}) {
  const calls = [], errors = [];
  let releases = 0;
  const defaults = {
    workfile: { rows: [{ id: WORKFILE, status: "draft", signed_at: null }] },
    signatures: { rows: [{ has_signatures: false }] },
    asset: { rows: [asset()] }, observers: { rows: [{ has_observers: false }] },
    retire: { rows: [{ id: ASSET }] },
  };
  const client = {
    async query(sql, parameters = []) {
      let stage;
      try {
        if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED") stage = "begin";
        else if (sql === "SET LOCAL lock_timeout = '500ms'") stage = "lock_timeout";
        else if (sql === "SET LOCAL statement_timeout = '2000ms'") stage = "statement_timeout";
        else if (sql === "COMMIT") stage = "commit";
        else if (sql === "ROLLBACK") stage = "rollback";
        else if (/SELECT id, status, signed_at FROM appraisal.uad_workfiles/.test(sql)) {
          stage = "workfile"; assert.match(sql, /FOR UPDATE$/); assert.deepEqual(parameters, [WORKFILE]);
        } else if (/AS has_signatures/.test(sql)) {
          stage = "signatures"; assert.deepEqual(parameters, [WORKFILE]);
          assert.doesNotMatch(sql, /revision_number/);
        } else if (/SELECT id, workfile_id, status, section_number/.test(sql)) {
          stage = "asset"; assert.match(sql, /FOR UPDATE$/); assert.deepEqual(parameters, [ASSET, WORKFILE]);
        } else if (/AS has_observers/.test(sql)) {
          stage = "observers"; assert.deepEqual(parameters, [ASSET, WORKFILE]);
          for (const table of ["uad_sketches", "uad_sketch_history", "uad_signatures", "uad_validation_runs", "uad_generated_artifacts"]) {
            assert.match(sql, new RegExp(`FROM appraisal\\.${table}`));
          }
          assert.doesNotMatch(sql, /started_at|verified_at|revision_number/);
          assert.match(sql, /uad_sketches WHERE rendered_asset_id = \$1\)/);
          assert.match(sql, /uad_sketch_history WHERE rendered_asset_id = \$1\)/);
          assert.match(sql, /uad_signatures WHERE signature_asset_id = \$1\)/);
        } else if (/UPDATE appraisal.uad_assets/.test(sql)) {
          stage = "retire"; assert.deepEqual(parameters, [ASSET, WORKFILE]);
          assert.match(sql, /status = 'deleted'/); assert.match(sql, /AND status = 'verified'/);
          assert.match(sql, /capture_metadata = capture_metadata \|\| '\{"orphaned_editor_render":true\}'::jsonb/);
          assert.match(sql, /RETURNING id/); assert.doesNotMatch(sql, /object_key\s*=/);
        } else assert.fail(`unexpected cleanup SQL: ${sql}`);
        calls.push(stage);
        if (failAt === stage || (stage === "rollback" && rollbackFailure)) throw new Error("synthetic_database_failure");
        return Object.hasOwn(responses, stage) ? responses[stage] : defaults[stage] ?? { rows: [] };
      } catch (error) {
        if (error.code === "ERR_ASSERTION") errors.push(error.message);
        throw error;
      }
    },
    release() { releases++; calls.push("release"); if (releaseFailure) throw new Error("synthetic_release_failure"); },
  };
  return { calls, pool: { async connect() {
    calls.push("connect"); if (failAt === "connect") throw new Error("synthetic_connect_failure"); return client;
  }, query() { assert.fail("cleanup must use its acquired client"); } },
  verify({ retired = false, connected = true } = {}) {
    assert.deepEqual(errors, []);
    assert.equal(releases, connected ? 1 : 0);
    assert.equal(calls.filter(value => value === "commit").length, retired ? 1 : 0);
    assert.equal(calls.filter(value => value === "rollback").length, connected && !retired ? 1 : 0);
    if (connected) assert.equal(calls.at(-1), "release");
  } };
}

test("owned ordinary cleanup locks workfile before asset and retires metadata only", async () => {
  const f = fixture();
  assert.equal(await cleanupFailedUadSketchRender(f.pool, args), true);
  assert.deepEqual(f.calls, ["connect", "begin", "lock_timeout", "statement_timeout", "workfile", "signatures", "asset", "observers", "retire", "commit", "release"]);
  f.verify({ retired: true });
});

for (const status of ["ready", "revised", "validating", "signed", "exported", "submitted", "archived", "unknown", " draft ", null]) {
  test(`cleanup abstains for ${JSON.stringify(status)} without reopening the workfile`, async () => {
    const f = fixture({ responses: { workfile: { rows: [{ id: WORKFILE, status, signed_at: null }] } } });
    assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false);
    assert.equal(f.calls.includes("asset"), false); f.verify();
  });
}

for (const signedAt of ["2026-09-05T12:00:00Z", undefined, ""]) {
  test(`cleanup requires explicit unsigned evidence: signed_at ${String(signedAt)}`, async () => {
    const f = fixture({ responses: { workfile: { rows: [{ id: WORKFILE, status: "draft", signed_at: signedAt }] } } });
    assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false);
    assert.equal(f.calls.includes("asset"), false); f.verify();
  });
}

for (const [stage, response] of [
  ["workfile", { rows: [] }], ["workfile", { rows: [{ id: ASSET, status: "draft", signed_at: null }] }],
  ["signatures", { rows: [{ has_signatures: true }] }], ["signatures", { rows: [] }],
  ["signatures", { rows: [{ has_signatures: "false" }] }], ["signatures", { rows: [{ has_signatures: null }] }],
  ["asset", { rows: [] }], ["asset", { rows: [asset(), asset()] }],
  ["asset", { rows: { 0: asset(), length: 1 } }],
  ["asset", { rows: [null] }],
  ["observers", { rows: [{ has_observers: true }] }], ["observers", { rows: [] }],
  ["observers", { rows: [{ has_observers: "false" }] }], ["observers", { rows: [{ has_observers: null }] }],
  ["observers", { rows: { 0: { has_observers: false }, length: 1 } }],
]) test(`cleanup fails closed on ${stage} evidence ${JSON.stringify(response)}`, async () => {
  const f = fixture({ responses: { [stage]: response } });
  assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false);
  assert.equal(f.calls.includes("retire"), false); f.verify();
});

for (const [field, value] of [["id", WORKFILE], ["workfile_id", ASSET], ["status", "deleted"],
  ["status", "pending_upload"], ["section_number", "7"], ["section_number", 8], ["verified_at", null]]) {
  test(`cleanup requires exact candidate ${field}=${String(value)}`, async () => {
    const f = fixture({ responses: { asset: { rows: [{ ...asset(), [field]: value }] } } });
    assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false);
    assert.equal(f.calls.includes("observers"), false); f.verify();
  });
}
for (const [field, value] of [["source", "homenode_mobile"], ["source_uad_sketch_id", ASSET],
  ["source_uad_sketch_revision", "1"], ["source_uad_sketch_revision", 2],
  ["uad_sketch_editor_revision", `${SKETCH}:3`], ["uad_sketch_editor_revision", undefined]]) {
  test(`cleanup requires exact editor provenance ${field}=${String(value)}`, async () => {
    const row = asset(); row.capture_metadata[field] = value;
    const f = fixture({ responses: { asset: { rows: [row] } } });
    assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false);
    assert.equal(f.calls.includes("retire"), false); f.verify();
  });
}

for (const stage of ["connect", "begin", "lock_timeout", "statement_timeout", "workfile", "signatures", "asset", "observers", "retire", "commit"]) {
  test(`cleanup ${stage} failure abstains and releases without leaking the error`, async () => {
    const f = fixture({ failAt: stage, rollbackFailure: true, releaseFailure: true });
    assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false);
    assert.ok(f.calls.includes(stage), "the injected failing stage was actually reached");
    assert.equal(f.calls.filter(value => value === "release").length, stage === "connect" ? 0 : 1);
    assert.equal(f.calls.filter(value => value === "rollback").length, stage === "connect" ? 0 : 1);
  });
}

for (const response of [{ rows: [] }, { rows: [{ id: WORKFILE }] }, { rows: [{ id: ASSET }, { id: ASSET }] }]) {
  test(`cleanup rolls back an unproven retirement result ${JSON.stringify(response)}`, async () => {
    const f = fixture({ responses: { retire: response } });
    assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false); f.verify();
  });
}
test("a synchronous rollback exception cannot prevent release or escape compensation", async () => {
  const f = fixture({ failAt: "asset" });
  const connect = f.pool.connect;
  f.pool.connect = async () => {
    const client = await connect();
    const query = client.query.bind(client);
    client.query = (sql, parameters) => {
      if (sql === "ROLLBACK") throw new Error("synthetic_synchronous_rollback_failure");
      return query(sql, parameters);
    };
    return client;
  };
  assert.equal(await cleanupFailedUadSketchRender(f.pool, args), false);
  assert.ok(f.calls.includes("asset"));
  assert.equal(f.calls.at(-1), "release");
  assert.equal(f.calls.filter(value => value === "release").length, 1);
});
for (const replacement of [{ workfileId: "invalid" }, { assetId: null }, { sketchId: "invalid" },
  { expectedRevision: "1" }, { expectedRevision: 0 }, { expectedRevision: Number.MAX_SAFE_INTEGER }]) {
  test(`cleanup rejects invalid internal identity before connection ${JSON.stringify(replacement)}`, async () => {
    const f = fixture();
    assert.equal(await cleanupFailedUadSketchRender(f.pool, { ...args, ...replacement }), false);
    assert.deepEqual(f.calls, []);
  });
}
