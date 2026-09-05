import assert from "node:assert/strict";
import test from "node:test";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment,
  buildNeighborhoodAttachment, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { buildNeighborhoodApplicationReceipt, neighborhoodMappedManifestDigest,
  prepareNeighborhoodApplicationGroup } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { assertNeighborhoodJsonbStorage } from "../src/services/neighborhoodAssessment/jsonbStorage.js";
import { buildUadNeighborhoodCandidate, prepareUadNeighborhoodApply, buildUadNeighborhoodReceipt,
  projectUadNeighborhoodExport } from "../src/modules/uad/neighborhoodReview.js";
import { uadNeighborhoodReviewFixture } from "./fixtures/uadNeighborhoodReviewFixture.js";

const clone = value => JSON.parse(JSON.stringify(value));
const byKey = candidate => Object.fromEntries(candidate.suggestions.map(item => [item.target_key, item.value]));
function rejected(plan, code) {
  assert.equal(plan.status, "conflict");
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.acceptance_manifest, null);
  if (code) assert.ok(plan.conflicts.some(item => item.code === code), JSON.stringify(plan.conflicts));
}
function rebind(input, change) {
  const assessment = clone(input.assessment);
  change(assessment);
  input.assessment = buildNeighborhoodAssessment(assessment);
  input.market_context.assessment_digest_sha256 = input.assessment.evidence_digest_sha256;
  return input;
}
function acceptedFixture(options) {
  const input = uadNeighborhoodReviewFixture(options);
  const plan = prepareUadNeighborhoodApply(input);
  assert.equal(plan.status, "ready", JSON.stringify(plan));
  const receipt = buildUadNeighborhoodReceipt(input.candidate, plan, input.target.editor_revision + 1);
  input.existing_values = input.existing_values.map(row => {
    const item = input.candidate.suggestions.find(item => item.target_key === row.target_key);
    return item ? { ...row, populated: true, value: item.value,
      provenance_digest: plan.acceptance_manifest.provenance_digest } : row;
  });
  input.target.editor_revision++;
  input.target.attachment_revision++;
  input.accepted_receipt = receipt;
  return input;
}

function smallSampleFixture(count, low, median, high) {
  const input = uadNeighborhoodReviewFixture();
  rebind(input, assessment => {
    const population = assessment.populations.find(item => item.id === "sales-a");
    Object.assign(population, { member_count: count, property_link_count: count, unique_property_count: count,
      member_set_sha256: assessmentEvidenceDigest(Array.from({ length: count }, (_, index) => `sale-${index}`)) });
    for (const statistic of assessment.statistics) {
      statistic.observed_count = count; statistic.denominator_count = count;
      statistic.value = { "sale-count": count, "lowest-price": low,
        "median-sale-price": median, "highest-price": high }[statistic.id];
    }
  });
  input.market_context.population_ref.member_set_sha256 = input.assessment.populations.find(item => item.id === "sales-a").member_set_sha256;
  return input;
}

// Reconstruct a historical receipt with all shared bindings intact, rather than
// corrupting an outer checksum. This test-only fixture models the former UAD
// order-only price check; it does not bypass or replace any production validator.
function historicalSmallSampleFixture(count, low, median, high) {
  const input = smallSampleFixture(count, low, median, high);
  const candidate = clone(input.candidate);
  candidate.group = input.assessment.application_group;
  const values = { "market_total_sales:3000.0026": count, "market_total_sales:3000.0028": low,
    "market_total_sales:3000.0029": median, "market_total_sales:3000.0027": high };
  candidate.suggestions = candidate.suggestions.map(item => ({ ...item,
    application_group_id: candidate.group.id, value: values[item.target_key] ?? item.value }));
  Object.assign(candidate.evidence, { assessment_digest_sha256: input.assessment.evidence_digest_sha256,
    market_context: clone(input.market_context),
    populations: input.assessment.populations.filter(item => input.assessment.required_population_ids.includes(item.id)),
    statistics: candidate.evidence.statistics.map(item => input.assessment.statistics.find(statistic => statistic.id === item.id)),
    sources: input.assessment.source_snapshots.filter(item => candidate.group.source_refs.includes(item.id)) });
  candidate.attachment = buildNeighborhoodAttachment(input.assessment, { ...input.target,
    source_digest_sha256: assessmentEvidenceDigest(candidate.evidence),
    mapped_manifest_sha256: neighborhoodMappedManifestDigest(candidate.suggestions),
    mapper_version: candidate.mapper_version });
  candidate.candidate_digest_sha256 = assessmentEvidenceDigest({
    application_identity_sha256: candidate.attachment.application_identity_sha256, mapper_version: candidate.mapper_version });
  input.candidate = candidate;
  Object.assign(input.request, { expected_candidate_digest_sha256: candidate.candidate_digest_sha256,
    expected_binding_digest_sha256: candidate.attachment.binding_digest_sha256 });
  const historicalValidator = finalValues => {
    const mapped = Object.fromEntries(finalValues.map(item => [item.target_key, item.value]));
    assert.equal(finalValues.length, 7);
    assert.ok(mapped["market_total_sales:3000.0028"] <= mapped["market_total_sales:3000.0029"]);
    assert.ok(mapped["market_total_sales:3000.0029"] <= mapped["market_total_sales:3000.0027"]);
    return { valid: true, issues: [] };
  };
  const sharedInput = { attachment: candidate.attachment, group: candidate.group, suggestions: candidate.suggestions,
    selected_ids: candidate.suggestions.map(item => item.id),
    expected_binding_digest: candidate.attachment.binding_digest_sha256,
    current_application_identity_sha256: candidate.attachment.application_identity_sha256,
    current_editor_revision: input.target.editor_revision, existing_values: input.existing_values };
  const plan = prepareNeighborhoodApplicationGroup({ ...sharedInput, validate_final_group: historicalValidator });
  assert.equal(plan.status, "ready", JSON.stringify(plan));
  const acceptedRevision = input.target.editor_revision + 1;
  const body = { receipt_version: 1, candidate,
    core_receipt: buildNeighborhoodApplicationReceipt(plan, acceptedRevision) };
  input.accepted_receipt = { ...body, receipt_digest_sha256: assessmentEvidenceDigest(body) };
  input.existing_values = candidate.suggestions.map(item => ({ target_key: item.target_key,
    target_exists: true, populated: true, value: item.value,
    provenance_digest: plan.acceptance_manifest.provenance_digest }));
  input.target.editor_revision = acceptedRevision;
  input.target.attachment_revision++;
  let reachedFinalValidator = false;
  const sharedReplay = prepareNeighborhoodApplicationGroup({ ...sharedInput,
    current_editor_revision: acceptedRevision, existing_values: input.existing_values,
    accepted_application: body.core_receipt, validate_final_group: finalValues => {
      reachedFinalValidator = true;
      return historicalValidator(finalValues);
    } });
  // These assertions prove that checksums, provenance, identities, occupancy and
  // receipt replay all pass before the format-specific arithmetic is considered.
  assert.equal(reachedFinalValidator, true);
  assert.equal(sharedReplay.status, "already_applied", JSON.stringify(sharedReplay));
  assert.deepEqual(sharedReplay.writes, []);
  assert.deepEqual(sharedReplay.acceptance_manifest, plan.acceptance_manifest);
  return { input, plan, acceptedRevision };
}

