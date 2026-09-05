import assert from "node:assert/strict";
import test from "node:test";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment } from "../src/services/neighborhoodAssessment/contract.js";
import { prepareNeighborhoodApplicationGroup, neighborhoodMappedManifestDigest, buildNeighborhoodApplicationReceipt } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

function fixture() {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const group = assessment.application_group;
  const suggestions = [
    { id: "boundary", target_key: "synthetic:boundary", value: "North Road", dependency_ids: ["source"], evidence_refs: ["geographic_neighborhood", "population:stock-a"], application_group_id: group.id },
    { id: "median", target_key: "synthetic:median", value: 330000, dependency_ids: ["boundary", "source"], evidence_refs: ["statistic:median-sale-price", "population:sales-a"], application_group_id: group.id },
    { id: "source", target_key: "synthetic:market-source", value: "fixture-source", dependency_ids: [], evidence_refs: ["source:fixture-source"], application_group_id: group.id },
  ];
  const attachment = buildNeighborhoodAttachment(assessment, { ...neighborhoodTargetFixture(), mapped_manifest_sha256: neighborhoodMappedManifestDigest(suggestions) });
  return { assessment, attachment, expected_binding_digest: attachment.binding_digest_sha256, group, suggestions,
    current_application_identity_sha256: attachment.application_identity_sha256, current_editor_revision: attachment.editor_revision,
    selected_ids: suggestions.map(item => item.id),
    existing_values: suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false, value: null })),
    validate_final_group: () => ({ valid: true, issues: [] }),
  };
}

function currentBinding(input, changes = {}) {
  const current = buildNeighborhoodAttachment(input.assessment, { ...input.attachment, ...changes });
  input.expected_binding_digest = current.binding_digest_sha256;
  input.current_application_identity_sha256 = current.application_identity_sha256;
  input.current_editor_revision = current.editor_revision;
  return current;
}

function appliedFixture() {
  const input = fixture();
  const first = prepareNeighborhoodApplicationGroup(input);
  input.accepted_application = buildNeighborhoodApplicationReceipt(first, input.current_editor_revision + 1);
  input.existing_values = input.suggestions.map(item => ({ target_key: item.target_key, target_exists: true,
    populated: true, value: item.value, provenance_digest: first.acceptance_manifest.provenance_digest }));
  currentBinding(input, { editor_revision: input.current_editor_revision + 1, attachment_revision: 2 });
  return input;
}

test("coherent boundary/price/source group prepares one complete manifest", () => {
  const result = prepareNeighborhoodApplicationGroup(fixture());
  assert.equal(result.status, "ready");
  assert.equal(result.writes.length, 3);
  assert.equal(result.acceptance_manifest.applied.length, 3);
});

test("existing incompatible boundary prevents every write, even when other values are empty", () => {
  const input = fixture();
  input.existing_values[0] = { ...input.existing_values[0], populated: true, value: "Different Road" };
  const result = prepareNeighborhoodApplicationGroup(input);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.writes, []);
  assert.equal(result.acceptance_manifest, null);
});

test("same text without compatible provenance cannot establish group coherence", () => {
  const input = fixture();
  input.existing_values[0] = { ...input.existing_values[0], populated: true, value: "North Road" };
  assert.equal(prepareNeighborhoodApplicationGroup(input).status, "conflict");
});

test("persisted receipt permits exact replay after the first save advances the editor revision", () => {
  const input = appliedFixture();
  assert.notEqual(input.expected_binding_digest, input.attachment.binding_digest_sha256);
  const result = prepareNeighborhoodApplicationGroup(input);
  assert.equal(result.status, "already_applied");
  assert.deepEqual(result.acceptance_manifest, input.accepted_application.acceptance_manifest);
  assert.equal(result.acceptance_manifest.base_editor_revision, 5);
  assert.equal(input.accepted_application.accepted_editor_revision, 6);
  assert.equal(result.acceptance_manifest.attachment_revision, 1);
  assert.deepEqual(result.writes, []);
});

test("rebuilding the current attachment still returns the original accepted manifest", () => {
  const input = appliedFixture();
  input.attachment = currentBinding(input, { editor_revision: 6, attachment_revision: 2 });
  const result = prepareNeighborhoodApplicationGroup(input);
  assert.equal(result.status, "already_applied");
  assert.equal(result.acceptance_manifest.attachment_revision, 1);
  assert.deepEqual(result.writes, []);
});

