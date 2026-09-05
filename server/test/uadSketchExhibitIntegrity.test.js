import assert from "node:assert/strict";
import test from "node:test";

import { editUadSketch } from "../src/modules/uad/mobileEvidence.js";
import { normalizeManualSketchDocument } from "../src/modules/mobile/sketches.js";
import { renderSketchPng } from "../src/modules/mobile/sketchPng.js";
import { inspectUadAssetPayload } from "../src/modules/uad/uadFileSecurity.js";

// This suite is deliberately synthetic. Never inherit a configured database or
// silently turn these service-level regressions into a native/live integration.
if (Object.hasOwn(process.env, "DATABASE_URL")) {
  throw new Error("uad_sketch_exhibit_test_database_environment_forbidden");
}

const WORKFILE_ID = "00000000-0000-4000-8000-000000000201";
const SKETCH_ID = "00000000-0000-4000-8000-000000000202";
const ORIGINAL_ASSET_ID = "00000000-0000-4000-8000-000000000203";
const SHARED_ASSET_ID = "00000000-0000-4000-8000-000000000204";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000205";
const ACTOR_ID = "00000000-0000-4000-8000-000000000206";
const REPORT_FILE_ID = "00000000-0000-4000-8000-000000000207";
const FILE_NUMBER = "SYNTHETIC-SKETCH-EXHIBIT";
const STAMP = "2026-09-05T12:00:00.000Z";
const PROVENANCE = `${SKETCH_ID}:2`;
const CAPTION = "Synthetic edited sketch";
const clone = value => structuredClone(value);

function sketchInput() {
  return {
    measurement_standard: "ansi_z765_2021", measurement_method: "exterior", review_status: "draft",
    areas: [{
      id: "00000000-0000-4000-8000-000000000208", label: "Synthetic Main Level",
      level_label: "Level 1", classification: "above_grade_finished", position: 1,
      vertices: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }, { x: 0, y: 0 }],
    }],
    rooms: [],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function renderMetadata() {
  return {
    source: "homenode_web_sketch_editor", source_uad_sketch_id: SKETCH_ID,
    source_uad_sketch_revision: 1, uad_sketch_editor_revision: PROVENANCE,
    retained_source_asset_id: ORIGINAL_ASSET_ID,
  };
}

function assetRow(id, { status = "verified", generated = false } = {}) {
  return {
    id, workfile_id: WORKFILE_ID, entity_id: null, asset_kind: "sketch", section_number: 7,
    caption_type: "SubjectPropertyImprovementSketch", caption: generated ? CAPTION : "Original synthetic sketch",
    storage_provider: "r2", storage_bucket: "synthetic-only",
    object_key: `synthetic/${WORKFILE_ID}/${id}/staging.png`,
    original_file_name: generated ? `${FILE_NUMBER}-sketch-r2.png` : "original-synthetic-sketch.png",
    content_type: "image/png", byte_size: null, checksum_sha256: null, status,
    capture_metadata: generated ? renderMetadata() : {},
    created_by_user_id: null, created_at: STAMP, updated_at: STAMP,
    uploaded_at: null, verified_at: status === "verified" ? STAMP : null,
  };
}

