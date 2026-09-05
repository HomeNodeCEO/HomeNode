import test from "node:test";
import assert from "node:assert/strict";
import { assessmentEvidenceDigest } from "../src/services/neighborhoodAssessment/contract.js";
import { buildSourceObservation as build, evaluateSourceObservationAtDate as atDate,
  SOURCE_OBSERVATION_LIMITS } from "../src/services/neighborhoodAssessment/sourceObservations.js";

const org = "10000000-0000-4000-8000-000000000001";
function input(payload, overrides = {}) {
  return { source_identity: { provider: "synthetic", source_record_id: "canonical-source-7", original_record_id: " Listing 0007 " },
    provider_version: "fixture-provider-1", schema_version: "fixture-schema-1", extractor_version: "explicit-v1",
    payload, retention: { mode: "full", original_paths: null }, visibility: "public", scope: null,
    source_locator: "synthetic://document-7/page/1", source_modified_at: "2024-01-01T00:00:00.000Z",
    retrieved_at: "2026-09-01T00:00:00.000Z", fact_validity: { from: "2024-01-01", to: null },
    historical_availability: "reconstructed", correction: null, contradiction_refs: [], ...overrides };
}
function field(id, concept = id, extra = {}) { return { id, concept, path: [id], ...extra }; }
function registry(fields, claims = []) {
  return { id: "synthetic-only", version: "1", provider: "synthetic", schema_version: "fixture-schema-1",
    extractor_version: "explicit-v1", fields, claims };
}
function claim(id, kind, fieldIds, extra = {}) {
  return { id, kind, field_ids: fieldIds, required_field_ids: fieldIds, attribution: "source_reported", ...extra };
}
function value(observation, id) { return observation.fields.find(item => item.id === id); }

test("roles remain separate: shared agent/name and contractor cannot become builder identity", () => {
  const observations = [];
  for (const [role, name] of [["seller", "S LLC"], ["owner", "D LLC"], ["contractor", "C LLC"], ["builder", "Builder B"], ["developer", "D LLC"]]) {
    const record = input({ role_name: name, registered_agent: "Shared Agent", phase_id: "phase-A" }, {
      source_locator: `synthetic://document-${role}`, source_identity: { provider: "synthetic", source_record_id: `record-${role}`, original_record_id: `doc-${role}` },
    });
    observations.push(build(record, registry([field("role_name"), field("registered_agent"), field("phase_id")],
      [claim("party", "role", ["role_name", "registered_agent", "phase_id"], { role })])));
  }
  assert.equal(new Set(observations.map(item => item.source_identity_sha256)).size, 5);
  assert.deepEqual(observations.map(item => item.claims[0].role), ["seller", "owner", "contractor", "builder", "developer"]);
  assert.ok(observations.every(item => item.claims[0].entity_resolution === "unresolved" && item.claims[0].review_status === "unreviewed"));
  assert.notEqual(observations[1].observation_sha256, observations[4].observation_sha256);
  assert.equal(value(observations[0], "role_name").raw_value, "S LLC");
});

test("parent tract and phase chronology retain separate evidence; later-learned history does not rewrite earlier reports", () => {
  const lineageRegistry = registry([field("predecessor_parcel_id"), field("successor_parcel_id"), field("phase_id")],
    [claim("lineage", "parcel_lineage", ["predecessor_parcel_id", "successor_parcel_id", "phase_id"])]);
  const lineage = build(input({ predecessor_parcel_id: "tract-2018", successor_parcel_id: "lot-A", phase_id: "phase-A" },
    { fact_validity: { from: "2019-01-01", to: null } }), lineageRegistry);
  const constructionRegistry = registry([field("construction_status"), field("phase_id")],
    [claim("construction", "construction", ["construction_status", "phase_id"])]);
  const vacant = build(input({ construction_status: "vacant assessment observation", phase_id: "phase-A" },
    { fact_validity: { from: "2019-01-01", to: "2019-01-01" } }), constructionRegistry);
  const improved = build(input({ construction_status: "improved assessment observation", phase_id: "phase-A" },
    { fact_validity: { from: "2021-01-01", to: "2021-01-01" } }), constructionRegistry);
  const roleRegistry = registry([field("role_name"), field("phase_id")], [claim("builder", "role", ["role_name", "phase_id"], { role: "builder" })]);
  const phaseB = build(input({ role_name: "Different Builder", phase_id: "phase-B" }, { fact_validity: { from: "2022-01-01", to: null } }), roleRegistry);
  const frozenReport = Object.freeze({ signed: true, evidence_refs: Object.freeze([vacant.observation_sha256]) });
  const laterHistory = build(input({ role_name: "Earlier Builder A", phase_id: "phase-A" }, { fact_validity: { from: "2019-01-01", to: "2020-12-31" } }), roleRegistry);
  assert.equal(value(lineage, "predecessor_parcel_id").value, "tract-2018");
  assert.equal(value(phaseB, "phase_id").value, "phase-B");
  assert.equal(atDate(phaseB, "2020-06-01").claims[0].state, "not_applicable");
  assert.equal(atDate(laterHistory, "2020-06-01").claims[0].state, "applicable");
  assert.equal(atDate(laterHistory, "2020-06-01").claims[0].later_retrieved, true);
  assert.deepEqual(frozenReport.evidence_refs, [vacant.observation_sha256]);
  assert.notEqual(vacant.observation_sha256, improved.observation_sha256);
  assert.ok(!Object.hasOwn(improved, "construction_start_date"));
});

