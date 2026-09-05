import assert from "node:assert/strict";
import test from "node:test";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment } from "../src/services/neighborhoodAssessment/contract.js";
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
