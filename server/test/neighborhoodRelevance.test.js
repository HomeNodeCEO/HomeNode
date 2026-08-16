import assert from "node:assert/strict";
import test from "node:test";

import {
  NEIGHBORHOOD_BOUNDARY_DISCLOSURE,
  NEIGHBORHOOD_RELEVANCE_EXCLUSION_THRESHOLD,
  NEIGHBORHOOD_RELEVANCE_WEIGHTS,
  assessNeighborhoodRelevanceConfidence,
  buildNeighborhoodRelevanceAssessment,
  buildNeighborhoodRelevanceDistributions,
  scoreNeighborhoodCandidate,
} from "../src/services/neighborhoodRelevance.js";

function subject(overrides = {}) {
  return {
    account_id: "subject",
    year_built: 1978,
    site_area_sqft: 8_000,
    gla_sqft: 1_800,
    reference_sale_price: 300_000,
    ...overrides,
  };
}

function candidates(count = 40) {
  return Array.from({ length: count }, (_, index) => ({
    account_id: `candidate-${index + 1}`,
    year_built: 1973 + (index % 11),
    site_area_sqft: 7_200 + (index % 9) * 200,
    gla_sqft: 1_200 + (index % 8) * 250,
    sale_price: 275_000 + (index % 12) * 5_000,
    sale_date: index % 2 ? "2026-06-01" : "2023-06-01",
    distance_miles: 0.1 + (index % 10) * 0.08,
  }));
}

test("locks the initial 40/30/20/10 relevance weights", () => {
  assert.deepEqual(NEIGHBORHOOD_RELEVANCE_WEIGHTS, {
    age: 0.40,
    site_size: 0.30,
    proximity: 0.20,
    sale_price: 0.10,
  });
  assert.equal(NEIGHBORHOOD_RELEVANCE_EXCLUSION_THRESHOLD, 20);
});

test("excludes sufficiently documented candidates scoring below twenty percent", () => {
  const available = candidates();
  const distributions = buildNeighborhoodRelevanceDistributions(subject(), available);
  const result = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: {
      account_id: "low-relevance",
      year_built: 2025,
      site_area_sqft: 50_000,
      sale_price: 1_500_000,
      distance_miles: 2,
    },
  });
  assert.ok(result.score < 20);
  assert.equal(result.excluded, true);
  assert.equal(result.statistical_classification, "excluded_low_relevance");
  assert.equal(result.exclusion_requires_contiguous_cluster, false);
});

test("does not exclude low-information records solely because their normalized score is low", () => {
  const available = candidates();
  const distributions = buildNeighborhoodRelevanceDistributions(subject(), available);
  const result = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: {
      account_id: "missing-physical-data",
      distance_miles: 2,
    },
  });
  assert.equal(result.available_weight_percent, 20);
  assert.equal(result.excluded, false);
  assert.equal(result.statistical_classification, "insufficient_data");
});

test("does not time-adjust sale prices and keeps GLA diagnostic-only", () => {
  const available = candidates();
  const distributions = buildNeighborhoodRelevanceDistributions(subject(), available);
  const recent = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: { ...available[0], sale_price: 300_000, sale_date: "2026-07-01" },
  });
  const older = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: { ...available[0], sale_price: 300_000, sale_date: "2022-07-01" },
  });
  assert.equal(recent.score, older.score);
  assert.equal(recent.sale_price_time_adjusted, false);
  assert.equal(older.sale_price_time_adjusted, false);
  assert.equal(recent.gla_diagnostic.contributes_to_score, false);
});

test("requires multiple deviations or an extreme deviation plus boundary evidence", () => {
  const available = candidates();
  const distributions = buildNeighborhoodRelevanceDistributions(subject(), available);
  const oneDifference = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: {
      ...available[0],
      year_built: 2020,
      site_area_sqft: 8_000,
      sale_price: 300_000,
    },
  });
  assert.equal(oneDifference.statistical_classification, "relevant_candidate");

  const multipleDifferences = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: {
      ...available[0],
      year_built: 2020,
      site_area_sqft: 30_000,
      sale_price: 300_000,
    },
  });
  assert.equal(
    multipleDifferences.statistical_classification,
    "potential_dissimilar_cluster_member",
  );
  assert.equal(multipleDifferences.exclusion_requires_contiguous_cluster, true);

  const supportedExtreme = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: {
      ...available[0],
      year_built: 2020,
      site_area_sqft: 8_000,
      sale_price: 300_000,
      road_boundary_strength: "strong",
    },
  });
  assert.equal(
    supportedExtreme.statistical_classification,
    "potential_dissimilar_cluster_member",
  );
});

test("normalizes across available factors without treating missing sale price as dissimilar", () => {
  const available = candidates();
  const distributions = buildNeighborhoodRelevanceDistributions(subject(), available);
  const result = scoreNeighborhoodCandidate({
    subject: subject(),
    distributions,
    maximumDistanceMiles: 2,
    candidate: {
      year_built: 1978,
      site_area_sqft: 8_000,
      distance_miles: 0,
      sale_price: null,
    },
  });
  assert.equal(result.score, 100);
  assert.equal(result.available_weight_percent, 90);
  assert.equal(result.statistical_classification, "relevant_candidate");
});

test("assigns high confidence only when physical, coordinate, and sale coverage are sufficient", () => {
  const available = candidates(60);
  const assessment = buildNeighborhoodRelevanceAssessment({
    subject: subject(),
    candidates: available,
    maximumDistanceMiles: 2,
    sourceHealth: [{ source_key: "dcad_parcels", status: "current" }],
  });
  assert.equal(assessment.confidence.confidence, "high");
  assert.equal(assessment.confidence.appraiser_review_required, false);
  assert.equal(assessment.broad_boundary_is_inclusion_rule, false);
  assert.equal(assessment.sale_price_time_adjusted, false);
  assert.equal(assessment.exclusion_threshold_percent, 20);
});

test("recommends automated widening before appraiser review for sparse data", () => {
  const sparse = candidates(10).map((candidate, index) => ({
    ...candidate,
    sale_price: index < 5 ? candidate.sale_price : null,
  }));
  const confidence = assessNeighborhoodRelevanceConfidence({ candidates: sparse });
  assert.equal(confidence.confidence, "limited");
  assert.equal(confidence.appraiser_review_required, true);
  assert.ok(confidence.automatic_actions.includes("extend_sale_history_to_36_months"));
  assert.ok(confidence.automatic_actions.includes("expand_discovery_radius"));
});

test("boundary disclosure distinguishes geography from relevant data selection", () => {
  assert.match(NEIGHBORHOOD_BOUNDARY_DISCLOSURE, /broader geographic setting/i);
  assert.match(NEIGHBORHOOD_BOUNDARY_DISCLOSURE, /not treated as an automatic inclusion rule/i);
  assert.match(NEIGHBORHOOD_BOUNDARY_DISCLOSURE, /unadjusted sale-price similarity/i);
});