test("HOA fees and amenity access use dated independent claims, retain zero/false and do not normalize annual dues implicitly", () => {
  const map = registry([field("association_id"), field("fee_amount"), field("fee_currency"), field("fee_frequency"), field("charge_type"),
    field("amenity_name"), field("amenity_access"), field("amenity_status")], [
    claim("dues", "charge", ["association_id", "fee_amount", "fee_currency", "fee_frequency", "charge_type"]),
    claim("pool", "amenity", ["association_id", "amenity_name", "amenity_access", "amenity_status"]),
  ]);
  const raw = { association_id: "HOA-A", fee_amount: "1200", fee_currency: "USD", fee_frequency: "annually",
    charge_type: "recurring dues", amenity_name: "pool", amenity_access: true, amenity_status: "completed" };
  const old = build(input(raw, { fact_validity: { from: "2024-01-01", to: "2025-12-31" } }), map);
  const amendment = build(input({ ...raw, fee_amount: 1800 }, { fact_validity: { from: "2026-01-01", to: null } }), map);
  const phaseB = build(input({ ...raw, association_id: "HOA-B", fee_amount: 0, amenity_access: false }), map);
  const planned = build(input({ ...raw, amenity_access: false, amenity_status: "planned" }, { fact_validity: { from: "2025-01-01", to: null } }), map);
  assert.equal(value(old, "fee_amount").value, 1200);
  assert.equal(value(old, "fee_amount").raw_value, "1200");
  assert.equal(value(old, "fee_frequency").value, "annually");
  assert.equal(atDate(old, "2024-06-01").claims[0].state, "applicable");
  assert.ok(atDate(amendment, "2024-06-01").claims.every(item => item.state === "not_applicable"));
  assert.ok(atDate(planned, "2024-06-01").claims.every(item => item.state === "not_applicable"));
  assert.equal(value(phaseB, "fee_amount").value, 0);
  assert.equal(value(phaseB, "amenity_access").value, false);
  assert.equal(value(phaseB, "amenity_access").presence, "present");
  assert.equal(value(planned, "amenity_status").value, "planned");
  assert.equal(old.fields.some(item => item.concept === "monthly_fee" || item.concept === "pud_classification"), false);
});

test("sparse replay preserves source identity and rich evidence; correction is a new immutable proposal", () => {
  const map = registry([field("role_name"), field("fee_amount")], [claim("builder", "role", ["role_name"], { role: "builder" })]);
  const manualMatch = Object.freeze({ canonical_sale_id: "sale-42", account_id: "MANUALLY-VERIFIED", accepted: true });
  const rich = build(input({ role_name: "Builder Old", fee_amount: 1200 }), map);
  const saved = Object.freeze({ assessment: "reviewed-1", source_sha: rich.observation_sha256 });
  const sparse = build(input({}, { retention: { mode: "projected", original_paths: [] } }), map);
  const dropped = build(input({}, { retention: { mode: "projected", original_paths: [["role_name"], ["fee_amount"]] } }), map);
  const corrected = build(input({ role_name: "Builder Corrected" }, { correction: { supersedes_observation_sha256: rich.observation_sha256, reason: "Dated construction agreement" },
    contradiction_refs: [`${rich.observation_sha256}:builder`], fact_validity: { from: "2023-01-01", to: null } }), map);
  assert.ok([sparse, dropped, corrected].every(item => item.source_identity_sha256 === rich.source_identity_sha256));
  assert.equal(value(rich, "role_name").value, "Builder Old");
  assert.equal(value(sparse, "role_name").presence, "absent");
  assert.equal(value(dropped, "role_name").presence, "not_retained");
  assert.equal(sparse.claims[0].status, "incomplete");
  assert.equal(corrected.correction.supersedes_observation_sha256, rich.observation_sha256);
  assert.equal(corrected.claims[0].review_status, "unreviewed");
  assert.equal(saved.source_sha, rich.observation_sha256);
  assert.equal(manualMatch.account_id, "MANUALLY-VERIFIED");
  assert.throws(() => { rich.fields[0].value = "overwrite"; }, TypeError);
});

