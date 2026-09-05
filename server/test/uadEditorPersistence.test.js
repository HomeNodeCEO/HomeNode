import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCertificationSystemValues,
  calculateReconciliationRepairTotal,
  calculateSalesComparisonSummaryValues,
  saveUadSection,
  validateCompleteSection,
} from "../src/modules/uad/editor.js";
import { createUadSectionPersistence } from "../src/modules/uad/editorPersistence.js";
import { getUadField, UAD_PHASE_ONE_FIELDS } from "../src/modules/uad/fieldCatalog.js";

const WORKFILE = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const FIELD_ID = "33333333-3333-4333-8333-333333333333";
const UPDATED = "2026-09-05T00:00:00.000Z";
const clone = value => JSON.parse(JSON.stringify(value));
const boundary = value => ({ context_key: "market", uid: "3000.0008", value });
const autosave = values => ({ expected_revision: 7, save_reason: "autosave", values });
const highestBestUse = () => UAD_PHASE_ONE_FIELDS.filter(field => field.section === "highest_best_use" && field.required)
  .map(field => ({ context_key: field.contextKey, uid: field.uid, value: true }));
const statements = db => db.events.map(event => event.kind);
const changes = db => db.events.filter(event => /^(insert_|update_)/.test(event.kind));
const event = (db, kind) => {
  const matches = db.events.filter(item => item.kind === kind);
  assert.equal(matches.length, 1, `Expected exactly one ${kind}`);
  return matches[0];
};
function savedBoundary(overrides = {}) {
  const field = getUadField("market", "3000.0008");
  return { id: FIELD_ID, workfile_id: WORKFILE, entity_id: null, field_context: field.contextKey,
    uad_uid: field.uid, report_field_id: field.reportFieldId, value: "Saved boundary",
    source_type: "homenode", source_reference: "fixture:original", is_appraiser_confirmed: true,
    is_override: false, override_reason: null, updated_at: UPDATED, ...overrides };
}

// In-memory SQL seam: no real database, authorization shortcut, or replacement
// catalog validator. Every unknown statement fails so added SQL is observable.
function database(options = {}) {
  const rows = clone(options.rows || []);
  const events = [];
  const state = { connected: 0, released: 0, committed: false,
    workfile: { id: WORKFILE, current_revision: "7", specification_release_key: "fixture-release",
      status: "draft", signed_at: null, ...options.workfile } };
  const classify = sql => {
    if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED") return "begin";
    if (sql === "COMMIT") return "commit";
    if (sql === "ROLLBACK") return "rollback";
    if (sql.includes("SELECT id, current_revision")) return "lock";
    if (sql.includes("AS has_signatures")) return "signatures";
    if (sql.startsWith("SELECT * FROM appraisal.uad_field_values")) return sql.includes("FOR UPDATE") ? "load_locked" : "load_latest";
    if (sql.startsWith("SELECT * FROM appraisal.uad_entities")) return "entities";
    if (sql.startsWith("SELECT * FROM appraisal.uad_assets")) return "assets";
    if (sql.startsWith("INSERT INTO appraisal.uad_field_values")) return "insert_field";
    if (sql.startsWith("UPDATE appraisal.uad_field_values")) return "update_field";
    if (sql.startsWith("UPDATE appraisal.uad_workfiles")) return "update_workfile";
    if (sql.startsWith("INSERT INTO appraisal.uad_revisions")) return "insert_revision";
    if (sql.startsWith("INSERT INTO appraisal.uad_audit_events")) return "insert_audit";
    throw new Error(`unexpected_test_sql:${sql}`);
  };
  const readRows = () => rows.map(row => {
    const result = { ...row };
    if (options.formatterError) Object.defineProperty(result, "id", { enumerable: true,
      get() { if (state.committed) throw options.formatterError; return row.id; } });
    return result;
  });
  const client = {
    async query(value, params = []) {
      const sql = String(value).trim().replace(/\s+/g, " ");
      const kind = classify(sql);
      events.push({ kind, sql, params });
      if (options.failures?.[kind]) throw options.failures[kind];
      if (kind === "lock") return { rows: options.missing ? [] : [{ ...state.workfile }] };
      if (kind === "signatures") {
        assert.ok(statements({ events }).includes("lock"), "signature state must follow the workfile lock");
        return { rows: options.signatureRows ?? [{ has_signatures: false }] };
      }
      if (kind === "load_locked" || kind === "load_latest") return { rows: readRows() };
      if (kind === "entities") return { rows: clone(options.entities || []) };
      if (kind === "assets") return { rows: clone(options.assets || []) };
      if (kind === "insert_field") rows.push({ id: params[0], workfile_id: params[1], entity_id: params[2],
        field_context: params[3], uad_uid: params[4], report_field_id: params[5], value: JSON.parse(params[6]),
        source_type: params[7], source_reference: params[8], is_appraiser_confirmed: true,
        is_override: false, override_reason: null, updated_by_user_id: params[9], updated_at: UPDATED });
      if (kind === "update_field") {
        const row = rows.find(item => item.id === params[0]);
        assert.ok(row, "updated field must already exist");
        Object.assign(row, { value: JSON.parse(params[1]), report_field_id: params[2], source_type: params[3],
          source_reference: params[4], is_appraiser_confirmed: true, is_override: params[5],
          override_reason: params[6], updated_by_user_id: params[7], updated_at: UPDATED });
      }
      if (kind === "update_workfile") Object.assign(state.workfile, { current_revision: params[1], status: "draft" });
      if (kind === "commit") state.committed = true;
      return { rows: [] };
    },
    release() {
      events.push({ kind: "release" }); state.released++;
      if (options.releaseError) throw options.releaseError;
    },
  };
  const pool = { async connect() {
    state.connected++;
    if (options.connectError) throw options.connectError;
    return client;
  } };
  return { client, pool, events, state, rows };
}