// The mock boundary is the existing pool/client and object-storage interfaces.
// Real editUadSketch, saveUadSketch, document normalization, PNG rendering,
// applicability, payload verification and immutable-key construction all run.
// These SQL doubles model only the statements this workflow executes; they are
// not evidence of native PostgreSQL locking or an actual signing transaction.
function harness({ existingRender = null, onConnect = null, lockError = null,
  onVerificationRead = null, onVerificationPublished = null, cleanupCommitError = null } = {}) {
  const document = normalizeManualSketchDocument(sketchInput());
  const originalBody = renderSketchPng({ document, revision: 1 }, { fileNumber: FILE_NUMBER, revision: 1 });
  const renderBody = renderSketchPng({ document, revision: 2 }, { fileNumber: FILE_NUMBER, revision: 2 });
  const state = {
    workfile: { id: WORKFILE_ID, organization_id: ORGANIZATION_ID, status: "ready", signed_at: null,
      current_revision: 4, updated_at: STAMP },
    signatures: [],
    sketch: { id: SKETCH_ID, workfile_id: WORKFILE_ID, entity_id: null, schema_version: "2.1",
      geometry: document, measurements: { standard: document.measurement_standard, method: document.measurement_method, rooms: [] },
      calculated_areas: document.summary, area_overrides: { retained: true }, rendered_asset_id: ORIGINAL_ASSET_ID,
      source: "mobile", revision: 1, created_at: STAMP, updated_at: STAMP },
    assets: new Map(), objects: new Map(), calls: [], storageCalls: [],
    history: [], sketchAudits: [], importAudits: [], clients: [], createdAssetIds: [], harnessErrors: [],
    validationRuns: [], generatedArtifacts: [],
  };
  const original = assetRow(ORIGINAL_ASSET_ID);
  original.byte_size = originalBody.length;
  original.checksum_sha256 = inspectUadAssetPayload(originalBody, "image/png").checksum_sha256;
  state.assets.set(original.id, original);
  state.objects.set(original.object_key, originalBody);
  if (existingRender) {
    const shared = assetRow(SHARED_ASSET_ID, { status: existingRender, generated: true });
    if (existingRender === "verified") {
      const inspection = inspectUadAssetPayload(renderBody, "image/png");
      shared.byte_size = inspection.byte_size;
      shared.checksum_sha256 = inspection.checksum_sha256;
      shared.object_key = `synthetic/${WORKFILE_ID}/${SHARED_ASSET_ID}/verified.png`;
    }
    state.assets.set(shared.id, shared);
    state.objects.set(shared.object_key, renderBody);
  }
  const record = (label, kind, sql, parameters, client = null) => {
    state.calls.push({ label, kind, sql, parameters: clone(parameters), client: client?.name || null });
  };
  const executeQuery = async (label, statement, parameters = [], client = null) => {
    assert.equal(typeof statement, "string");
    const sql = statement.replace(/\s+/g, " ").trim();
    const log = kind => record(label, kind, sql, parameters, client);
    if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED") {
      assert.ok(client, "canonical transaction must use the acquired client");
      assert.equal(client.transaction, null);
      log("begin");
      client.transaction = clone({ workfile: state.workfile, sketch: state.sketch,
        assets: state.assets, history: state.history, sketchAudits: state.sketchAudits });
      return { rows: [] };
    }
    if (sql === "SET LOCAL lock_timeout = '500ms'") {
      assert.ok(client?.transaction); assert.deepEqual(parameters, []);
      assert.equal(client.cleanup, false);
      client.cleanup = true; log("cleanup_lock_timeout");
      return { rows: [] };
    }
    if (sql === "SET LOCAL statement_timeout = '2000ms'") {
      assert.ok(client?.transaction); assert.deepEqual(parameters, []);
      assert.equal(client.cleanup, true);
      assert.equal(state.calls.at(-1).kind, "cleanup_lock_timeout");
      log("cleanup_statement_timeout");
      return { rows: [] };
    }
    if (sql === "COMMIT") {
      assert.ok(client?.transaction); log("commit");
      if (client.cleanup && cleanupCommitError) throw cleanupCommitError;
      client.transaction = null;
      return { rows: [] };
    }
    if (sql === "ROLLBACK") {
      assert.ok(client); log("rollback");
      if (client.transaction) Object.assign(state, client.transaction);
      client.transaction = null;
      return { rows: [] };
    }
    if (sql.startsWith("SELECT report_file.*")) {
      log("report_file"); assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: [{ id: REPORT_FILE_ID, uad_workfile_id: WORKFILE_ID, file_number: FILE_NUMBER }] };
    }
    if (sql.startsWith("SELECT sketch.*, asset.caption_type")) {
      log("editor_sketch"); assert.deepEqual(parameters, [SKETCH_ID, WORKFILE_ID]);
      const prior = state.assets.get(state.sketch.rendered_asset_id);
      return { rows: [{ ...clone(state.sketch), caption_type: prior.caption_type,
        caption: prior.caption, prior_asset_id: prior.id }] };
    }
    if (sql.startsWith("SELECT * FROM appraisal.uad_assets") && sql.includes("capture_metadata ->> $2 = $3")) {
      log("existing_import");
      assert.deepEqual(parameters, [WORKFILE_ID, "uad_sketch_editor_revision", PROVENANCE]);
      const asset = [...state.assets.values()].find(row => row.status !== "deleted"
        && row.capture_metadata.uad_sketch_editor_revision === PROVENANCE);
      return { rows: asset ? [clone(asset)] : [] };
    }
    if (sql.startsWith("SELECT id, organization_id, status FROM appraisal.uad_workfiles")) {
      log("asset_workfile"); assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: [clone(state.workfile)] };
    }
    if (sql.startsWith("SELECT uad_uid, value FROM appraisal.uad_field_values")) {
      log("applicability"); assert.deepEqual(parameters, [WORKFILE_ID, ["3300.0002"]]);
      return { rows: [{ uad_uid: "3300.0002", value: true }] };
    }
    if (sql.startsWith("WITH mutable_workfile") && sql.includes("inserted_asset AS")) {
      log("create_asset"); assert.equal(parameters[1], WORKFILE_ID);
      const row = assetRow(parameters[0], { status: "pending_upload", generated: true });
      Object.assign(row, { entity_id: parameters[2], asset_kind: parameters[3], section_number: parameters[4],
        caption_type: parameters[5], caption: parameters[6], storage_provider: parameters[7], storage_bucket: parameters[8],
        object_key: parameters[9], original_file_name: parameters[10], content_type: parameters[11],
        capture_metadata: JSON.parse(parameters[12]), upload_expires_at: parameters[13] });
      state.assets.set(row.id, row); state.createdAssetIds.push(row.id);
      state.workfile.status = "draft";
      return { rows: [{ id: row.id }] };
    }
    if (sql.startsWith("SELECT asset.id, asset.object_key")) {
      log("verification_read"); assert.equal(parameters[1], WORKFILE_ID);
      const asset = state.assets.get(parameters[0]);
      assert.ok(asset);
      const rows = ["pending_upload", "uploaded"].includes(asset.status)
        ? [{ ...clone(asset), organization_id: ORGANIZATION_ID, workfile_status: state.workfile.status }]
        : [];
      // Preserve the selected row snapshot before admitting either concurrent
      // verifier. Both real service calls can therefore observe pending state.
      await onVerificationRead?.(label, state);
      return { rows };
    }
    if (sql.startsWith("WITH mutable_workfile") && sql.includes("updated_asset AS")) {
      log("verify_asset"); assert.equal(parameters[1], WORKFILE_ID);
      const row = state.assets.get(parameters[0]);
      assert.ok(row);
      Object.assign(row, { status: "verified", byte_size: parameters[2], checksum_sha256: parameters[4],
        object_key: parameters[5], uploaded_at: STAMP, verified_at: STAMP, updated_at: STAMP,
        capture_metadata: { ...row.capture_metadata, storage_etag: parameters[3],
          verified_dimensions: JSON.parse(parameters[6]), verified_object_immutable: true } });
      state.workfile.status = "draft";
      const rows = [clone(row)];
      await onVerificationPublished?.(label, state);
      return { rows };
    }
    if (sql.startsWith("WITH import_lock AS MATERIALIZED")) {
      log("import_audit"); assert.equal(parameters[1], WORKFILE_ID);
      const asset = state.assets.get(parameters[0]); assert.ok(asset);
      if (asset.created_by_user_id === null) asset.created_by_user_id = parameters[2];
      if (!state.importAudits.some(row => row.assetId === asset.id)) {
        state.importAudits.push({ assetId: asset.id, actor: parameters[2], event: parameters[3], after: JSON.parse(parameters[4]) });
      }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT id, status, signed_at FROM appraisal.uad_workfiles")) {
      assert.ok(client?.transaction);
      if (client.cleanup) assert.equal(state.calls.at(-1).kind, "cleanup_statement_timeout");
      log(client.cleanup ? "cleanup_workfile_lock" : "canonical_lock");
      assert.deepEqual(parameters, [WORKFILE_ID]);
      assert.equal(sql, "SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE");
      if (!client.cleanup && lockError) throw lockError;
      return { rows: [clone(state.workfile)] };
    }
    if (sql.startsWith("SELECT EXISTS")) {
      log("signatures"); assert.ok(client?.transaction);
      assert.deepEqual(parameters, [WORKFILE_ID]);
      assert.match(sql, /FROM appraisal.uad_signatures WHERE workfile_id = \$1/);
      assert.doesNotMatch(sql, /revision_number/);
      return { rows: [{ has_signatures: state.signatures.length > 0 }] };
    }
    if (sql === "SELECT id, workfile_id, status, section_number, capture_metadata, verified_at FROM appraisal.uad_assets WHERE id = $1 AND workfile_id = $2 FOR UPDATE") {
      assert.ok(client?.transaction); assert.equal(client.cleanup, true);
      assert.equal(state.calls.at(-1).kind, "signatures");
      log("cleanup_asset_lock");
      assert.equal(parameters.length, 2); assert.equal(parameters[1], WORKFILE_ID);
      const asset = state.assets.get(parameters[0]);
      return { rows: asset?.workfile_id === WORKFILE_ID ? [clone(asset)] : [] };
    }
    if (sql === "SELECT ( EXISTS (SELECT 1 FROM appraisal.uad_sketches WHERE rendered_asset_id = $1) OR EXISTS (SELECT 1 FROM appraisal.uad_sketch_history WHERE rendered_asset_id = $1) OR EXISTS (SELECT 1 FROM appraisal.uad_signatures WHERE signature_asset_id = $1) OR EXISTS (SELECT 1 FROM appraisal.uad_validation_runs WHERE workfile_id = $2) OR EXISTS (SELECT 1 FROM appraisal.uad_generated_artifacts WHERE workfile_id = $2) ) AS has_observers") {
      assert.ok(client?.transaction); assert.equal(client.cleanup, true);
      assert.equal(state.calls.at(-1).kind, "cleanup_asset_lock");
      assert.deepEqual(parameters, state.calls.at(-1).parameters);
      log("cleanup_observers");
      const assetId = parameters[0];
      const hasObservers = state.sketch.rendered_asset_id === assetId
        || state.history.some(row => row.rendered_asset_id === assetId)
        || state.signatures.some(row => row.signature_asset_id === assetId)
        || state.validationRuns.length > 0 || state.generatedArtifacts.length > 0;
      return { rows: [{ has_observers: hasObservers }] };
    }
    if (sql.startsWith("SELECT id FROM appraisal.uad_assets")) {
      log("canonical_asset"); assert.ok(client?.transaction);
      assert.equal(parameters[1], WORKFILE_ID);
      const asset = state.assets.get(parameters[0]);
      return { rows: asset?.status === "verified" ? [{ id: asset.id }] : [] };
    }
    if (sql.startsWith("SELECT * FROM appraisal.uad_sketches") && sql.endsWith("FOR UPDATE")) {
      log("canonical_sketch"); assert.ok(client?.transaction);
      assert.deepEqual(parameters, [WORKFILE_ID, null]);
      return { rows: [clone(state.sketch)] };
    }
    if (sql.startsWith("UPDATE appraisal.uad_sketches SET schema_version")) {
      log("save_sketch"); assert.ok(client?.transaction);
      assert.deepEqual(parameters.slice(0, 3), [SKETCH_ID, WORKFILE_ID, null]);
      Object.assign(state.sketch, { schema_version: parameters[3], geometry: JSON.parse(parameters[4]),
        measurements: JSON.parse(parameters[5]), calculated_areas: JSON.parse(parameters[6]),
        area_overrides: JSON.parse(parameters[7]), rendered_asset_id: parameters[8], source: parameters[9],
        updated_by_user_id: parameters[10], revision: parameters[11], updated_at: STAMP });
      return { rows: [clone(state.sketch)] };
    }
    if (sql.startsWith("UPDATE appraisal.uad_workfiles SET status = 'draft'")) {
      log("touch_workfile"); assert.ok(client?.transaction); assert.deepEqual(parameters, [WORKFILE_ID]);
      state.workfile.status = "draft"; return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO appraisal.uad_sketch_history")) {
      log("sketch_history"); assert.ok(client?.transaction);
      assert.deepEqual(parameters.slice(0, 3), [SKETCH_ID, WORKFILE_ID, 2]);
      state.history.push({ sketch_id: parameters[0], revision: parameters[2], rendered_asset_id: parameters[7] });
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO appraisal.uad_audit_events") && sql.includes("'uad_sketch.saved'")) {
      log("sketch_audit"); assert.ok(client?.transaction);
      assert.deepEqual(parameters.slice(0, 2), [WORKFILE_ID, SKETCH_ID]);
      state.sketchAudits.push({ before: JSON.parse(parameters[2]), after: JSON.parse(parameters[3]),
        metadata: JSON.parse(parameters[4]), actor: parameters[5] });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE appraisal.uad_assets") && sql.includes('"orphaned_editor_render":true')) {
      assert.ok(client?.transaction); assert.equal(client.cleanup, true);
      assert.equal(sql, "UPDATE appraisal.uad_assets SET status = 'deleted', updated_at = now(), capture_metadata = capture_metadata || '{\"orphaned_editor_render\":true}'::jsonb WHERE id = $1 AND workfile_id = $2 AND status = 'verified' RETURNING id");
      assert.equal(state.calls.at(-1).kind, "cleanup_observers");
      assert.deepEqual(parameters, state.calls.at(-1).parameters);
      log("orphan_compensation");
      const asset = state.assets.get(parameters[0]); assert.ok(asset);
      assert.equal(asset.status, "verified");
      asset.status = "deleted";
      asset.capture_metadata.orphaned_editor_render = true;
      return { rows: [{ id: asset.id }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE appraisal.uad_assets") && sql.includes("capture_metadata = capture_metadata || $3::jsonb")) {
      log("supersede_prior"); assert.deepEqual(parameters.slice(0, 2), [ORIGINAL_ASSET_ID, WORKFILE_ID]);
      const asset = state.assets.get(parameters[0]); assert.ok(asset);
      if (asset.status === "verified") {
        asset.status = "deleted"; Object.assign(asset.capture_metadata, JSON.parse(parameters[2]));
      }
      return { rows: [] };
    }
    if (sql.startsWith("SELECT * FROM appraisal.uad_assets") && sql.includes("status <> 'deleted'")) {
      log("list_assets"); assert.deepEqual(parameters, [WORKFILE_ID]);
      return { rows: [...state.assets.values()].filter(row => row.status !== "deleted").map(clone) };
    }
    if (sql.startsWith("SELECT * FROM appraisal.uad_sketches")) {
      log("list_sketches"); assert.deepEqual(parameters, [WORKFILE_ID]); return { rows: [clone(state.sketch)] };
    }
    assert.fail(`Unexpected synthetic exhibit query: ${sql}`);
  };
  const query = async (...args) => {
    try { return await executeQuery(...args); } catch (error) {
      // Production compensation deliberately swallows cleanup errors. Record
      // mock-contract failures independently so that swallowing an unexpected
      // query can never make a future implementation appear to pass this suite.
      if (error?.code === "ERR_ASSERTION") state.harnessErrors.push(error.message);
      throw error;
    }
  };
  const pool = label => ({
    query: (sql, parameters) => query(label, sql, parameters),
    async connect() {
      record(label, "connect", "", []);
      await onConnect?.(label, state);
      const client = { name: `${label}-${state.clients.length + 1}`, transaction: null, released: false, cleanup: false,
        query: (sql, parameters) => query(label, sql, parameters, client),
        release() { assert.equal(client.released, false); client.released = true; record(label, "release", "", [], client); },
      };
      state.clients.push(client); return client;
    },
  });
  const storage = label => ({
    configured: true, provider: "r2", bucket: "synthetic-only",
    createUploadUrl({ objectKey, contentType }) {
      state.storageCalls.push({ label, kind: "upload_url", objectKey, contentType });
      return { url: "https://unused-synthetic.invalid/upload", method: "PUT", headers: {}, expires_in_seconds: 900 };
    },
    async putObject({ objectKey, contentType, body }) {
      assert.equal(contentType, "image/png"); assert.ok(Buffer.isBuffer(body));
      // Actual bytes from the real renderer must satisfy the real verifier.
      const inspected = inspectUadAssetPayload(body, contentType);
      state.storageCalls.push({ label, kind: "put", objectKey, checksum: inspected.checksum_sha256 });
      state.objects.set(objectKey, Buffer.from(body));
      return { byte_size: body.length, content_type: contentType, etag: "synthetic-etag" };
    },
    async inspectObject({ objectKey }) {
      state.storageCalls.push({ label, kind: "inspect", objectKey });
      const body = state.objects.get(objectKey); assert.ok(body, "synthetic object must exist");
      return { byte_size: body.length, content_type: "image/png", etag: "synthetic-etag" };
    },
    async getObject({ objectKey }) {
      state.storageCalls.push({ label, kind: "get", objectKey });
      const body = state.objects.get(objectKey); assert.ok(body, "synthetic object must exist");
      return { body: Buffer.from(body), byte_size: body.length, content_type: "image/png" };
    },
    async deleteObject({ objectKey }) {
      state.storageCalls.push({ label, kind: "delete", objectKey });
      state.objects.delete(objectKey); return { deleted: true };
    },
  });
  const run = label => editUadSketch(pool(label), storage(label), WORKFILE_ID, SKETCH_ID,
    { expected_revision: 1, caption: CAPTION, sketch: sketchInput() }, ACTOR_ID);
  return { state, run, assertComplete() {
    assert.deepEqual(state.harnessErrors, [], "no mock-contract failure may be swallowed by cleanup");
    assert.equal(state.clients.every(client => client.released && client.transaction === null), true);
  } };
}