test("field presence distinguishes absent, not retained, null/blank, zero, false and invalid", () => {
  const map = registry([field("fee_amount"), field("hoa_membership"), field("role_name")]);
  const cases = [
    [{}, { mode: "full", original_paths: null }, "absent", null],
    [{}, { mode: "projected", original_paths: null }, "not_retained", null],
    [{ fee_amount: null }, { mode: "full", original_paths: null }, "blank", null],
    [{ fee_amount: "  " }, { mode: "full", original_paths: null }, "blank", null],
    [{ fee_amount: 0 }, { mode: "full", original_paths: null }, "present", 0],
    [{ fee_amount: "1200junk" }, { mode: "full", original_paths: null }, "present", null],
    [{ fee_amount: -5 }, { mode: "full", original_paths: null }, "present", null],
  ];
  for (const [payload, retention, presence, expected] of cases) {
    const result = build(input(payload, { retention }), map);
    assert.equal(value(result, "fee_amount").presence, presence);
    assert.equal(value(result, "fee_amount").value, expected);
  }
  const booleans = build(input({ hoa_membership: false, role_name: "  Original LLC  " }), map);
  assert.equal(value(booleans, "hoa_membership").value, false);
  assert.equal(value(booleans, "role_name").value, "  Original LLC  ");
  assert.equal(booleans.source_identity.original_record_id, " Listing 0007 ");
});

test("no provider key guesses or unapproved private remark retention; supplied value maps are exact", () => {
  const map = registry([field("hoa_membership", "hoa_membership", { path: ["SyntheticHOA"], value_map: [{ raw: "N", value: false }, { raw: "Y", value: true }] })]);
  const payload = { SyntheticHOA: "N", BuilderName: "unmapped", privateRemarks: "private content must not appear" };
  const result = build(input(payload), map);
  assert.equal(value(result, "hoa_membership").value, false);
  assert.equal(result.content_sha256, assessmentEvidenceDigest(payload));
  assert.equal(JSON.stringify(result).includes("private content must not appear"), false);
  assert.equal(JSON.stringify(result).includes("BuilderName"), false);
  assert.equal(value(build(input({ SyntheticHOA: "No" }), map), "hoa_membership").normalization_status, "invalid");
});

test("digests bind source/version/retention/scope/temporal evidence and ordering is deterministic", () => {
  const map = registry([field("role_name"), field("fee_amount")]);
  const source = input({ role_name: "Builder", fee_amount: 0 });
  const first = build(source, map);
  map.fields.reverse(); source.payload = { fee_amount: 0, role_name: "Builder" };
  assert.equal(build(source, map).observation_sha256, first.observation_sha256);
  source.retrieved_at = "2026-09-02T00:00:00.000Z";
  assert.notEqual(build(source, map).observation_sha256, first.observation_sha256);
  assert.equal(build(source, map).extraction_key_sha256, first.extraction_key_sha256);
  assert.equal(build(source, map).source_identity_sha256, first.source_identity_sha256);
  source.provider_version = "fixture-provider-2";
  assert.notEqual(build(source, map).extraction_key_sha256, first.extraction_key_sha256);
  assert.throws(() => build(input({}, { content_sha256: "0".repeat(64) }), map), /content_sha256.mismatch/);
  const forged = structuredClone(first); forged.fields[0].value = "tampered";
  assert.throws(() => atDate(forged, "2024-01-01"), /digest_mismatch/);
});

test("private scopes remain exact, cannot be promoted into public observations", () => {
  const map = registry([field("role_name")]);
  const organization = build(input({ role_name: "Private LLC" }, { visibility: "organization", scope: { organization_id: org } }), map);
  assert.deepEqual(organization.scope, { organization_id: org });
  const assignmentScope = { organization_id: org, appraisal_case_id: "20000000-0000-4000-8000-000000000001",
    subject_snapshot_id: "30000000-0000-4000-8000-000000000001", account_id: "SYNTHETIC-PARCEL" };
  const privateObservation = build(input({}, { visibility: "assignment", scope: assignmentScope }), map);
  assert.deepEqual(privateObservation.scope, assignmentScope);
  assert.throws(() => build(input({}, { scope: assignmentScope }), map), /scope.public/);
  assert.throws(() => build(input({}, { visibility: "assignment", scope: { organization_id: org } }), map), /scope/);
  assert.throws(() => build(input({}, { visibility: "organization", scope: assignmentScope }), map), /scope/);
});