// The factory receives the real editor calculations and final validator. Only
// the small keyed-lookup/load seams are supplied here; no field rules are mocked.
function persistence(loadCalls = []) {
  const valueKey = row => `${row.entity_id || "root"}:${row.field_context}:${row.uad_uid}`;
  return createUadSectionPersistence({
    loadValues: async (client, workfileId, suffix = "") => {
      loadCalls.push({ client, workfileId, suffix });
      return (await client.query(`SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1
        ORDER BY created_at, id ${suffix}`, [workfileId])).rows;
    },
    calculatedSalesComparisonFields: () => UAD_PHASE_ONE_FIELDS.filter(field => field.section === "sales_comparison" && field.calculated === true),
    valueLookup: (values, entityId = null) => key => values.get(`${entityId || "root"}:${key}`) ?? values.get(`root:${key}`),
    valuesMap: values => new Map(values.map(row => [valueKey(row), row.value])),
    calculateSalesComparisonSummaryValues, calculateReconciliationRepairTotal, calculateCertificationSystemValues,
    validateCompleteSection, valueKey,
    fieldValueKey: (field, entityId = null) => `${entityId || "root"}:${field.key}`,
  });
}
const persistenceInput = (input = autosave([boundary("New boundary")]), extras = {}) => ({
  workfileId: WORKFILE, expectedRevision: 7, saveReason: "autosave", allowIncomplete: true,
  section: "market", input, actorUserId: ACTOR, trustedSource: {}, ...extras,
});