test("maps seven canonical Section 17 fields with no preselection, no unrelated conclusions", () => {
  const input = uadNeighborhoodReviewFixture();
  assert.equal(input.candidate.status, "ready");
  assert.deepEqual(input.candidate.selected_suggestion_ids, []);
  assert.deepEqual(byKey(input.candidate), {
    "market:3000.0008": input.market_context.analysis_geometry.boundary_description,
    "market:3000.0010": input.market_context.search_criteria, "market:3000.0009": 12,
    "market_total_sales:3000.0026": 3, "market_total_sales:3000.0028": 300000,
    "market_total_sales:3000.0029": 330000, "market_total_sales:3000.0027": 390000,
  });
  assert.ok(input.candidate.omissions.includes("active_listing_coverage_not_mapped"));
  assert.ok(input.candidate.omissions.includes("land_use_has_no_verified_section17_mapping"));
  assert.ok(Object.isFrozen(input.candidate.evidence.sources));
  const prepared = prepareUadNeighborhoodApply(input);
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.writes.length, 7);
  assert.deepEqual(prepared.acceptance_manifest.provenance.population_refs, input.assessment.application_group.population_refs);
});

test("market geography may be distinct from descriptive neighborhood without replacing its evidence", () => {
  const input = uadNeighborhoodReviewFixture();
  input.market_context.analysis_geometry = { role: "competitive_market", revision: "pockets-a-b-1",
    geometry_sha256: assessmentEvidenceDigest({ synthetic: "disconnected-competitive-pockets" }),
    boundary_description: "Competitive market: pocket A and separate pocket B; the intervening industrial strip is excluded." };
  const candidate = buildUadNeighborhoodCandidate(input);
  assert.equal(candidate.status, "ready");
  assert.equal(byKey(candidate)["market:3000.0008"], input.market_context.analysis_geometry.boundary_description);
  assert.notEqual(candidate.evidence.geographic_neighborhood.geometry_sha256, candidate.evidence.market_context.analysis_geometry.geometry_sha256);
  assert.equal(candidate.evidence.geographic_neighborhood.geometry_sha256, input.assessment.application_group.geometry_sha256);
});

test("missing or changed server-resolved boundary/search/population context cannot produce suggestions", () => {
  for (const mutate of [
    input => { delete input.market_context.analysis_geometry; },
    input => { input.market_context.population_ref.member_set_sha256 = "0".repeat(64); },
    input => { input.market_context.analysis_geometry.geometry_sha256 = "0".repeat(64); },
    input => { input.market_context.analysis_geometry.boundary_description = "A different, unrelated region"; },
    input => { input.market_context.analysis_geometry.role = "selected_comparables"; },
    input => { input.market_context.source_refs = ["unresolved-source"]; },
    input => { input.market_context.source_refs = []; },
    input => { input.market_context.transaction_scope = "all_recorded_transfers"; },
    input => { input.market_context.assessment_digest_sha256 = "0".repeat(64); },
    input => { delete input.market_context.search_criteria; },
  ]) {
    const input = uadNeighborhoodReviewFixture(); mutate(input);
    const candidate = buildUadNeighborhoodCandidate(input);
    assert.equal(candidate.status, "incomplete"); assert.deepEqual(candidate.suggestions, []);
  }
});

test("catalog limits and exact calendar-month lookback reject lossy mapping", () => {
  for (const mutate of [
    input => { input.market_context.lookback_months = 11; },
    input => { input.market_context.lookback_months = "12"; },
    input => { input.market_context.lookback_months = 100; },
    input => { input.market_context.analysis_geometry.boundary_description = "x".repeat(1251); },
    input => { input.market_context.search_criteria = "x".repeat(1251); },
    input => { input.market_context.search_criteria = " "; },
    input => { input.target.specification_release = "future-release"; },
    input => { rebind(input, a => { a.statistics.find(s => s.id === "lowest-price").value = 0; }); },
    input => { rebind(input, a => { a.statistics.find(s => s.id === "highest-price").value = 1000000000; }); },
    input => { rebind(input, a => { a.statistics.find(s => s.id === "median-sale-price").value = 400000; }); },
  ]) {
    const input = uadNeighborhoodReviewFixture(); mutate(input);
    assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
  }
});

test("median without minimum/maximum or complete observations is not a complete sales bundle", () => {
  for (const mutate of [
    input => { input.market_context.statistic_ids.low = "unavailable"; },
    input => { rebind(input, a => { const s = a.statistics.find(s => s.id === "median-sale-price"); s.observed_count = 2; s.missing_count = 1; }); },
    input => { rebind(input, a => { a.statistics.find(s => s.id === "lowest-price").estimator_parameters.probability = 0.25; }); },
    input => { rebind(input, a => { a.statistics.find(s => s.id === "median-sale-price").estimator = "arithmetic_mean"; }); },
    input => { rebind(input, a => { a.required_statistic_ids = a.required_statistic_ids.filter(id => id !== "highest-price"); }); },
    input => { rebind(input, a => { a.populations.find(p => p.id === "sales-a").property_link_count++; }); },
  ]) {
    const input = uadNeighborhoodReviewFixture(); mutate(input);
    assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
  }
});

