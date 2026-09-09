import assert from "node:assert/strict";
import test from "node:test";
import { buildNeighborhoodAssessment } from "../src/services/neighborhoodAssessment/contract.js";
import { buildNeighborhoodApplicationReceipt } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { prepareCustomNeighborhoodAcceptanceSnapshot } from "../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js";
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply,
  projectCustomNeighborhoodReportSection } from "../src/services/neighborhoodAssessment/customReportMapping.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

function fixture() {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const target = neighborhoodTargetFixture("custom_appraisal");
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment, target });
  assert.equal(candidate.status, "ready", JSON.stringify(candidate));
  const existing_values = candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false }));
  const input = { assessment, target, existing_values,
    request: { selected_ids: candidate.suggestions.map(item => item.id), binding_digest_sha256: candidate.attachment.binding_digest_sha256 },
    current_application_identity_sha256: candidate.attachment.application_identity_sha256, current_editor_revision: target.editor_revision };
  const plan = prepareCustomNeighborhoodReportApply(input);
  assert.equal(plan.status, "ready", JSON.stringify(plan));
  const saved = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment: candidate.attachment,
    mappedSuggestions: candidate.suggestions, operationId: "abcdef01-0000-4000-8000-000000000001",
    actorUserId: "abcdef02-0000-4000-8000-000000000002", receipt: buildNeighborhoodApplicationReceipt(plan, target.editor_revision + 1) });
  return { assessment, target, candidate, input, saved, expected: {
    organization_id: assessment.scope.organization_id, report_file_id: target.report_file_id,
    assignment_file_id: target.custom_assignment_file_id, account_id: assessment.scope.account_id } };
}

test("real Custom catalog survives shared Apply/receipt/section and exact report projection", () => {
  const { assessment, saved, expected, candidate } = fixture();
  assert.equal(candidate.suggestions.length, 5);
  assert.ok(candidate.suggestions.every(item => item.target_key.startsWith("custom_neighborhood:")));
  const projected = projectCustomNeighborhoodReportSection({ section: saved.section_value, expected });
  assert.equal(projected.status, "ready");
  assert.deepEqual(projected.assessment, assessment);
  assert.equal(projected.assessment.statistics.find(item => item.id === "median-sale-price").estimator, "exact_median");
  assert.equal(projected.assessment.statistics.find(item => item.id === "predominant-sale-price").value, null);
  assert.equal(projected.assessment.populations.find(item => item.id === "sales-a").member_count, 3);
  assert.equal(projected.assessment.populations.find(item => item.id === "sales-a").unique_property_count, 2);
  assert.ok(Object.isFrozen(projected.assessment.statistics));
});

test("mapper retains all rows, unknown optional facts and exact separate pocket/geography", () => {
  const input = neighborhoodAssessmentFixture();
  input.selection.pocket_ids.push("pocket-b");
  input.populations[0].pocket_ids.push("pocket-b");
  input.statistics.push({ ...input.statistics[0], id: "unavailable-gla", measurement: "gla", unit: "ft2",
    value: null, status: "incomplete", reason: "gla_not_known_at_sale", observed_count: 0, missing_count: 3 });
  const assessment = buildNeighborhoodAssessment(input);
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment, target: neighborhoodTargetFixture("custom_appraisal") });
  assert.equal(candidate.status, "ready", JSON.stringify(candidate));
  assert.deepEqual(candidate.suggestions.find(item => item.target_key.endsWith(":statistics")).value, assessment.statistics);
  assert.deepEqual(candidate.suggestions.find(item => item.target_key.endsWith(":geography")).value.geometry, input.geographic_neighborhood.geometry);
  assert.deepEqual(candidate.suggestions.find(item => item.target_key.endsWith(":selection")).value.pocket_ids, ["pocket-a", "pocket-b"]);
});

for (const field of ["organization_id", "account_id", "assignment_file_id", "report_file_id"]) {
  test(`saved projection rejects another ${field}`, () => {
    const { saved, expected } = fixture();
    expected[field] = field === "assignment_file_id" ? 2 : "another";
    const result = projectCustomNeighborhoodReportSection({ section: saved.section_value, expected });
    assert.equal(result.status, "unavailable"); assert.equal(result.assessment, null);
  });
}

for (const mutate of [
  value => { value.request.selected_ids.pop(); },
  value => { value.current_editor_revision++; },
  value => { value.current_application_identity_sha256 = "f".repeat(64); },
  value => { value.request.binding_digest_sha256 = "e".repeat(64); },
  value => { value.existing_values[0].target_exists = false; },
  value => { value.existing_values[0] = { ...value.existing_values[0], populated: true, value: "manual choice", provenance_digest: null }; },
]) {
  test(`Apply refuses partial/stale/missing/manual-conflict: ${mutate}`, () => {
    const { input } = fixture(); mutate(input);
    const result = prepareCustomNeighborhoodReportApply(input);
    assert.equal(result.status, "conflict"); assert.deepEqual(result.writes, []);
    assert.equal(result.acceptance_manifest, null);
  });
}

for (const mutate of [
  section => { delete section.mapped_values["custom-neighborhood-report:selection"]; },
  section => { section.mapped_values["custom-neighborhood-report:statistics"].value[0].value = 999999; },
  section => { section.mapped_values["custom-neighborhood-report:geography"].value.cardinal_summaries.north = "Changed Road"; },
  section => { section.mapped_values["custom-neighborhood-report:selection"].value.pocket_ids = ["different"]; },
  section => { section.mapped_values["custom-neighborhood-report:evidence"].value.mapper_version = "unknown"; },
  section => { delete section.decision.applied["custom-neighborhood-report:geography"]; },
  section => { section.decision.reused["custom-neighborhood-report:geography"] = true; },
  section => { section.mapped_values["custom-neighborhood-report:statistics"].target_key = "neighborhood_house_price_predominant"; },
]) {
  test(`saved projection refuses incomplete or changed group: ${mutate}`, () => {
    const { saved, expected } = fixture(); const section = structuredClone(saved.section_value); mutate(section);
    const result = projectCustomNeighborhoodReportSection({ section, expected });
    assert.equal(result.status, "unavailable"); assert.equal(result.assessment, null);
  });
}

test("no caller-owned input mutation or legacy assignment alias writes", () => {
  const { input, candidate } = fixture(), before = structuredClone(input);
  const result = prepareCustomNeighborhoodReportApply(input);
  assert.equal(result.status, "ready"); assert.deepEqual(input, before);
  assert.ok(!JSON.stringify(candidate.suggestions.map(item => item.target_key)).includes("assignment_details"));
});

test("changed assessment and UAD target do not acquire a Custom binding", () => {
  const { assessment, target } = fixture();
  const changed = structuredClone(assessment); changed.discovery.radius_miles = 10;
  for (const options of [{ assessment: changed, target }, { assessment, target: neighborhoodTargetFixture("uad_3_6") }]) {
    const result = buildCustomNeighborhoodReportCandidate(options);
    assert.equal(result.status, "incomplete"); assert.deepEqual(result.suggestions, []);
  }
});

for (const size of [750_000, 900_000]) {
  test(`candidate capacity rejects ${size} retained diagnostic bytes before offering Apply`, () => {
    const raw = neighborhoodAssessmentFixture(); raw.diagnostics.large_retained_note = "x".repeat(size);
    const assessment = buildNeighborhoodAssessment(raw);
    const result = buildCustomNeighborhoodReportCandidate({ assessment, target: neighborhoodTargetFixture("custom_appraisal") });
    assert.equal(result.status, "incomplete"); assert.deepEqual(result.suggestions, []);
  });
}