test("public autosave preserves request normalization, response shape, one revision and actor audit", async () => {
  const db = database();
  const input = { expected_revision: "7", save_reason: " autosave ", values: [boundary("  North Road boundary  "),
    { context_key: "market", uid: "3000.0009", value: "12" }] };
  const before = clone(input);
  const result = await saveUadSection(db.pool, ` ${WORKFILE} `, "market", input, ACTOR);
  assert.deepEqual(Object.keys(result).sort(), ["changed_field_count", "completion", "current_revision",
    "save_reason", "saved_field_count", "section", "values"]);
  assert.equal(result.current_revision, 8);
  assert.equal(result.save_reason, "autosave");
  assert.equal(result.saved_field_count, 2);
  assert.equal(result.changed_field_count, 2);
  assert.deepEqual(result.values.map(row => row.value), ["North Road boundary", 12]);
  assert.ok(result.values.every(row => row.source_type === "appraiser" && row.source_reference === "uad_workspace.autosave"));
  assert.ok(result.values.every(row => row.is_appraiser_confirmed && !row.is_override && row.entity_id === null));
  assert.equal(typeof result.completion.market.percent, "number");
  assert.deepEqual(statements(db).slice(0, 3), ["begin", "lock", "signatures"]);
  assert.deepEqual(statements(db).slice(-2), ["commit", "release"]);
  assert.equal(event(db, "lock").params[0], WORKFILE);
  const revision = event(db, "insert_revision").params;
  assert.equal(revision[2], 8); assert.equal(revision[3], "fixture-release");
  assert.equal(revision[5], "Autosaved market draft"); assert.equal(revision[6], ACTOR);
  const document = JSON.parse(revision[4]);
  assert.deepEqual(Object.keys(document).sort(), ["entities", "field_values"]);
  assert.deepEqual(Object.keys(document.field_values[0]).sort(), ["context_key", "entity_id", "is_appraiser_confirmed",
    "report_field_id", "source_type", "uid", "value"]);
  const audit = event(db, "insert_audit").params;
  assert.equal(audit[5], ACTOR);
  assert.deepEqual(JSON.parse(audit[4]), { revision_number: 8, submitted_field_count: 2,
    changed_field_count: 2, save_reason: "autosave" });
  assert.ok(JSON.parse(audit[2]).every(row => row.value === null));
  assert.deepEqual(JSON.parse(audit[3]).map(row => row.value), ["North Road boundary", 12]);
  assert.deepEqual(input, before);
});

test("complete manual save retains full validation, defaults, summary and completion", async () => {
  const db = database();
  const result = await saveUadSection(db.pool, WORKFILE, "highest_best_use", { expected_revision: 7, values: highestBestUse() }, ACTOR);
  assert.equal(result.save_reason, "manual_save");
  assert.equal(result.saved_field_count, 5); assert.equal(result.changed_field_count, 5);
  assert.equal(result.completion.highest_best_use.percent, 100);
  assert.ok(result.values.every(row => row.value === true && row.source_reference === "uad_workspace.section_save"));
  assert.equal(event(db, "insert_revision").params[5], "Saved highest_best_use information");
  assert.deepEqual(statements(db).slice(-2), ["commit", "release"]);
});

test("incomplete manual save rejects while the identical bounded autosave remains permitted", async () => {
  const manual = database();
  await assert.rejects(() => saveUadSection(manual.pool, WORKFILE, "highest_best_use", {
    expected_revision: 7, values: highestBestUse().slice(0, 1),
  }), error => error.message === "invalid_uad_field_values" && error.details.some(item => item.code === "required"));
  assert.deepEqual(changes(manual), []);
  assert.deepEqual(statements(manual).slice(-2), ["rollback", "release"]);
  const draft = database();
  const result = await saveUadSection(draft.pool, WORKFILE, "highest_best_use", autosave(highestBestUse().slice(0, 1)));
  assert.equal(result.changed_field_count, 1);
});

test("empty and already-confirmed autosaves commit with no synthetic revision, audit or provenance rewrite", async () => {
  for (const values of [[], [boundary("  Saved boundary  ")]]) {
    const db = database({ rows: [savedBoundary()] });
    const result = await saveUadSection(db.pool, WORKFILE, "market", autosave(values), ACTOR,
      { sourceType: "document", sourceReference: "different-source" });
    assert.equal(result.current_revision, 7);
    assert.equal(result.changed_field_count, 0);
    assert.equal(result.saved_field_count, values.length);
    assert.equal(result.values[0].source_type, "homenode");
    assert.equal(result.values[0].source_reference, "fixture:original");
    assert.deepEqual(changes(db), []);
    assert.equal(statements(db).includes("load_latest"), false);
    assert.deepEqual(statements(db).slice(-2), ["commit", "release"]);
  }
});

test("empty and unchanged saves still reject an invalid trusted source before commit in both entry points", async () => {
  for (const values of [[], [boundary("Saved boundary")]]) for (const wrapped of [false, true]) {
    const db = database({ rows: [savedBoundary()] });
    const input = autosave(values);
    const trustedSource = { sourceType: "not-an-approved-source" };
    const invoke = wrapped
      ? () => saveUadSection(db.pool, WORKFILE, "market", input, ACTOR, trustedSource)
      : () => persistence()(db.client, persistenceInput(input, { trustedSource }));
    await assert.rejects(invoke, { message: "invalid_uad_trusted_source_type" });
    assert.deepEqual(changes(db), []);
    assert.equal(statements(db).includes("commit"), false);
    assert.equal(db.rows[0].source_reference, "fixture:original");
    assert.deepEqual(statements(db).filter(kind => ["begin", "commit", "rollback", "release"].includes(kind)),
      wrapped ? ["begin", "rollback", "release"] : []);
  }
});