function assertVerifiedObjectRetained(state, assetId) {
  const asset = state.assets.get(assetId); assert.ok(asset);
  assert.equal(asset.status, "verified", "failed canonical save must not hide the retained verified exhibit");
  assert.equal(asset.capture_metadata.orphaned_editor_render, undefined);
  const body = state.objects.get(asset.object_key); assert.ok(body, "verified storage object must be retained");
  assert.equal(inspectUadAssetPayload(body, "image/png").checksum_sha256, asset.checksum_sha256);
  assert.equal(state.storageCalls.some(call => call.kind === "delete" && call.objectKey === asset.object_key), false);
}

test("exhibit preservation: a shared pending winner survives the real loser's canonical revision conflict", { timeout: 10000 }, async t => {
  const bothRead = deferred(); const bothPublished = deferred(); const winnerFinished = deferred();
  const readers = new Set(); const publishers = new Set();
  const fixture = harness({
    existingRender: "pending_upload",
    async onVerificationRead(label) {
      readers.add(label); if (readers.size === 2) bothRead.resolve(); await bothRead.promise;
    },
    async onVerificationPublished(label) {
      publishers.add(label); if (publishers.size === 2) bothPublished.resolve(); await bothPublished.promise;
    },
    async onConnect(label) { if (label === "loser") await winnerFinished.promise; },
  });
  const winning = fixture.run("winner");
  const losing = fixture.run("loser").then(value => ({ value }), error => ({ error }));
  t.after(async () => {
    bothRead.resolve(); bothPublished.resolve(); winnerFinished.resolve();
    await Promise.allSettled([winning, losing]);
  });
  let winner;
  try { winner = await winning; } finally { winnerFinished.resolve(); }
  const { error } = await losing;
  assert.equal(winner.idempotent, false);
  assert.equal(winner.sketch.revision, 2);
  assert.equal(winner.sketch.rendered_asset_id, SHARED_ASSET_ID);
  assert.equal(error?.message, "uad_sketch_revision_conflict");
  assert.equal(error.currentRevision, 2, "use the real saveUadSketch optimistic-revision guard");
  assert.deepEqual([...readers].sort(), ["loser", "winner"]);
  assert.deepEqual([...publishers].sort(), ["loser", "winner"]);
  assert.equal(fixture.state.createdAssetIds.length, 0, "both requests resumed the same pre-existing pending render");
  assert.equal(fixture.state.sketch.revision, 2);
  assert.equal(fixture.state.sketch.rendered_asset_id, SHARED_ASSET_ID);
  assert.deepEqual(fixture.state.history, [{ sketch_id: SKETCH_ID, revision: 2, rendered_asset_id: SHARED_ASSET_ID }]);
  const loserCalls = fixture.state.calls.filter(call => call.label === "loser");
  assert.ok(loserCalls.some(call => call.kind === "canonical_sketch"));
  assert.ok(loserCalls.some(call => call.kind === "rollback"));
  assert.equal(loserCalls.some(call => call.kind === "save_sketch"), false);
  assert.equal(fixture.state.clients.every(client => client.released), true);
  fixture.assertComplete();
  // This was RED against the prior compensation: idempotent:false does not
  // mean this request owns the asset or may soft-delete the winner's exhibit.
  assertVerifiedObjectRetained(fixture.state, SHARED_ASSET_ID);
});

