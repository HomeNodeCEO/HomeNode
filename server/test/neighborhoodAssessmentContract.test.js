import assert from "node:assert/strict";
import test from "node:test";
import { assessmentDate, assessmentEvidenceDigest, buildNeighborhoodAssessment, buildNeighborhoodAttachment, canonicalAssessmentJson, NEIGHBORHOOD_MEASUREMENTS } from "../src/services/neighborhoodAssessment/contract.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./fixtures/neighborhoodAssessmentFixture.js";

test("assessment is immutable, deterministic and independent of target workflow/request time", () => {
  const input = neighborhoodAssessmentFixture();
  const result = buildNeighborhoodAssessment(input);
  const later = { ...input, generated_at: "2026-09-06T00:00:00.000Z" };
  assert.equal(result.evidence_digest_sha256, buildNeighborhoodAssessment(later).evidence_digest_sha256);
  assert.equal(result.input_signature_sha256, buildNeighborhoodAssessment(later).input_signature_sha256);
  assert.ok(Object.isFrozen(result.statistics[0]));
  input.subject_facts.gla_sqft = 9999;
  assert.equal(result.subject_facts.gla_sqft, 2000);
  assert.equal(result.application_group.policy, "all_or_nothing");
  assert.equal(result.application_group.status, "ready");
  assert.deepEqual(result.application_group.required_statistic_ids, ["median-sale-price"]);
  assert.deepEqual(result.required_population_ids, ["sales-a", "stock-a"]);
  assert.deepEqual(result.application_group.population_refs.map(item => item.id), result.required_population_ids);
  assert.equal(result.statistics.find(item => item.id === "predominant-sale-price").value, null);
});

test("UAD-only and same-assignment Custom have one core and distinct exact attachment bindings", () => {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const uad = buildNeighborhoodAttachment(assessment, neighborhoodTargetFixture());
  const custom = buildNeighborhoodAttachment(assessment, neighborhoodTargetFixture("custom_appraisal"));
  assert.equal(uad.custom_assignment_file_id, null);
  assert.equal(uad.evidence_digest_sha256, custom.evidence_digest_sha256);
  assert.notEqual(uad.binding_digest_sha256, custom.binding_digest_sha256);
  assert.notEqual(uad.report_file_id, uad.uad_workfile_id);
  assert.notEqual(uad.report_file_id, custom.report_file_id);
  assert.notEqual(uad.application_identity_sha256, custom.application_identity_sha256);
  assert.equal(uad.application_group_id, custom.application_group_id);
  assert.equal(uad.review_status, "proposed");
});

test("all scoring/date/source/selection inputs affect the request identity", () => {
  const reference = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  for (const edit of [
    input => { input.subject_facts.gla_sqft++; },
    input => {
      input.effective_date = "2024-07-01"; input.data_cutoff = "2024-07-01";
      input.populations[0].observation_period.start_date = "2024-07-01";
      input.populations[0].observation_period.end_date = "2024-07-01";
    },
    input => { input.source_snapshots[0].revision = "2"; },
    input => { input.methodology.configuration.minimum_physical_support = 0.7; },
    input => { input.selection.overrides = [{ pocket_id: "pocket-a", included: false }]; },
  ]) {
    const input = neighborhoodAssessmentFixture(); edit(input);
    const result = buildNeighborhoodAssessment(input);
    assert.notEqual(result.input_signature_sha256, reference.input_signature_sha256);
    assert.notEqual(result.evidence_digest_sha256, reference.evidence_digest_sha256);
  }
});

test("source/statistic/population set ordering and object keys do not change digests", () => {
  const input = neighborhoodAssessmentFixture();
  const reference = buildNeighborhoodAssessment(input);
  input.statistics.reverse(); input.populations.reverse();
  input.required_population_ids.reverse();
  input.subject_facts = Object.fromEntries(Object.entries(input.subject_facts).reverse());
  assert.equal(reference.evidence_digest_sha256, buildNeighborhoodAssessment(input).evidence_digest_sha256);
  assert.equal(assessmentEvidenceDigest({ b: 2, a: 1 }), assessmentEvidenceDigest({ a: 1, b: 2 }));
});

