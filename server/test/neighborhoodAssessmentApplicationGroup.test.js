import assert from "node:assert/strict";
import test from "node:test";
import { buildNeighborhoodAssessment, buildNeighborhoodAttachment } from "../src/services/neighborhoodAssessment/contract.js";
import { prepareNeighborhoodApplicationGroup, neighborhoodMappedManifestDigest } from "../src/services/neighborhoodAssessment/applicationGroup.js";
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
  return { attachment, expected_binding_digest: attachment.binding_digest_sha256, group, suggestions,
    selected_ids: suggestions.map(item => item.id),
    existing_values: suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false, value: null })),
    validate_final_group: () => ({ valid: true, issues: [] }),
  };
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

test("compatible revision-bound provenance makes full replay idempotent", () => {
  const input = fixture();
  const first = prepareNeighborhoodApplicationGroup(input);
  input.existing_values = input.suggestions.map(item => ({ target_key: item.target_key, target_exists: true,
    populated: true, value: item.value, provenance_digest: first.acceptance_manifest.provenance_digest }));
  const result = prepareNeighborhoodApplicationGroup(input);
  assert.equal(result.status, "already_applied");
  assert.equal(result.acceptance_manifest.reused.length, 3);
  assert.deepEqual(result.writes, []);
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