test("verified zero sales maps a known zero and never invents prices or active/pending counts", () => {
  const input = uadNeighborhoodReviewFixture({ zeroSales: true });
  assert.equal(input.candidate.status, "ready", JSON.stringify(input.candidate));
  const values = byKey(input.candidate);
  assert.equal(values["market_total_sales:3000.0026"], 0);
  assert.equal(Object.keys(values).length, 4);
  assert.equal(prepareUadNeighborhoodApply(input).status, "ready");
  Object.assign(input.existing_values.find(item => item.target_key === "market_total_sales:3000.0028"), {
    populated: true, value: 290000 });
  rejected(prepareUadNeighborhoodApply(input), "zero_sales_existing_prices");
});

test("unknown sales membership is not treated as a verified zero", () => {
  const input = uadNeighborhoodReviewFixture({ zeroSales: true });
  rebind(input, a => {
    const p = a.populations.find(p => p.id === "sales-a");
    p.member_count = null; p.member_set_sha256 = null; p.completeness = "incomplete"; p.reasons = ["unknown_history"];
    a.statistics[0].value = null; a.statistics[0].status = "incomplete"; a.statistics[0].reason = "unknown_history";
  });
  assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
});

test("no appraiser confirmation, incomplete selection or duplicate selection produces any writes", () => {
  for (const mutate of [
    input => { input.request.confirmed = false; },
    input => { input.request.preserve_existing = false; },
    input => { input.request.selected_suggestion_ids.pop(); },
    input => { input.request.selected_suggestion_ids.push(input.request.selected_suggestion_ids[0]); },
    input => { input.request.selected_suggestion_ids = []; },
    input => { input.request.selected_suggestion_ids[0] = "arbitrary-client-field"; },
  ]) { const input = uadNeighborhoodReviewFixture(); mutate(input); rejected(prepareUadNeighborhoodApply(input)); }
});

test("manual values are preserved even if their text equals the proposed boundary", () => {
  const input = uadNeighborhoodReviewFixture();
  const index = input.existing_values.findIndex(item => item.target_key === "market:3000.0008");
  input.existing_values[index].populated = true;
  input.existing_values[index].value = byKey(input.candidate)["market:3000.0008"];
  rejected(prepareUadNeighborhoodApply(input), "incompatible_existing_value");
  input.existing_values[index].value = "Appraiser's revised boundary";
  rejected(prepareUadNeighborhoodApply(input), "incompatible_existing_value");
});

test("unresolved, duplicate and unknown occupancy fails the entire operation", () => {
  for (const mutate of [
    input => { input.existing_values.pop(); },
    input => { input.existing_values[0].target_exists = false; },
    input => { input.existing_values[0].populated = null; },
    input => { input.existing_values.push(input.existing_values[0]); },
  ]) { const input = uadNeighborhoodReviewFixture(); mutate(input); rejected(prepareUadNeighborhoodApply(input)); }
});

test("edited filters, source snapshot, population, workfile or editor invalidate old review request", () => {
  for (const mutate of [
    input => { input.target.editor_revision++; },
    input => { input.target.attachment_revision++; },
    input => { input.request.expected_revision = "5"; },
    input => { input.request.expected_binding_digest_sha256 = "0".repeat(64); },
    input => { input.market_context.search_criteria += " Excludes seller incentives."; },
    input => { input.target.uad_workfile_id = "70000000-0000-4000-8000-000000000099"; },
    input => { input.target.report_file_id = "60000000-0000-4000-8000-000000000099"; },
    input => { rebind(input, a => { a.source_snapshots[0].revision = "new-evidence"; }); },
    input => { rebind(input, a => { a.populations.find(p => p.id === "sales-a").revision = "new-selection"; }); },
  ]) { const input = uadNeighborhoodReviewFixture(); mutate(input); rejected(prepareUadNeighborhoodApply(input)); }
});

test("same property cannot cross assignment, organization or snapshot identity", () => {
  for (const key of ["organization_id", "appraisal_case_id", "subject_snapshot_id"]) {
    const input = uadNeighborhoodReviewFixture(); input.target.scope[key] = "10000000-0000-4000-8000-000000000099";
    assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
    rejected(prepareUadNeighborhoodApply(input));
  }
});

test("signed, submitted, exported, cancelled and unknown lifecycle states prevent applying or replay", () => {
  for (const status of ["signed", "submitted", "exported", "cancelled", "unknown", null]) {
    const input = uadNeighborhoodReviewFixture(); input.target.status = status;
    rejected(prepareUadNeighborhoodApply(input), "uad_workfile_status_locked");
    const accepted = acceptedFixture(); accepted.target.status = status;
    rejected(prepareUadNeighborhoodApply(accepted), "uad_workfile_status_locked");
  }
});

test("exact receipt replay after the own revision increment has zero writes and the original receipt", () => {
  const input = acceptedFixture();
  const result = prepareUadNeighborhoodApply(input);
  assert.equal(result.status, "already_applied", JSON.stringify(result));
  assert.deepEqual(result.writes, []);
  assert.deepEqual(result.acceptance_manifest, input.accepted_receipt.core_receipt.acceptance_manifest);
  input.target.editor_revision++;
  rejected(prepareUadNeighborhoodApply(input), "stale_accepted_application");
});

test("receipt replay still requires original or current request binding and compatible values", () => {
  for (const mutate of [
    input => { input.request.expected_binding_digest_sha256 = "a".repeat(64); },
    input => { input.existing_values[0].value = 999; },
    input => { input.existing_values[0].provenance_digest = "a".repeat(64); },
    input => { input.accepted_receipt = null; },
  ]) { const input = acceptedFixture(); mutate(input); rejected(prepareUadNeighborhoodApply(input)); }
});

test("compatible reuse stays in the required group while genuinely new fields are planned", () => {
  const input = uadNeighborhoodReviewFixture();
  const original = prepareUadNeighborhoodApply(input);
  const index = input.existing_values.findIndex(item => item.target_key === "market:3000.0008");
  Object.assign(input.existing_values[index], { populated: true, value: byKey(input.candidate)["market:3000.0008"],
    provenance_digest: original.acceptance_manifest.provenance_digest });
  const result = prepareUadNeighborhoodApply(input);
  assert.equal(result.status, "ready"); assert.equal(result.writes.length, 6);
  assert.equal(result.acceptance_manifest.reused.length, 1);
  input.request.selected_suggestion_ids = input.request.selected_suggestion_ids.filter(id => !id.endsWith("market:3000.0008"));
  rejected(prepareUadNeighborhoodApply(input), "partial_atomic_group");
});