test("strict Gregorian dates and temporal boundaries reject future sale periods", () => {
  assert.equal(assessmentDate("2024-02-29"), "2024-02-29");
  for (const value of ["2023-02-29", "2024-06-31", "2024-6-1", null]) assert.throws(() => assessmentDate(value));
  const input = neighborhoodAssessmentFixture();
  input.populations[1].observation_period.end_date = "2024-07-01";
  assert.throws(() => buildNeighborhoodAssessment(input), /future_or_reversed/);
  input.populations[1].observation_period.end_date = "2024-06-30";
  input.data_cutoff = "2024-06-29";
  assert.throws(() => buildNeighborhoodAssessment(input), /data_cutoff/);
});

test("unknown is not zero; observed denominators and predominant semantics are enforced", () => {
  const input = neighborhoodAssessmentFixture();
  input.statistics[0].missing_count = 1;
  assert.throws(() => buildNeighborhoodAssessment(input), /denominator/);
  input.statistics[0].missing_count = 0;
  input.statistics[0].measurement = "predominant_sale_price";
  assert.throws(() => buildNeighborhoodAssessment(input), /median_not_predominant/);
  input.statistics[0].measurement = "assessed_market_value";
  assert.throws(() => buildNeighborhoodAssessment(input), /assessment_tax_year_required/);
});

test("incomplete geometry blocks coherent group readiness and complete chains cannot have gaps", () => {
  const input = neighborhoodAssessmentFixture();
  input.geographic_neighborhood.perimeter[1].from_node = "missing-node";
  assert.throws(() => buildNeighborhoodAssessment(input), /perimeter.gap/);
  input.geographic_neighborhood.status = "incomplete";
  input.geographic_neighborhood.reasons = ["source_edge_gap"];
  input.geographic_neighborhood.geometry = null;
  input.geographic_neighborhood.validation.valid = null;
  const result = buildNeighborhoodAssessment(input);
  assert.equal(result.application_group.status, "incomplete");
  assert.equal(result.geographic_neighborhood.geometry, null);
});

test("private sources cannot leak from another organization or assignment", () => {
  const input = neighborhoodAssessmentFixture();
  input.source_snapshots[0].visibility = "assignment";
  input.source_snapshots[0].scope = { ...input.scope };
  assert.doesNotThrow(() => buildNeighborhoodAssessment(input));
  input.source_snapshots[0].scope.appraisal_case_id = "20000000-0000-4000-8000-000000000009";
  assert.throws(() => buildNeighborhoodAssessment(input), /private_source_assignment/);
});

test("changed assessment, target scope and revisions cannot silently reuse a binding", () => {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const target = neighborhoodTargetFixture();
  const original = buildNeighborhoodAttachment(assessment, target);
  target.editor_revision++;
  assert.notEqual(original.binding_digest_sha256, buildNeighborhoodAttachment(assessment, target).binding_digest_sha256);
  target.scope.organization_id = "10000000-0000-4000-8000-000000000002";
  assert.throws(() => buildNeighborhoodAttachment(assessment, target), /scope_mismatch/);
  assert.throws(() => buildNeighborhoodAttachment({ ...assessment, effective_date: "2024-07-01" }, neighborhoodTargetFixture()), /changed_assessment/);
});

test("reject unknown versions, duplicate identities, target data in core and lossy JSON", () => {
  const input = neighborhoodAssessmentFixture(); input.contract_version = 2;
  assert.throws(() => buildNeighborhoodAssessment(input), /contract_version/);
  input.contract_version = 1; input.statistics.push(input.statistics[0]);
  assert.throws(() => buildNeighborhoodAssessment(input), /statistics.duplicate/);
  input.statistics.pop(); input.target = neighborhoodTargetFixture();
  assert.throws(() => buildNeighborhoodAssessment(input), /target_outside_core/);
  for (const value of [undefined, NaN, Infinity, { a: undefined }, new Date()]) {
    assert.throws(() => canonicalAssessmentJson(value));
  }
});