test("exhibit preservation: the render creator cannot retire an exhibit referenced by the winning request", { timeout: 10000 }, async t => {
  const creatorRead = deferred(); const bothRead = deferred(); const bothPublished = deferred();
  const winnerFinished = deferred(); const readers = new Set(); const publishers = new Set();
  const fixture = harness({
    async onVerificationRead(label) {
      readers.add(label);
      if (label === "creator") creatorRead.resolve();
      if (readers.size === 2) bothRead.resolve();
      await bothRead.promise;
    },
    async onVerificationPublished(label) {
      publishers.add(label);
      if (publishers.size === 2) bothPublished.resolve();
      await bothPublished.promise;
    },
    async onConnect(label) { if (label === "creator") await winnerFinished.promise; },
  });
  const losing = fixture.run("creator").then(value => ({ value }), error => ({ error }));
  let winning;
  t.after(async () => {
    creatorRead.resolve(); bothRead.resolve(); bothPublished.resolve(); winnerFinished.resolve();
    await Promise.allSettled([winning, losing]);
  });
  await creatorRead.promise;
  assert.equal(fixture.state.createdAssetIds.length, 1);
  const assetId = fixture.state.createdAssetIds[0];
  assert.equal(fixture.state.assets.get(assetId).status, "pending_upload");
  winning = fixture.run("winner");
  let winner;
  try { winner = await winning; } finally { winnerFinished.resolve(); }
  const { error } = await losing;
  assert.equal(winner.idempotent, false);
  assert.equal(winner.sketch.revision, 2);
  assert.equal(winner.sketch.rendered_asset_id, assetId);
  assert.equal(error?.message, "uad_sketch_revision_conflict");
  assert.equal(error.currentRevision, 2);
  assert.deepEqual([...readers].sort(), ["creator", "winner"]);
  assert.deepEqual([...publishers].sort(), ["creator", "winner"]);
  assert.equal(fixture.state.createdAssetIds.length, 1);
  assert.deepEqual(fixture.state.history, [{ sketch_id: SKETCH_ID, revision: 2, rendered_asset_id: assetId }]);
  assert.equal(fixture.state.sketchAudits.length, 1);
  const creatorKinds = fixture.state.calls.filter(call => call.label === "creator").map(call => call.kind);
  assert.ok(creatorKinds.includes("canonical_sketch"));
  assert.equal(creatorKinds.includes("save_sketch"), false);
  assert.equal(creatorKinds.filter(kind => kind === "rollback").length, 2);
  assert.ok(creatorKinds.includes("cleanup_workfile_lock"), "private creation proof admits guarded cleanup, not deletion");
  assert.ok(creatorKinds.includes("cleanup_asset_lock"));
  assert.ok(creatorKinds.includes("cleanup_observers"), "fresh references must protect the winner even from the creator");
  assert.equal(creatorKinds.includes("orphan_compensation"), false);
  assert.equal(creatorKinds.includes("commit"), false);
  fixture.assertComplete();
  assertVerifiedObjectRetained(fixture.state, assetId);
});

