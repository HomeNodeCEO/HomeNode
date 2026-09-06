import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createUadAssetUpload, deleteUadAsset, verifyUadAssetUpload } from "../src/modules/uad/assets.js";
import { createUadEntity, createUadEntityWithClient, deleteUadEntity, deleteUadEntityWithClient } from "../src/modules/uad/entities.js";
import { assertUadWorkfileMutable, isUadWorkfileMutable } from "../src/modules/uad/workfileLifecycle.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const WORKFILE_ID = "11111111-1111-4111-8111-111111111111";
const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";

test("the shared UAD lifecycle guard fails closed outside explicitly mutable states", () => {
  for (const status of ["signed", "exported", "submitted", "cancelled", "", null, "unknown"]) {
    assert.equal(isUadWorkfileMutable(status), false);
    assert.throws(() => assertUadWorkfileMutable(status), /uad_workfile_status_locked/);
  }
  for (const status of ["draft", "validating", "ready", "revised"]) {
    assert.equal(isUadWorkfileMutable(status), true);
    assert.doesNotThrow(() => assertUadWorkfileMutable(status));
  }
});

test("entity creation and deletion stop at the locked finalized workfile row", async () => {
  for (const operation of [
    (client) => createUadEntityWithClient(client, WORKFILE_ID, { entity_type: "sales_comparable" }),
    (client) => deleteUadEntityWithClient(client, WORKFILE_ID, ENTITY_ID),
  ]) {
    const queries = [];
    const client = {
      async query(sql) {
        queries.push(String(sql));
        return { rows: [{ id: WORKFILE_ID, status: "signed" }] };
      },
    };
    await assert.rejects(() => operation(client), /uad_workfile_status_locked/);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /FOR UPDATE/);
    assert.doesNotMatch(queries[0], /INSERT|DELETE FROM appraisal\.uad_entities/);
  }
});

test("asset URL creation and verification reject finalized workfiles before storage access", async () => {
  let storageTouched = false;
  const storage = {
    createUploadUrl() { storageTouched = true; },
    inspectObject() { storageTouched = true; },
  };
  const creationQueries = [];
  let creationReleased = false;
  const creationClient = {
    async query(statement, parameters = []) {
      const sql = statement.replace(/\s+/g, " ").trim();
      creationQueries.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED" || sql === "ROLLBACK") {
        assert.deepEqual(parameters, []);
        return { rows: [] };
      }
      assert.equal(sql, "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE");
      assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: [{ id: WORKFILE_ID, organization_id: "org", status: "signed", signed_at: null }] };
    },
    release() { assert.equal(creationReleased, false); creationReleased = true; },
  };
  await assert.rejects(
    () => createUadAssetUpload(
      { connect: async () => creationClient, query: async () => assert.fail("creation escaped its transaction client") },
      storage,
      WORKFILE_ID,
      { asset_kind: "photo", content_type: "image/jpeg", file_name: "subject.jpg", byte_size: 10 },
    ),
    /uad_workfile_status_locked/,
  );
  assert.deepEqual(creationQueries, [
    "BEGIN ISOLATION LEVEL READ COMMITTED",
    "SELECT id, organization_id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE",
    "ROLLBACK",
  ]);
  assert.equal(creationReleased, true);
  await assert.rejects(
    () => verifyUadAssetUpload(
      { query: async () => ({ rows: [{ id: ASSET_ID, workfile_status: "signed" }] }) },
      storage,
      WORKFILE_ID,
      ASSET_ID,
    ),
    /uad_workfile_status_locked/,
  );
  assert.equal(storageTouched, false);
});