test("ready group requires nonempty required statistics and complete discovery", () => {
  const input = neighborhoodAssessmentFixture();
  const original = buildNeighborhoodAssessment(input);
  input.required_statistic_ids = [];
  const noRequired = buildNeighborhoodAssessment(input);
  assert.equal(noRequired.application_group.status, "incomplete");
  assert.notEqual(original.input_signature_sha256, noRequired.input_signature_sha256);
  input.statistics = [];
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "incomplete");
  for (const complete of [false, null]) {
    const truncated = neighborhoodAssessmentFixture(); truncated.discovery.complete = complete;
    assert.equal(buildNeighborhoodAssessment(truncated).application_group.status, "incomplete");
  }
  assert.equal(original.development_evidence.status, "incomplete");
  assert.equal(original.application_group.status, "ready", "optional unfinished builder research must not block supported neighborhood group");
});

test("complete populations require actual counts, membership digests and applicable sources", () => {
  for (const mutate of [
    value => { value.member_count = null; },
    value => { value.unique_property_count = null; },
    value => { value.property_link_count = null; },
    value => { value.member_set_sha256 = null; },
    value => { value.source_refs = []; },
    value => { value.reasons = ["truncated"]; },
    value => { value.unique_property_count = 999; },
    value => { value.unique_property_count = 0; },
  ]) {
    const input = neighborhoodAssessmentFixture(); mutate(input.populations[0]);
    assert.throws(() => buildNeighborhoodAssessment(input), /population\./);
  }
  const input = neighborhoodAssessmentFixture();
  input.populations[1].completeness = "unknown"; input.populations[1].reasons = ["source_coverage_unknown"];
  assert.throws(() => buildNeighborhoodAssessment(input), /statistic.not_ready/);
  input.statistics[0].status = "incomplete"; input.statistics[0].reason = "source_coverage_unknown";
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "incomplete");
});

test("multi-parcel transactions distinguish links, unique properties and allocated property sales", () => {
  const input = neighborhoodAssessmentFixture();
  const transactions = input.populations[1];
  transactions.member_count = 3; transactions.property_link_count = 6; transactions.unique_property_count = 5;
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "ready");
  transactions.member_unit = "allocated_property_sale";
  assert.throws(() => buildNeighborhoodAssessment(input), /property_link_count/);
  transactions.member_count = 6;
  input.statistics[0].measurement = "allocated_sale_price";
  for (const statistic of input.statistics) {
    statistic.observed_count = 6; statistic.denominator_count = 6;
  }
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "ready");
  transactions.unique_property_count = 7;
  assert.throws(() => buildNeighborhoodAssessment(input), /unique_property_count/);
});

test("statistics cannot invent population denominators or ready fractional/negative counts", () => {
  const input = neighborhoodAssessmentFixture();
  input.statistics[0].observed_count = 999; input.statistics[0].denominator_count = 999;
  assert.throws(() => buildNeighborhoodAssessment(input), /population_denominator/);
  const count = neighborhoodAssessmentFixture();
  Object.assign(count.statistics[0], { measurement: "transaction_count", unit: "transactions", estimator: "count", value: 3 });
  assert.equal(buildNeighborhoodAssessment(count).application_group.status, "ready");
  for (const value of [-3.5, -1, 0, 1.5, 4]) {
    count.statistics[0].value = value;
    assert.throws(() => buildNeighborhoodAssessment(count), /count_value/);
  }
  Object.assign(count.statistics[0], { value: 0, observed_count: 0, missing_count: 3 });
  assert.throws(() => buildNeighborhoodAssessment(count), /count_membership_unknown/);
  Object.assign(count.statistics[0], {
    measurement: "unique_property_count", unit: "properties", denominator_basis: "unique_properties",
    value: 2, observed_count: 2, missing_count: 0, denominator_count: 2,
  });
  assert.equal(buildNeighborhoodAssessment(count).application_group.status, "ready");
  count.statistics[0].denominator_basis = "population_members";
  assert.throws(() => buildNeighborhoodAssessment(count), /denominator|basis/);
  const empty = neighborhoodAssessmentFixture();
  Object.assign(empty.populations[1], {
    member_count: 0, property_link_count: 0, unique_property_count: 0,
    member_set_sha256: assessmentEvidenceDigest([]),
  });
  for (const statistic of empty.statistics) {
    statistic.observed_count = 0; statistic.denominator_count = 0;
  }
  Object.assign(empty.statistics[0], { measurement: "transaction_count", unit: "transactions", estimator: "count", value: 0 });
  const zero = buildNeighborhoodAssessment(empty);
  assert.equal(zero.application_group.status, "ready", "confirmed empty population can supply a true zero");
  assert.equal(zero.statistics.find(item => item.id === "median-sale-price").value, 0);
});