for (const lifecycle of ["signed", "partial_signature", "historical_signature"]) {
  test(`exhibit preservation: newly created render is not retired after ${lifecycle} canonical refusal`, async () => {
    const fixture = harness({
      onConnect(_label, state) {
        // The render has already been published. Simulate lifecycle changing
        // before the real canonical transaction, without faking its guard error.
        if (lifecycle === "signed") {
          state.workfile.status = "signed"; state.workfile.signed_at = STAMP;
        } else {
          state.workfile.status = "ready";
          state.signatures = [{ workfile_id: WORKFILE_ID, revision_number: lifecycle === "partial_signature" ? 4 : 3 }];
        }
      },
    });
    await assert.rejects(fixture.run("refused"), { message: "uad_workfile_status_locked" });
    assert.equal(fixture.state.createdAssetIds.length, 1);
    assert.equal(fixture.state.sketch.revision, 1);
    assert.equal(fixture.state.sketch.rendered_asset_id, ORIGINAL_ASSET_ID);
    assert.deepEqual(fixture.state.history, []);
    assert.deepEqual(fixture.state.sketchAudits, []);
    const kinds = fixture.state.calls.map(call => call.kind);
    assert.ok(kinds.indexOf("verify_asset") < kinds.indexOf("canonical_lock"));
    assert.ok(kinds.includes("rollback"));
    assert.equal(kinds.includes("canonical_sketch"), false);
    assert.equal(kinds.includes("commit"), false);
    assert.equal(fixture.state.clients.every(client => client.released), true);
    assert.equal(fixture.state.workfile.status, lifecycle === "signed" ? "signed" : "ready");
    fixture.assertComplete();
    // This assertion is preservation-only: a retained verified render remains
    // report-eligible today, which still requires a separate publication fix.
    assertVerifiedObjectRetained(fixture.state, fixture.state.createdAssetIds[0]);
  });
}