test("export reads saved acceptance evidence and the requested report snapshot, including later signed revisions", () => {
  const input = acceptedFixture();
  input.target.status = "signed"; input.target.editor_revision = 9;
  const result = projectUadNeighborhoodExport({ receipt: input.accepted_receipt, target: input.target, existing_values: input.existing_values });
  assert.equal(result.status, "ready", JSON.stringify(result));
  assert.equal(result.accepted_revision, 6); assert.equal(result.revision, 9);
  assert.equal(result.fields.length, 7);
  assert.equal(result.evidence.market_context.search_criteria, input.market_context.search_criteria);
  input.market_context.search_criteria = "A later unaccepted research update";
  assert.equal(projectUadNeighborhoodExport({ receipt: input.accepted_receipt, target: input.target,
    existing_values: input.existing_values }).evidence.market_context.search_criteria, result.evidence.market_context.search_criteria);
  assert.ok(Object.isFrozen(result.evidence.sources));
});

test("export rejects receipt corruption, changed saved values/identity, and revision before acceptance", () => {
  for (const mutate of [
    input => { input.accepted_receipt = clone(input.accepted_receipt); input.accepted_receipt.candidate.evidence.market_context.search_criteria += " changed"; },
    input => { input.target.editor_revision = 5; },
    input => { input.target.report_file_id = "60000000-0000-4000-8000-000000000099"; },
    input => { input.target.specification_release = "different-spec"; },
    input => { input.existing_values[0].value = 18; },
    input => { input.existing_values[0].populated = false; },
    input => { input.existing_values.pop(); },
  ]) {
    const input = acceptedFixture(); mutate(input);
    const result = projectUadNeighborhoodExport({ receipt: input.accepted_receipt, target: input.target, existing_values: input.existing_values });
    assert.equal(result.status, "conflict"); assert.deepEqual(result.fields, []); assert.equal(result.provenance, null);
  }
});

test("zero-sale receipt export cannot mask surviving historical price fields", () => {
  const input = acceptedFixture({ zeroSales: true });
  Object.assign(input.existing_values.find(item => item.target_key === "market_total_sales:3000.0029"), { populated: true, value: 330000 });
  assert.equal(projectUadNeighborhoodExport({ receipt: input.accepted_receipt, target: input.target,
    existing_values: input.existing_values }).status, "conflict");
});

test("zero-sale apply and export require explicit empty occupancy for every price field", () => {
  for (const key of ["market_total_sales:3000.0028", "market_total_sales:3000.0029", "market_total_sales:3000.0027"]) {
    const input = uadNeighborhoodReviewFixture({ zeroSales: true });
    input.existing_values = input.existing_values.filter(item => item.target_key !== key);
    rejected(prepareUadNeighborhoodApply(input), "unresolved_market_occupancy");
    const accepted = acceptedFixture({ zeroSales: true });
    accepted.existing_values = accepted.existing_values.filter(item => item.target_key !== key);
    assert.equal(projectUadNeighborhoodExport({ receipt: accepted.accepted_receipt, target: accepted.target,
      existing_values: accepted.existing_values }).status, "conflict");
  }
});

test("receipt detail edits cannot be concealed by recomputing its outer checksum", () => {
  const input = acceptedFixture();
  const receipt = clone(input.accepted_receipt);
  receipt.candidate.evidence.statistics.find(item => item.id === "median-sale-price").value = 999999;
  const { receipt_digest_sha256: oldDigest, ...body } = receipt;
  receipt.receipt_digest_sha256 = assessmentEvidenceDigest(body);
  const result = projectUadNeighborhoodExport({ receipt, target: input.target, existing_values: input.existing_values });
  assert.equal(result.status, "conflict");
  assert.equal(result.issues[0].code, "changed_uad_neighborhood_receipt");
});

test("inconsistent or unknown signature state is locked even when status appears editable", () => {
  for (const state of [{ signed_at: "2024-07-01T00:00:00Z" }, { has_signatures: true },
    { has_signatures: null }, { signed_at: undefined }]) {
    const input = uadNeighborhoodReviewFixture(); Object.assign(input.target, state);
    rejected(prepareUadNeighborhoodApply(input), "uad_workfile_status_locked");
  }
});

test("candidate and receipt construction do not mutate inputs; source generation time is not observation time", () => {
  const input = uadNeighborhoodReviewFixture();
  const before = clone(input);
  const candidate = buildUadNeighborhoodCandidate(input);
  const plan = prepareUadNeighborhoodApply(input);
  buildUadNeighborhoodReceipt(candidate, plan, 6);
  assert.deepEqual(input, before);
  assert.equal(candidate.evidence.sources[0].observed_at, input.assessment.source_snapshots[0].observed_at);
  assert.notEqual(candidate.evidence.sources[0].observed_at, input.assessment.generated_at);
  const regenerated = { ...input, assessment: { ...input.assessment, generated_at: "2026-09-06T00:00:00.000Z" } };
  assert.equal(buildUadNeighborhoodCandidate(regenerated).candidate_digest_sha256, candidate.candidate_digest_sha256);
  assert.throws(() => buildUadNeighborhoodReceipt(candidate, plan, 7), /invalid_uad_neighborhood_receipt/);
});

test("lookback is end-anchored and inclusive across leap years and clipped month ends", () => {
  for (const [start, end, months] of [
    ["2024-02-01", "2024-02-29", 1], ["2023-03-01", "2024-02-29", 12],
    ["2024-05-16", "2024-06-15", 1], ["2024-02-29", "2024-03-30", 1],
  ]) {
    const input = uadNeighborhoodReviewFixture();
    const period = { start_date: start, end_date: end, date_basis: "closing_date" };
    rebind(input, a => {
      a.effective_date = end; a.data_cutoff = end; a.observation_period = period;
      for (const p of a.populations) p.observation_period = p.kind === "transactions" ? period
        : { start_date: end, end_date: end, date_basis: "effective_date" };
    });
    Object.assign(input.target, { effective_date: end, data_cutoff: end });
    Object.assign(input.market_context, { observation_period: period, lookback_months: months,
      search_criteria: `Closed single-property sales from ${start} through ${end}.` });
    const candidate = buildUadNeighborhoodCandidate(input);
    assert.equal(candidate.status, "ready", JSON.stringify(candidate));
    input.market_context.lookback_months++;
    assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
  }
});

