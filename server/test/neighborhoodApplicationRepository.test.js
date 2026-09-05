import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { prepareNeighborhoodApplicationGroup, neighborhoodMappedManifestDigest, buildNeighborhoodApplicationReceipt } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { persistNeighborhoodAttachment as persist, getNeighborhoodAttachment as getAttachment,
  getAcceptedNeighborhoodApplication as getAccepted, recordNeighborhoodApplicationAcceptance as accept } from "../src/services/neighborhoodAssessment/applicationRepository.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

// Injected-client orchestration/SQL-shape tests only: no real PostgreSQL claims.
const OPERATION = "80000000-0000-4000-8000-000000000001";
const ACTOR = "90000000-0000-4000-8000-000000000001";
const REVISION = "a0000000-0000-4000-8000-000000000001";
const APPLICATION = "b0000000-0000-4000-8000-000000000001";
const AUDIT = "9007199254740993"; // Exercise bigint identity without Number rounding.
const rows = (items = []) => ({ rows: items, rowCount: items.length });
function fixture(workflow = "uad_3_6") {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const group = assessment.application_group;
  const mappedSuggestions = [
    { id: "boundary", target_key: "synthetic:boundary", value: "North Road", dependency_ids: ["source"], evidence_refs: ["geographic_neighborhood", "population:stock-a"], application_group_id: group.id },
    { id: "median", target_key: "synthetic:median", value: 330000, dependency_ids: ["source", "boundary"], evidence_refs: ["statistic:median-sale-price", "population:sales-a"], application_group_id: group.id },
    { id: "source", target_key: "synthetic:source", value: "fixture-source", dependency_ids: [], evidence_refs: ["source:fixture-source"], application_group_id: group.id },
  ];
  const attachment = buildNeighborhoodAttachment(assessment, { ...neighborhoodTargetFixture(workflow), mapped_manifest_sha256: neighborhoodMappedManifestDigest(mappedSuggestions) });
  const plan = prepareNeighborhoodApplicationGroup({ attachment, group, suggestions: mappedSuggestions,
    expected_binding_digest: attachment.binding_digest_sha256, current_application_identity_sha256: attachment.application_identity_sha256,
    current_editor_revision: attachment.editor_revision, selected_ids: mappedSuggestions.map(item => item.id),
    existing_values: mappedSuggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    validate_final_group: () => ({ valid: true, issues: [] }) });
  assert.equal(plan.status, "ready");
  const receipt = buildNeighborhoodApplicationReceipt(plan, attachment.editor_revision + 1);
  const target = { organizationId: attachment.scope.organization_id, reportFileId: attachment.report_file_id,
    workflowType: workflow, workflowTargetId: workflow === "uad_3_6" ? attachment.uad_workfile_id : attachment.custom_assignment_file_id };
  const request = { attachmentId: attachment.attachment_id, applicationIdentitySha256: attachment.application_identity_sha256,
    receipt, uadRevisionId: REVISION, uadRevisionNumber: receipt.accepted_editor_revision, auditEventId: AUDIT, operationId: OPERATION, actorUserId: ACTOR };
  const manifest = receipt.acceptance_manifest;
  const stored = { assessment, stored_assessment_id: assessment.id, stored_assessment_revision: assessment.revision,
    stored_evidence_digest: assessment.evidence_digest_sha256, attachment, mapped_suggestions: mappedSuggestions,
    attachment_id: attachment.attachment_id, attachment_revision: attachment.attachment_revision,
    binding_digest_sha256: attachment.binding_digest_sha256, application_identity_sha256: attachment.application_identity_sha256,
    report_file_id: attachment.report_file_id, organization_id: attachment.scope.organization_id,
    account_id: attachment.scope.account_id, appraisal_case_id: attachment.scope.appraisal_case_id, subject_snapshot_id: attachment.scope.subject_snapshot_id,
    workflow_type: workflow, custom_assignment_file_id: workflow === "custom_appraisal" ? String(attachment.custom_assignment_file_id) : null,
    uad_workfile_id: attachment.uad_workfile_id, case_organization_id: attachment.scope.organization_id, case_account_id: attachment.scope.account_id,
    case_effective_date: assessment.effective_date, snapshot_case_id: attachment.scope.appraisal_case_id,
    snapshot_effective_date: assessment.effective_date, canonical_effective_date: assessment.effective_date,
    target_organization_id: attachment.scope.organization_id, target_account_id: attachment.scope.account_id };
  const links = { linked_revision_id: REVISION, linked_revision_workfile_id: attachment.uad_workfile_id,
    linked_revision_number: receipt.accepted_editor_revision, linked_revision_actor: ACTOR, linked_specification_release: attachment.specification_release,
    linked_audit_id: AUDIT, linked_audit_workfile_id: attachment.uad_workfile_id, linked_audit_actor: ACTOR,
    linked_event_type: "uad_neighborhood_assessment.applied", linked_entity_type: "uad_neighborhood_application", linked_entity_id: OPERATION,
    linked_current_revision: receipt.accepted_editor_revision, linked_signed_at: null, linked_workfile_status: "draft",
    linked_metadata: { operation_id: OPERATION, uad_revision_id: REVISION, uad_revision_number: receipt.accepted_editor_revision,
      application_identity_sha256: attachment.application_identity_sha256, receipt_digest_sha256: receipt.receipt_digest_sha256,
      mapped_manifest_sha256: attachment.mapped_manifest_sha256, prepared_values_sha256: manifest.prepared_values_sha256 },
    linked_after_data: { attachment_id: attachment.attachment_id, assessment_id: assessment.id, assessment_revision: assessment.revision,
      application_group_id: group.id, application_group_revision: group.revision,
      applied_suggestion_ids: manifest.applied.map(item => item.id), reused_suggestion_ids: manifest.reused.map(item => item.id) } };
  const app = { attachment_id: attachment.attachment_id, attachment_revision: attachment.attachment_revision,
    report_file_id: attachment.report_file_id, application_identity_sha256: attachment.application_identity_sha256,
    operation_id: OPERATION, actor_user_id: ACTOR, accepted_editor_revision: receipt.accepted_editor_revision,
    uad_revision_id: REVISION, uad_audit_event_id: AUDIT, receipt };
  const acceptedRow = { ...stored, ...app, ...links, id: APPLICATION, request_digest_sha256: assessmentEvidenceDigest(app) };
  return { assessment, attachment, mappedSuggestions, receipt, target, request, stored, links, acceptedRow };
}
function fake(f, overrides = {}) {
  const calls = [];
  const handlers = { "published-context": rows([f.stored]), "insert-attachment": rows([{ attachment_id: f.attachment.attachment_id }]),
    "exact-attachment": rows([f.stored]), "accepted-receipt": rows([f.acceptedRow]), "acceptance-links": rows([f.links]),
    "insert-acceptance": rows([{ id: APPLICATION }]), "acceptance-conflict": rows([{ id: APPLICATION, request_digest_sha256: f.acceptedRow.request_digest_sha256 }]), ...overrides };
  return { calls, release() { assert.fail("Only the caller may release its checked-out client"); }, async query(sql, values = []) {
    const tag = sql.match(/\/\* neighborhood-application:([a-z-]+) \*\//)?.[1];
    assert.ok(tag, `No transaction control, DDL or unowned query expected: ${sql}`);
    calls.push({ tag, sql, values: structuredClone(values) });
    assert.ok(Object.hasOwn(handlers, tag), `unexpected fake query ${tag}`);
    const handler = handlers[tag]; return typeof handler === "function" ? handler(values, sql) : handler;
  } };
}
function persisted(f) { return { assessment: f.assessment, attachment: f.attachment, mappedSuggestions: f.mappedSuggestions }; }
function lookup(f) { return { ...f.target, applicationIdentitySha256: f.attachment.application_identity_sha256 }; }
function exact(f) { return { ...f.target, attachmentId: f.attachment.attachment_id, attachmentRevision: f.attachment.attachment_revision }; }
const noWrites = client => assert.equal(client.calls.some(call => /\bINSERT\b|\bUPDATE\b|\bDELETE\b/.test(call.sql)), false);
function rehashReceipt(receipt) { const { receipt_digest_sha256: _digest, ...body } = receipt; return { ...body, receipt_digest_sha256: assessmentEvidenceDigest(body) }; }

test("attachment insert captures canonical full mapper manifest and preserves caller input", async () => {
  for (const workflow of ["uad_3_6", "custom_appraisal"]) {
    const f = fixture(workflow), client = fake(f), before = canonicalAssessmentJson(f.mappedSuggestions);
    const saved = await persist(client, persisted(f));
    assert.equal(saved.reused, false); assert.ok(Object.isFrozen(saved.attachment));
    assert.equal(canonicalAssessmentJson(f.mappedSuggestions), before);
    const insert = client.calls.find(call => call.tag === "insert-attachment");
    assert.match(insert.sql, /ON CONFLICT DO NOTHING/); assert.doesNotMatch(insert.sql, /DO UPDATE/);
    assert.equal(neighborhoodMappedManifestDigest(JSON.parse(insert.values[12])), f.attachment.mapped_manifest_sha256);
    assert.deepEqual(JSON.parse(insert.values[11]), f.attachment);
  }
});

test("immutable attachment conflict permits exact replay only, including canonical mapped suggestions", async () => {
  const f = fixture(), client = fake(f, { "insert-attachment": rows() });
  assert.equal((await persist(client, persisted(f))).reused, true);
  assert.equal(client.calls.at(-1).tag, "exact-attachment");
  const conflict = fixture();
  conflict.stored.attachment = { ...conflict.attachment, editor_revision: 8 };
  await assert.rejects(persist(fake(conflict, { "insert-attachment": rows() }), persisted(conflict)), /stored_attachment_changed/);
  const invisible = fake(f, { "insert-attachment": rows(), "exact-attachment": rows() });
  await assert.rejects(persist(invisible, persisted(f)), /attachment_conflict/);
});

test("wrong organization/report/workfile/case/snapshot/date context fails before attachment insert", async () => {
  for (const [key, value] of [
    ["organization_id", "10000000-0000-4000-8000-000000000009"], ["report_file_id", "60000000-0000-4000-8000-000000000009"],
    ["uad_workfile_id", "70000000-0000-4000-8000-000000000009"], ["appraisal_case_id", "20000000-0000-4000-8000-000000000009"],
    ["subject_snapshot_id", "30000000-0000-4000-8000-000000000009"], ["target_organization_id", "10000000-0000-4000-8000-000000000009"],
    ["target_account_id", "other-account"], ["canonical_effective_date", "2024-06-29"], ["snapshot_effective_date", "2024-06-29"],
  ]) {
    const f = fixture(); f.stored[key] = value; const client = fake(f);
    await assert.rejects(persist(client, persisted(f)), /target_mismatch|scope_mismatch/); noWrites(client);
  }
});

test("unpublished/missing assessment, bad stored digest and pruned full group cannot be persisted", async () => {
  const f = fixture(), unavailable = fake(f, { "published-context": rows() });
  await assert.rejects(persist(unavailable, persisted(f)), /published_assessment_not_found/); noWrites(unavailable);
  assert.match(unavailable.calls[0].sql, /n.publication_status='published'/);
  const changed = fixture(); changed.stored.stored_evidence_digest = "0".repeat(64);
  const changedClient = fake(changed); await assert.rejects(persist(changedClient, persisted(changed)), /digest_mismatch/); noWrites(changedClient);
  const partial = fixture(), partialClient = fake(partial);
  await assert.rejects(persist(partialClient, { ...persisted(partial), mappedSuggestions: partial.mappedSuggestions.slice(1) }), /mapped_manifest_mismatch/);
  noWrites(partialClient);
});

test("exact attachment read requires complete target/id/revision filters and performs SELECT only", async () => {
  const f = fixture(), client = fake(f);
  const found = await getAttachment(client, exact(f));
  assert.equal(found.attachment.attachment_revision, 1); noWrites(client);
  const call = client.calls[0];
  assert.deepEqual(call.values, [f.target.organizationId, f.target.reportFileId, "uad_3_6", f.target.workflowTargetId, f.attachment.attachment_id, 1]);
  assert.match(call.sql, /a.attachment_id=\$5 AND a.attachment_revision=\$6/);
  assert.match(call.sql, /h.appraisal_case_id=r.appraisal_case_id/);
  assert.doesNotMatch(call.sql, /ORDER BY|LIMIT|is_current|current_revision/);
  assert.equal(await getAttachment(fake(f, { "exact-attachment": rows() }), exact(f)), null);
  await assert.rejects(getAttachment(client, { ...exact(f), attachmentRevision: undefined }), /invalid_attachment_revision/);
});

test("acceptance records exact original attachment revision and verified UAD revision/audit/actor", async () => {
  const f = fixture(), client = fake(f);
  const saved = await accept(client, f.request);
  assert.equal(saved.reused, false); assert.equal(saved.application_id, APPLICATION);
  assert.deepEqual(saved.receipt, f.receipt);
  assert.deepEqual(client.calls.map(call => call.tag), ["exact-attachment", "acceptance-links", "insert-acceptance"]);
  assert.equal(client.calls[0].values.at(-1), f.receipt.acceptance_manifest.attachment_revision);
  const insert = client.calls.at(-1);
  assert.equal(insert.values[9], REVISION); assert.equal(insert.values[10], AUDIT);
  assert.equal(insert.values[6], ACTOR); assert.equal(insert.values[5], OPERATION);
  assert.equal(insert.values[7], f.acceptedRow.request_digest_sha256);
});

test("even consistently rehashed altered receipt values cannot evade the retained complete mapper manifest", async () => {
  const f = fixture();
  const receipt = structuredClone(f.receipt);
  receipt.acceptance_manifest.applied[1].value = 999_999;
  receipt.acceptance_manifest.prepared_values_sha256 = assessmentEvidenceDigest(receipt.acceptance_manifest.applied.map(({ target_key, value }) => ({ target_key, value })));
  const client = fake(f);
  await assert.rejects(accept(client, { ...f.request, receipt: rehashReceipt(receipt) }), /receipt_mapped_values_mismatch/);
  noWrites(client);
});

test("receipt digest, provenance/base binding and partition corruption reject before writes", async () => {
  for (const edit of [
    value => { value.accepted_editor_revision = 7; },
    value => { value.acceptance_manifest.base_editor_revision = 4; },
    value => { value.acceptance_manifest.provenance.mapper_version = "wrong-mapper"; },
    value => { value.acceptance_manifest.binding_digest_sha256 = "0".repeat(64); },
    value => { value.acceptance_manifest.prepared_values_sha256 = "0".repeat(64); },
    value => { value.acceptance_manifest.applied.pop(); },
    value => { value.acceptance_manifest.reused.push(value.acceptance_manifest.applied[0]); },
  ]) {
    const f = fixture(), receipt = structuredClone(f.receipt); edit(receipt);
    const client = fake(f);
    await assert.rejects(accept(client, { ...f.request, receipt: rehashReceipt(receipt) }), /receipt_|revision_number_mismatch/); noWrites(client);
  }
});

test("different audit/actor/operation/revision links cannot manufacture an accepted receipt", async () => {
  for (const edit of [
    row => { row.linked_revision_actor = "90000000-0000-4000-8000-000000000009"; },
    row => { row.linked_audit_workfile_id = "70000000-0000-4000-8000-000000000009"; },
    row => { row.linked_revision_number = 7; },
    row => { row.linked_event_type = "uad_completion_suggestions.applied"; },
    row => { row.linked_entity_id = "80000000-0000-4000-8000-000000000009"; },
    row => { row.linked_metadata.receipt_digest_sha256 = "0".repeat(64); },
    row => { row.linked_metadata.uad_revision_id = "a0000000-0000-4000-8000-000000000009"; },
    row => { row.linked_after_data.assessment_revision = 2; },
    row => { row.linked_after_data.applied_suggestion_ids = ["median"]; },
    row => { row.linked_after_data.reused_suggestion_ids = ["median"]; },
  ]) {
    const f = fixture(); edit(f.links); const client = fake(f);
    await assert.rejects(accept(client, f.request), /uad_/); noWrites(client);
  }
});

test("new acceptance refuses changed editor or protected UAD state; historical receipt reads remain available", async () => {
  for (const edit of [row => { row.linked_current_revision = 7; }, row => { row.linked_signed_at = "2026-09-05T00:00:00.000Z"; },
    row => { row.linked_workfile_status = "signed"; }, row => { row.linked_workfile_status = "cancelled"; }]) {
    const f = fixture(); edit(f.links); const client = fake(f);
    await assert.rejects(accept(client, f.request), /uad_target_not_editable/); noWrites(client);
    Object.assign(f.acceptedRow, f.links);
    assert.deepEqual(await getAccepted(fake(f), lookup(f)), f.receipt);
  }
});

test("Custom proposal is available but acceptance/receipt lookup explicitly reject until editor concurrency is defined", async () => {
  const f = fixture("custom_appraisal"), client = fake(f);
  await assert.rejects(accept(client, f.request), /custom_acceptance_not_supported/);
  await assert.rejects(getAccepted(client, lookup(f)), /custom_acceptance_not_supported/);
  assert.equal(client.calls.length, 0);
});

test("concurrent immutable acceptance replay requires identical request and validated trusted receipt", async () => {
  const f = fixture(), client = fake(f, { "insert-acceptance": rows() });
  const saved = await accept(client, f.request);
  assert.equal(saved.reused, true); assert.equal(saved.application_id, APPLICATION);
  assert.equal(client.calls.at(-1).tag, "accepted-receipt");
  const conflict = fake(f, { "insert-acceptance": rows(), "acceptance-conflict": rows([{ id: APPLICATION, request_digest_sha256: "0".repeat(64) }]) });
  await assert.rejects(accept(conflict, f.request), /receipt_conflict/);
  assert.equal(conflict.calls.some(call => /DO UPDATE/.test(call.sql)), false);
  const dual = fake(f, { "insert-acceptance": rows(), "acceptance-conflict": rows([{}, {}]) });
  await assert.rejects(accept(dual, f.request), /receipt_conflict/);
});

test("receipt read is exact-target SELECT-only and rejects tampered persisted identity/links", async () => {
  const f = fixture(), client = fake(f);
  assert.deepEqual(await getAccepted(client, lookup(f)), f.receipt); noWrites(client);
  assert.deepEqual(client.calls[0].values, [f.target.organizationId, f.target.reportFileId, "uad_3_6", f.target.workflowTargetId, f.attachment.application_identity_sha256]);
  assert.doesNotMatch(client.calls[0].sql, /ORDER BY|LIMIT|is_current|current_revision/);
  assert.equal(await getAccepted(fake(f, { "accepted-receipt": rows() }), lookup(f)), null);
  for (const edit of [row => { row.request_digest_sha256 = "0".repeat(64); }, row => { row.accepted_editor_revision = 8; },
    row => { row.report_file_id = "60000000-0000-4000-8000-000000000009"; }, row => { row.linked_audit_actor = "90000000-0000-4000-8000-000000000009"; }]) {
    const changed = fixture(); edit(changed.acceptedRow);
    await assert.rejects(getAccepted(fake(changed), lookup(changed)), /stored_receipt_changed|target_mismatch|uad_link_mismatch/);
  }
});

test("input revision and bigint validation happen without transaction ownership or pool access", async () => {
  const f = fixture();
  for (const edit of [{ uadRevisionNumber: undefined }, { uadRevisionNumber: 0 }, { actorUserId: "browser-name" },
    { auditEventId: 9_007_199_254_740_993 }, { auditEventId: "9223372036854775808" }]) {
    await assert.rejects(accept(fake(f), { ...f.request, ...edit }), /invalid_/);
  }
  await assert.rejects(persist({ query() {}, connect() {} }, persisted(f)), /caller_client_required/);
  const checkedOut = fake(f);
  checkedOut.connect = () => assert.fail("A checked-out pg Client must not be reconnected");
  assert.equal((await persist(checkedOut, persisted(f))).reused, false);
  const source = await readFile(new URL("../src/services/neighborhoodAssessment/applicationRepository.js", import.meta.url), "utf8");
  assert.match(source, /caller-owned transaction helpers/i);
  assert.match(source, /authorize the exact target, lock the workfile\/report/);
  assert.match(source, /catalog\/cross-field rules/);
  assert.match(source, /never BEGIN, COMMIT/);
  assert.match(source, /NOT authorization or signing controls/);
  assert.doesNotMatch(source, /client\.query\(["'`](?:BEGIN|COMMIT|ROLLBACK)|pool\.connect|\.release\(/);
});