test("exhibit preservation: original canonical query error identity and details survive wrapper failure", async () => {
  const sentinel = Object.assign(new Error("synthetic_canonical_storage_failure"), { currentRevision: 7, details: { synthetic: true } });
  const fixture = harness({ existingRender: "pending_upload", lockError: sentinel });
  await assert.rejects(fixture.run("query-failure"), error => {
    assert.equal(error, sentinel);
    assert.equal(error.currentRevision, 7);
    assert.deepEqual(error.details, { synthetic: true });
    return true;
  });
  assert.equal(fixture.state.clients.every(client => client.released), true);
  assert.equal(fixture.state.calls.some(call => call.kind === "rollback"), true);
  fixture.assertComplete();
});

test("exhibit preservation: owned unreferenced render receives bounded metadata-only ordinary failure cleanup", async () => {
  const sentinel = Object.assign(new Error("synthetic_canonical_storage_failure"), { currentRevision: 7, details: { synthetic: true } });
  const fixture = harness({ lockError: sentinel });
  await assert.rejects(fixture.run("owned-failure"), error => error === sentinel);
  assert.equal(fixture.state.createdAssetIds.length, 1);
  const assetId = fixture.state.createdAssetIds[0];
  const asset = fixture.state.assets.get(assetId);
  assert.equal(asset.status, "deleted");
  assert.equal(asset.capture_metadata.orphaned_editor_render, true);
  assert.equal(fixture.state.sketch.revision, 1);
  assert.equal(fixture.state.sketch.rendered_asset_id, ORIGINAL_ASSET_ID);
  assert.deepEqual(fixture.state.history, []);
  assert.deepEqual(fixture.state.sketchAudits, []);
  assert.equal(fixture.state.importAudits.length, 1, "existing import audit is retained");
  assert.equal(fixture.state.workfile.status, "draft");
  assert.equal(fixture.state.workfile.current_revision, 4);
  assert.equal(fixture.state.assets.get(ORIGINAL_ASSET_ID).status, "verified");
  assert.equal(fixture.state.clients.length, 2);
  const cleanupClient = fixture.state.clients[1];
  assert.deepEqual(fixture.state.calls.filter(call => call.client === cleanupClient.name).map(call => call.kind), [
    "begin", "cleanup_lock_timeout", "cleanup_statement_timeout", "cleanup_workfile_lock", "signatures",
    "cleanup_asset_lock", "cleanup_observers", "orphan_compensation", "commit", "release",
  ]);
  assert.equal(fixture.state.calls.filter(call => call.kind === "rollback").length, 1);
  const body = fixture.state.objects.get(asset.object_key);
  assert.ok(body, "metadata retirement must never remove the verified object");
  assert.equal(inspectUadAssetPayload(body, "image/png").checksum_sha256, asset.checksum_sha256);
  assert.equal(fixture.state.storageCalls.some(call => call.kind === "delete" && call.objectKey === asset.object_key), false);
  assert.equal(fixture.state.storageCalls.filter(call => call.kind === "delete").length, 1,
    "only the existing successful verification staging cleanup touches storage");
  fixture.assertComplete();
});