test("one-sale and two-sale price summaries must obey exact sample arithmetic", () => {
  for (const [count, low, median, high, valid] of [
    [1, 300000, 330000, 390000, false], [2, 300000, 330000, 390000, false],
    [1, 330000, 330000, 330000, true], [2, 300000, 345000, 390000, true],
    [2, 300000.01, 300000.02, 300000.02, false],
    [2, 300000.01, (300000.01 + 300000.02) / 2, 300000.02, true],
  ]) {
    const input = smallSampleFixture(count, low, median, high);
    const candidate = buildUadNeighborhoodCandidate(input);
    assert.equal(candidate.status, valid ? "ready" : "incomplete", JSON.stringify({ count, low, median, high, candidate }));
    if (!valid) {
      assert.deepEqual(candidate.suggestions, []);
      rejected(prepareUadNeighborhoodApply(input), "neighborhood_candidate_incomplete");
    } else {
      input.request.expected_candidate_digest_sha256 = candidate.candidate_digest_sha256;
      input.request.expected_binding_digest_sha256 = candidate.attachment.binding_digest_sha256;
      assert.equal(prepareUadNeighborhoodApply(input).status, "ready");
    }
  }
});

test("fully bound historical one-sale and two-sale receipts fail current receipt construction, export and replay", () => {
  for (const [count, low, median, high] of [
    [1, 300000, 330000, 390000], [2, 300000, 330000, 390000],
    [2, 300000.01, 300000.02, 300000.02],
  ]) {
    const { input, plan, acceptedRevision } = historicalSmallSampleFixture(count, low, median, high);
    const before = clone(input);
    assert.throws(() => buildUadNeighborhoodReceipt(input.candidate, plan, acceptedRevision),
      /invalid_uad_neighborhood_receipt/);
    const exported = projectUadNeighborhoodExport({ receipt: input.accepted_receipt,
      target: input.target, existing_values: input.existing_values });
    assert.equal(exported.status, "conflict");
    // Not changed_uad_neighborhood_receipt: all receipt/manifest checks passed;
    // the shared replay can no longer satisfy the current UAD final-group rule.
    assert.deepEqual(exported.issues, [{ code: "export_values_or_receipt_changed" }]);
    assert.deepEqual(exported.fields, []);
    assert.equal(exported.provenance, null);
    rejected(prepareUadNeighborhoodApply(input), "neighborhood_candidate_incomplete");
    assert.deepEqual(input, before);
  }
});

test("valid historical small-sample receipts retain exact current construction, replay and export", () => {
  for (const [count, low, median, high] of [
    [1, 330000, 330000, 330000], [2, 300000, 345000, 390000],
    [2, 300000.01, (300000.01 + 300000.02) / 2, 300000.02],
  ]) {
    const { input, plan, acceptedRevision } = historicalSmallSampleFixture(count, low, median, high);
    const constructed = buildUadNeighborhoodReceipt(input.candidate, plan, acceptedRevision);
    assert.deepEqual(constructed, input.accepted_receipt);
    const replay = prepareUadNeighborhoodApply(input);
    assert.equal(replay.status, "already_applied", JSON.stringify(replay));
    assert.deepEqual(replay.writes, []);
    assert.deepEqual(replay.acceptance_manifest, plan.acceptance_manifest);
    const exported = projectUadNeighborhoodExport({ receipt: input.accepted_receipt,
      target: input.target, existing_values: input.existing_values });
    assert.equal(exported.status, "ready", JSON.stringify(exported));
    assert.equal(exported.accepted_revision, acceptedRevision);
    assert.equal(exported.revision, acceptedRevision);
    assert.equal(exported.fields.length, 7);
    const values = Object.fromEntries(exported.fields.map(item => [item.field_key, item.value]));
    assert.equal(values["market_total_sales:3000.0026"], count);
    assert.equal(values["market_total_sales:3000.0028"], low);
    assert.equal(values["market_total_sales:3000.0029"], median);
    assert.equal(values["market_total_sales:3000.0027"], high);
    assert.equal(exported.receipt_digest_sha256, constructed.receipt_digest_sha256);
  }
});

const canonicalBytes = value => Buffer.byteLength(canonicalAssessmentJson(value), "utf8");
function capacityFixture({ sources, padding, extra, editorRevision = 5, zeroSales = false,
  longRevisions = false } = {}) {
  const input = uadNeighborhoodReviewFixture({ zeroSales });
  input.target.editor_revision = editorRevision;
  input.request.expected_revision = editorRevision;
  rebind(input, assessment => {
    if (sources !== undefined) {
      // Synthetic evidence fan-out only: this is not a publication/source-authority fixture.
      const original = assessment.source_snapshots[0];
      assessment.source_snapshots = [original, ...Array.from({ length: sources - 1 }, (_, index) => ({
        ...original, id: `source-${String(index).padStart(4, "0")}`,
      }))];
      assessment.populations.find(item => item.id === "sales-a").source_refs =
        assessment.source_snapshots.map(item => item.id);
    }
    if (longRevisions) {
      assessment.source_snapshots.forEach(item => { item.revision = "s".repeat(200); });
      assessment.populations.forEach(item => { item.revision = "p".repeat(200); });
    }
    const uncertainty = assessment.statistics.find(item => item.id === (zeroSales ? "sale-count" : "median-sale-price")).uncertainty;
    if (padding !== undefined) uncertainty.extra = "x".repeat(padding);
    if (extra !== undefined) uncertainty.extra = extra;
  });
  input.market_context.population_ref.revision = input.assessment.populations.find(item => item.id === "sales-a").revision;
  return input;
}

