import { assessmentEvidenceDigest, buildNeighborhoodAssessment } from "../../src/services/neighborhoodAssessment/contract.js";
import { CURRENT_UAD_RELEASE_KEY } from "../../src/modules/uad/constants.js";
import { buildUadNeighborhoodCandidate } from "../../src/modules/uad/neighborhoodReview.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./neighborhoodAssessmentFixture.js";

export function uadNeighborhoodReviewFixture({ zeroSales = false } = {}) {
  const input = neighborhoodAssessmentFixture();
  const median = input.statistics[0];
  const population = input.populations.find(item => item.id === "sales-a");
  if (zeroSales) {
    Object.assign(population, { member_count: 0, unique_property_count: 0, property_link_count: 0,
      member_set_sha256: assessmentEvidenceDigest([]) });
  }
  const count = { ...median, id: "sale-count", measurement: "transaction_count", unit: "transactions", estimator: "count",
    value: zeroSales ? 0 : 3, observed_count: zeroSales ? 0 : 3, denominator_count: zeroSales ? 0 : 3 };
  input.statistics = zeroSales ? [count] : [count, median,
    { ...median, id: "lowest-price", value: 300000, estimator: "exact_quantile", estimator_parameters: { convention: "type_7", probability: 0 } },
    { ...median, id: "highest-price", value: 390000, estimator: "exact_quantile", estimator_parameters: { convention: "type_7", probability: 1 } },
  ];
  input.required_statistic_ids = input.statistics.map(item => item.id);
  const assessment = buildNeighborhoodAssessment(input);
  const target = { ...neighborhoodTargetFixture(), status: "draft", signed_at: null, has_signatures: false,
    specification_release: CURRENT_UAD_RELEASE_KEY };
  const market_context = {
    context_version: 1, assessment_digest_sha256: assessment.evidence_digest_sha256,
    population_ref: { id: population.id, revision: population.revision, member_set_sha256: population.member_set_sha256 },
    transaction_scope: "closed_single_property_sales", observation_period: { ...population.observation_period },
    lookback_months: 12,
    analysis_geometry: { role: "geographic_neighborhood", revision: assessment.geographic_neighborhood.revision,
      geometry_sha256: assessment.application_group.geometry_sha256,
      boundary_description: "North: North Road; East: East Road; South: South Road; West: West Road." },
    search_criteria: "Eligible single-family, single-property closed sales in pocket A, closing July 1, 2023 through June 30, 2024.",
    source_refs: ["fixture-source"],
    statistic_ids: { count: "sale-count", low: zeroSales ? null : "lowest-price",
      median: zeroSales ? null : "median-sale-price", high: zeroSales ? null : "highest-price" },
  };
  const candidate = buildUadNeighborhoodCandidate({ assessment, target, market_context });
  const existing_values = candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true,
    populated: false, value: null }));
  for (const key of ["market_total_sales:3000.0028", "market_total_sales:3000.0029", "market_total_sales:3000.0027"]) {
    if (!existing_values.some(item => item.target_key === key)) existing_values.push({ target_key: key,
      target_exists: true, populated: false, value: null });
  }
  const request = { confirmed: true, preserve_existing: true,
    expected_candidate_digest_sha256: candidate.candidate_digest_sha256,
    expected_binding_digest_sha256: candidate.attachment?.binding_digest_sha256,
    expected_revision: target.editor_revision, selected_suggestion_ids: candidate.suggestions.map(item => item.id) };
  return { assessment, target, market_context, candidate, existing_values, request };
}
