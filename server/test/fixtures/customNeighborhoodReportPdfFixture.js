import { buildNeighborhoodAssessment } from "../../src/services/neighborhoodAssessment/contract.js";
import { buildNeighborhoodApplicationReceipt } from "../../src/services/neighborhoodAssessment/applicationGroup.js";
import { prepareCustomNeighborhoodAcceptanceSnapshot } from "../../src/services/neighborhoodAssessment/customAcceptanceSnapshot.js";
import { buildCustomNeighborhoodReportCandidate, prepareCustomNeighborhoodReportApply } from "../../src/services/neighborhoodAssessment/customReportMapping.js";
import { neighborhoodAssessmentFixture, neighborhoodTargetFixture } from "./neighborhoodAssessmentFixture.js";
import { customAppraisalReportFixture } from "./customAppraisalReportFixture.js";

// Synthetic evidence normalized and mapped through the actual production paths.
// It provides no cadastral, source, topology or signature authority.
export function customNeighborhoodReportPdfFixture({ extraStatistics = 0, longDescriptions = false, mutateRaw } = {}) {
  const { snapshot, property } = customAppraisalReportFixture();
  const raw = neighborhoodAssessmentFixture();
  raw.scope.account_id = property.account.account_id;
  const stat = patch => ({ ...structuredClone(raw.statistics[0]), ...patch });
  raw.selection.pocket_ids.push("pocket-b");
  raw.statistics.push(
    stat({ id: "cad-median", population_id: "stock-a", measurement: "assessed_market_value", value: 410001,
      observed_count: 4, denominator_count: 4, assessment_tax_year: 2024 }),
    stat({ id: "cad-per-sf", population_id: "stock-a", measurement: "assessed_value_per_square_foot", unit: "USD/ft2", value: 205.0005,
      observed_count: 4, denominator_count: 4, assessment_tax_year: 2024 }),
    stat({ id: "stock-age", population_id: "stock-a", measurement: "age_at_effective_date", unit: "years", value: 20, observed_count: 4, denominator_count: 4 }),
    stat({ id: "sale-age", measurement: "age_at_sale", unit: "years", value: 18 }),
    stat({ id: "sale-cod", measurement: "cod_percent", unit: "percent", estimator: "coefficient_of_dispersion", value: 12.75 }),
    stat({ id: "sale-quantile", estimator: "exact_quantile", estimator_parameters: { convention: "type_7", probability: 0.25 }, value: 315001 }),
    stat({ id: "modal-sale-price", measurement: "predominant_sale_price", estimator: "modal_interval",
      estimator_parameters: { method: "fixed_width_histogram", lower_bound: 300000, upper_bound: 350000, bin_width: 50000 }, value: 335001 }),
    stat({ id: "unique-sale-properties", measurement: "unique_property_count", unit: "properties", estimator: "count", value: 2,
      observed_count: 2, denominator_count: 2, denominator_basis: "unique_properties" }),
    stat({ id: "known-zero-coverage", population_id: "stock-a", measurement: "data_coverage_percent", unit: "percent", estimator: "ratio",
      estimator_parameters: { numerator_count: 0 }, value: 0, observed_count: 0, missing_count: 4, denominator_count: 4 }),
  );
  raw.populations.push({ ...structuredClone(raw.populations[1]), id: "allocated-a", member_unit: "allocated_property_sale", definition: "Two property allocations from a package transaction", member_count: 2, unique_property_count: 2, property_link_count: 2 });
  raw.statistics.push(stat({ id: "allocated-price", population_id: "allocated-a", measurement: "allocated_sale_price", value: 120001, observed_count: 2, denominator_count: 2 }));
  raw.populations.push({ ...structuredClone(raw.populations[1]), id: "listings-a", kind: "listings", member_unit: "listing", definition: "Listings are a separate supplied population", member_count: 33, unique_property_count: 31, property_link_count: 33, observation_period: { ...raw.observation_period, date_basis: "status_as_of" } });
  raw.statistics.push(stat({ id: "listing-count", population_id: "listings-a", measurement: "listing_count", unit: "listings", estimator: "count", value: 33, observed_count: 33, denominator_count: 33 }));
  raw.populations.push({ ...structuredClone(raw.populations[0]), id: "zero-stock", member_count: 0, unique_property_count: 0, property_link_count: 0 });
  raw.statistics.push(stat({ id: "zero-count", population_id: "zero-stock", measurement: "property_count", unit: "properties", estimator: "count", value: 0, observed_count: 0, denominator_count: 0 }));
  raw.statistics.push(stat({ id: "zero-denominator", population_id: "zero-stock", measurement: "data_coverage_percent", unit: "percent", estimator: "ratio", estimator_parameters: { numerator_count: 0 }, value: null, status: "incomplete", reason: "denominator_unavailable", observed_count: 0, denominator_count: 0 }));
  for (let index = 0; index < extraStatistics; index++) raw.statistics.push(stat({ id: `retained-stat-${index}`, value: 800000 + index }));
  if (longDescriptions) {
    raw.geographic_neighborhood.cardinal_summaries.north = `${"Stored northern boundary description ".repeat(45)}NORTH_END_MARKER`;
    raw.populations[0].definition = `${"Complete population definition ".repeat(55)}DEFINITION_END_MARKER`;
    raw.statistics[1].reason = `${"No supported modal estimator. ".repeat(55)}REASON_END_MARKER`;
  }
  mutateRaw?.(raw);
  const assessment = buildNeighborhoodAssessment(raw);
  const target = { ...neighborhoodTargetFixture("custom_appraisal"), scope: assessment.scope,
    custom_assignment_file_id: snapshot.assignment_file_id };
  const candidate = buildCustomNeighborhoodReportCandidate({ assessment, target });
  if (candidate.status !== "ready") throw new Error(JSON.stringify(candidate));
  const plan = prepareCustomNeighborhoodReportApply({ assessment, target,
    existing_values: candidate.suggestions.map(item => ({ target_key: item.target_key, target_exists: true, populated: false })),
    request: { selected_ids: candidate.suggestions.map(item => item.id), binding_digest_sha256: candidate.attachment.binding_digest_sha256 },
    current_application_identity_sha256: candidate.attachment.application_identity_sha256, current_editor_revision: target.editor_revision });
  if (plan.status !== "ready") throw new Error(JSON.stringify(plan));
  const saved = prepareCustomNeighborhoodAcceptanceSnapshot({ assessment, attachment: candidate.attachment,
    mappedSuggestions: candidate.suggestions, operationId: "abcdef01-0000-4000-8000-000000000001",
    actorUserId: "abcdef02-0000-4000-8000-000000000002", receipt: buildNeighborhoodApplicationReceipt(plan, target.editor_revision + 1) });
  snapshot.assignment.organization_id = assessment.scope.organization_id;
  snapshot.signature = { organization_id: assessment.scope.organization_id };
  snapshot.sections.neighborhood_assessment = { value: structuredClone(saved.section_value), revision: saved.section_value.accepted_editor_revision };
  snapshot.evidence = { ...snapshot.evidence, property_report_data: property, report_files: [{
    id: target.report_file_id, organization_id: assessment.scope.organization_id, account_id: assessment.scope.account_id,
    workflow_type: "custom_appraisal", custom_assignment_file_id: snapshot.assignment_file_id, uad_workfile_id: null, tax_protest_file_id: null,
  }] };
  return { snapshot, property, assessment, target, section: snapshot.sections.neighborhood_assessment.value };
}