test("confirming unchanged imported data counts as a change but preserves original source", async () => {
  const db = database({ rows: [savedBoundary({ is_appraiser_confirmed: false })] });
  const result = await saveUadSection(db.pool, WORKFILE, "market", autosave([boundary("Saved boundary")]), ACTOR);
  assert.equal(result.changed_field_count, 1); assert.equal(result.current_revision, 8);
  const update = event(db, "update_field").params;
  assert.equal(update[3], "homenode"); assert.equal(update[4], "fixture:original");
  assert.equal(update[5], false); assert.equal(update[7], ACTOR);
  const audit = event(db, "insert_audit").params;
  assert.equal(JSON.parse(audit[2])[0].value, JSON.parse(audit[3])[0].value);
});

test("the moved JSON equality retains its existing object-key-order-sensitive no-op behavior", async () => {
  const field = getUadField("site", "1500.0093");
  for (const [value, changed] of [[{ amount: 1000, unit: "SquareFeet" }, 0], [{ unit: "SquareFeet", amount: 1000 }, 1]]) {
    const db = database({ rows: [savedBoundary({ field_context: field.contextKey, uad_uid: field.uid,
      report_field_id: field.reportFieldId, value, source_type: "public_record" })] });
    const result = await saveUadSection(db.pool, WORKFILE, "site", autosave([
      { context_key: field.contextKey, uid: field.uid, value: { unit: "SquareFeet", amount: 1000 } },
    ]));
    assert.equal(result.changed_field_count, changed);
    assert.equal(result.current_revision, 7 + changed);
    assert.equal(result.values[0].source_type, changed ? "appraiser" : "public_record");
    assert.equal(result.values[0].is_override, Boolean(changed));
    assert.equal(db.events.filter(item => item.kind === "update_field").length, changed);
  }
});

test("document replacement keeps bounded trusted provenance and override metadata separate from browser claims", async () => {
  const db = database({ rows: [savedBoundary()] });
  const trustedSource = { sourceType: " document ", sourceReference: ` ${"r".repeat(1100)} `,
    changeSummary: ` ${"s".repeat(600)} ` };
  const input = autosave([{ ...boundary("Document boundary"), source_type: "mls", source_reference: "untrusted" }]);
  const before = clone({ input, trustedSource });
  const result = await saveUadSection(db.pool, WORKFILE, "market", input, ACTOR, trustedSource);
  const row = result.values[0];
  assert.equal(row.source_type, "document"); assert.equal(row.source_reference, "r".repeat(1000));
  assert.equal(row.is_override, true);
  assert.equal(row.override_reason, "Appraiser-confirmed document evidence replaced the prior value.");
  assert.equal(event(db, "insert_revision").params[5], "s".repeat(500));
  assert.deepEqual(JSON.parse(event(db, "insert_audit").params[4]), { revision_number: 8,
    submitted_field_count: 1, changed_field_count: 1, save_reason: "autosave",
    source_type: "document", source_reference: "r".repeat(1000) });
  assert.deepEqual({ input, trustedSource }, before);
  const browserOnly = database();
  const fallback = await saveUadSection(browserOnly.pool, WORKFILE, "market", input);
  assert.equal(fallback.values[0].source_type, "appraiser");
  assert.equal(fallback.values[0].source_reference, "uad_workspace.autosave");
  assert.equal(event(browserOnly, "insert_audit").params[5], null);
});