test("exhibit preservation: cleanup commit failure rolls back retirement and preserves the original error identity", async () => {
  const sentinel = Object.assign(new Error("synthetic_canonical_storage_failure"), { currentRevision: 7, details: { synthetic: true } });
  const cleanupError = new Error("synthetic_cleanup_commit_failure");
  const fixture = harness({ lockError: sentinel, cleanupCommitError: cleanupError });
  await assert.rejects(fixture.run("cleanup-failure"), error => {
    assert.equal(error, sentinel);
    assert.notEqual(error, cleanupError);
    assert.equal(error.currentRevision, 7);
    assert.deepEqual(error.details, { synthetic: true });
    return true;
  });
  assert.equal(fixture.state.createdAssetIds.length, 1);
  assert.equal(fixture.state.clients.length, 2);
  const cleanupClient = fixture.state.clients[1];
  const cleanupKinds = fixture.state.calls.filter(call => call.client === cleanupClient.name).map(call => call.kind);
  assert.deepEqual(cleanupKinds, [
    "begin", "cleanup_lock_timeout", "cleanup_statement_timeout", "cleanup_workfile_lock", "signatures",
    "cleanup_asset_lock", "cleanup_observers", "orphan_compensation", "commit", "rollback", "release",
  ]);
  assert.equal(fixture.state.sketch.revision, 1);
  assert.deepEqual(fixture.state.history, []);
  assert.deepEqual(fixture.state.sketchAudits, []);
  fixture.assertComplete();
  assertVerifiedObjectRetained(fixture.state, fixture.state.createdAssetIds[0]);
});

