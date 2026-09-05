import assert from "node:assert/strict";
import test from "node:test";

import { saveUadSketch } from "../src/modules/uad/sketches.js";

const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const ENTITY_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const SKETCH_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_WORKFILE_ID = "66666666-6666-4666-8666-666666666666";
const BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";
const LOCKED_ERROR = "uad_workfile_status_locked";
const CREATED_AT = "2026-09-05T12:00:00.000Z";
const UPDATED_AT = "2026-09-05T12:05:00.000Z";
const UNSIGNED = { id: WORKFILE_ID, status: "draft", signed_at: null };

function without(record, key) {
  const result = { ...record };
  delete result[key];
  return result;
}

function sketchInput(overrides = {}) {
  return {
    entity_id: ENTITY_ID,
    schema_version: "2.0",
    geometry: { areas: [{ id: "first-floor", vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }] }] },
    measurements: { standard: "ANSI", method: "Measured", rooms: [{ id: "room-1", label: "Office" }] },
    calculated_areas: { gross_living_area: 2100, unit: "sqft" },
    area_overrides: { gross_living_area: { value: 2090, reason: "Appraiser correction" } },
    rendered_asset_id: ASSET_ID,
    source: "homenode",
    change_source: "synthetic_lifecycle_review",
    ...overrides,
  };
}

