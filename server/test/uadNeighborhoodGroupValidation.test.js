import assert from "node:assert/strict";
import test from "node:test";

import { prepareUadNeighborhoodSectionValidation } from "../src/modules/uad/neighborhoodGroupValidation.js";
import { buildUadNeighborhoodCandidate, buildUadNeighborhoodReceipt, prepareUadNeighborhoodApply } from "../src/modules/uad/neighborhoodReview.js";
import { validateCompleteSection } from "../src/modules/uad/editor.js";
import { getUadField, UAD_PHASE_ONE_FIELDS, validateUadSectionValues } from "../src/modules/uad/fieldCatalog.js";
import { assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment, canonicalAssessmentJson } from "../src/services/neighborhoodAssessment/contract.js";
import { buildNeighborhoodApplicationReceipt, neighborhoodMappedManifestDigest, prepareNeighborhoodApplicationGroup } from "../src/services/neighborhoodAssessment/applicationGroup.js";
import { uadNeighborhoodReviewFixture } from "./fixtures/uadNeighborhoodReviewFixture.js";

const clone = value => structuredClone(value);
const KEYS = ["market:3000.0008", "market:3000.0010", "market:3000.0009", "market_total_sales:3000.0026",
  "market_total_sales:3000.0028", "market_total_sales:3000.0029", "market_total_sales:3000.0027"];
const PRICE_KEYS = KEYS.slice(4);
const RESULT_KEYS = ["validation_version", "status", "http_status", "conflicts", "candidate_digest_sha256",
  "acceptance_manifest", "writes", "normalized_writes", "normalized_final_members", "final_slots", "section_findings"].sort();
