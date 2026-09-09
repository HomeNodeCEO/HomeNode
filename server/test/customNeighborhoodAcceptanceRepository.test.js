import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildNeighborhoodAssessment, buildNeighborhoodAttachment, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { buildNeighborhoodApplicationReceipt, neighborhoodMappedManifestDigest,
  prepareNeighborhoodApplicationGroup } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { prepareCustomNeighborhoodAcceptanceSnapshot } from "../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js";
import { getCustomNeighborhoodAcceptance as getAcceptance,
  recordCustomNeighborhoodAcceptance as recordAcceptance } from "../src/services/neighborhoodAssessment/customAcceptanceRepository.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";
import { saveCustomNeighborhoodAcceptanceInTransaction as saveGroup } from "../src/services/neighborhoodAssessment/customAcceptanceSave.js";

// Query-double orchestration tests with real contract, attachment and snapshot
// validation. These do not execute PostgreSQL or prove native authorization.
const OPERATION = "abcdef01-0000-4000-8000-000000000001";
const ACTOR = "abcdef02-0000-4000-8000-000000000002";
const ACCEPTANCE = "abcdef03-0000-4000-8000-000000000003";
const OTHER = "abcdef04-0000-4000-8000-000000000004";
const HISTORY = "9007199254740993";
const clone = value => structuredClone(value);
const rows = (items = []) => ({ rows: items, rowCount: items.length });
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const digest = value => createHash("sha256").update(canonical(value), "utf8").digest("hex");

function fixture(boundaryValue = "North Road") {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const group = assessment.application_group;
  const mappedSuggestions = [
    { id: "boundary", target_key: "synthetic:boundary", value: boundaryValue, dependency_ids: ["source"],
      evidence_refs: ["geographic_neighborhood", "population:stock-a"], application_group_id: group.id },
    { id: "median", target_key: "synthetic:median", value: 330000, dependency_ids: ["boundary", "source"],
      evidence_refs: ["statistic:median-sale-price", "population:sales-a"], application_group_id: group.id },
    { id: "source", target_key: "synthetic:market-source", value: "fixture-source", dependency_ids: [],
      evidence_refs: ["source:fixture-source"], application_group_id: group.id },
  ];
  const attachment = buildNeighborhoodAttachment(assessment, {
    ...neighborhoodTargetFixture("custom_appraisal"), editor_revision: 5,
    mapped_manifest_sha256: neighborhoodMappedManifestDigest(mappedSuggestions),
  });
  const plan = prepareNeighborhoodApplicationGroup({ attachment, group, suggestions: mappedSuggestions,
    expected_binding_digest: attachment.binding_digest_sha256,
    current_application_identity_sha256: attachment.application_identity_sha256,
    current_editor_revision: attachment.editor_revision, selected_ids: mappedSuggestions.map(item => item.id),
    existing_values: mappedSuggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    // Synthetic representation closure, not validation against a live Custom catalog.
    validate_final_group: () => ({ valid: true, issues: [] }) });
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  const receipt = buildNeighborhoodApplicationReceipt(plan, attachment.editor_revision + 1);
  const snapshot = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment, mappedSuggestions,
    operationId: OPERATION, actorUserId: ACTOR, receipt });
  const target = { organizationId: attachment.scope.organization_id, reportFileId: attachment.report_file_id,
    assignmentFileId: attachment.custom_assignment_file_id, operationId: OPERATION };
  const input = { ...target, actorUserId: ACTOR, attachmentId: attachment.attachment_id,
    attachmentRevision: attachment.attachment_revision, sectionHistoryId: HISTORY, receipt };
  const stored = { assessment, stored_assessment_id: assessment.id, stored_assessment_revision: assessment.revision,
    stored_evidence_digest: assessment.evidence_digest_sha256, attachment, mapped_suggestions: mappedSuggestions,
    attachment_id: attachment.attachment_id, attachment_revision: attachment.attachment_revision,
    binding_digest_sha256: attachment.binding_digest_sha256, application_identity_sha256: attachment.application_identity_sha256,
    report_file_id: attachment.report_file_id, organization_id: attachment.scope.organization_id,
    account_id: attachment.scope.account_id, appraisal_case_id: attachment.scope.appraisal_case_id,
    subject_snapshot_id: attachment.scope.subject_snapshot_id, workflow_type: "custom_appraisal",
    custom_assignment_file_id: String(attachment.custom_assignment_file_id), uad_workfile_id: null,
    case_organization_id: attachment.scope.organization_id, case_account_id: attachment.scope.account_id,
    case_effective_date: assessment.effective_date, snapshot_case_id: attachment.scope.appraisal_case_id,
    snapshot_effective_date: assessment.effective_date, canonical_effective_date: assessment.effective_date,
    target_organization_id: attachment.scope.organization_id, target_account_id: attachment.scope.account_id };
  const accepted = { id: ACCEPTANCE, organization_id: target.organizationId, report_file_id: target.reportFileId,
    assignment_file_id: String(target.assignmentFileId), account_id: assessment.scope.account_id,
    operation_id: OPERATION, actor_user_id: ACTOR, attachment_id: attachment.attachment_id,
    attachment_revision: attachment.attachment_revision, application_identity_sha256: attachment.application_identity_sha256,
    section_key: snapshot.section_key, section_history_id: HISTORY, accepted_editor_revision: receipt.accepted_editor_revision,
    section_json_utf8: canonical(snapshot.section_value), section_bytes_sha256: digest(snapshot.section_value), decision: snapshot.section_value.decision,
    history_value: snapshot.section_value, history_revision: receipt.accepted_editor_revision,
    current_value: snapshot.section_value, current_revision: receipt.accepted_editor_revision };
  // Each stored JSON column is independent, as it is after database decoding.
  return { assessment: clone(assessment), attachment: clone(attachment), target: clone(target), input: clone(input),
    stored: clone(stored), snapshot: clone(snapshot), accepted: { ...clone(accepted),
      decision: clone(snapshot.section_value.decision), history_value: clone(snapshot.section_value), current_value: clone(snapshot.section_value) } };
}