test("population periods respect cutoff, kind and selected transaction window", () => {
  const edits = [
    input => { input.populations[1].observation_period.start_date = "2023-06-30"; },
    input => { input.populations[1].observation_period.date_basis = "status_as_of"; },
    input => { input.populations[1].observation_period.date_basis = "contract_date"; },
    input => { input.populations[0].observation_period.start_date = "2024-06-29"; },
    input => { input.data_cutoff = "2024-03-31"; input.observation_period.end_date = "2024-03-31"; },
  ];
  for (const edit of edits) {
    const input = neighborhoodAssessmentFixture(); edit(input);
    assert.throws(() => buildNeighborhoodAssessment(input), /population\./);
  }
  const listing = neighborhoodAssessmentFixture();
  listing.populations[1].kind = "listings"; listing.populations[1].member_unit = "listing";
  assert.throws(() => buildNeighborhoodAssessment(listing), /population.date_basis/);
});

test("source support uses fact validity while preserving later-retrieved historical evidence", () => {
  const input = neighborhoodAssessmentFixture();
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "ready");
  for (const edit of [
    source => { source.valid_from = "2025-01-01"; },
    source => { source.valid_to = "2023-12-31"; },
    source => { source.valid_from = null; },
    source => { source.historical_availability = "unknown"; },
    source => { source.historical_availability = "contemporaneous"; },
  ]) {
    const changed = neighborhoodAssessmentFixture(); edit(changed.source_snapshots[0]);
    assert.throws(() => buildNeighborhoodAssessment(changed), /not_complete|source_temporal_support/);
  }
  input.source_snapshots.push({ ...input.source_snapshots[0], id: "future-optional-research", valid_from: "2025-01-01" });
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "ready");
  input.statistics[0].source_refs = ["future-optional-research"];
  assert.throws(() => buildNeighborhoodAssessment(input), /statistic.not_ready/);
});

test("adjacent source fact intervals can jointly cover a full historical population", () => {
  const input = neighborhoodAssessmentFixture();
  input.source_snapshots[0].valid_from = "2024-01-01";
  input.source_snapshots.push({ ...input.source_snapshots[0], id: "earlier-source", valid_from: "2023-07-01", valid_to: "2023-12-31" });
  input.populations[1].source_refs.push("earlier-source");
  for (const statistic of input.statistics) statistic.source_refs.push("earlier-source");
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "ready");
  input.source_snapshots[1].valid_to = "2023-12-30";
  assert.throws(() => buildNeighborhoodAssessment(input), /population.not_complete/);
});

test("ready geography needs bounded valid ring structure and directional narrative", () => {
  for (const coordinates of [[], [[]], [[[0, 0], [1, 1], [2, 2]]],
    [[[0, 0], [181, 1], [2, 2], [0, 0]]], [[[0, 0], [1, 91], [2, 2], [0, 0]]],
    [[[0, 0], ["1", 1], [2, 2], [0, 0]]], [[[0, 0], [1, 1], [2, 2], [3, 3]]],
    [[[0, 0], [1, 1], [0, 0], [0, 0]]]]) {
    const input = neighborhoodAssessmentFixture(); input.geographic_neighborhood.geometry.coordinates = coordinates;
    assert.throws(() => buildNeighborhoodAssessment(input), /geometry\./);
  }
  const input = neighborhoodAssessmentFixture(); input.geographic_neighborhood.cardinal_summaries = {};
  assert.throws(() => buildNeighborhoodAssessment(input), /cardinal_summaries/);
  input.geographic_neighborhood.cardinal_summaries = { north: null, east: "East", south: "South", west: "West" };
  assert.throws(() => buildNeighborhoodAssessment(input), /not_ready/);
});