function reviewedCapacityCandidate(input) {
  const candidate = buildUadNeighborhoodCandidate(input);
  assert.equal(candidate.status, "ready", JSON.stringify(candidate.issues));
  input.candidate = candidate;
  Object.assign(input.request, { expected_candidate_digest_sha256: candidate.candidate_digest_sha256,
    expected_binding_digest_sha256: candidate.attachment.binding_digest_sha256,
    selected_suggestion_ids: candidate.suggestions.map(item => item.id) });
  return candidate;
}

// Reconstruct pre-capacity-check historical evidence with exact current shared
// bindings and unchanged valid seven-field values. This fixture deliberately
// avoids the new UAD capacity gate; it does not bypass a production write path.
function historicalCapacityFixture(options) {
  const input = capacityFixture(options);
  const candidate = clone(input.candidate);
  assert.deepEqual(candidate.group, input.assessment.application_group);
  Object.assign(candidate.evidence, { assessment_digest_sha256: input.assessment.evidence_digest_sha256,
    market_context: clone(input.market_context),
    populations: input.assessment.populations.filter(item => input.assessment.required_population_ids.includes(item.id)),
    statistics: candidate.evidence.statistics.map(item => input.assessment.statistics.find(statistic => statistic.id === item.id)),
    sources: input.assessment.source_snapshots.filter(item => candidate.group.source_refs.includes(item.id)) });
  candidate.attachment = buildNeighborhoodAttachment(input.assessment, { ...input.target,
    source_digest_sha256: assessmentEvidenceDigest(candidate.evidence),
    mapped_manifest_sha256: neighborhoodMappedManifestDigest(candidate.suggestions),
    mapper_version: candidate.mapper_version });
  candidate.candidate_digest_sha256 = assessmentEvidenceDigest({
    application_identity_sha256: candidate.attachment.application_identity_sha256, mapper_version: candidate.mapper_version });
  input.candidate = candidate;
  Object.assign(input.request, { expected_candidate_digest_sha256: candidate.candidate_digest_sha256,
    expected_binding_digest_sha256: candidate.attachment.binding_digest_sha256 });
  const unchangedFields = candidate.suggestions.map(({ target_key, value }) => ({ target_key, value }))
    .sort((a, b) => a.target_key < b.target_key ? -1 : a.target_key > b.target_key ? 1 : 0);
  const sharedInput = { attachment: candidate.attachment, group: candidate.group, suggestions: candidate.suggestions,
    selected_ids: input.request.selected_suggestion_ids,
    expected_binding_digest: candidate.attachment.binding_digest_sha256,
    current_application_identity_sha256: candidate.attachment.application_identity_sha256,
    current_editor_revision: input.target.editor_revision, existing_values: input.existing_values };
  const validateUnchangedFields = values => {
    assert.deepEqual(values, unchangedFields);
    return { valid: true, issues: [] };
  };
  const plan = prepareNeighborhoodApplicationGroup({ ...sharedInput, validate_final_group: validateUnchangedFields });
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  const freshInput = clone(input);
  const acceptedRevision = input.target.editor_revision + 1;
  const body = { receipt_version: 1, candidate,
    core_receipt: buildNeighborhoodApplicationReceipt(plan, acceptedRevision) };
  input.accepted_receipt = { ...body, receipt_digest_sha256: assessmentEvidenceDigest(body) };
  input.existing_values = candidate.suggestions.map(item => ({ target_key: item.target_key,
    target_exists: true, populated: true, value: item.value,
    provenance_digest: plan.acceptance_manifest.provenance_digest }));
  input.target.editor_revision = acceptedRevision;
  input.target.attachment_revision++;
  let reachedFinalValidator = false;
  const replay = prepareNeighborhoodApplicationGroup({ ...sharedInput,
    current_editor_revision: acceptedRevision, existing_values: input.existing_values,
    accepted_application: body.core_receipt, validate_final_group: values => {
      reachedFinalValidator = true;
      return validateUnchangedFields(values);
    } });
  assert.equal(reachedFinalValidator, true);
  assert.equal(replay.status, "already_applied", JSON.stringify(replay.conflicts));
  assert.deepEqual(replay.writes, []);
  assert.deepEqual(replay.acceptance_manifest, plan.acceptance_manifest);
  return { input, freshInput, plan, acceptedRevision };
}

test("997 sources and two populations fit exactly 1000 emitted boundary evidence references", () => {
  const input = capacityFixture({ sources: 997 });
  const before = clone(input);
  const candidate = buildUadNeighborhoodCandidate(input);
  assert.equal(candidate.status, "ready", JSON.stringify(candidate.issues));
  assert.equal(candidate.group.source_refs.length, 997);
  assert.equal(candidate.group.population_refs.length, 2);
  for (const key of ["market:3000.0008", "market:3000.0010"]) {
    assert.equal(candidate.suggestions.find(item => item.target_key === key).evidence_refs.length, 1000);
  }
  assert.equal(canonicalBytes(candidate), 388911);
  assert.deepEqual(input, before);
  reviewedCapacityCandidate(input);
  const plan = prepareUadNeighborhoodApply(input);
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  assert.equal(buildUadNeighborhoodReceipt(candidate, plan, 6).core_receipt.accepted_editor_revision, 6);
});

test("998 sources and two populations fail candidate capacity without truncating required evidence", () => {
  const input = capacityFixture({ sources: 998 });
  const before = clone(input);
  const candidate = buildUadNeighborhoodCandidate(input);
  assert.equal(input.assessment.application_group.source_refs.length, 998);
  assert.equal(candidate.status, "incomplete");
  assert.deepEqual(candidate.suggestions, []);
  assert.deepEqual(candidate.selected_suggestion_ids, []);
  rejected(prepareUadNeighborhoodApply(input), "neighborhood_candidate_incomplete");
  assert.deepEqual(input, before);
});

test("the complete all-new receipt fits at exactly 1500000 canonical bytes", () => {
  const input = capacityFixture({ padding: 1486237 });
  const before = clone(input);
  const candidate = buildUadNeighborhoodCandidate(input);
  assert.equal(candidate.status, "ready", JSON.stringify(candidate.issues));
  assert.equal(canonicalBytes(candidate), 1496679);
  assert.deepEqual(input, before);
  reviewedCapacityCandidate(input);
  const plan = prepareUadNeighborhoodApply(input);
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  const receipt = buildUadNeighborhoodReceipt(candidate, plan, 6);
  assert.equal(canonicalBytes(receipt), 1500000);
  assert.ok(assertNeighborhoodJsonbStorage(receipt) < 2000000);
  assert.equal(receipt.core_receipt.acceptance_manifest.applied.length, 7);
});