test("any intervening editor change prevents replay even when market values have not changed", () => {
  const input = appliedFixture();
  currentBinding(input, { editor_revision: 7, attachment_revision: 3 });
  const result = prepareNeighborhoodApplicationGroup(input);
  assert.equal(result.status, "conflict");
  assert.ok(result.conflicts.some(item => item.code === "stale_accepted_application"));
  assert.deepEqual(result.writes, []);
});

test("matching text and target-specific provenance alone cannot claim already applied", () => {
  const input = appliedFixture();
  input.accepted_application = null;
  input.attachment = currentBinding(input, { editor_revision: 6, attachment_revision: 2 });
  const result = prepareNeighborhoodApplicationGroup(input);
  assert.equal(result.status, "conflict");
  assert.ok(result.conflicts.some(item => item.code === "missing_application_receipt"));
});

test("without a receipt normal editor and full binding checks remain mandatory", () => {
  for (const edit of [
    input => { input.current_editor_revision++; },
    input => { input.expected_binding_digest = "0".repeat(64); },
    input => { delete input.current_application_identity_sha256; },
  ]) {
    const input = fixture(); edit(input);
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict"); assert.deepEqual(result.writes, []);
  }
});

test("exact report registry or UAD workfile mismatch rejects under the same organization and case", () => {
  for (const changes of [
    { report_file_id: neighborhoodTargetFixture("custom_appraisal").report_file_id },
    { uad_workfile_id: "70000000-0000-4000-8000-000000000002" },
  ]) {
    const input = fixture();
    // Simulates the authorized current registry lookup disagreeing with the proposal.
    currentBinding(input, changes);
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict");
    assert.ok(result.conflicts.some(item => item.code === "stale_application_identity"));
    assert.deepEqual(result.writes, []);
  }
});

test("copied values/provenance cannot be reused in a different report or workfile", () => {
  for (const changes of [
    { report_file_id: "60000000-0000-4000-8000-000000000003" },
    { uad_workfile_id: "70000000-0000-4000-8000-000000000002" },
    { attachment_id: "50000000-0000-4000-8000-000000000003" },
    { source_digest_sha256: "a".repeat(64) },
  ]) {
    const input = appliedFixture(); input.accepted_application = null;
    input.attachment = currentBinding(input, changes);
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict");
    assert.ok(result.conflicts.some(item => item.code === "incompatible_existing_value"));
    assert.deepEqual(result.writes, []);
  }
});

test("receipt cannot revive missing, manually altered, or differently sourced current values", () => {
  for (const edit of [
    input => { input.existing_values[0].populated = false; input.existing_values[0].value = null; },
    input => { input.existing_values[0].value = "Manual Road"; },
    input => { input.existing_values[0].provenance_digest = "0".repeat(64); },
    input => { input.existing_values[0].target_exists = false; },
    input => { input.attachment = currentBinding(input, { source_digest_sha256: "a".repeat(64) }); },
  ]) {
    const input = appliedFixture(); edit(input);
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict"); assert.deepEqual(result.writes, []);
  }
});

test("tampered receipt and partial selection cannot bypass full atomic validation", () => {
  const input = appliedFixture();
  input.accepted_application = { ...input.accepted_application, accepted_editor_revision: 7 };
  input.current_editor_revision = 7;
  assert.equal(prepareNeighborhoodApplicationGroup(input).status, "conflict");
  const partial = appliedFixture(); partial.selected_ids = ["median"];
  assert.equal(prepareNeighborhoodApplicationGroup(partial).status, "conflict");
});

test("receipt must preserve a reconstructable original binding, not just a well-formed hash", () => {
  for (const change of [{ binding_digest_sha256: "a".repeat(64) }, { attachment_revision: 9 }, { base_editor_revision: 4 }]) {
    const input = appliedFixture();
    const { receipt_digest_sha256: _digest, ...saved } = input.accepted_application;
    const receipt = { ...saved, acceptance_manifest: { ...saved.acceptance_manifest, ...change } };
    input.accepted_application = { ...receipt, receipt_digest_sha256: assessmentEvidenceDigest(receipt) };
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict"); assert.deepEqual(result.writes, []);
    assert.ok(result.conflicts.some(item => item.code === "incompatible_application_receipt"));
  }
});