test("unordered selection sets and overrides canonicalize with duplicate rejection", () => {
  const input = neighborhoodAssessmentFixture();
  input.selection.pocket_ids = ["pocket-z", "pocket-a"];
  input.selection.overrides = [{ pocket_id: "pocket-z", included: false }, { pocket_id: "pocket-a", included: true }];
  const result = buildNeighborhoodAssessment(input);
  input.selection.pocket_ids.reverse(); input.selection.overrides.reverse();
  assert.equal(result.input_signature_sha256, buildNeighborhoodAssessment(input).input_signature_sha256);
  input.selection.pocket_ids.push("pocket-a");
  assert.throws(() => buildNeighborhoodAssessment(input), /pocket_ids.duplicate/);
  input.selection.pocket_ids.pop(); input.selection.overrides.push(input.selection.overrides[0]);
  assert.throws(() => buildNeighborhoodAssessment(input), /override.duplicate/);
});

test("attachment binds group manifest and exact target dates/workflow/revision", () => {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const target = neighborhoodTargetFixture();
  const attachment = buildNeighborhoodAttachment(assessment, target);
  assert.equal(attachment.application_group_sha256, assessmentEvidenceDigest(assessment.application_group));
  assert.equal(attachment.mapped_manifest_sha256, target.mapped_manifest_sha256);
  for (const edit of [
    value => { value.effective_date = "2025-01-01"; },
    value => { value.data_cutoff = "2024-06-29"; },
    value => { value.custom_assignment_file_id = 123; },
    value => { value.editor_revision = 0; },
  ]) {
    const changed = neighborhoodTargetFixture(); edit(changed);
    assert.throws(() => buildNeighborhoodAttachment(assessment, changed), /date_mismatch|inappropriate_workflow|editor_revision/);
  }
  const custom = neighborhoodTargetFixture("custom_appraisal"); custom.uad_workfile_id = target.uad_workfile_id;
  assert.throws(() => buildNeighborhoodAttachment(assessment, custom), /inappropriate_workflow/);
  target.mapped_manifest_sha256 = assessmentEvidenceDigest({ different: "manifest" });
  assert.notEqual(attachment.binding_digest_sha256, buildNeighborhoodAttachment(assessment, target).binding_digest_sha256);
});

test("published measurement vocabulary prevents unit/estimator confusion", () => {
  assert.equal(NEIGHBORHOOD_MEASUREMENTS.recorded_sale_price.unit, "USD");
  assert.ok(Object.isFrozen(NEIGHBORHOOD_MEASUREMENTS.recorded_sale_price.estimators));
  for (const edit of [
    value => { value.measurement = "invented_price"; },
    value => { value.unit = "cents"; },
    value => { value.estimator = "count"; },
    value => { value.estimator = "exact_quantile"; },
    value => { value.measurement = null; },
  ]) {
    const input = neighborhoodAssessmentFixture(); edit(input.statistics[0]);
    assert.throws(() => buildNeighborhoodAssessment(input), /invalid_neighborhood_assessment:statistic\./);
  }
  const input = neighborhoodAssessmentFixture(); input.statistics[0].estimator = "exact_quantile";
  input.statistics[0].estimator_parameters = { probability: 0.5, convention: "type_7" };
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "ready");
});

test("required populations are explicit validated dependencies in the input signature", () => {
  const input = neighborhoodAssessmentFixture();
  const original = buildNeighborhoodAssessment(input);
  input.required_population_ids = ["sales-a"];
  const narrower = buildNeighborhoodAssessment(input);
  assert.notEqual(original.input_signature_sha256, narrower.input_signature_sha256);
  assert.deepEqual(narrower.application_group.population_refs.map(item => item.id), ["sales-a"]);
  input.required_population_ids = ["stock-a"];
  assert.throws(() => buildNeighborhoodAssessment(input), /missing_statistic_population/);
  input.required_population_ids = ["not-present"];
  assert.throws(() => buildNeighborhoodAssessment(input), /missing_population/);
  input.required_population_ids = ["sales-a", "sales-a"];
  assert.throws(() => buildNeighborhoodAssessment(input), /required_population_ids.duplicate/);
  delete input.required_population_ids;
  assert.throws(() => buildNeighborhoodAssessment(input), /required_population_ids/);
});