test("registry validation rejects unknown roles/concepts, ambiguous definitions and unbounded data", () => {
  const good = registry([field("role_name")], [claim("party", "role", ["role_name"], { role: "builder" })]);
  for (const mutate of [
    item => { item.claims[0].role = "seller_and_builder"; },
    item => { item.fields[0].concept = "reputation_price_premium"; },
    item => { item.fields.push({ ...item.fields[0] }); },
    item => { item.fields[0].path = ["__proto__", "name"]; },
    item => { item.claims[0].required_field_ids = []; },
    item => { item.provider = "another-provider"; },
    item => { item.fields = Array.from({ length: SOURCE_OBSERVATION_LIMITS.fields + 1 }, (_, index) => field(`f${index}`, "role_name")); },
  ]) {
    const changed = structuredClone(good); mutate(changed);
    assert.throws(() => build(input({ role_name: "Builder" }), changed), /invalid_source_observation/);
  }
  assert.throws(() => build(input({ role_name: "x".repeat(40_000) }), good), /raw_limit/);
  assert.throws(() => build(input({ role_name: undefined }), good), /invalid_neighborhood_assessment/);
  assert.throws(() => build(input({ role_name: "Builder" }, { retention: { mode: "projected", original_paths: [] } }), good), /present_path_unlisted/);
});

test("fact validity, source dates and historical availability never use a wall-clock fallback", () => {
  const map = registry([field("role_name")], [claim("builder", "role", ["role_name"], { role: "builder" })]);
  const raw = { role_name: "Historical Builder" };
  assert.equal(atDate(build(input(raw, { historical_availability: "unknown" }), map), "2024-06-01").claims[0].state, "unknown");
  assert.equal(atDate(build(input(raw, { historical_availability: "contemporaneous" }), map), "2024-06-01").claims[0].state, "unknown");
  assert.equal(atDate(build(input(raw, { fact_validity: { from: null, to: null } }), map), "2024-06-01").claims[0].state, "unknown");
  assert.throws(() => build(input(raw, { retrieved_at: undefined }), map), /retrieved_at/);
  assert.throws(() => build(input(raw, { fact_validity: { from: "2024-02-30", to: null } }), map), /fact_validity/);
  assert.throws(() => build(input(raw, { fact_validity: { from: "2025-01-01", to: "2024-01-01" } }), map), /reversed/);
  assert.throws(() => build(input(raw, { source_modified_at: "2027-01-01T00:00:00.000Z" }), map), /after_retrieval/);
});

test("explicit claim date fields with gaps or invalid values cannot become open-ended support", () => {
  const map = registry([field("role_name"), field("valid_from"), field("valid_to")], [
    claim("builder", "role", ["role_name", "valid_from", "valid_to"], {
      role: "builder", required_field_ids: ["role_name"], valid_from_field_id: "valid_from", valid_to_field_id: "valid_to",
    }),
  ]);
  const good = build(input({ role_name: "Builder", valid_from: "2019-01-01", valid_to: "2021-12-31" }), map);
  assert.equal(atDate(good, "2020-06-01").claims[0].state, "applicable");
  assert.equal(atDate(good, "2024-06-01").claims[0].state, "not_applicable");
  for (const raw of [
    { role_name: "Builder", valid_from: "2019-01-01" },
    { role_name: "Builder", valid_from: "2019-01-01", valid_to: "invalid-date" },
    { role_name: "Builder", valid_from: "2021-01-01", valid_to: "2020-01-01" },
  ]) {
    const result = build(input(raw), map);
    assert.equal(result.claims[0].status, "incomplete");
    assert.equal(atDate(result, "2024-06-01").claims[0].state, "unknown");
  }
});

test("explicit mapping order is immaterial and contradictory same-concept fields require separate claims", () => {
  const map = registry([field("hoa_membership", "hoa_membership", { value_map: [{ raw: "Y", value: true }, { raw: "N", value: false }] })]);
  const original = build(input({ hoa_membership: "Y" }), map);
  map.fields[0].value_map.reverse();
  assert.equal(build(input({ hoa_membership: "Y" }), map).observation_sha256, original.observation_sha256);
  const ambiguous = registry([field("seller", "role_name"), field("builder", "role_name")], [
    claim("both", "role", ["seller", "builder"], { role: "builder" }),
  ]);
  assert.throws(() => build(input({ seller: "S LLC", builder: "B LLC" }), ambiguous), /claim.concepts.duplicate/);
});