for (const observer of ["validationRuns", "generatedArtifacts"]) {
  test(`exhibit preservation: owned render remains verified when any ${observer} history exists`, async () => {
    const sentinel = new Error("synthetic_canonical_storage_failure");
    const fixture = harness({ lockError: sentinel, onConnect(_label, state) {
      state[observer] = [{ workfile_id: WORKFILE_ID, created_at: "2020-01-01T00:00:00.000Z" }];
    } });
    await assert.rejects(fixture.run("observed-failure"), error => error === sentinel);
    assert.equal(fixture.state.createdAssetIds.length, 1);
    assert.ok(fixture.state.calls.some(call => call.kind === "cleanup_observers"));
    assert.equal(fixture.state.calls.some(call => call.kind === "orphan_compensation"), false);
    assert.equal(fixture.state.calls.some(call => call.kind === "commit"), false);
    assert.equal(fixture.state.calls.filter(call => call.kind === "rollback").length, 2);
    fixture.assertComplete();
    assertVerifiedObjectRetained(fixture.state, fixture.state.createdAssetIds[0]);
  });
}

test("exhibit preservation: verified idempotent render is retained on real lifecycle refusal without storage access", async () => {
  const fixture = harness({ existingRender: "verified", onConnect(_label, state) {
    state.workfile.status = "signed"; state.workfile.signed_at = STAMP;
  } });
  await assert.rejects(fixture.run("verified-refusal"), { message: "uad_workfile_status_locked" });
  assert.deepEqual(fixture.state.storageCalls, []);
  assert.equal(fixture.state.createdAssetIds.length, 0);
  assert.equal(fixture.state.calls.some(call => call.kind === "orphan_compensation"), false);
  fixture.assertComplete();
  assertVerifiedObjectRetained(fixture.state, SHARED_ASSET_ID);
});

test("exhibit preservation: ordinary edit and exact retry preserve their established API and persistence", async () => {
  const fixture = harness();
  const result = await fixture.run("ordinary");
  assert.deepEqual(Object.keys(result).sort(), ["asset", "idempotent", "sketch"]);
  assert.equal(result.idempotent, false);
  assert.equal(result.sketch.revision, 2);
  assert.equal(result.sketch.source, "homenode");
  assert.deepEqual(result.sketch.area_overrides, { retained: true });
  assert.equal(result.sketch.rendered_asset_id, result.asset.id);
  assert.equal(fixture.state.createdAssetIds.length, 1);
  assert.equal(fixture.state.sketchAudits.length, 1);
  assert.equal(fixture.state.importAudits.length, 1);
  assert.equal(fixture.state.history.length, 1);
  assert.equal(fixture.state.workfile.current_revision, 4);
  assert.equal(fixture.state.assets.get(ORIGINAL_ASSET_ID).status, "deleted");
  assert.equal(fixture.state.assets.get(ORIGINAL_ASSET_ID).capture_metadata.retained_for_audit, true);
  assert.equal(fixture.state.objects.has(fixture.state.assets.get(ORIGINAL_ASSET_ID).object_key), true);
  assertVerifiedObjectRetained(fixture.state, result.asset.id);
  assert.equal(fixture.state.storageCalls.filter(call => call.kind === "put").length, 2);
  assert.equal(fixture.state.storageCalls.filter(call => call.kind === "delete").length, 1,
    "successful verification removes its staging object, not the verified or prior source objects");
  const storageCount = fixture.state.storageCalls.length;
  const clientCount = fixture.state.clients.length;
  const retry = await fixture.run("exact-retry");
  assert.deepEqual(Object.keys(retry).sort(), ["asset", "idempotent", "sketch"]);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.asset.id, result.asset.id);
  assert.equal(retry.sketch.id, result.sketch.id);
  assert.equal(retry.sketch.revision, 2);
  assert.equal(fixture.state.storageCalls.length, storageCount);
  assert.equal(fixture.state.clients.length, clientCount, "exact retry does not open a canonical writer");
  assert.equal(fixture.state.sketchAudits.length, 1);
  assert.equal(fixture.state.importAudits.length, 1);
  assert.equal(fixture.state.history.length, 1);
  fixture.assertComplete();
});