function existingSketch(overrides = {}) {
  return {
    id: SKETCH_ID,
    workfile_id: WORKFILE_ID,
    entity_id: ENTITY_ID,
    schema_version: "1.0",
    geometry: { areas: [{ id: "prior-floor" }] },
    measurements: { unit: "Feet" },
    calculated_areas: { gross_living_area: 2000 },
    area_overrides: {},
    rendered_asset_id: null,
    source: "mobile",
    revision: 3,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

function sketchPool(options = {}) {
  const row = Object.hasOwn(options, "workfileRow") ? options.workfileRow : UNSIGNED;
  const calls = [];
  let connected = 0;
  let released = 0;
  let locked = false;
  let signatureRead = false;
  let savedRow;
  const client = {
    async query(sql, parameters = []) {
      const statement = String(sql).replace(/\s+/g, " ").trim();
      const call = { statement, parameters };
      calls.push(call);
      const at = (stage) => {
        call.stage = stage;
        if (options.failAt === stage) throw new Error(`synthetic_${stage}_failed`);
      };
      if ([BEGIN, "COMMIT", "ROLLBACK"].includes(statement)) {
        at(statement === BEGIN ? "begin" : statement.toLowerCase());
        if (statement === "ROLLBACK" && options.rollbackFails) throw new Error("synthetic_rollback_failed");
        return { rows: [] };
      }
      if (statement.includes("FROM appraisal.uad_workfiles")) {
        at("workfile");
        assert.equal(calls[0].statement, BEGIN);
        assert.equal(statement, "SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE");
        assert.deepEqual(parameters, [WORKFILE_ID]);
        locked = true;
        return { rows: options.missingWorkfile ? [] : [row] };
      }
      if (statement.includes("FROM appraisal.uad_signatures")) {
        at("signatures");
        assert.equal(locked, true);
        assert.equal(calls.length, 3, "signature lookup must immediately follow the workfile lock");
        assert.match(statement, /^SELECT EXISTS \(/);
        assert.match(statement, /WHERE workfile_id = \$1\b/);
        assert.match(statement, /AS has_signatures$/);
        assert.doesNotMatch(statement, /revision_number/);
        assert.equal(statement.includes(WORKFILE_ID), false);
        assert.deepEqual(parameters, [WORKFILE_ID]);
        signatureRead = true;
        return options.signatureResult
          ? options.signatureResult()
          : { rows: [{ has_signatures: (options.signatures || []).some((signature) => signature.workfile_id === WORKFILE_ID) }] };
      }
      assert.equal(locked && signatureRead, true, "canonical access requires prior locked lifecycle evidence");
      if (statement.includes("FROM appraisal.uad_entities")) {
        at("entity");
        assert.deepEqual(parameters, [ENTITY_ID, WORKFILE_ID]);
        return { rows: options.missingEntity ? [] : [{ id: ENTITY_ID }] };
      }
      if (statement.includes("FROM appraisal.uad_assets")) {
        at("asset");
        assert.deepEqual(parameters, [ASSET_ID, WORKFILE_ID]);
        assert.match(statement, /section_number = 7 AND status = 'verified'/);
        return { rows: options.missingAsset ? [] : [{ id: ASSET_ID }] };
      }
      if (statement.startsWith("SELECT * FROM appraisal.uad_sketches")) {
        at("sketch");
        assert.deepEqual(parameters, [WORKFILE_ID, options.rootSketch ? null : ENTITY_ID]);
        assert.match(statement, /entity_id IS NOT DISTINCT FROM \$2::uuid/);
        assert.match(statement, /ORDER BY updated_at DESC, id LIMIT 1 FOR UPDATE$/);
        return { rows: options.existing ? [options.existing] : [] };
      }
      if (/^(INSERT INTO|UPDATE) appraisal\.uad_sketches\b/.test(statement)) {
        at("save");
        assert.equal(parameters.length, 12);
        const referencedParameters = [...new Set([...statement.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
        assert.deepEqual(referencedParameters, parameters.map((_, index) => index + 1),
          "every supplied SQL parameter must have a typed use; omitted slots can fail in PostgreSQL");
        if (statement.startsWith("UPDATE")) {
          assert.match(statement, /WHERE id = \$1 AND workfile_id = \$2 AND entity_id IS NOT DISTINCT FROM \$3::uuid RETURNING \*$/);
        }
        savedRow = {
          id: parameters[0],
          workfile_id: parameters[1],
          entity_id: parameters[2],
          schema_version: parameters[3],
          geometry: JSON.parse(parameters[4]),
          measurements: JSON.parse(parameters[5]),
          calculated_areas: JSON.parse(parameters[6]),
          area_overrides: JSON.parse(parameters[7]),
          rendered_asset_id: parameters[8],
          source: parameters[9],
          created_by_user_id: options.existing?.created_by_user_id ?? parameters[10],
          updated_by_user_id: parameters[10],
          revision: parameters[11],
          created_at: options.existing?.created_at || CREATED_AT,
          updated_at: UPDATED_AT,
        };
        return { rows: [savedRow] };
      }
      if (statement.startsWith("UPDATE appraisal.uad_workfiles")) {
        at("touch");
        assert.equal(statement, "UPDATE appraisal.uad_workfiles SET status = 'draft', updated_at = now() WHERE id = $1");
        assert.deepEqual(parameters, [WORKFILE_ID]);
        return { rows: [] };
      }
      if (statement.startsWith("INSERT INTO appraisal.uad_sketch_history")) {
        at("history");
        assert.match(statement, /ON CONFLICT \(sketch_id, revision\) DO NOTHING$/);
        return { rows: [] };
      }
      if (statement.startsWith("INSERT INTO appraisal.uad_audit_events")) {
        at("audit");
        assert.match(statement, /'uad_sketch.saved', 'uad_sketch'/);
        return { rows: [] };
      }
      throw new Error(`unexpected_sketch_test_query:${statement.slice(0, 120)}`);
    },
    release() { released += 1; },
  };
  return {
    calls,
    pool: { async connect() { connected += 1; return client; } },
    assertFinished(committed, { attemptedCommit = false } = {}) {
      assert.equal(connected, 1);
      assert.equal(released, 1);
      assert.equal(calls[0].statement, BEGIN);
      assert.equal(calls.at(-1).statement, committed ? "COMMIT" : "ROLLBACK");
      assert.equal(calls.filter((call) => call.statement === "COMMIT").length, committed || attemptedCommit ? 1 : 0);
      assert.equal(calls.filter((call) => call.statement === "ROLLBACK").length, committed ? 0 : 1);
    },
    assertLifecycleDenied() {
      this.assertFinished(false);
      assert.ok(calls.every((call) => ["begin", "workfile", "signatures", "rollback"].includes(call.stage)),
        "lifecycle refusal must precede all entity, asset, sketch, source, history and audit work");
      assert.equal(calls.some(({ statement }) => /^(INSERT|UPDATE|DELETE)\b/.test(statement)), false);
    },
  };
}

const refusedWorkfiles = [
  ...["signed", "exported", "submitted", "cancelled", "unknown", "", "SIGNED"].map((status) => (
    [`status ${JSON.stringify(status)}`, { ...UNSIGNED, status }]
  )),
  ["missing status", without(UNSIGNED, "status")],
  ...[null, undefined, 0, true, ["draft"], {}].map((status) => (
    [`malformed status ${JSON.stringify(status)}`, { ...UNSIGNED, status }]
  )),
  ["null locked record", null],
  ["undefined locked record", undefined],
  ["missing signed_at column", without(UNSIGNED, "signed_at")],
  ["ready with signed_at", { ...UNSIGNED, status: "ready", signed_at: CREATED_AT }],
  ...[undefined, false, 0, "", {}, [], new Date(CREATED_AT)].map((signed_at) => (
    [`non-null signed_at ${JSON.stringify(signed_at)}`, { ...UNSIGNED, signed_at }]
  )),
];

for (const [name, workfileRow] of refusedWorkfiles) {
  test(`canonical sketch save rejects ${name} before canonical work`, async () => {
    const harness = sketchPool({ workfileRow });
    await assert.rejects(() => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput(), ACTOR_ID), { message: LOCKED_ERROR });
    harness.assertLifecycleDenied();
    assert.equal(harness.calls.some((call) => call.stage === "signatures"), false);
  });
}

for (const [name, status, revision_number] of [
  ["partial current-revision signature", "ready", 7],
  ["historical signature despite revised status", "revised", 1],
]) {
  test(`canonical sketch save rejects ${name}`, async () => {
    const harness = sketchPool({
      workfileRow: { ...UNSIGNED, status, current_revision: 7 },
      signatures: [{ workfile_id: WORKFILE_ID, revision_number }],
    });
    await assert.rejects(() => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput(), ACTOR_ID), { message: LOCKED_ERROR });
    harness.assertLifecycleDenied();
    assert.equal(harness.calls.filter((call) => call.stage === "signatures").length, 1);
  });
}

const malformedEvidence = [
  ["missing result", undefined],
  ["null result", null],
  ["missing rows", {}],
  ["null rows", { rows: null }],
  ["non-array rows", { rows: { 0: { has_signatures: false }, length: 1 } }],
  ["empty rows", { rows: [] }],
  ["multiple rows", { rows: [{ has_signatures: false }, { has_signatures: false }] }],
  ["null row", { rows: [null] }],
  ["undefined row", { rows: [undefined] }],
  ["missing boolean", { rows: [{}] }],
  ...[null, undefined, 0, 1, "false", "true", [], {}].map((has_signatures) => (
    [`non-boolean ${JSON.stringify(has_signatures)}`, { rows: [{ has_signatures }] }]
  )),
];

for (const [name, result] of malformedEvidence) {
  test(`canonical sketch save fails closed for signature evidence ${name}`, async () => {
    const harness = sketchPool({ signatureResult: () => result });
    await assert.rejects(() => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput(), ACTOR_ID), { message: LOCKED_ERROR });
    harness.assertLifecycleDenied();
  });
}

function assertSavedContent(harness, result, input, { existing = null, actor = ACTOR_ID } = {}) {
  harness.assertFinished(true);
  const save = harness.calls.find((call) => call.stage === "save");
  const history = harness.calls.find((call) => call.stage === "history");
  const audit = harness.calls.find((call) => call.stage === "audit");
  const nextRevision = existing ? Number(existing.revision) + 1 : 1;
  assert.match(save.statement, existing ? /^UPDATE appraisal\.uad_sketches/ : /^INSERT INTO appraisal\.uad_sketches/);
  assert.match(result.id, /^[a-f0-9-]{36}$/);
  if (existing) assert.equal(result.id, existing.id);
  assert.deepEqual(result, {
    id: result.id,
    workfile_id: WORKFILE_ID,
    entity_id: input.entity_id ?? null,
    schema_version: input.schema_version ?? "1.0",
    geometry: input.geometry ?? {},
    measurements: input.measurements ?? {},
    calculated_areas: input.calculated_areas ?? {},
    area_overrides: input.area_overrides ?? {},
    rendered_asset_id: input.rendered_asset_id ?? null,
    source: input.source ?? "homenode",
    revision: nextRevision,
    created_at: existing?.created_at || CREATED_AT,
    updated_at: UPDATED_AT,
  });
  assert.deepEqual(save.parameters, [
    result.id, WORKFILE_ID, result.entity_id, result.schema_version,
    JSON.stringify(result.geometry), JSON.stringify(result.measurements),
    JSON.stringify(result.calculated_areas), JSON.stringify(result.area_overrides),
    result.rendered_asset_id, result.source, actor, nextRevision,
  ]);
  assert.deepEqual(history.parameters, [
    result.id, WORKFILE_ID, nextRevision,
    JSON.stringify(result.geometry), JSON.stringify(result.measurements),
    JSON.stringify(result.calculated_areas), JSON.stringify(result.area_overrides),
    result.rendered_asset_id, result.source, actor, input.change_source ?? "uad_sketch_api",
  ]);
  assert.deepEqual(audit.parameters.slice(0, 2), [WORKFILE_ID, result.id]);
  assert.deepEqual(JSON.parse(audit.parameters[2]), existing);
  assert.deepEqual(JSON.parse(audit.parameters[3]), result);
  assert.deepEqual(JSON.parse(audit.parameters[4]), {
    source: result.source,
    schema_version: result.schema_version,
    prior_revision: existing ? Number(existing.revision) : null,
    next_revision: nextRevision,
    change_source: input.change_source ?? "uad_sketch_api",
  });
  assert.equal(audit.parameters[5], actor);
  assert.deepEqual(harness.calls.slice(-5).map((call) => call.stage), ["save", "touch", "history", "audit", "commit"]);
  assert.equal(harness.calls.some(({ statement }) => /appraisal\.(uad_revisions|uad_field_values)\b/.test(statement)), false);
  assert.equal(harness.calls.some(({ statement }) => statement.includes("current_revision")), false,
    "a sketch save must not become a workfile revision save");
}

for (const [status, source] of [["draft", "homenode"], ["validating", "mobile"], ["ready", "imported"], ["revised", "third_party"]]) {
  test(`canonical sketch save preserves unsigned ${status} inserts with ${source} provenance`, async () => {
    const input = sketchInput({ source, actor_user_id: OTHER_WORKFILE_ID });
    const harness = sketchPool({ workfileRow: { ...UNSIGNED, status } });
    const result = await saveUadSketch(harness.pool, WORKFILE_ID, input, ACTOR_ID);
    assertSavedContent(harness, result, input);
  });
}

test("canonical sketch update preserves existing identity, optimistic revision, evidence and audit history", async () => {
  const existing = existingSketch();
  const input = sketchInput({ expected_revision: existing.revision, source: "imported" });
  const harness = sketchPool({ existing });
  const result = await saveUadSketch(harness.pool, WORKFILE_ID, input, ACTOR_ID);
  assertSavedContent(harness, result, input, { existing });
});

test("canonical sketch update preserves the existing optional expected-revision behavior", async () => {
  const existing = existingSketch();
  const input = sketchInput();
  const harness = sketchPool({ existing });
  const result = await saveUadSketch(harness.pool, WORKFILE_ID, input, ACTOR_ID);
  assertSavedContent(harness, result, input, { existing });
});

test("canonical root sketch update binds its null entity without changing sketch ownership", async () => {
  const existing = existingSketch({ entity_id: null });
  const input = sketchInput({ entity_id: null, expected_revision: existing.revision });
  const harness = sketchPool({ existing, rootSketch: true });
  const result = await saveUadSketch(harness.pool, WORKFILE_ID, input, ACTOR_ID);
  assertSavedContent(harness, result, input, { existing });
  assert.equal(harness.calls.some((call) => call.stage === "entity"), false);
});

test("a root sketch retains default payload, actor and source behavior and ignores other-workfile signatures", async () => {
  const harness = sketchPool({ rootSketch: true, signatures: [{ workfile_id: OTHER_WORKFILE_ID, revision_number: 1 }] });
  const result = await saveUadSketch(harness.pool, WORKFILE_ID);
  assertSavedContent(harness, result, {}, { actor: null });
  assert.equal(harness.calls.some((call) => ["entity", "asset"].includes(call.stage)), false);
});

test("missing canonical workfile preserves not-found response without signature or canonical access", async () => {
  const harness = sketchPool({ missingWorkfile: true });
  await assert.rejects(() => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput(), ACTOR_ID), { message: "uad_workfile_not_found" });
  harness.assertLifecycleDenied();
  assert.equal(harness.calls.some((call) => call.stage === "signatures"), false);
});

for (const [name, options, message] of [
  ["missing entity", { missingEntity: true }, "uad_entity_not_found"],
  ["unverified or missing rendered exhibit", { missingAsset: true }, "uad_sketch_rendered_asset_not_found"],
]) {
  test(`canonical sketch save preserves ${name} refusal after lifecycle authorization`, async () => {
    const harness = sketchPool(options);
    await assert.rejects(() => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput(), ACTOR_ID), { message });
    harness.assertFinished(false);
    assert.equal(harness.calls.some(({ statement }) => /^(INSERT|UPDATE|DELETE)\b/.test(statement)), false);
  });
}

test("stale sketch revision returns the current sketch revision and performs no writes", async () => {
  const harness = sketchPool({ existing: existingSketch() });
  await assert.rejects(
    () => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput({ expected_revision: 2 }), ACTOR_ID),
    (error) => error.message === "uad_sketch_revision_conflict" && error.currentRevision === 3,
  );
  harness.assertFinished(false);
  assert.equal(harness.calls.some(({ statement }) => /^(INSERT|UPDATE|DELETE)\b/.test(statement)), false);
});

for (const failAt of ["begin", "workfile", "signatures", "entity", "asset", "sketch", "save", "touch", "history", "audit", "commit"]) {
  test(`canonical sketch save rolls back and releases after ${failAt} failure`, async () => {
    const harness = sketchPool({ failAt });
    await assert.rejects(() => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput(), ACTOR_ID), { message: `synthetic_${failAt}_failed` });
    harness.assertFinished(false, { attemptedCommit: failAt === "commit" });
  });
}

test("rollback failure does not mask lifecycle denial or prevent release", async () => {
  const harness = sketchPool({ workfileRow: { ...UNSIGNED, status: "signed" }, rollbackFails: true });
  await assert.rejects(() => saveUadSketch(harness.pool, WORKFILE_ID, sketchInput(), ACTOR_ID), { message: LOCKED_ERROR });
  harness.assertLifecycleDenied();
});

test("invalid sketch input still fails before acquiring a database connection", async () => {
  const pool = { async connect() { assert.fail("invalid input must not acquire a connection"); } };
  await assert.rejects(() => saveUadSketch(pool, WORKFILE_ID, sketchInput({ expected_revision: 0 }), ACTOR_ID), {
    message: "invalid_uad_sketch_expected_revision",
  });
});