test("asset deletion locks and rejects the workfile before deleting storage", async () => {
  const queries = [];
  let deleted = false;
  const client = {
    async query(sql) {
      const statement = String(sql).trim();
      queries.push(statement);
      if (statement.startsWith("SELECT id, status")) {
        return { rows: [{ id: WORKFILE_ID, status: "exported", signed_at: null }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  await assert.rejects(
    () => deleteUadAsset(
      { connect: async () => client },
      { deleteObject: async () => { deleted = true; } },
      WORKFILE_ID,
      ASSET_ID,
    ),
    /uad_workfile_status_locked/,
  );
  assert.equal(deleted, false);
  assert.equal(queries[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
  assert.ok(queries.includes("ROLLBACK"));
  assert.equal(queries.some((sql) => sql.startsWith("SELECT id, object_key")), false);
});

test("asset insertion and verification retain mutable-workfile dependencies with locked verification admission", () => {
  const assets = fs.readFileSync(path.resolve(directory, "../src/modules/uad/assets.js"), "utf8");
  const validation = fs.readFileSync(path.resolve(directory, "../src/modules/uad/validation.js"), "utf8");
  assert.match(assets, /WITH mutable_workfile AS[\s\S]+status IN \('draft', 'validating', 'ready', 'revised'\)[\s\S]+FROM mutable_workfile/);
  assert.match(assets, /updated_asset AS[\s\S]+EXISTS \(SELECT 1 FROM mutable_workfile\)/);
  assert.match(assets, /async function withUadAssetVerificationLock[\s\S]+BEGIN ISOLATION LEVEL READ COMMITTED[\s\S]+FOR UPDATE[\s\S]+await assertLockedUadWorkfileMutable\(client, locked\.rows\[0\]\)/);
  assert.match(assets, /async function rejectUadAssetIfWorkfileMutable[\s\S]+await withUadAssetVerificationLock\(pool, workfileId, assetId, source/);
  assert.match(assets, /const updatedAsset = await withUadAssetVerificationLock\(pool, workfileId, assetId, asset/);
  assert.match(validation, /assertUadWorkfileMutable\(locked\.rows\[0\]\.status, "uad_validation_status_locked"\)/);
});

const ENTITY_ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const ENTITY_BEGIN = "BEGIN ISOLATION LEVEL READ COMMITTED";
const ENTITY_INPUT = Object.freeze({ entity_type: "assignment_seller", label: "New synthetic seller", data: { synthetic: true } });

// Stateful unit model, not PostgreSQL evidence. Accept both the old and new
// lock/BEGIN forms so old-source RED means missing refusal, not missing SQL.
function entityLifecycleFixture({ status = "ready", signedAt = null, signatureRevision = null, commitError = null } = {}) {
  let state = {
    workfile: { id: WORKFILE_ID, status, signed_at: signedAt, current_revision: 2, updated_at: "before" },
    entities: [{ id: ENTITY_ID, workfile_id: WORKFILE_ID, parent_entity_id: null,
      entity_type: "assignment_seller", entity_identifier: "assignment-seller-1", ordinal: 1,
      label: "Retained seller", data: { retained: true }, created_at: "before", updated_at: "before" }],
    values: [{ id: "retained-value", entity_id: ENTITY_ID, value: "Retained seller value" }],
    audit: [{ event_type: "retained-event", actor_user_id: ENTITY_ACTOR_ID }],
    revisions: [{ revision_number: 2, document: { retained: true } }],
    signatures: signatureRevision === null ? [] : [{ workfile_id: WORKFILE_ID,
      revision_number: signatureRevision, signer_user_id: ENTITY_ACTOR_ID, signer_role: "appraiser", retained: true }],
    assets: [{ id: ASSET_ID, status: "verified", object_key: "retained-object" }],
    history: [{ revision: 1, retained: true }],
    validation: [{ revision_number: 2, status: "passed" }],
    artifacts: [{ revision_number: 2, generation_status: "ready" }],
  };
  const before = structuredClone(state), trace = [], failures = [], isolations = [];
  let snapshot = null, active = false, locked = false, connections = 0, releases = 0;
  const client = {
    async query(sql, params = []) {
      const statement = String(sql).replace(/\s+/g, " ").trim();
      trace.push(statement);
      try {
        assert.equal(this, client);
        assert.equal(releases, 0);
        if (statement === "BEGIN" || statement === ENTITY_BEGIN) {
          assert.deepEqual(params, []);
          assert.equal(active, false, "a borrowed helper must not start a nested transaction");
          active = true; locked = false; snapshot = structuredClone(state);
          isolations.push(statement === ENTITY_BEGIN ? "read committed" : "repeatable read");
          return { rows: [] };
        }
        assert.equal(active, true, "all helper SQL must use the active caller transaction");
        if (statement === "COMMIT" || statement === "ROLLBACK") {
          assert.deepEqual(params, []);
          if (statement === "COMMIT" && commitError) throw commitError;
          if (statement === "ROLLBACK") state = structuredClone(snapshot);
          active = false; locked = false;
          return { rows: [] };
        }
        if (statement === "SELECT 1 AS caller_still_owns_transaction") {
          assert.deepEqual(params, []); return { rows: [{ caller_still_owns_transaction: 1 }] };
        }
        if (statement === "SELECT id, status FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE"
          || statement === "SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE") {
          assert.deepEqual(params, [WORKFILE_ID]); locked = true;
          return { rows: [{ id: WORKFILE_ID, status: state.workfile.status,
            ...(statement.includes("signed_at") ? { signed_at: state.workfile.signed_at } : {}) }] };
        }
        assert.equal(locked, true, "workfile lock must precede signature/entity queries");
        if (statement === "SELECT EXISTS ( SELECT 1 FROM appraisal.uad_signatures WHERE workfile_id = $1 ) AS has_signatures") {
          assert.deepEqual(params, [WORKFILE_ID]);
          return { rows: [{ has_signatures: state.signatures.some(row => row.workfile_id === WORKFILE_ID) }] };
        }
        if (statement === "SELECT count(*)::integer AS count FROM appraisal.uad_entities WHERE workfile_id = $1 AND entity_type = $2 AND parent_entity_id IS NOT DISTINCT FROM $3::uuid") {
          assert.deepEqual(params, [WORKFILE_ID, "assignment_seller", null]);
          return { rows: [{ count: state.entities.length }] };
        }
        if (statement === "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM appraisal.uad_entities WHERE workfile_id = $1 AND entity_type = $2") {
          assert.deepEqual(params, [WORKFILE_ID, "assignment_seller"]);
          return { rows: [{ ordinal: Math.max(0, ...state.entities.map(row => row.ordinal)) + 1 }] };
        }
        if (statement === "INSERT INTO appraisal.uad_entities ( id, workfile_id, parent_entity_id, entity_type, entity_identifier, ordinal, label, data ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *") {
          assert.match(params[0], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
          assert.deepEqual(params.slice(1), [WORKFILE_ID, null, "assignment_seller", "assignment-seller-2", 2,
            ENTITY_INPUT.label, JSON.stringify(ENTITY_INPUT.data)]);
          const row = { id: params[0], workfile_id: params[1], parent_entity_id: params[2], entity_type: params[3],
            entity_identifier: params[4], ordinal: params[5], label: params[6], data: JSON.parse(params[7]),
            created_at: "after", updated_at: "after" };
          state.entities.push(row); return { rows: [structuredClone(row)] };
        }
        if (statement === "SELECT * FROM appraisal.uad_entities WHERE id = $1 AND workfile_id = $2 FOR UPDATE") {
          assert.deepEqual(params, [ENTITY_ID, WORKFILE_ID]);
          return { rows: state.entities.filter(row => row.id === ENTITY_ID).map(row => structuredClone(row)) };
        }
        if (statement === "DELETE FROM appraisal.uad_entities WHERE id = $1") {
          assert.deepEqual(params, [ENTITY_ID]);
          state.entities = state.entities.filter(row => row.id !== ENTITY_ID);
          state.values = state.values.filter(row => row.entity_id !== ENTITY_ID);
          return { rows: [] };
        }
        const createdAudit = "INSERT INTO appraisal.uad_audit_events ( workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data ) VALUES ($1, $2, 'uad_entity.created', $3, $4, $5::jsonb)";
        const deletedAudit = "INSERT INTO appraisal.uad_audit_events ( workfile_id, actor_user_id, event_type, entity_type, entity_id, before_data ) VALUES ($1, $2, 'uad_entity.deleted', $3, $4, $5::jsonb)";
        if (statement === createdAudit || statement === deletedAudit) {
          assert.equal(params.length, 5);
          assert.equal(params[0], WORKFILE_ID); assert.equal(params[1], ENTITY_ACTOR_ID);
          assert.equal(params[2], "assignment_seller");
          const payload = JSON.parse(params[4]); assert.equal(payload.id, params[3]);
          state.audit.push({ workfile_id: params[0], actor_user_id: params[1], entity_type: params[2], entity_id: params[3],
            event_type: statement === createdAudit ? "uad_entity.created" : "uad_entity.deleted",
            [statement === createdAudit ? "after_data" : "before_data"]: payload });
          return { rows: [] };
        }
        if (statement === "UPDATE appraisal.uad_workfiles SET status = 'draft', updated_at = now() WHERE id = $1") {
          assert.deepEqual(params, [WORKFILE_ID]);
          state.workfile.status = "draft"; state.workfile.updated_at = "after";
          return { rows: [] };
        }
        assert.fail(`unsupported entity lifecycle fixture SQL: ${statement}`);
      } catch (error) {
        if (error !== commitError) failures.push(error);
        throw error;
      }
    },
    release() {
      try { assert.equal(this, client); assert.equal(active, false); assert.equal(++releases, 1); }
      catch (error) { failures.push(error); throw error; }
    },
  };
  return {
    client, trace, isolations, before,
    pool: {
      async connect() { assert.equal(++connections, 1); return client; },
      async query() { assert.fail("entity mutation escaped the checked-out client"); },
    },
    state: () => structuredClone(state),
    ownership: () => ({ active, connections, releases }),
    assertSqlHealthy() { assert.deepEqual(failures, [], "old-source mutation SQL must be fully supported"); },
  };
}

function invokeEntityLifecycle(fixture, operation, borrowed, options = {}) {
  if (borrowed) return operation === "create"
    ? createUadEntityWithClient(fixture.client, WORKFILE_ID, ENTITY_INPUT, { actorUserId: ENTITY_ACTOR_ID, ...options })
    : deleteUadEntityWithClient(fixture.client, WORKFILE_ID, ENTITY_ID, { actorUserId: ENTITY_ACTOR_ID });
  return operation === "create"
    ? createUadEntity(fixture.pool, WORKFILE_ID, ENTITY_INPUT, ENTITY_ACTOR_ID)
    : deleteUadEntity(fixture.pool, WORKFILE_ID, ENTITY_ID, ENTITY_ACTOR_ID);
}

for (const borrowed of [false, true]) {
  for (const operation of ["create", "delete"]) {
    const name = `${borrowed ? "borrowed" : "public"} entity lifecycle ${operation}`;
    for (const [reason, options] of [
      ["mutable signed_at", { signedAt: "2026-09-06T00:00:00.000Z" }],
      ["partial current signature", { signatureRevision: 2 }],
      ["historical signature under revised", { status: "revised", signatureRevision: 1 }],
    ]) {
      test(`${name} refuses ${reason} without changing complete synthetic state`, async () => {
        const fixture = entityLifecycleFixture(options);
        if (borrowed) await fixture.client.query(ENTITY_BEGIN);
        let failure = null;
        // Trusted composition flags suppress side effects, never the guard.
        try { await invokeEntityLifecycle(fixture, operation, borrowed,
          borrowed && operation === "create" ? { audit: false, touch: false } : {}); }
        catch (error) { failure = error; }
        fixture.assertSqlHealthy();
        assert.equal(failure?.message, "uad_workfile_status_locked", "missing lifecycle refusal; old mutation completed");
        assert.deepEqual(fixture.state(), fixture.before);
        const queries = fixture.trace;
        assert.equal(queries[0], ENTITY_BEGIN);
        assert.match(queries[1], /status, signed_at.*FOR UPDATE$/);
        assert.equal(queries.some(sql => /appraisal\.(uad_entities|uad_field_values|uad_audit_events)/.test(sql)), false);
        assert.equal(queries.some(sql => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), false);
        if (options.signedAt) assert.equal(queries.some(sql => sql.includes("FROM appraisal.uad_signatures")), false);
        else assert.equal(queries.filter(sql => sql.includes("FROM appraisal.uad_signatures")).length, 1);
        if (borrowed) {
          assert.deepEqual(fixture.ownership(), { active: true, connections: 0, releases: 0 });
          assert.equal(queries.some(sql => sql === "COMMIT" || sql === "ROLLBACK"), false);
          assert.deepEqual((await fixture.client.query("SELECT 1 AS caller_still_owns_transaction")).rows,
            [{ caller_still_owns_transaction: 1 }]);
          await fixture.client.query("ROLLBACK");
        } else {
          assert.deepEqual(fixture.ownership(), { active: false, connections: 1, releases: 1 });
          assert.equal(queries.at(-1), "ROLLBACK"); assert.equal(queries.includes("COMMIT"), false);
        }
      });
    }
    test(`${name} preserves unsigned audit, touch and transaction ownership`, async () => {
      for (const status of ["draft", "validating", "ready", "revised"]) {
        const fixture = entityLifecycleFixture({ status });
        if (borrowed) await fixture.client.query(ENTITY_BEGIN);
        const result = await invokeEntityLifecycle(fixture, operation, borrowed);
        fixture.assertSqlHealthy();
        const state = fixture.state();
        assert.equal(state.workfile.status, "draft"); assert.equal(state.workfile.current_revision, 2);
        assert.equal(state.workfile.updated_at, "after");
        assert.deepEqual(state.audit.at(-1), { workfile_id: WORKFILE_ID, actor_user_id: ENTITY_ACTOR_ID,
          entity_type: "assignment_seller", entity_id: result.id,
          event_type: operation === "create" ? "uad_entity.created" : "uad_entity.deleted",
          [operation === "create" ? "after_data" : "before_data"]: result });
        assert.equal(state.entities.length, operation === "create" ? 2 : 0);
        assert.deepEqual(state.entities, operation === "create" ? [...fixture.before.entities, result] : []);
        const comparable = { ...state, workfile: fixture.before.workfile, audit: fixture.before.audit,
          entities: fixture.before.entities, values: fixture.before.values };
        assert.deepEqual(comparable, fixture.before);
        assert.deepEqual(state.values, operation === "create" ? fixture.before.values : []);
        assert.deepEqual(fixture.isolations, ["read committed"], "public owner must override the hostile default isolation");
        if (borrowed) {
          assert.deepEqual(fixture.ownership(), { active: true, connections: 0, releases: 0 });
          assert.equal(fixture.trace.filter(sql => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)).length, 1);
          await fixture.client.query("ROLLBACK"); assert.deepEqual(fixture.state(), fixture.before);
        } else {
          assert.deepEqual(fixture.ownership(), { active: false, connections: 1, releases: 1 });
          assert.equal(fixture.trace.at(-1), "COMMIT");
        }
      }
    });
  }
}

test("borrowed entity lifecycle creation preserves independent audit:false and touch:false options", async () => {
  for (const options of [{ audit: false }, { touch: false }, { audit: false, touch: false }]) {
    const fixture = entityLifecycleFixture();
    await fixture.client.query(ENTITY_BEGIN);
    const result = await invokeEntityLifecycle(fixture, "create", true, options);
    fixture.assertSqlHealthy();
    const state = fixture.state();
    assert.deepEqual(state.entities, [...fixture.before.entities, result]);
    assert.equal(state.audit.length, fixture.before.audit.length + (options.audit === false ? 0 : 1));
    if (options.audit === false) assert.deepEqual(state.audit, fixture.before.audit);
    else assert.equal(state.audit.at(-1).actor_user_id, ENTITY_ACTOR_ID);
    assert.deepEqual(state.workfile, options.touch === false ? fixture.before.workfile
      : { ...fixture.before.workfile, status: "draft", updated_at: "after" });
    assert.deepEqual(fixture.ownership(), { active: true, connections: 0, releases: 0 });
    assert.equal(fixture.trace.filter(sql => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(sql)).length, 1);
    await fixture.client.query("ROLLBACK"); assert.deepEqual(fixture.state(), fixture.before);
  }
});

for (const operation of ["create", "delete"]) {
  test(`public entity lifecycle ${operation} rolls back completed synthetic writes on pre-COMMIT failure`, async () => {
    const commitError = new Error("synthetic_entity_commit_failure");
    const fixture = entityLifecycleFixture({ commitError });
    await assert.rejects(() => invokeEntityLifecycle(fixture, operation, false), error => error === commitError);
    fixture.assertSqlHealthy();
    assert.ok(fixture.trace.some(sql => sql.startsWith("INSERT INTO appraisal.uad_audit_events")));
    assert.ok(fixture.trace.some(sql => sql.startsWith("UPDATE appraisal.uad_workfiles")));
    assert.deepEqual(fixture.trace.slice(-2), ["COMMIT", "ROLLBACK"]);
    assert.deepEqual(fixture.state(), fixture.before);
    assert.deepEqual(fixture.ownership(), { active: false, connections: 1, releases: 1 });
  });
}