function fake(f, overrides = {}) {
  const calls = [];
  const handlers = { "savepoint": rows(), "release-savepoint": rows(),
    "neighborhood-application:exact-attachment": rows([f.stored]),
    "custom-neighborhood-acceptance:insert": rows([{ id: ACCEPTANCE }]),
    "custom-neighborhood-acceptance:exact-operation": rows([f.accepted]), ...overrides };
  return { calls, release() { assert.fail("Only the transaction owner may release the client"); }, async query(sql, values = []) {
    assert.doesNotMatch(sql, /^\s*(?:BEGIN|COMMIT|ROLLBACK|CREATE|ALTER|DROP)\b/i);
    const tag = sql === "SAVEPOINT custom_neighborhood_acceptance_write" ? "savepoint"
      : sql === "RELEASE SAVEPOINT custom_neighborhood_acceptance_write" ? "release-savepoint"
        : sql.match(/\/\* ([a-z-]+:[a-z-]+) \*\//)?.[1];
    assert.ok(tag && Object.hasOwn(handlers, tag), `unexpected query: ${sql}`);
    calls.push({ tag, sql, values: clone(values) });
    const handler = handlers[tag];
    return typeof handler === "function" ? handler(values, sql) : handler;
  } };
}
function deepFrozen(value) {
  if (value && typeof value === "object") {
    assert.ok(Object.isFrozen(value));
    Object.values(value).forEach(deepFrozen);
  }
}
const noWrites = client => assert.equal(client.calls.some(call => /\b(?:INSERT|UPDATE|DELETE)\b/.test(call.sql)), false);
const noRelease = client => assert.equal(client.calls.some(call => call.tag === "release-savepoint"), false);
const exactValues = f => [f.target.organizationId, f.target.reportFileId, f.target.assignmentFileId, OPERATION];
const attachmentValues = f => [f.target.organizationId, f.target.reportFileId, "custom_appraisal",
  String(f.target.assignmentFileId), f.input.attachmentId, f.input.attachmentRevision];

const groupInput = f => { const { sectionHistoryId: _history, ...input } = f.input; return input; };
function groupDatabase(f, options = {}) {
  let accepted = Boolean(options.existing);
  const client = fake(f, {
    "custom-neighborhood-acceptance:exact-operation": () => accepted ? rows([f.accepted]) : rows(),
    "custom-neighborhood-acceptance:insert": () => {
      if (options.failAcceptance) throw new Error("synthetic_acceptance_failure");
      const prior = accepted; accepted = true; return prior ? rows() : rows([{ id: ACCEPTANCE }]);
    },
  });
  const original = client.query.bind(client), commands = [];
  client.query = async (statement, values = []) => {
    const sql = statement.replace(/\s+/g, " ").trim();
    commands.push({ sql, values: clone(values) });
    if (sql === "SAVEPOINT custom_neighborhood_group_save") {
      if (options.autocommit) throw new Error("SAVEPOINT can only be used in transaction blocks");
      options.onStart?.(); return rows();
    }
    if (sql === "ROLLBACK TO SAVEPOINT custom_neighborhood_group_save" && options.rollbackFailure) {
      throw new Error("synthetic_rollback_failure");
    }
    if (/^(?:RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) custom_neighborhood_group_save$/.test(sql)
      || /^(?:SAVEPOINT|RELEASE SAVEPOINT) homenode_custom_section_save$/.test(sql)) return rows();
    if (sql.startsWith("SELECT assignment_file.id, assignment_file.file_number")) {
      return rows([{ id: f.target.assignmentFileId, file_number: "Synthetic file" }]);
    }
    if (sql.startsWith("INSERT INTO app.custom_appraisal_workfiles (")) return rows();
    if (sql.startsWith("SELECT status FROM app.custom_appraisal_workfiles")) return rows([{ status: options.signed ? "signed" : "draft" }]);
    if (sql.startsWith("SELECT revision FROM app.custom_appraisal_workfile_sections")) {
      return rows([{ revision: options.stale ? 99 : f.attachment.editor_revision }]);
    }
    if (sql.startsWith("INSERT INTO app.custom_appraisal_workfile_sections (")) return rows([{
      section_key: values[1], section_value: JSON.parse(values[2]), revision: values[3], updated_by: values[4], updated_at: "2026-09-09T14:00:00Z",
    }]);
    if (sql.startsWith("INSERT INTO app.custom_appraisal_workfile_section_history (")
      || sql.startsWith("UPDATE app.custom_appraisal_workfiles SET updated_at")
      || sql.startsWith("UPDATE app.assignment_files SET updated_at")) return rows();
    if (sql.startsWith("/* custom-neighborhood-save:history */")) return options.noHistory ? rows() : rows([{ id: HISTORY }]);
    return original(statement, values);
  };
  return { client, commands };
}

test("coherent save uses the actual section/history writer and exact derived account and actor", async () => {
  const f = fixture(), db = groupDatabase(f);
  const accepted = await saveGroup(db.client, groupInput(f));
  assert.deepEqual(accepted.snapshot, f.snapshot);
  assert.equal(accepted.reused, false);
  const section = db.commands.find(command => command.sql.startsWith("INSERT INTO app.custom_appraisal_workfile_sections ("));
  const history = db.commands.find(command => command.sql.startsWith("INSERT INTO app.custom_appraisal_workfile_section_history ("));
  assert.deepEqual(section.values, [f.target.assignmentFileId, f.snapshot.section_key,
    JSON.stringify(f.snapshot.section_value), 6, ACTOR]);
  assert.deepEqual(history.values, [f.target.assignmentFileId, f.snapshot.section_key,
    JSON.stringify(f.snapshot.section_value), 6, "manual_save", ACTOR]);
  assert.equal(db.commands.at(-1).sql, "RELEASE SAVEPOINT custom_neighborhood_group_save");
  assert.equal(db.commands.some(command => /^(?:BEGIN|COMMIT|ROLLBACK)$/.test(command.sql)), false);
});

test("coherent exact retry does not rewrite section/history or timestamps", async () => {
  const f = fixture(), db = groupDatabase(f, { existing: true });
  const accepted = await saveGroup(db.client, groupInput(f));
  assert.equal(accepted.reused, true);
  assert.deepEqual(accepted.snapshot, f.snapshot);
  assert.equal(db.commands.some(command => /^(?:INSERT INTO app.custom_appraisal|UPDATE app\.)/.test(command.sql)), false);
});

for (const [name, options, expected] of [
  ["signed file", { signed: true }, /custom_appraisal_workfile_signed/],
  ["stale revision", { stale: true }, /custom_appraisal_section_revision_conflict/],
  ["missing exact history", { noHistory: true }, /custom_neighborhood_save_history_mismatch/],
  ["late acceptance failure", { failAcceptance: true }, /synthetic_acceptance_failure/],
]) test(`coherent save rolls back its savepoint on ${name}`, async () => {
  const f = fixture(), db = groupDatabase(f, options);
  await assert.rejects(saveGroup(db.client, groupInput(f)), expected);
  assert.deepEqual(db.commands.slice(-2).map(command => command.sql),
    ["ROLLBACK TO SAVEPOINT custom_neighborhood_group_save", "RELEASE SAVEPOINT custom_neighborhood_group_save"]);
});

test("coherent save requires explicit transaction and rejects caller-shaped persisted fields", async () => {
  const f = fixture(), db = groupDatabase(f, { autocommit: true });
  await assert.rejects(saveGroup(db.client, groupInput(f)), /SAVEPOINT can only/);
  assert.equal(db.commands.length, 1);
  for (const [key, value] of Object.entries({ sectionValue: {}, sectionHistoryId: HISTORY, accountId: "other", reviewer: "Browser name" })) {
    const rejected = groupDatabase(f);
    await assert.rejects(saveGroup(rejected.client, { ...groupInput(f), [key]: value }), /invalid_input/);
    assert.equal(rejected.commands.length, 0);
  }
});

test("coherent save captures the original request before its first await", async () => {
  const f = fixture(), input = groupInput(f);
  const db = groupDatabase(f, { onStart: () => { input.actorUserId = OTHER; input.receipt.acceptance_manifest.applied[0].value = "changed"; } });
  assert.deepEqual((await saveGroup(db.client, input)).snapshot, f.snapshot);
});

test("coherent save exposes rollback failure without returning an accepted result", async () => {
  const f = fixture(), db = groupDatabase(f, { failAcceptance: true, rollbackFailure: true });
  await assert.rejects(saveGroup(db.client, groupInput(f)), error => error instanceof AggregateError
    && error.message === "custom_neighborhood_save_rollback_failed"
    && error.errors[0].message === "synthetic_acceptance_failure"
    && error.errors[1].message === "synthetic_rollback_failure");
  assert.equal(db.commands.at(-1).sql, "ROLLBACK TO SAVEPOINT custom_neighborhood_group_save");
});

test("exact insert captures all immutable acceptance columns and rereads the exact operation", async () => {
  const f = fixture(), before = clone(f.input), client = fake(f);
  const accepted = await recordAcceptance(client, f.input);
  assert.equal(accepted.reused, false);
  assert.deepEqual(accepted.snapshot, f.snapshot);
  assert.equal(accepted.sectionHistoryId, HISTORY);
  assert.deepEqual(f.input, before);
  deepFrozen(accepted);
  assert.deepEqual(client.calls.map(call => call.tag), ["savepoint", "neighborhood-application:exact-attachment",
    "custom-neighborhood-acceptance:insert", "custom-neighborhood-acceptance:exact-operation",
    "neighborhood-application:exact-attachment", "release-savepoint"]);
  const insert = client.calls[2];
  assert.match(insert.values[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(insert.values.slice(1), [f.target.organizationId, f.target.reportFileId, f.target.assignmentFileId,
    f.assessment.scope.account_id, f.input.attachmentId, f.input.attachmentRevision,
    f.attachment.application_identity_sha256, OPERATION, ACTOR, f.snapshot.section_key, HISTORY,
    f.input.receipt.accepted_editor_revision, digest(f.snapshot.section_value), canonical(f.snapshot.section_value), canonical(f.snapshot.section_value.decision)]);
  assert.match(insert.sql, /ON CONFLICT DO NOTHING RETURNING id/);
  assert.doesNotMatch(insert.sql, /DO UPDATE/);
  assert.deepEqual(client.calls[3].values, exactValues(f));
  for (const call of client.calls.filter(call => call.tag === "neighborhood-application:exact-attachment")) {
    assert.deepEqual(call.values, attachmentValues(f));
  }
});

test("individually bounded section and receipt can save and retry when their envelope exceeds one constituent limit", async () => {
  const f = fixture("x".repeat(748500));
  assert.doesNotThrow(() => canonicalAssessmentJson(f.snapshot.section_value));
  assert.doesNotThrow(() => canonicalAssessmentJson(f.snapshot.receipt));
  assert.throws(() => canonicalAssessmentJson(f.snapshot), /json_bytes/);
  for (const reused of [false, true]) {
    const client = fake(f, reused ? { "custom-neighborhood-acceptance:insert": rows() } : {});
    const accepted = await recordAcceptance(client, f.input);
    assert.equal(accepted.reused, reused);
    assert.deepEqual(accepted.snapshot, f.snapshot);
    assert.equal(client.calls.at(-1).tag, "release-savepoint");
    assert.deepEqual((await getAcceptance(client, f.target)).snapshot, f.snapshot);
  }
});

test("exact read returns a detached frozen snapshot and exact scoped SQL parameters", async () => {
  const f = fixture(), client = fake(f), accepted = await getAcceptance(client, f.target);
  assert.deepEqual(accepted.snapshot, f.snapshot);
  assert.deepEqual(client.calls.map(call => call.tag), ["custom-neighborhood-acceptance:exact-operation", "neighborhood-application:exact-attachment"]);
  assert.deepEqual(client.calls[0].values, exactValues(f));
  assert.deepEqual(client.calls[1].values, attachmentValues(f));
  assert.match(client.calls[0].sql, /a\.organization_id=\$1 AND a\.report_file_id=\$2 AND a\.assignment_file_id=\$3 AND a\.operation_id=\$4/);
  assert.match(client.calls[0].sql, /h\.section_value AS history_value/);
  assert.match(client.calls[0].sql, /s\.section_value AS current_value/);
  assert.doesNotMatch(client.calls[0].sql, /ORDER BY|LIMIT 1|h\.value\b|s\.value\b/);
  f.accepted.history_value.changed = true;
  f.stored.mapped_suggestions[0].value = "Changed after read";
  assert.deepEqual(accepted.snapshot, f.snapshot);
  deepFrozen(accepted);
  noWrites(client);
});

test("an exact immutable retry reuses the row without owning transaction or connection", async () => {
  const f = fixture(), client = fake(f, { "custom-neighborhood-acceptance:insert": rows() });
  const accepted = await recordAcceptance(client, f.input);
  assert.equal(accepted.reused, true);
  assert.deepEqual(accepted.snapshot, f.snapshot);
  assert.equal(client.calls.at(-1).tag, "release-savepoint");
  deepFrozen(accepted);
});

test("SAVEPOINT failure prevents every attachment read and acceptance write", async () => {
  const f = fixture(), failure = Object.assign(new Error("SAVEPOINT can only be used in transaction blocks"), { code: "25P01" });
  const client = fake(f, { savepoint: () => { throw failure; } });
  await assert.rejects(recordAcceptance(client, f.input), error => error === failure);
  assert.deepEqual(client.calls.map(call => call.tag), ["savepoint"]);
  noWrites(client);
});

test("caller changes during the first await cannot alter captured request or receipt", async () => {
  const f = fixture(), original = clone(f.input);
  const client = fake(f, { savepoint: () => {
    f.input.operationId = OTHER;
    f.input.reportFileId = OTHER;
    f.input.assignmentFileId += 1;
    f.input.attachmentId = OTHER;
    f.input.actorUserId = OTHER;
    f.input.sectionHistoryId = "2";
    f.input.receipt.acceptance_manifest.applied[0].value = "caller mutation";
    return rows();
  } });
  const accepted = await recordAcceptance(client, f.input);
  assert.equal(accepted.operationId, original.operationId);
  assert.equal(accepted.actorUserId, original.actorUserId);
  assert.equal(accepted.sectionHistoryId, original.sectionHistoryId);
  assert.equal(client.calls[2].values[15], canonical(f.snapshot.section_value.decision));
  assert.deepEqual(accepted.snapshot.receipt, original.receipt);
  assert.deepEqual(accepted.snapshot, f.snapshot);
});

test("the lookup target is captured before the query awaits", async () => {
  const f = fixture(), target = clone(f.target), client = fake(f, {
    "custom-neighborhood-acceptance:exact-operation": () => {
      target.organizationId = OTHER; target.reportFileId = OTHER; target.assignmentFileId += 1; target.operationId = OTHER;
      return rows([f.accepted]);
    },
  });
  const accepted = await getAcceptance(client, target);
  assert.equal(accepted.operationId, OPERATION);
  assert.deepEqual(client.calls[0].values, exactValues(f));
  assert.deepEqual(client.calls[1].values, attachmentValues(f));
});

const invalidInputs = {
  "caller-supplied attachment": input => { input.attachment = {}; },
  "caller-supplied assessment": input => { input.assessment = {}; },
  "extra workflow target": input => { input.workflowType = "custom_appraisal"; },
  "missing operation": input => { delete input.operationId; },
  "invalid organization": input => { input.organizationId = "bad"; },
  "invalid report": input => { input.reportFileId = "bad"; },
  "noninteger assignment": input => { input.assignmentFileId = 1.5; },
  "string assignment": input => { input.assignmentFileId = "1"; },
  "zero assignment": input => { input.assignmentFileId = 0; },
  "unsafe assignment": input => { input.assignmentFileId = Number.MAX_SAFE_INTEGER + 1; },
  "invalid operation": input => { input.operationId = "bad"; },
};
for (const [name, mutate] of Object.entries(invalidInputs)) {
  test(`closed read/write target rejects ${name} before query`, async () => {
    for (const [operation, key] of [[getAcceptance, "target"], [recordAcceptance, "input"]]) {
      const f = fixture(), client = fake(f); mutate(f[key]);
      await assert.rejects(operation(client, f[key]), error => /custom_neighborhood_acceptance_invalid_/.test(error.code));
      assert.equal(client.calls.length, 0);
    }
  });
}

for (const [name, patch] of Object.entries({
  actor: { actorUserId: "bad" }, attachment: { attachmentId: "bad" }, revision: { attachmentRevision: 0 },
  "revision ceiling": { attachmentRevision: 2147483648 }, "numeric history": { sectionHistoryId: 1 },
  "history leading zero": { sectionHistoryId: "01" }, "history bigint ceiling": { sectionHistoryId: "9223372036854775808" },
})) {
  test(`invalid write ${name} is rejected before SAVEPOINT`, async () => {
    const f = fixture(), client = fake(f);
    await assert.rejects(recordAcceptance(client, { ...f.input, ...patch }), error => /custom_neighborhood_acceptance_invalid_/.test(error.code));
    assert.equal(client.calls.length, 0);
  });
}

test("both operations require a caller-owned query/release client", async () => {
  const f = fixture();
  for (const client of [null, {}, { query() {} }, { release() {} }]) {
    await assert.rejects(getAcceptance(client, f.target), { code: "custom_neighborhood_acceptance_caller_client_required" });
    await assert.rejects(recordAcceptance(client, f.input), { code: "custom_neighborhood_acceptance_caller_client_required" });
  }
});

test("missing exact operation returns null without searching account history", async () => {
  const f = fixture(), client = fake(f, { "custom-neighborhood-acceptance:exact-operation": rows() });
  assert.equal(await getAcceptance(client, f.target), null);
  assert.equal(client.calls.length, 1);
});

test("missing stored attachment fails read and write without trusting caller data", async () => {
  for (const writing of [false, true]) {
    const f = fixture(), client = fake(f, { "neighborhood-application:exact-attachment": rows() });
    await assert.rejects(writing ? recordAcceptance(client, f.input) : getAcceptance(client, f.target), {
      code: `custom_neighborhood_acceptance_${writing ? "attachment_not_found" : "stored_attachment_missing"}`,
    });
    noWrites(client); noRelease(client);
  }
});

for (const [name, key, value] of [
  ["organization", "organization_id", OTHER], ["report", "report_file_id", OTHER],
  ["assignment", "custom_assignment_file_id", "9999"], ["account", "account_id", "wrong-account"],
  ["case", "appraisal_case_id", OTHER], ["subject snapshot", "subject_snapshot_id", OTHER],
  ["target organization", "target_organization_id", OTHER], ["target account", "target_account_id", "wrong-account"],
]) {
  test(`real attachment validator rejects wrong stored ${name} before acceptance write`, async () => {
    const f = fixture(); f.stored[key] = value; const client = fake(f);
    await assert.rejects(recordAcceptance(client, f.input), /neighborhood_application_(?:target|scope)_mismatch/);
    noWrites(client); noRelease(client);
  });
}

const storedMutations = {
  "organization": row => { row.organization_id = OTHER; },
  "report": row => { row.report_file_id = OTHER; },
  "assignment": row => { row.assignment_file_id = "9999"; },
  "account": row => { row.account_id = "wrong-account"; },
  "actor": row => { row.actor_user_id = OTHER; },
  "operation": row => { row.operation_id = OTHER; },
  "application identity": row => { row.application_identity_sha256 = "0".repeat(64); },
  "section key": row => { row.section_key = "other-section"; },
  "accepted revision": row => { row.accepted_editor_revision += 1; },
  "history revision": row => { row.history_revision += 1; },
  "unhashed whitespace": row => { row.section_json_utf8 += " "; },
  "invalid stored JSON": row => { row.section_json_utf8 = "{"; },
  "stored values": row => { row.section_json_utf8 = canonical({ forged: true }); },
  "section byte digest": row => { row.section_bytes_sha256 = "0".repeat(64); },
  "history value": row => { row.history_value.forged = true; },
};
for (const [name, mutate] of Object.entries(storedMutations)) {
  test(`stored acceptance rejects mutated ${name}`, async () => {
    const f = fixture(); mutate(f.accepted); const client = fake(f);
    await assert.rejects(getAcceptance(client, f.target), { code: name === "accepted revision"
      ? "custom_neighborhood_acceptance_invalid_accepted_revision" : "custom_neighborhood_acceptance_stored_group_mismatch" });
    noWrites(client);
  });
}

test("byte-hashed noncanonical JSON reopens to the same canonical snapshot and derived receipt", async () => {
  const f = fixture();
  f.accepted.section_json_utf8 = JSON.stringify(f.snapshot.section_value, null, 2);
  f.accepted.section_bytes_sha256 = createHash("sha256").update(f.accepted.section_json_utf8).digest("hex");
  assert.notEqual(f.accepted.section_bytes_sha256, f.snapshot.section_value_sha256);
  assert.deepEqual((await getAcceptance(fake(f), f.target)).snapshot, f.snapshot);
});

test("invalid stored decision and mapped values use real snapshot/attachment validation", async () => {
  const receiptCase = fixture(); receiptCase.accepted.decision.receipt_digest_sha256 = "0".repeat(64);
  await assert.rejects(getAcceptance(fake(receiptCase), receiptCase.target), /decision/);
  const mappingCase = fixture(); mappingCase.stored.mapped_suggestions[0].value = "forged";
  await assert.rejects(getAcceptance(fake(mappingCase), mappingCase.target), /neighborhood_application_mapped_manifest_mismatch/);
  const attachmentCase = fixture(); attachmentCase.stored.attachment_revision += 1;
  await assert.rejects(getAcceptance(fake(attachmentCase), attachmentCase.target), /neighborhood_application_stored_attachment_columns_mismatch/);
});

for (const mode of ["same values at newer revision", "changed values at same revision"]) {
  test(`old accepted group cannot replay over ${mode}`, async () => {
    const f = fixture();
    if (mode.startsWith("same")) f.accepted.current_revision += 1;
    else f.accepted.current_value.forged = true;
    for (const writing of [false, true]) {
      const client = fake(f, { "custom-neighborhood-acceptance:insert": rows() });
      await assert.rejects(writing ? recordAcceptance(client, f.input) : getAcceptance(client, f.target),
        { code: "custom_neighborhood_acceptance_not_current_section" });
      noRelease(client);
    }
  });
}

for (const [name, patch] of Object.entries({ actor: { actorUserId: OTHER }, history: { sectionHistoryId: "2" },
  attachment: { attachmentId: OTHER }, "attachment revision": { attachmentRevision: 2 } })) {
  test(`retry with changed ${name} cannot overwrite the original acceptance`, async () => {
    const f = fixture(), client = fake(f, { "custom-neighborhood-acceptance:insert": rows() });
    await assert.rejects(recordAcceptance(client, { ...f.input, ...patch }), { code: "custom_neighborhood_acceptance_operation_conflict" });
    assert.equal(client.calls.filter(call => /\b(?:UPDATE|DELETE)\b/.test(call.sql)).length, 0);
    noRelease(client);
  });
}

test("a changed receipt fails before inserting the acceptance", async () => {
  const f = fixture(), client = fake(f); f.input.receipt.accepted_editor_revision += 1;
  await assert.rejects(recordAcceptance(client, f.input), /receipt|accepted_revision/);
  noWrites(client); noRelease(client);
});

test("ambiguous operation, invalid insert count and invisible conflict fail closed", async () => {
  const f = fixture();
  const ambiguous = fake(f, { "custom-neighborhood-acceptance:exact-operation": rows([f.accepted, f.accepted]) });
  await assert.rejects(getAcceptance(ambiguous, f.target), { code: "custom_neighborhood_acceptance_operation_conflict" });
  assert.equal(ambiguous.calls.length, 1);
  const invalidInsert = fake(f, { "custom-neighborhood-acceptance:insert": rows([{}, {}]) });
  await assert.rejects(recordAcceptance(invalidInsert, f.input), { code: "custom_neighborhood_acceptance_insert_conflict" });
  noRelease(invalidInsert);
  const invisible = fake(f, { "custom-neighborhood-acceptance:insert": rows(), "custom-neighborhood-acceptance:exact-operation": rows() });
  await assert.rejects(recordAcceptance(invisible, f.input), { code: "custom_neighborhood_acceptance_operation_conflict" });
  noRelease(invisible);
});