const normalized = ({ target_key, value }) => ({ context_key: target_key.split(":")[0], uid: target_key.split(":")[1], entity_id: null, value });
const sortValues = values => [...values].sort((a, b) => `${a.context_key}:${a.uid}`.localeCompare(`${b.context_key}:${b.uid}`, "en"));
const uuid = index => `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

// Capture shared identities and their complete nested freeze state BEFORE any
// test invokes composition. Do not infer this from data-only output assertions:
// a helper could accidentally freeze an internal normalized field definition.
const SHARED_FIELD_REFERENCES = UAD_PHASE_ONE_FIELDS.map(field => ({ context: field.contextKey,
  uid: field.uid, field: getUadField(field.contextKey, field.uid) }));
const SHARED_CATALOG_FREEZE = new Map();
function captureCatalogFreeze(value) {
  if (!value || typeof value !== "object" || SHARED_CATALOG_FREEZE.has(value)) return;
  SHARED_CATALOG_FREEZE.set(value, Object.isFrozen(value));
  for (const child of Object.values(value)) captureCatalogFreeze(child);
}
for (const { field } of SHARED_FIELD_REFERENCES) captureCatalogFreeze(field);

function assertSharedCatalogUnchanged() {
  for (const { context, uid, field } of SHARED_FIELD_REFERENCES) assert.equal(getUadField(context, uid), field);
  for (const [object, frozen] of SHARED_CATALOG_FREEZE) assert.equal(Object.isFrozen(object), frozen,
    "Composition must not change shared catalog object/array freeze state");
}

function canonicalRow(input, key, value, extra = {}) {
  return { workfile_id: input.target.uad_workfile_id, entity_id: null,
    field_context: key.split(":")[0], uad_uid: key.split(":")[1], value, ...extra };
}

function wrap(raw) {
  return clone({ assessment: raw.assessment, target: raw.target, market_context: raw.market_context,
    existing_values: raw.existing_values, request: raw.request, accepted_receipt: raw.accepted_receipt ?? null,
    canonical_state: { state_version: 1, workfile_id: raw.target.uad_workfile_id,
      editor_revision: raw.target.editor_revision, complete: true,
      rows: raw.existing_values.filter(item => item.populated).map(item => canonicalRow(raw, item.target_key, item.value)),
      entities: [], assets: [] } });
}
const fixture = options => wrap(uadNeighborhoodReviewFixture(options));

function shape(result) {
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
  assert.equal(result.validation_version, 1);
  for (const item of [...result.normalized_writes, ...result.normalized_final_members]) {
    assert.deepEqual(Object.keys(item).sort(), ["context_key", "entity_id", "uid", "value"]);
    assert.equal(item.entity_id, null);
  }
}

function rejected(input, code) {
  const result = prepareUadNeighborhoodSectionValidation(input);
  shape(result);
  assert.equal(result.status, "conflict");
  assert.equal(result.http_status, 409);
  for (const key of ["writes", "normalized_writes", "normalized_final_members", "final_slots"]) assert.deepEqual(result[key], []);
  for (const key of ["candidate_digest_sha256", "acceptance_manifest", "section_findings"]) assert.equal(result[key], null);
  assert.ok(result.conflicts.length > 0);
  if (code) assert.ok(result.conflicts.some(item => item.code === code), JSON.stringify(result.conflicts));
  return result;
}

function directFindings(input, finalMembers) {
  const validation = validateUadSectionValues("market", finalMembers, { allowIncomplete: false });
  assert.deepEqual(validation.errors, []);
  return validateCompleteSection("market", input.canonical_state.rows, validation.normalized,
    input.canonical_state.entities, input.canonical_state.assets);
}

function reviewed(raw) {
  raw.candidate = buildUadNeighborhoodCandidate(raw);
  assert.equal(raw.candidate.status, "ready", JSON.stringify(raw.candidate.issues));
  Object.assign(raw.request, { expected_candidate_digest_sha256: raw.candidate.candidate_digest_sha256,
    expected_binding_digest_sha256: raw.candidate.attachment.binding_digest_sha256,
    expected_revision: raw.target.editor_revision, selected_suggestion_ids: raw.candidate.suggestions.map(item => item.id) });
  return raw;
}

function accept(raw) {
  const plan = prepareUadNeighborhoodApply(raw);
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  raw.accepted_receipt = buildUadNeighborhoodReceipt(raw.candidate, plan, raw.target.editor_revision + 1);
  raw.existing_values = raw.existing_values.map(row => {
    const member = raw.candidate.suggestions.find(item => item.target_key === row.target_key);
    return member ? { ...row, populated: true, value: member.value, provenance_digest: plan.acceptance_manifest.provenance_digest } : row;
  });
  raw.target.editor_revision++;
  raw.target.attachment_revision++;
  return { input: wrap(raw), plan };
}

function reuse(raw, keys) {
  const plan = prepareUadNeighborhoodApply(raw);
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  for (const key of keys) {
    const item = raw.candidate.suggestions.find(member => member.target_key === key);
    Object.assign(raw.existing_values.find(row => row.target_key === key), { populated: true,
      value: item.value, provenance_digest: plan.acceptance_manifest.provenance_digest });
  }
  return raw;
}

function rebind(raw, modify) {
  const assessment = clone(raw.assessment);
  modify(assessment);
  raw.assessment = buildNeighborhoodAssessment(assessment);
  raw.market_context.assessment_digest_sha256 = raw.assessment.evidence_digest_sha256;
  raw.market_context.population_ref = Object.fromEntries(["id", "revision", "member_set_sha256"]
    .map(key => [key, raw.assessment.populations.find(item => item.id === "sales-a")[key]]));
  return raw;
}

function smallSample(count, low, median, high) {
  return rebind(uadNeighborhoodReviewFixture(), assessment => {
    Object.assign(assessment.populations.find(item => item.id === "sales-a"), { member_count: count,
      property_link_count: count, unique_property_count: count,
      member_set_sha256: assessmentEvidenceDigest(Array.from({ length: count }, (_, index) => `sale-${index}`)) });
    for (const statistic of assessment.statistics) Object.assign(statistic, { observed_count: count,
      denominator_count: count, value: { "sale-count": count, "lowest-price": low,
        "median-sale-price": median, "highest-price": high }[statistic.id] });
  });
}

// Historical data construction only: reproduce an internally consistent old
// receipt, using the shared manifest API. No production validator is replaced.
// The shared replay control proves this is not merely a broken outer checksum.
function historical(raw, values = {}) {
  const candidate = clone(raw.candidate);
  candidate.group = raw.assessment.application_group;
  candidate.suggestions = candidate.suggestions.map(item => ({ ...item, application_group_id: candidate.group.id,
    value: Object.hasOwn(values, item.target_key) ? values[item.target_key] : item.value }));
  Object.assign(candidate.evidence, { assessment_digest_sha256: raw.assessment.evidence_digest_sha256,
    market_context: clone(raw.market_context),
    populations: raw.assessment.populations.filter(item => raw.assessment.required_population_ids.includes(item.id)),
    statistics: candidate.evidence.statistics.map(item => raw.assessment.statistics.find(statistic => statistic.id === item.id)),
    sources: raw.assessment.source_snapshots.filter(item => candidate.group.source_refs.includes(item.id)) });
  candidate.attachment = buildNeighborhoodAttachment(raw.assessment, { ...raw.target,
    source_digest_sha256: assessmentEvidenceDigest(candidate.evidence),
    mapped_manifest_sha256: neighborhoodMappedManifestDigest(candidate.suggestions), mapper_version: candidate.mapper_version });
  candidate.candidate_digest_sha256 = assessmentEvidenceDigest({ application_identity_sha256: candidate.attachment.application_identity_sha256,
    mapper_version: candidate.mapper_version });
  raw.candidate = candidate;
  Object.assign(raw.request, { expected_candidate_digest_sha256: candidate.candidate_digest_sha256,
    expected_binding_digest_sha256: candidate.attachment.binding_digest_sha256,
    expected_revision: raw.target.editor_revision, selected_suggestion_ids: candidate.suggestions.map(item => item.id) });
  const finalValues = candidate.suggestions.map(({ target_key, value }) => ({ target_key, value }))
    .sort((a, b) => a.target_key < b.target_key ? -1 : a.target_key > b.target_key ? 1 : 0);
  const sharedInput = { attachment: candidate.attachment, group: candidate.group, suggestions: candidate.suggestions,
    selected_ids: raw.request.selected_suggestion_ids, expected_binding_digest: candidate.attachment.binding_digest_sha256,
    current_application_identity_sha256: candidate.attachment.application_identity_sha256,
    current_editor_revision: raw.target.editor_revision, existing_values: raw.existing_values };
  const historicalCheck = members => { assert.deepEqual(members, finalValues); return { valid: true, issues: [] }; };
  const plan = prepareNeighborhoodApplicationGroup({ ...sharedInput, validate_final_group: historicalCheck });
  assert.equal(plan.status, "ready", JSON.stringify(plan.conflicts));
  const body = { receipt_version: 1, candidate, core_receipt: buildNeighborhoodApplicationReceipt(plan, raw.target.editor_revision + 1) };
  raw.accepted_receipt = { ...body, receipt_digest_sha256: assessmentEvidenceDigest(body) };
  raw.existing_values = candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true,
    populated: true, value: item.value, provenance_digest: plan.acceptance_manifest.provenance_digest }));
  raw.target.editor_revision++; raw.target.attachment_revision++;
  let finalReached = false;
  const control = prepareNeighborhoodApplicationGroup({ ...sharedInput, current_editor_revision: raw.target.editor_revision,
    existing_values: raw.existing_values, accepted_application: body.core_receipt, validate_final_group: members => {
      finalReached = true; return historicalCheck(members);
    } });
  assert.equal(finalReached, true); assert.equal(control.status, "already_applied"); assert.deepEqual(control.writes, []);
  return { raw, input: wrap(raw), plan };
}

test("positive group preserves the exact public result shape, seven slots and actual catalog inputs", () => {
  const input = fixture();
  const plan = prepareUadNeighborhoodApply(input);
  const result = prepareUadNeighborhoodSectionValidation(input);
  shape(result);
  assert.equal(result.status, "ready"); assert.equal(result.http_status, 200); assert.deepEqual(result.conflicts, []);
  assert.equal(result.candidate_digest_sha256, plan.candidate_digest_sha256);
  assert.deepEqual(result.acceptance_manifest, plan.acceptance_manifest); assert.deepEqual(result.writes, plan.writes);
  assert.deepEqual(sortValues(result.normalized_writes), sortValues(plan.writes.map(normalized)));
  assert.deepEqual(sortValues(result.normalized_final_members), sortValues(plan.writes.map(normalized)));
  assert.deepEqual(result.final_slots.map(item => item.target_key).sort(), [...KEYS].sort());
  for (const item of result.final_slots) {
    assert.deepEqual(Object.keys(item).sort(), ["populated", "target_key", "value"]); assert.equal(item.populated, true);
  }
  assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
  assert.equal(result.section_findings.length, 8);
});

test("verified zero sales has four members but seven resolved slots, without clearing-price writes", () => {
  const input = fixture({ zeroSales: true });
  const result = prepareUadNeighborhoodSectionValidation(input);
  shape(result); assert.equal(result.status, "ready");
  assert.equal(result.writes.length, 4); assert.equal(result.normalized_final_members.length, 4); assert.equal(result.final_slots.length, 7);
  for (const key of PRICE_KEYS) {
    assert.deepEqual(result.final_slots.find(item => item.target_key === key), { target_key: key, populated: false, value: null });
    assert.equal(result.writes.some(item => item.target_key === key), false);
  }
  assert.equal(result.normalized_final_members.find(item => item.uid === "3000.0026").value, 0);
  assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
});

test("valid one-sale equality and two-sale unrounded midpoint pass fresh and full-receipt replay", () => {
  for (const [count, low, median, high] of [[1, 310000.25, 310000.25, 310000.25], [2, 300000.01, (300000.01 + 300000.02) / 2, 300000.02]]) {
    const raw = reviewed(smallSample(count, low, median, high));
    const fresh = prepareUadNeighborhoodSectionValidation(wrap(raw));
    assert.equal(fresh.status, "ready", JSON.stringify(fresh.conflicts));
    assert.equal(fresh.normalized_final_members.find(item => item.uid === "3000.0029").value, median);
    const accepted = accept(raw);
    assert.equal(prepareUadNeighborhoodSectionValidation(accepted.input).status, "already_applied");
  }
});

test("fully rehashed old single/two-sale arithmetic receipts fail despite passing shared replay controls", () => {
  for (const [count, low, median, high] of [[1, 300000, 330000, 390000], [2, 300000, 330000, 390000]]) {
    const raw = smallSample(count, low, median, high);
    const built = historical(raw, { [KEYS[3]]: count, [KEYS[4]]: low, [KEYS[5]]: median, [KEYS[6]]: high });
    const { receipt_digest_sha256, ...body } = built.input.accepted_receipt;
    assert.equal(assessmentEvidenceDigest(body), receipt_digest_sha256);
    rejected(built.input, "neighborhood_candidate_incomplete");
  }
});

test("valid historical small-sample receipts pass the identical fully rehashed fixture path", () => {
  for (const [count, low, median, high] of [[1, 310000, 310000, 310000], [2, 300000, 345000, 390000]]) {
    const built = historical(smallSample(count, low, median, high), {
      [KEYS[3]]: count, [KEYS[4]]: low, [KEYS[5]]: median, [KEYS[6]]: high,
    });
    const result = prepareUadNeighborhoodSectionValidation(built.input);
    assert.equal(result.status, "already_applied", JSON.stringify(result.conflicts));
    assert.deepEqual(result.writes, []); assert.deepEqual(result.acceptance_manifest, built.plan.acceptance_manifest);
  }
});

test("mixed new/reused positive and zero-sale groups validate every member but only return new writes", () => {
  for (const zeroSales of [false, true]) for (const reusedKey of zeroSales ? KEYS.slice(0, 4) : KEYS) {
    const input = wrap(reuse(uadNeighborhoodReviewFixture({ zeroSales }), [reusedKey]));
    const result = prepareUadNeighborhoodSectionValidation(input);
    assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
    assert.equal(result.normalized_final_members.length, zeroSales ? 4 : 7);
    assert.equal(result.normalized_writes.length, zeroSales ? 3 : 6);
    assert.equal(result.writes.some(item => item.target_key === reusedKey), false);
    assert.equal(result.acceptance_manifest.reused[0].target_key, reusedKey);
    assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
  }
});

test("full receipt replay keeps original mixed partition while current writes remain empty", () => {
  for (const zeroSales of [false, true]) {
    const { input, plan } = accept(reuse(uadNeighborhoodReviewFixture({ zeroSales }), [KEYS[0]]));
    const result = prepareUadNeighborhoodSectionValidation(input);
    assert.equal(result.status, "already_applied");
    assert.deepEqual(result.writes, []); assert.deepEqual(result.normalized_writes, []);
    assert.deepEqual(result.acceptance_manifest, plan.acceptance_manifest);
    assert.equal(result.acceptance_manifest.reused.length, 1);
    assert.equal(result.normalized_final_members.length, zeroSales ? 4 : 7);
    input.target.editor_revision++; input.canonical_state.editor_revision++;
    rejected(input, "stale_accepted_application");
  }
});

test("same-text manual provenance and all-reused-without-receipt are not accepted", () => {
  const raw = reuse(uadNeighborhoodReviewFixture(), [KEYS[0]]);
  delete raw.existing_values.find(item => item.target_key === KEYS[0]).provenance_digest;
  const input = wrap(raw);
  Object.assign(input.canonical_state.rows[0], { source_type: "homenode", source_reference: "claimed-proof", is_appraiser_confirmed: true });
  rejected(input, "incompatible_existing_value");
  rejected(wrap(reuse(uadNeighborhoodReviewFixture(), KEYS)), "missing_application_receipt");
});

test("every owned occupancy slot is required once, including absent zero-sale prices", () => {
  for (const zeroSales of [false, true]) for (const key of KEYS) for (const duplicate of [false, true]) {
    const input = fixture({ zeroSales });
    const index = input.existing_values.findIndex(item => item.target_key === key);
    if (duplicate) input.existing_values.push(clone(input.existing_values[index]));
    else input.existing_values.splice(index, 1);
    rejected(input);
  }
});

test("canonical rows and occupancy must agree exactly before accepting any mapped member", () => {
  for (const mutate of [
    input => input.canonical_state.rows.push(canonicalRow(input, KEYS[0], "Unrepresented persisted boundary")),
    input => Object.assign(input.existing_values[0], { populated: true, value: "No canonical row" }),
    input => input.canonical_state.rows.push(canonicalRow(input, KEYS[0], null), canonicalRow(input, KEYS[0], null)),
    input => input.canonical_state.rows.push(canonicalRow(input, KEYS[0], null, { entity_id: uuid(1) })),
    input => input.canonical_state.rows.push(canonicalRow(input, KEYS[0], null, { workfile_id: uuid(99) })),
    input => Object.assign(input.existing_values[0], { populated: false, value: "Not empty" }),
    input => Object.assign(input.existing_values[0], { populated: true, value: null }),
    input => Object.assign(input.existing_values[0], { target_exists: false }),
  ]) { const input = fixture(); mutate(input); rejected(input); }
});

test("each explicit null root row can represent known-empty without changing the saved group", () => {
  for (const zeroSales of [false, true]) {
    const input = fixture({ zeroSales });
    input.canonical_state.rows = KEYS.map(key => canonicalRow(input, key, null));
    assert.equal(prepareUadNeighborhoodSectionValidation(input).status, "ready");
  }
});

test("undefined, blank, numeric strings and zero cannot masquerade as empty mapped slots", () => {
  for (const value of [undefined, "", " ", "0", 0, false, [], {}]) {
    const input = fixture(); input.canonical_state.rows.push(canonicalRow(input, KEYS[0], value)); rejected(input);
  }
  for (const key of PRICE_KEYS) for (const value of [0, 300000, "", "300000", false]) {
    const input = fixture({ zeroSales: true });
    input.canonical_state.rows.push(canonicalRow(input, key, value));
    Object.assign(input.existing_values.find(item => item.target_key === key), { populated: true, value });
    rejected(input);
  }
});

test("zero-sale replay cannot conceal a historical price surviving in the canonical row set", () => {
  for (const key of PRICE_KEYS) {
    const { input } = accept(uadNeighborhoodReviewFixture({ zeroSales: true }));
    input.canonical_state.rows.push(canonicalRow(input, key, 300000));
    rejected(input);
    Object.assign(input.existing_values.find(item => item.target_key === key), { populated: true, value: 300000 });
    rejected(input, "zero_sales_existing_prices");
  }
});

test("confirmation, closure, stale binding and lifecycle conflicts retain the existing preparation reasons", () => {
  for (const [mutate, code] of [
    [input => { input.request.confirmed = false; }, "appraiser_confirmation_required"],
    [input => { input.request.preserve_existing = false; }, "appraiser_confirmation_required"],
    [input => { input.request.selected_suggestion_ids.pop(); }, "partial_atomic_group"],
    [input => { input.request.expected_candidate_digest_sha256 = "0".repeat(64); }, "stale_neighborhood_candidate"],
    [input => { input.request.expected_binding_digest_sha256 = "0".repeat(64); }, "stale_attachment"],
    [input => { input.target.has_signatures = true; }, "uad_workfile_status_locked"],
  ]) { const input = fixture(); mutate(input); rejected(input, code); }
});

test("catalog bounds and exact reviewed types fail without lossy coercion", () => {
  for (const mutate of [
    input => { input.market_context.lookback_months = "12"; },
    input => { input.market_context.lookback_months = 100; },
    input => { input.market_context.search_criteria = " x "; },
    input => { input.market_context.search_criteria = "x".repeat(1251); },
    input => { input.market_context.analysis_geometry.boundary_description = " "; },
    input => { input.target.specification_release = "unknown-release"; },
    input => { input.existing_values[0].target_key = "market:not-a-field"; },
  ]) { const input = fixture(); mutate(input); rejected(input); }
  for (const [key, value] of [[KEYS[2], "12"], [KEYS[3], 1000], [KEYS[4], 0], [KEYS[5], 1000000000], [KEYS[0], " x "]]) {
    const raw = reuse(uadNeighborhoodReviewFixture(), [key]);
    Object.assign(raw.existing_values.find(item => item.target_key === key), { value });
    rejected(wrap(raw));
  }
});

function fullMarket(input, { graph = true, commentary = false, source = "Verified synthetic MLS" } = {}) {
  const id = uuid(1);
  input.canonical_state.entities.push({ id, workfile_id: input.target.uad_workfile_id,
    entity_type: "market_price_trend_source", data: {} });
  for (const [key, value] of [["market_active_listings:3000.0018", 0], ["market_pending_sales:3000.0024", 0],
    ["market:3000.0034", false], ["market:3000.0033", "InBalance"], ["market:3000.0031", "UnderThreeMonths"]]) {
    input.canonical_state.rows.push(canonicalRow(input, key, value));
  }
  input.canonical_state.rows.push(canonicalRow(input, "market_price_trend_source:3000.0051", source, { entity_id: id }));
  if (graph) input.canonical_state.assets.push({ section_number: 17, status: "verified", caption_type: "PriceTrendGraph", content_type: "IMAGE/PNG" });
  if (commentary) input.canonical_state.rows.push(canonicalRow(input, "market_price_trend_commentary:3000.0040", "Appraiser-reviewed trend commentary."));
  return input;
}

test("Section17 findings exactly preserve real source/graph/commentary and unrelated required-field rules", () => {
  for (const options of [{}, { graph: false }, { graph: false, commentary: true }, { source: "x".repeat(34) }]) {
    const input = fullMarket(fixture(), options);
    const result = prepareUadNeighborhoodSectionValidation(input);
    assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
    assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
    if (options.source) assert.ok(result.section_findings.some(item => item.code === "max_length"));
    else if (options.graph === false && !options.commentary) assert.ok(result.section_findings.some(item => item.code === "market_price_trend_commentary_required"));
    else assert.deepEqual(result.section_findings, []);
  }
  const input = fullMarket(fixture());
  input.canonical_state.rows.find(item => item.uad_uid === "3000.0033").value = "not-an-enumeration";
  const result = prepareUadNeighborhoodSectionValidation(input);
  assert.equal(result.status, "ready");
  assert.ok(result.section_findings.some(item => item.uid === "3000.0033" && item.code === "enumeration"));
  assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
});

test("unverified or wrong-kind assets never satisfy the real Section17 graph requirement", () => {
  for (const change of [{ status: "pending_upload" }, { section_number: 20 }, { content_type: "application/pdf" },
    { caption_type: "MarketAnalysisExhibit" }]) {
    const input = fullMarket(fixture()); Object.assign(input.canonical_state.assets[0], change);
    const result = prepareUadNeighborhoodSectionValidation(input);
    assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
    assert.ok(result.section_findings.some(item => item.code === "market_price_trend_commentary_required"));
    assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
  }
});

test("mapped-only validation does not normalize unrelated values or silently deduplicate their row order", () => {
  const input = fullMarket(fixture());
  input.canonical_state.rows.push(canonicalRow(input, "market:3000.0033", "different-invalid-value"));
  const original = clone(input);
  const result = prepareUadNeighborhoodSectionValidation(input);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
  assert.ok(result.section_findings.some(item => item.code === "enumeration"));
  assert.deepEqual(input, original);
});

test("ordinary PG Date metadata is ignored while exact data-only projections preserve findings", () => {
  const input = fullMarket(fixture(), { graph: false });
  for (const record of [...input.canonical_state.rows, ...input.canonical_state.entities]) {
    record.created_at = new Date("2026-09-05T00:00:00.000Z"); record.updated_at = new Date("2026-09-06T00:00:00.000Z");
  }
  input.canonical_state.assets.push({ section_number: 17, status: "verified", caption_type: "PriceTrendGraph",
    content_type: "image/png", created_at: new Date("2026-09-05T00:00:00.000Z") });
  const before = clone(input);
  const result = prepareUadNeighborhoodSectionValidation(input);
  assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
  assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
  assert.deepEqual(input, before); assert.ok(input.canonical_state.rows[0].created_at instanceof Date);
});

test("all seven wrapper keys and the literal complete current-state declaration are mandatory", () => {
  for (const key of Object.keys(fixture())) { const input = fixture(); delete input[key]; rejected(input); }
  for (const key of ["state_version", "workfile_id", "editor_revision", "complete", "rows", "entities", "assets"]) {
    const input = fixture(); delete input.canonical_state[key]; rejected(input);
  }
  for (const [key, value] of [["state_version", 2], ["workfile_id", uuid(999)], ["editor_revision", 6],
    ["editor_revision", "5"], ["complete", false], ["complete", "true"], ["rows", null], ["entities", {}], ["assets", undefined]]) {
    const input = fixture(); input.canonical_state[key] = value; rejected(input);
  }
});

test("no unknown wrapper/state/request options, browser plan or callback can select a validation path", () => {
  let called = 0;
  const callback = () => { called++; throw new Error("CALLER_CALLBACK_MUST_NOT_RUN"); };
  for (const container of ["wrapper", "canonical_state", "request"]) for (const key of ["options", "validate_final_group", "candidate", "plan", "allowIncomplete"]) {
    const input = fixture(); (container === "wrapper" ? input : input[container])[key] = callback; rejected(input);
  }
  for (const key of Object.keys(fixture().request)) { const input = fixture(); delete input.request[key]; rejected(input); }
  assert.equal(called, 0);
});

test("required canonical projection identities are own properties and foreign bindings fail closed", () => {
  for (const key of ["workfile_id", "entity_id", "field_context", "uad_uid", "value"]) {
    const input = fixture(); const row = canonicalRow(input, KEYS[0], null); delete row[key]; input.canonical_state.rows.push(row); rejected(input);
  }
  for (const key of ["workfile_id", "id", "entity_type", "data"]) {
    const input = fullMarket(fixture()); delete input.canonical_state.entities[0][key]; rejected(input);
  }
  for (const key of ["section_number", "status", "caption_type", "content_type"]) {
    const input = fullMarket(fixture()); delete input.canonical_state.assets[0][key]; rejected(input);
  }
  for (const collection of ["rows", "entities", "assets"]) {
    const input = fullMarket(fixture()); input.canonical_state[collection][0].workfile_id = uuid(999); rejected(input);
  }
  const input = fullMarket(fixture());
  assert.equal(Object.hasOwn(input.canonical_state.assets[0], "workfile_id"), false);
  assert.equal(prepareUadNeighborhoodSectionValidation(input).status, "ready");
  input.canonical_state.assets[0].section_number = "17";
  rejected(input);
});

test("blank and whitespace identity strings and false root aliases do not normalize into valid rows", () => {
  for (const [key, value] of [["entity_id", ""], ["entity_id", " "], ["entity_id", false], ["entity_id", 0],
    ["entity_id", " root "], ["field_context", " market"], ["field_context", "market "],
    ["uad_uid", "3000.0008 "], ["workfile_id", ` ${uuid(1)}`]]) {
    const input = fixture(); input.canonical_state.rows.push(canonicalRow(input, KEYS[0], null, { [key]: value })); rejected(input);
  }
  for (const [key, value] of [["id", " "], ["entity_type", " dwelling "]]) {
    const input = fullMarket(fixture()); input.canonical_state.entities[0][key] = value; rejected(input);
  }
});

test("nonenumerable required properties and hidden metadata fail rather than disappearing during copying", () => {
  for (const locate of [input => [input, "target"], input => [input.canonical_state, "complete"],
    input => [input.request, "confirmed"], input => {
      input.canonical_state.rows.push(canonicalRow(input, KEYS[0], null)); return [input.canonical_state.rows[0], "value"];
    }, input => {
      input.canonical_state.rows.push(canonicalRow(input, KEYS[0], null));
      input.canonical_state.rows[0].created_at = new Date(); return [input.canonical_state.rows[0], "created_at"];
    }]) {
    const input = fixture(); const [target, key] = locate(input);
    Object.defineProperty(target, key, { value: target[key], enumerable: false, configurable: true, writable: true });
    rejected(input);
  }
});

test("own __proto__ JSON keys are copied as data without invoking prototype setters", () => {
  const input = fixture();
  const data = JSON.parse('{"__proto__":{"a2_prototype_marker":true},"note":"ordinary JSON"}');
  input.canonical_state.entities.push({ workfile_id: input.target.uad_workfile_id, id: uuid(1), entity_type: "dwelling", data });
  const before = clone(input);
  const result = prepareUadNeighborhoodSectionValidation(input);
  assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
  assert.equal(Object.getPrototypeOf(data), Object.prototype); assert.equal(Object.hasOwn(data, "__proto__"), true);
  assert.equal(Object.prototype.a2_prototype_marker, undefined); assert.equal({}.a2_prototype_marker, undefined);
  assert.deepEqual(input, before);
  Object.defineProperty(input.request, "__proto__", { enumerable: true, configurable: true, value: { bypass: true } });
  rejected(input);
});

test("repeated data references are allowed but traversed cycles are not", () => {
  const input = fixture(); const shared = { note: "A reused ordinary JSON object", list: [1, 2, 3] };
  input.canonical_state.entities.push(...[1, 2].map(index => ({ workfile_id: input.target.uad_workfile_id,
    id: uuid(index), entity_type: "dwelling", data: { first: shared, second: shared } })));
  assert.equal(prepareUadNeighborhoodSectionValidation(input).status, "ready");
  assert.equal(Object.isFrozen(shared), false);
  shared.loop = shared; rejected(input);
});

test("getters on wrapper, evidence, arrays and ignored metadata are rejected without evaluation", () => {
  for (const locate of [input => [input, "assessment"], input => [input.target, "editor_revision"],
    input => [input.market_context, "lookback_months"], input => [input.assessment.subject_facts, "year_built"],
    input => [input.canonical_state, "rows"], input => [input.existing_values, "0"],
    input => { const row = canonicalRow(input, KEYS[0], null); input.canonical_state.rows.push(row); return [row, "created_at"]; },
    input => { input.canonical_state.entities.push({ workfile_id: input.target.uad_workfile_id, id: uuid(1), entity_type: "dwelling", data: {} }); return [input.canonical_state.entities[0].data, "hidden"]; },
  ]) {
    const input = fixture(); const [target, key] = locate(input); let calls = 0;
    Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { calls++; throw new Error("PRIVATE_GETTER_TEXT"); } });
    const result = rejected(input); assert.equal(calls, 0); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_GETTER_TEXT/);
  }
});

test("ordinary and revoked proxies are rejected before any caller trap can run", () => {
  for (const location of ["wrapper", "target", "rows", "row-value", "receipt"]) for (const revoked of [false, true]) {
    const input = fixture(); let calls = 0;
    const trapped = () => { calls++; throw new Error("PROXY_TRAP_MUST_NOT_RUN"); };
    const original = location === "wrapper" ? input : {};
    const handle = Proxy.revocable(original, { get: trapped, ownKeys: trapped, getPrototypeOf: trapped, getOwnPropertyDescriptor: trapped });
    if (revoked) handle.revoke();
    let argument = input;
    if (location === "wrapper") argument = handle.proxy;
    else if (location === "target") input.target = handle.proxy;
    else if (location === "rows") input.canonical_state.rows = handle.proxy;
    else if (location === "receipt") input.accepted_receipt = handle.proxy;
    else input.canonical_state.rows.push(canonicalRow(input, "market_commentary:0100.0044", handle.proxy));
    rejected(argument); assert.equal(calls, 0);
  }
});

test("data-only inspection rejects functions, toJSON hooks, symbols, cycles and custom prototypes", () => {
  let calls = 0;
  for (const mutate of [
    input => { input.assessment.subject_facts.toJSON = () => { calls++; return {}; }; },
    input => { input.market_context.source_refs[Symbol.iterator] = () => { calls++; return [][Symbol.iterator](); }; },
    input => { input.canonical_state.rows.push(canonicalRow(input, "market_commentary:0100.0044", () => { calls++; })); },
    input => { input.target[Symbol("hidden")] = true; },
    input => { input.assessment.subject_facts.cycle = input.assessment; },
    input => { const data = {}; data.self = data; input.canonical_state.entities.push({ workfile_id: input.target.uad_workfile_id, id: uuid(1), entity_type: "dwelling", data }); },
    input => { Object.setPrototypeOf(input.request, { inherited: true }); },
    input => { input.canonical_state.rows.push(canonicalRow(input, "market_commentary:0100.0044", new Date())); },
    input => { input.canonical_state.rows.push(canonicalRow(input, "market_commentary:0100.0044", Number.POSITIVE_INFINITY)); },
  ]) { const input = fixture(); mutate(input); rejected(input); }
  assert.equal(calls, 0);
});

test("sparse and accessor-backed arrays are not silently filled or iterated", () => {
  for (const locate of [input => input.existing_values, input => input.request.selected_suggestion_ids,
    input => { input.canonical_state.rows = [canonicalRow(input, KEYS[0], null)]; return input.canonical_state.rows; },
    input => input.market_context.source_refs]) {
    const input = fixture(); const array = locate(input); delete array[0]; rejected(input);
  }
  const input = fixture(); input.canonical_state.rows.length = 1; rejected(input);
});

test("ordinary collections enforce fixed row/entity/asset count ceilings without truncation", () => {
  for (const [key, count] of [["rows", 20000], ["entities", 5000], ["assets", 10000]]) {
    const input = fixture();
    input.canonical_state[key] = Array.from({ length: count }, (_, index) => key === "rows"
      ? canonicalRow(input, "market_commentary:0100.0044", "Retained optional commentary")
      : key === "entities" ? { workfile_id: input.target.uad_workfile_id, id: uuid(index), entity_type: "dwelling", data: {} }
        : { section_number: 7, status: "verified", caption_type: "Sketch", content_type: "image/png" });
    const result = prepareUadNeighborhoodSectionValidation(input);
    assert.equal(result.status, "ready", `${key}: ${JSON.stringify(result.conflicts)}`);
    assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
    input.canonical_state[key].push(clone(input.canonical_state[key][0])); rejected(input);
    assert.equal(input.canonical_state[key].length, count + 1);
  }
});

test("projected JSON node and depth budgets are cumulative and fail with no partially prepared writes", () => {
  const nodes = fixture();
  nodes.canonical_state.entities.push({ workfile_id: nodes.target.uad_workfile_id,
    id: uuid(1), entity_type: "dwelling", data: { members: Array(260000).fill(null) } });
  assert.equal(prepareUadNeighborhoodSectionValidation(nodes).status, "ready");
  nodes.canonical_state.entities.push({ workfile_id: nodes.target.uad_workfile_id,
    id: uuid(2), entity_type: "dwelling", data: { members: Array(260000).fill(null) } });
  rejected(nodes);
  const deep = fixture(); let data = { leaf: true };
  for (let level = 0; level < 50; level++) data = { nested: data };
  deep.canonical_state.entities.push({ workfile_id: deep.target.uad_workfile_id, id: uuid(1), entity_type: "dwelling", data });
  rejected(deep);
});

test("projected depth 40 passes exactly and depth 41 fails without widening the guard", () => {
  for (const wrappers of [37, 38]) {
    const input = fixture(); let value = null;
    for (let index = 0; index < wrappers; index++) value = { v: value };
    input.canonical_state.rows = [canonicalRow(input, "unmapped:depth", value)];
    // Projected value begins at depth 3, so 37 wrappers put its leaf at 40.
    if (wrappers === 38) rejected(input, "neighborhood_validation_input_limit");
    else {
      const result = prepareUadNeighborhoodSectionValidation(input);
      assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
      assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
    }
  }
});

test("exactly 500000 projected JSON nodes pass and node 500001 fails cumulatively", () => {
  for (const delta of [0, 1]) {
    const input = fixture();
    input.canonical_state.rows = Array.from({ length: 10 }, (_, index) => canonicalRow(input,
      `unmapped:${index}`, Array(index === 9 ? 49937 + delta : 50000).fill(0)));
    // Three collection roots + ten records with five projected values each,
    // including the array containers themselves, plus all array elements.
    assert.equal(3 + 10 * (1 + 5) + 9 * 50000 + 49937 + delta, 500000 + delta);
    if (delta) rejected(input, "neighborhood_validation_input_limit");
    else {
      const result = prepareUadNeighborhoodSectionValidation(input);
      assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
      assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
    }
  }
});

test("canonical UTF8 string/key budget is aggregate, not JavaScript character count", () => {
  const input = fixture();
  // Each entry is well below 32 MiB alone; their UTF-8 data exceeds it together.
  const text = "\u00e9".repeat(65536);
  input.canonical_state.entities = Array.from({ length: 256 }, (_, index) => ({ workfile_id: input.target.uad_workfile_id,
    id: uuid(index), entity_type: "dwelling", data: { notes: text } }));
  assert.equal(text.length * 256 < 32 * 1024 * 1024, true);
  assert.equal(Buffer.byteLength(text, "utf8") * 256, 32 * 1024 * 1024);
  rejected(input);
  input.canonical_state.entities.pop();
  assert.equal(prepareUadNeighborhoodSectionValidation(input).status, "ready");
});

test("exactly 32MiB of projected UTF8 strings and keys pass and one extra byte fails", () => {
  for (const delta of [0, 1]) {
    const input = fixture(); const row = canonicalRow(input, "unmapped:bytes", "");
    const overhead = Object.entries(row).reduce((bytes, [key, value]) => bytes + Buffer.byteLength(key, "utf8")
      + (typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0), 0);
    row.value = "x".repeat(32 * 1024 * 1024 - overhead + delta);
    input.canonical_state.rows = [row];
    assert.equal(overhead + Buffer.byteLength(row.value, "utf8"), 32 * 1024 * 1024 + delta);
    if (delta) rejected(input, "neighborhood_validation_input_limit");
    else {
      const result = prepareUadNeighborhoodSectionValidation(input);
      assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
      assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
    }
  }
});

test("ordinary canonical JSON larger than 1.5MiB is not subjected to the neighborhood envelope cap", () => {
  const input = fixture();
  input.canonical_state.entities.push({ workfile_id: input.target.uad_workfile_id, id: uuid(1),
    entity_type: "dwelling", data: { supplemental_notes: "x".repeat(1600000) } });
  assert.ok(Buffer.byteLength(JSON.stringify(input.canonical_state)) > 1500000);
  const result = prepareUadNeighborhoodSectionValidation(input);
  assert.equal(result.status, "ready", JSON.stringify(result.conflicts));
  assert.deepEqual(result.section_findings, directFindings(input, result.normalized_final_members));
});

test("exact-size accepted receipts replay without the public candidate's hypothetical next-revision capacity check", () => {
  for (const [revision, padding] of [[8, 1486237], [9, 1486236]]) {
    const raw = uadNeighborhoodReviewFixture(); raw.target.editor_revision = revision;
    rebind(raw, assessment => { assessment.statistics.find(item => item.id === "median-sale-price").uncertainty.extra = "x".repeat(padding); });
    const built = historical(raw);
    assert.equal(Buffer.byteLength(canonicalAssessmentJson(built.input.accepted_receipt)), 1500000);
    assert.equal(buildUadNeighborhoodCandidate(built.raw).status, "incomplete");
    const result = prepareUadNeighborhoodSectionValidation(built.input);
    assert.equal(result.status, "already_applied", JSON.stringify(result.conflicts));
    assert.deepEqual(result.writes, []); assert.deepEqual(result.normalized_writes, []);
    assert.deepEqual(result.acceptance_manifest, built.plan.acceptance_manifest);
    assert.equal(result.acceptance_manifest.base_editor_revision, revision);
  }
});

test("saved MAX_SAFE_INTEGER revision replays although any prospective next revision is invalid", () => {
  const raw = uadNeighborhoodReviewFixture(); raw.target.editor_revision = Number.MAX_SAFE_INTEGER - 1;
  const built = historical(raw);
  assert.equal(built.input.target.editor_revision, Number.MAX_SAFE_INTEGER);
  assert.equal(buildUadNeighborhoodCandidate(built.raw).status, "incomplete");
  const result = prepareUadNeighborhoodSectionValidation(built.input);
  assert.equal(result.status, "already_applied", JSON.stringify(result.conflicts));
  assert.deepEqual(result.writes, []); assert.deepEqual(result.normalized_writes, []);
});

test("only a full consistent receipt can replay; core-only and rehashed changed evidence fail", () => {
  for (const change of [
    input => { input.accepted_receipt = input.accepted_receipt.core_receipt; },
    input => { input.accepted_receipt.receipt_digest_sha256 = "0".repeat(64); },
    input => {
      input.accepted_receipt.candidate.evidence.market_context.search_criteria += " forged";
      const { receipt_digest_sha256, ...body } = input.accepted_receipt;
      input.accepted_receipt.receipt_digest_sha256 = assessmentEvidenceDigest(body);
    },
  ]) { const { input } = accept(uadNeighborhoodReviewFixture()); change(input); rejected(input); }
});

test("results are deterministic, deeply frozen data while caller input remains mutable and unchanged", () => {
  const input = fullMarket(fixture());
  const before = clone(input);
  const result = prepareUadNeighborhoodSectionValidation(input);
  assert.equal(result instanceof Promise, false);
  assert.equal(result.status, "ready");
  assert.deepEqual(result, prepareUadNeighborhoodSectionValidation(input)); assert.deepEqual(input, before);
  const inspect = (value, frozen) => {
    if (!value || typeof value !== "object") return;
    assert.equal(Object.isFrozen(value), frozen);
    for (const member of Object.values(value)) inspect(member, frozen);
  };
  inspect(result, true); inspect(input, false);
  const saved = clone(result);
  input.market_context.search_criteria = "A later caller edit";
  input.canonical_state.rows[0].value = "A later caller value";
  assert.deepEqual(result, saved);
  assert.throws(() => { result.final_slots[0].value = "mutate"; }, TypeError);
});

test("ready, conflict and replay preserve every captured shared catalog reference and nested freeze state", () => {
  assert.ok(SHARED_FIELD_REFERENCES.length > 0); assert.ok(SHARED_CATALOG_FREEZE.size >= SHARED_FIELD_REFERENCES.length);
  assertSharedCatalogUnchanged();
  const ready = prepareUadNeighborhoodSectionValidation(fixture());
  assert.equal(ready.status, "ready"); assertSharedCatalogUnchanged();
  const invalid = fixture(); invalid.request.confirmed = false;
  rejected(invalid, "appraiser_confirmation_required"); assertSharedCatalogUnchanged();
  const { input } = accept(uadNeighborhoodReviewFixture());
  assert.equal(prepareUadNeighborhoodSectionValidation(input).status, "already_applied");
  assertSharedCatalogUnchanged();
});