test("caller-client helper returns raw persistence data and never owns transaction or release", async () => {
  const db = database();
  const calls = [];
  await db.client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  const offset = db.events.length;
  const input = persistenceInput();
  const before = clone(input);
  const result = await persistence(calls)(db.client, input);
  assert.deepEqual(Object.keys(result).sort(), ["assets", "changedCount", "currentRevision", "entities",
    "normalizedCount", "rows", "saveReason", "section"]);
  assert.equal(result.changedCount, 1); assert.equal(result.currentRevision, 8);
  assert.equal(result.rows[0].uad_uid, "3000.0008");
  assert.equal(Object.hasOwn(result.rows[0], "uid"), false);
  assert.deepEqual(calls.map(call => [call.client === db.client, call.workfileId, call.suffix]),
    [[true, WORKFILE, "FOR UPDATE"], [true, WORKFILE, ""]]);
  assert.equal(db.events.slice(offset).some(item => ["begin", "commit", "rollback", "release"].includes(item.kind)), false);
  assert.equal(db.state.connected, 0); assert.equal(db.state.released, 0); assert.equal(db.state.committed, false);
  assert.deepEqual(input, before);
  await db.client.query("COMMIT"); db.client.release();
  assert.equal(db.state.committed, true);
});

test("caller-client no-op and failure both leave transaction lifecycle to their owner", async () => {
  const noop = database({ rows: [savedBoundary()] });
  const result = await persistence()(noop.client, persistenceInput(autosave([boundary("Saved boundary")])));
  assert.equal(result.currentRevision, 7); assert.equal(result.changedCount, 0); assert.equal(result.normalizedCount, 1);
  assert.deepEqual(changes(noop), []);
  for (const failureAt of ["lock", "signatures", "load_locked", "insert_field", "load_latest", "update_workfile", "insert_revision", "insert_audit"]) {
    const failure = new Error(`fixture:${failureAt}`);
    const db = database({ failures: { [failureAt]: failure } });
    await assert.rejects(() => persistence()(db.client, persistenceInput()), error => error === failure);
    assert.equal(statements(db).some(kind => ["begin", "commit", "rollback", "release"].includes(kind)), false);
    assert.equal(db.state.released, 0);
  }
  assert.equal(statements(noop).some(kind => ["begin", "commit", "rollback", "release"].includes(kind)), false);
});

test("missing, signed, signature-unknown and stale workfiles reject before field reads in both entry points", async () => {
  for (const [options, revision, message] of [
    [{ missing: true }, 7, "uad_workfile_not_found"],
    [{ workfile: { status: "signed" } }, 7, "uad_workfile_status_locked"],
    [{ workfile: { signed_at: "2026-09-01T00:00:00.000Z" } }, 7, "uad_workfile_status_locked"],
    [{ workfile: { status: "ready" }, signatureRows: [{ has_signatures: true }] }, 7, "uad_workfile_status_locked"],
    [{ signatureRows: [] }, 7, "uad_workfile_status_locked"],
    [{ signatureRows: [{ has_signatures: "false" }] }, 7, "uad_workfile_status_locked"],
    [{}, 6, "uad_section_stale_revision"],
  ]) for (const wrapped of [false, true]) {
    const db = database(options);
    const invoke = wrapped
      ? () => saveUadSection(db.pool, WORKFILE, "market", { ...autosave([]), expected_revision: revision })
      : () => persistence()(db.client, persistenceInput(autosave([]), { expectedRevision: revision }));
    await assert.rejects(invoke, error => error.message === message &&
      (message !== "uad_section_stale_revision" || error.details.current_revision === 7));
    assert.equal(statements(db).includes("load_locked"), false);
    assert.deepEqual(changes(db), []);
    assert.deepEqual(statements(db).filter(kind => ["begin", "commit", "rollback", "release"].includes(kind)),
      wrapped ? ["begin", "rollback", "release"] : []);
  }
});

test("normalization failures happen before acquiring a connection", async () => {
  for (const [workfile, input, message] of [
    ["bad-id", autosave([]), "invalid_uad_workfile_id"],
    [WORKFILE, { values: [] }, "invalid_uad_expected_revision"],
    [WORKFILE, { ...autosave([]), save_reason: "background" }, "invalid_uad_save_reason"],
  ]) {
    const db = database();
    await assert.rejects(() => saveUadSection(db.pool, workfile, "market", input), { message });
    assert.equal(db.state.connected, 0); assert.deepEqual(db.events, []);
  }
});