test("UAD receipt cannot represent revision zero even with consistent reconstructed hashes", () => {
  const input = appliedFixture();
  const { binding_digest_sha256: _bindingDigest, review_status: _reviewStatus, ...binding } = input.attachment;
  const { receipt_digest_sha256: _receiptDigest, ...saved } = input.accepted_application;
  const manifest = { ...saved.acceptance_manifest, base_editor_revision: 0,
    binding_digest_sha256: assessmentEvidenceDigest({ ...binding, editor_revision: 0 }) };
  const receipt = { ...saved, acceptance_manifest: manifest };
  input.accepted_application = { ...receipt, receipt_digest_sha256: assessmentEvidenceDigest(receipt) };
  assert.equal(prepareNeighborhoodApplicationGroup(input).status, "conflict");
});

test("receipt construction requires a ready plan and a newly allocated editor revision", () => {
  const plan = prepareNeighborhoodApplicationGroup(fixture());
  for (const revision of [null, undefined, 5, 4, NaN, Infinity, "6"]) {
    assert.throws(() => buildNeighborhoodApplicationReceipt(plan, revision));
  }
  const conflict = fixture(); conflict.selected_ids = ["median"];
  assert.throws(() => buildNeighborhoodApplicationReceipt(prepareNeighborhoodApplicationGroup(conflict), 6));
  assert.ok(Object.isFrozen(buildNeighborhoodApplicationReceipt(plan, 6).acceptance_manifest));
});

test("pruned source or boundary, duplicate ids/targets, missing dependencies reject entire operation", () => {
  for (const edit of [
    input => { input.selected_ids = ["median"]; },
    input => { input.suggestions.push({ ...input.suggestions[0] }); },
    input => { input.suggestions[1].target_key = input.suggestions[0].target_key; },
    input => { input.suggestions[1].dependency_ids = ["missing-source"]; },
    input => { input.existing_values[0].target_exists = false; },
  ]) {
    const input = fixture(); edit(input);
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict"); assert.deepEqual(result.writes, []);
  }
});

test("date, revision, source binding and relevant cross-field conflicts reject without partial acceptance", () => {
  for (const edit of [
    input => { input.expected_binding_digest = "0".repeat(64); },
    input => { input.group = { ...input.group, effective_date: "2024-07-01" }; },
    input => { input.group = { ...input.group, revision: 2 }; },
    input => { input.group = { ...input.group, geometry_sha256: "0".repeat(64) }; },
    input => { input.validate_final_group = () => ({ valid: false, issues: ["invalid_relevant_section"] }); },
  ]) {
    const input = fixture(); edit(input);
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict"); assert.deepEqual(result.writes, []);
  }
});

test("unrelated unfinished sections are not required by the scoped validation callback", () => {
  const input = fixture();
  input.validate_final_group = final => ({ valid: final.length === 3, issues: [] });
  assert.equal(prepareNeighborhoodApplicationGroup(input).status, "ready");
});

test("pruning the server manifest together with selection cannot evade atomic coverage", () => {
  const input = fixture();
  input.suggestions = [{ ...input.suggestions[1], dependency_ids: [] }];
  input.selected_ids = ["median"];
  assert.equal(prepareNeighborhoodApplicationGroup(input).status, "conflict");
});

test("prepared values are immutable and callback cannot alter accepted group", () => {
  const input = fixture();
  const result = prepareNeighborhoodApplicationGroup(input);
  assert.ok(Object.isFrozen(result.writes[0]));
  input.suggestions[0].value = "Changed";
  assert.equal(result.writes[0].value, "North Road");
  const malicious = fixture();
  malicious.validate_final_group = rows => { rows[0].value = "Changed"; return { valid: true, issues: [] }; };
  assert.equal(prepareNeighborhoodApplicationGroup(malicious).status, "conflict");
});

test("lossy invalid values fail before preparation even with permissive cross-field callback", () => {
  for (const value of [undefined, NaN, Infinity, () => 1]) {
    const input = fixture(); input.suggestions[1].value = value;
    const result = prepareNeighborhoodApplicationGroup(input);
    assert.equal(result.status, "conflict"); assert.deepEqual(result.writes, []);
  }
});

test("group preparation is order invariant and bounds caller collections", () => {
  const input = fixture();
  const expected = prepareNeighborhoodApplicationGroup(input);
  input.suggestions.reverse(); input.selected_ids.reverse(); input.existing_values.reverse();
  assert.deepEqual(prepareNeighborhoodApplicationGroup(input), expected);
  input.selected_ids = Array(1001).fill("median");
  assert.equal(prepareNeighborhoodApplicationGroup(input).status, "conflict");
});
