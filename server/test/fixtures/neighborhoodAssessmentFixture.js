import { assessmentEvidenceDigest } from "../../src/services/neighborhoodAssessment/contract.js";

export const ASSESSMENT_SCOPE = {
  organization_id: "10000000-0000-4000-8000-000000000001",
  appraisal_case_id: "20000000-0000-4000-8000-000000000001",
  subject_snapshot_id: "30000000-0000-4000-8000-000000000001",
  account_id: "SYNTHETIC-P1",
};

export function neighborhoodAssessmentFixture() {
  return {
    contract_version: 1,
    id: "40000000-0000-4000-8000-000000000001", revision: 1,
    scope: { ...ASSESSMENT_SCOPE }, effective_date: "2024-06-30", data_cutoff: "2024-06-30",
    generated_at: "2026-09-05T00:00:00.000Z",
    observation_period: { start_date: "2023-07-01", end_date: "2024-06-30", date_basis: "closing_date" },
    subject_facts: { year_built: 2004, gla_sqft: 2000, site_area_sqft: 8000, housing_type: "single_family", snapshot_revision: 1 },
    methodology: { version: "foundation-v1", geometry_version: "synthetic-cell-v1", configuration: { minimum_physical_support: 0.6 } },
    source_snapshots: [{
      id: "fixture-source", revision: "1", provider: "synthetic-replay",
      content_sha256: assessmentEvidenceDigest({ fixture: "neighborhood-v1" }),
      visibility: "public", scope: null, valid_from: "2004-01-01", valid_to: null,
      observed_at: "2026-09-01T00:00:00.000Z", historical_availability: "reconstructed",
    }],
    discovery: { radius_miles: 3, center: [-97, 33], complete: true },
    selection: { revision: "1", pocket_ids: ["pocket-a"], overrides: [], housing_eligibility: "verified_single_family" },
    geographic_neighborhood: {
      status: "ready", reasons: [], revision: "geometry-1", crs: "EPSG:4326",
      geometry: { type: "Polygon", coordinates: [[[-97.01, 32.99], [-96.99, 32.99], [-96.99, 33.01], [-97.01, 33.01], [-97.01, 32.99]]] },
      perimeter: [
        { edge_id: "e1", from_node: "n1", to_node: "n2", name: "South Road", source_refs: ["fixture-source"] },
        { edge_id: "e2", from_node: "n2", to_node: "n3", name: "East Road", source_refs: ["fixture-source"] },
        { edge_id: "e3", from_node: "n3", to_node: "n4", name: "North Road", source_refs: ["fixture-source"] },
        { edge_id: "e4", from_node: "n4", to_node: "n1", name: "West Road", source_refs: ["fixture-source"] },
      ],
      validation: { valid: true, connected: true, contains_subject: true, engine: "synthetic-oracle", revision: "1" },
      cardinal_summaries: { north: "North Road", east: "East Road", south: "South Road", west: "West Road" },
    },
    populations: [
      { id: "stock-a", revision: "1", kind: "competitive_stock", member_unit: "property", property_link_count: 4, definition: "Four eligible dwellings in pocket A", observation_period: { start_date: "2024-06-30", end_date: "2024-06-30", date_basis: "effective_date" }, member_count: 4, unique_property_count: 4, member_set_sha256: assessmentEvidenceDigest(["P1", "P2", "P3", "P4"]), members_resource_id: "members-stock-a-1", pocket_ids: ["pocket-a"], completeness: "complete", reasons: [], source_refs: ["fixture-source"] },
      { id: "sales-a", revision: "1", kind: "transactions", member_unit: "canonical_transaction", property_link_count: 3, definition: "Eligible canonical closed single-property transactions", observation_period: { start_date: "2023-07-01", end_date: "2024-06-30", date_basis: "closing_date" }, member_count: 3, unique_property_count: 2, member_set_sha256: assessmentEvidenceDigest(["T1", "T2", "T3"]), members_resource_id: "members-sales-a-1", pocket_ids: ["pocket-a"], completeness: "complete", reasons: [], source_refs: ["fixture-source"] },
    ],
    statistics: [
      { id: "median-sale-price", population_id: "sales-a", measurement: "recorded_sale_price", unit: "USD", estimator: "exact_median", estimator_parameters: {}, value: 330000, status: "ready", reason: null, observed_count: 3, missing_count: 0, denominator_count: 3, denominator_basis: "population_members", assessment_tax_year: null, uncertainty: { status: "not_estimated", reason: "synthetic_fixture" }, source_refs: ["fixture-source"] },
      { id: "predominant-sale-price", population_id: "sales-a", measurement: "predominant_sale_price", unit: "USD", estimator: "unsupported", estimator_parameters: {}, value: null, status: "unsupported", reason: "no_supported_modal_estimator", observed_count: 3, missing_count: 0, denominator_count: 3, denominator_basis: "population_members", assessment_tax_year: null, uncertainty: { status: "not_estimated" }, source_refs: ["fixture-source"] },
    ],
    required_statistic_ids: ["median-sale-price"],
    required_population_ids: ["stock-a", "sales-a"],
    development_evidence: { status: "incomplete", profile_refs: [], reasons: ["builder_research_unavailable"] },
    diagnostics: { physical_similarity: { status: "supported" }, transaction_sufficiency: { status: "not_estimated" }, omissions: ["predominant-sale-price"] },
  };
}

export function neighborhoodTargetFixture(workflow = "uad_3_6") {
  return {
    attachment_id: workflow === "uad_3_6" ? "50000000-0000-4000-8000-000000000001" : "50000000-0000-4000-8000-000000000002",
    attachment_revision: 1,
    effective_date: "2024-06-30", data_cutoff: "2024-06-30",
    scope: { ...ASSESSMENT_SCOPE },
    report_file_id: workflow === "uad_3_6" ? "60000000-0000-4000-8000-000000000001" : "60000000-0000-4000-8000-000000000002",
    workflow_type: workflow,
    custom_assignment_file_id: workflow === "custom_appraisal" ? 1 : null,
    uad_workfile_id: workflow === "uad_3_6" ? "70000000-0000-4000-8000-000000000001" : null,
    editor_revision: 5, source_digest_sha256: assessmentEvidenceDigest({ editor: "fixture-5" }),
    mapped_manifest_sha256: assessmentEvidenceDigest({ mapper: "fixture" }),
    mapper_version: "synthetic-mapper-1", specification_release: workflow === "uad_3_6" ? "repository-pinned-fixture" : null,
  };
}