test("one byte over the full receipt ceiling fails candidate capacity despite a bounded candidate", () => {
  const input = capacityFixture({ padding: 1486238 });
  const before = clone(input);
  const candidate = buildUadNeighborhoodCandidate(input);
  assert.equal(candidate.status, "incomplete");
  assert.deepEqual(candidate.issues, [{ code: "invalid_neighborhood_assessment:json_bytes" }]);
  assert.deepEqual(candidate.suggestions, []);
  assert.deepEqual(candidate.selected_suggestion_ids, []);
  assert.deepEqual(input, before);
  const historical = historicalCapacityFixture({ padding: 1486238 });
  assert.equal(canonicalBytes(historical.input.candidate), 1496680);
  rejected(prepareUadNeighborhoodApply(historical.freshInput), "invalid_neighborhood_assessment:json_bytes");
});

test("public candidate arguments cannot disable the full-receipt capacity check", () => {
  const input = capacityFixture({ padding: 1486238 });
  const before = clone(input);
  for (const args of [[{ ...input, checkCapacity: false }], [input, false],
    [{ ...input, checkCapacity: false }, false]]) {
    const candidate = buildUadNeighborhoodCandidate(...args);
    assert.equal(candidate.status, "incomplete");
    assert.deepEqual(candidate.issues, [{ code: "invalid_neighborhood_assessment:json_bytes" }]);
    assert.deepEqual(candidate.suggestions, []);
    assert.deepEqual(candidate.selected_suggestion_ids, []);
  }
  assert.deepEqual(input, before);
});

test("small canonical evidence with exponent expansion fails JSONB candidate and actual-plan capacity", () => {
  const input = capacityFixture({ extra: Array(7000).fill(1e300) });
  const before = clone(input);
  assert.ok(canonicalBytes(input.assessment) < 100000);
  const candidate = buildUadNeighborhoodCandidate(input);
  assert.equal(candidate.status, "incomplete");
  assert.deepEqual(candidate.issues, [{ code: "neighborhood_jsonb_storage_limit:bytes" }]);
  assert.deepEqual(candidate.suggestions, []);
  assert.deepEqual(input, before);
  const historical = historicalCapacityFixture({ extra: Array(7000).fill(1e300) });
  assert.equal(canonicalBytes(historical.input.accepted_receipt), 62762);
  rejected(prepareUadNeighborhoodApply(historical.freshInput), "neighborhood_jsonb_storage_limit:bytes");
});

test("fully bound historical receipts over canonical or JSONB limits fail construction, replay and export", () => {
  for (const [options, code] of [
    [{ padding: 1486238 }, "invalid_neighborhood_assessment:json_bytes"],
    [{ extra: Array(7000).fill(1e300) }, "neighborhood_jsonb_storage_limit:bytes"],
  ]) {
    const { input, plan, acceptedRevision } = historicalCapacityFixture(options);
    const before = clone(input);
    assert.throws(() => buildUadNeighborhoodReceipt(input.candidate, plan, acceptedRevision),
      error => error.message === code);
    const exported = projectUadNeighborhoodExport({ receipt: input.accepted_receipt,
      target: input.target, existing_values: input.existing_values });
    assert.equal(exported.status, "conflict");
    assert.deepEqual(exported.issues, [{ code }]);
    assert.deepEqual(exported.fields, []);
    assert.equal(exported.provenance, null);
    rejected(prepareUadNeighborhoodApply(input), code);
    assert.deepEqual(input, before);
  }
});

test("JSONB-invalid captured strings stay invalid in fully bound historical receipts", () => {
  for (const [extra, code] of [
    ["\u0000", "neighborhood_jsonb_storage_invalid:nul_string"],
    ["\ud800", "neighborhood_jsonb_storage_invalid:unpaired_surrogate"],
  ]) {
    const { input, plan, acceptedRevision } = historicalCapacityFixture({ extra });
    assert.doesNotThrow(() => canonicalAssessmentJson(input.accepted_receipt));
    assert.deepEqual(buildUadNeighborhoodCandidate(input).issues, [{ code }]);
    assert.throws(() => buildUadNeighborhoodReceipt(input.candidate, plan, acceptedRevision),
      error => error.message === code);
    const exported = projectUadNeighborhoodExport({ receipt: input.accepted_receipt,
      target: input.target, existing_values: input.existing_values });
    assert.equal(exported.status, "conflict");
    assert.deepEqual(exported.issues, [{ code }]);
    rejected(prepareUadNeighborhoodApply(input), code);
  }
});

test("all 126 positive and 14 zero-sale mixed partitions fit below all-new across revision and identifier boundaries", () => {
  let partitions = 0;
  for (const zeroSales of [false, true]) for (const longRevisions of [false, true]) {
    const input = capacityFixture({ zeroSales, longRevisions, editorRevision: longRevisions ? 9 : 8 });
    reviewedCapacityCandidate(input);
    const allNew = prepareUadNeighborhoodApply(input);
    assert.equal(allNew.status, "ready", JSON.stringify(allNew.conflicts));
    const acceptedRevision = input.target.editor_revision + 1;
    const maximum = buildUadNeighborhoodReceipt(input.candidate, allNew, acceptedRevision);
    const maximumCanonical = canonicalBytes(maximum);
    const maximumStorage = assertNeighborhoodJsonbStorage(maximum);
    assert.equal(input.candidate.attachment.application_identity_sha256.length, 64);
    assert.equal(input.candidate.attachment.uad_workfile_id.length, 36);
    if (longRevisions) {
      assert.equal(input.candidate.evidence.sources[0].revision.length, 200);
      assert.equal(input.candidate.evidence.market_context.population_ref.revision.length, 200);
    }
    const suggestions = input.candidate.suggestions;
    const expectedPartitions = zeroSales ? 14 : 126;
    for (let mask = 1; mask < 2 ** suggestions.length - 1; mask++) {
      const mixed = clone(input);
      let reused = 0;
      suggestions.forEach((item, index) => {
        if (!(mask & (1 << index))) return;
        reused++;
        Object.assign(mixed.existing_values.find(row => row.target_key === item.target_key), {
          populated: true, value: item.value, provenance_digest: allNew.acceptance_manifest.provenance_digest,
        });
      });
      const before = clone(mixed);
      const plan = prepareUadNeighborhoodApply(mixed);
      assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
      assert.equal(plan.writes.length, suggestions.length - reused);
      assert.equal(plan.acceptance_manifest.reused.length, reused);
      const receipt = buildUadNeighborhoodReceipt(input.candidate, plan, acceptedRevision);
      assert.equal(canonicalBytes(receipt), maximumCanonical - 1);
      assert.equal(assertNeighborhoodJsonbStorage(receipt), maximumStorage - 2);
      assert.deepEqual(mixed, before);
      partitions++;
    }
    assert.equal(2 ** suggestions.length - 2, expectedPartitions);
  }
  assert.equal(partitions, 280);
});