test("optional incomplete populations and research sources cannot block or enter the required group", () => {
  const input = neighborhoodAssessmentFixture();
  input.source_snapshots.push({ ...input.source_snapshots[0],
    id: "optional-current-research", valid_from: "2025-01-01", historical_availability: "unknown" });
  input.populations.push({ ...input.populations[0], id: "exploratory-stock", member_count: null,
    unique_property_count: null, property_link_count: null, member_set_sha256: null,
    completeness: "unknown", reasons: ["historical_stock_unavailable"], source_refs: ["optional-current-research"] });
  const result = buildNeighborhoodAssessment(input);
  assert.equal(result.application_group.status, "ready");
  assert.equal(result.populations.find(item => item.id === "exploratory-stock").completeness, "unknown");
  assert.deepEqual(result.application_group.population_refs.map(item => item.id), ["sales-a", "stock-a"]);
  assert.deepEqual(result.application_group.source_refs, ["fixture-source"]);
  input.required_population_ids.push("exploratory-stock");
  assert.equal(buildNeighborhoodAssessment(input).application_group.status, "incomplete");
});

test("group source references are the exact union of perimeter and required population/statistic sources", () => {
  const input = neighborhoodAssessmentFixture();
  for (const id of ["population-source", "statistic-source", "optional-statistic-source"]) {
    input.source_snapshots.push({ ...input.source_snapshots[0], id });
  }
  input.populations[1].source_refs = ["population-source"];
  input.statistics[0].source_refs = ["statistic-source"];
  input.statistics[1].source_refs = ["optional-statistic-source"];
  const result = buildNeighborhoodAssessment(input);
  assert.deepEqual(result.application_group.source_refs, ["fixture-source", "population-source", "statistic-source"]);
});

test("stable application identity excludes only mutable attachment and editor revisions", () => {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const target = neighborhoodTargetFixture();
  const original = buildNeighborhoodAttachment(assessment, target);
  for (const edit of [value => { value.editor_revision++; }, value => { value.attachment_revision++; },
    value => { value.editor_revision += 10; value.attachment_revision += 2; }]) {
    const changed = neighborhoodTargetFixture(); edit(changed);
    const next = buildNeighborhoodAttachment(assessment, changed);
    assert.equal(original.application_identity_sha256, next.application_identity_sha256);
    assert.notEqual(original.binding_digest_sha256, next.binding_digest_sha256);
  }
  const { binding_digest_sha256: _bindingDigest, review_status: _status,
    application_identity_sha256: identity, editor_revision: _editorRevision,
    attachment_revision: _attachmentRevision, ...stableFields } = original;
  assert.equal(identity, assessmentEvidenceDigest(stableFields));
});

test("application identity binds exact target and source/mapper/evidence manifests", () => {
  const assessment = buildNeighborhoodAssessment(neighborhoodAssessmentFixture());
  const original = buildNeighborhoodAttachment(assessment, neighborhoodTargetFixture());
  for (const edit of [
    value => { value.report_file_id = "60000000-0000-4000-8000-000000000009"; },
    value => { value.uad_workfile_id = "70000000-0000-4000-8000-000000000009"; },
    value => { value.attachment_id = "50000000-0000-4000-8000-000000000009"; },
    value => { value.source_digest_sha256 = assessmentEvidenceDigest({ source: "changed" }); },
    value => { value.mapped_manifest_sha256 = assessmentEvidenceDigest({ mapping: "changed" }); },
    value => { value.mapper_version = "mapper-2"; },
    value => { value.specification_release = "another-release"; },
  ]) {
    const target = neighborhoodTargetFixture(); edit(target);
    assert.notEqual(original.application_identity_sha256, buildNeighborhoodAttachment(assessment, target).application_identity_sha256);
  }
  const input = neighborhoodAssessmentFixture(); input.revision++;
  assert.notEqual(original.application_identity_sha256,
    buildNeighborhoodAttachment(buildNeighborhoodAssessment(input), neighborhoodTargetFixture()).application_identity_sha256);
  const custom = neighborhoodTargetFixture("custom_appraisal");
  const firstCustom = buildNeighborhoodAttachment(assessment, custom);
  custom.custom_assignment_file_id++;
  assert.notEqual(firstCustom.application_identity_sha256, buildNeighborhoodAttachment(assessment, custom).application_identity_sha256);
});