test("catalog and trusted-source failures remain concrete and precede any canonical writes", async () => {
  for (const [values, source, message] of [
    [[{ context_key: "market", uid: "3000.0009", value: "not-a-number" }], {}, "invalid_uad_field_values"],
    [[boundary("A boundary")], { sourceType: "browser-asserted" }, "invalid_uad_trusted_source_type"],
  ]) {
    const db = database();
    await assert.rejects(() => saveUadSection(db.pool, WORKFILE, "market", autosave(values), ACTOR, source), { message });
    assert.deepEqual(changes(db), []);
    assert.deepEqual(statements(db).slice(-2), ["rollback", "release"]);
  }
});

test("public DB failures retain their original error, rollback once and release once", async () => {
  for (const failureAt of ["begin", "lock", "signatures", "load_locked", "entities", "assets", "insert_field",
    "load_latest", "update_workfile", "insert_revision", "insert_audit", "commit"]) {
    const failure = new Error(`fixture:${failureAt}`);
    const db = database({ failures: { [failureAt]: failure } });
    await assert.rejects(() => saveUadSection(db.pool, WORKFILE, "market", autosave([boundary("New boundary")])), error => error === failure);
    assert.equal(db.events.filter(item => item.kind === "rollback").length, 1);
    assert.equal(db.state.released, 1);
    assert.equal(db.state.committed, false);
    assert.deepEqual(statements(db).slice(-2), ["rollback", "release"]);
  }
});

test("failed rollback is swallowed without replacing the original write or commit error", async () => {
  for (const failureAt of ["insert_audit", "commit"]) {
    const primary = new Error(`primary:${failureAt}`);
    const db = database({ failures: { [failureAt]: primary, rollback: new Error("rollback-failed") } });
    await assert.rejects(() => saveUadSection(db.pool, WORKFILE, "market", autosave([boundary("New boundary")])), error => error === primary);
    assert.equal(db.state.released, 1);
    assert.deepEqual(statements(db).slice(-2), ["rollback", "release"]);
  }
});

test("update failures roll back and an exceptional release preserves the original finally error precedence", async () => {
  for (const releaseFails of [false, true]) {
    const primary = new Error("update-failed");
    const finalizer = new Error("release-failed-after-update-failure");
    const db = database({ rows: [savedBoundary()], failures: { update_field: primary },
      releaseError: releaseFails ? finalizer : undefined });
    await assert.rejects(() => saveUadSection(db.pool, WORKFILE, "market", autosave([boundary("Changed boundary")])),
      error => error === (releaseFails ? finalizer : primary));
    assert.deepEqual(statements(db).slice(-3), ["update_field", "rollback", "release"]);
    assert.equal(db.state.released, 1); assert.equal(db.state.committed, false);
    assert.equal(db.rows[0].value, "Saved boundary");
  }
});

test("connection failure never tries rollback or release on an unavailable client", async () => {
  const failure = new Error("connect-failed");
  const db = database({ connectError: failure });
  await assert.rejects(() => saveUadSection(db.pool, WORKFILE, "market", autosave([])), error => error === failure);
  assert.equal(db.state.connected, 1); assert.equal(db.state.released, 0); assert.deepEqual(db.events, []);
});

test("release exceptions retain the existing finally semantics after successful commit", async () => {
  const failure = new Error("release-failed");
  const db = database({ releaseError: failure });
  await assert.rejects(() => saveUadSection(db.pool, WORKFILE, "market", autosave([])), error => error === failure);
  assert.equal(db.state.committed, true); assert.equal(db.state.released, 1);
  assert.deepEqual(statements(db).slice(-2), ["commit", "release"]);
  assert.equal(statements(db).includes("rollback"), false);
});

test("response formatting still occurs after commit, including no-op saves, and retains catch/finally behavior", async () => {
  for (const values of [[], [boundary("Changed boundary")]]) {
    const failure = new Error("after-commit-formatter-failed");
    const db = database({ rows: [savedBoundary()], formatterError: failure,
      failures: { rollback: new Error("cannot-rollback-an-already-committed-save") } });
    await assert.rejects(() => saveUadSection(db.pool, WORKFILE, "market", autosave(values)), error => error === failure);
    assert.equal(db.state.committed, true);
    assert.equal(db.state.released, 1);
    assert.deepEqual(statements(db).slice(-3), ["commit", "rollback", "release"]);
    assert.equal(db.events.filter(item => item.kind === "insert_revision").length, values.length ? 1 : 0);
    assert.equal(db.rows[0].value, values.length ? "Changed boundary" : "Saved boundary");
  }
});