test("actual mixed plan can fit exactly when the conservative all-new preview exceeds capacity by one byte", () => {
  const { freshInput: input, plan: allNew } = historicalCapacityFixture({ padding: 1486238 });
  assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
  Object.assign(input.existing_values[0], { populated: true,
    value: byKey(input.candidate)[input.existing_values[0].target_key],
    provenance_digest: allNew.acceptance_manifest.provenance_digest });
  const before = clone(input);
  const plan = prepareUadNeighborhoodApply(input);
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  assert.equal(plan.writes.length, 6);
  assert.equal(plan.acceptance_manifest.reused.length, 1);
  assert.equal(canonicalBytes(buildUadNeighborhoodReceipt(input.candidate, plan, 6)), 1500000);
  assert.deepEqual(input, before);
});

test("exact-size accepted revisions 9 and 10 replay without rehearsing a larger synthetic next receipt", () => {
  for (const [editorRevision, padding] of [[8, 1486237], [9, 1486236]]) {
    const { input, freshInput, plan, acceptedRevision } = historicalCapacityFixture({ padding, editorRevision });
    assert.equal(canonicalBytes(input.accepted_receipt), 1500000);
    assert.equal(buildUadNeighborhoodCandidate(freshInput).status, "ready");
    assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
    const before = clone(input);
    const replay = prepareUadNeighborhoodApply(input);
    assert.equal(replay.status, "already_applied", JSON.stringify(replay.conflicts));
    assert.deepEqual(replay.writes, []);
    assert.deepEqual(replay.acceptance_manifest, plan.acceptance_manifest);
    assert.equal(replay.acceptance_manifest.base_editor_revision, editorRevision);
    assert.equal(input.accepted_receipt.core_receipt.accepted_editor_revision, acceptedRevision);
    const exported = projectUadNeighborhoodExport({ receipt: input.accepted_receipt,
      target: { ...input.target, status: "signed", editor_revision: acceptedRevision + 1 }, existing_values: input.existing_values });
    assert.equal(exported.status, "ready", JSON.stringify(exported.issues));
    assert.equal(exported.accepted_revision, acceptedRevision);
    assert.equal(exported.revision, acceptedRevision + 1);
    assert.equal(exported.receipt_digest_sha256, input.accepted_receipt.receipt_digest_sha256);
    assert.deepEqual(input, before);
  }
});

test("MAX_SAFE_INTEGER acceptance replays although a new next-revision receipt is impossible", () => {
  const { input, freshInput, plan } = historicalCapacityFixture({ editorRevision: Number.MAX_SAFE_INTEGER - 1 });
  assert.equal(input.accepted_receipt.core_receipt.accepted_editor_revision, Number.MAX_SAFE_INTEGER);
  assert.equal(buildUadNeighborhoodCandidate(freshInput).status, "ready");
  assert.equal(buildUadNeighborhoodCandidate(input).status, "incomplete");
  const before = clone(input);
  const replay = prepareUadNeighborhoodApply(input);
  assert.equal(replay.status, "already_applied", JSON.stringify(replay.conflicts));
  assert.deepEqual(replay.writes, []);
  assert.deepEqual(replay.acceptance_manifest, plan.acceptance_manifest);
  assert.equal(projectUadNeighborhoodExport({ receipt: input.accepted_receipt,
    target: input.target, existing_values: input.existing_values }).status, "ready");
  assert.deepEqual(input, before);
});

test("capacity checks preserve concrete manual, selection, signature and stale replay errors", () => {
  const { freshInput } = historicalCapacityFixture({ padding: 1486238 });
  for (const [mutate, code] of [
    [input => { input.target.status = "signed"; }, "uad_workfile_status_locked"],
    [input => { input.request.confirmed = false; }, "appraiser_confirmation_required"],
    [input => { input.request.selected_suggestion_ids.pop(); }, "partial_atomic_group"],
    [input => { Object.assign(input.existing_values[0], { populated: true,
      value: byKey(input.candidate)[input.existing_values[0].target_key] }); }, "incompatible_existing_value"],
  ]) {
    const input = clone(freshInput); mutate(input);
    const before = clone(input);
    rejected(prepareUadNeighborhoodApply(input), code);
    assert.deepEqual(input, before);
  }
  const { input } = historicalCapacityFixture({ padding: 1486236, editorRevision: 9 });
  input.target.editor_revision = 11;
  rejected(prepareUadNeighborhoodApply(input), "stale_accepted_application");
});

test("capacity-only candidate rehearsal exposes no write plan, receipt, occupancy or confirmation", () => {
  for (const zeroSales of [false, true]) {
    const input = uadNeighborhoodReviewFixture({ zeroSales });
    input.target.status = "signed";
    input.request.confirmed = false;
    const before = clone(input);
    const candidate = buildUadNeighborhoodCandidate(input);
    assert.equal(candidate.status, "ready", JSON.stringify(candidate.issues));
    assert.deepEqual(Object.keys(candidate).sort(), ["attachment", "candidate_digest_sha256", "candidate_version",
      "evidence", "group", "mapper_version", "omissions", "selected_suggestion_ids", "status", "suggestions"]);
    assert.deepEqual(candidate.selected_suggestion_ids, []);
    rejected(prepareUadNeighborhoodApply(input), "uad_workfile_status_locked");
    assert.deepEqual(input, before);
  }
});
