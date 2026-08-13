import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPropertyComplexityReview,
  buildPropertyComplexityAssessment,
} from "../src/util/propertyComplexity.js";
import { determineInfluenceRelationship } from "../src/services/propertyContext.js";
import { normalizeSourceHealth } from "../src/services/propertyContextStore.js";

const CURRENT_SOURCE = {
  source_key: "dcad_parcels",
  label: "Dallas CAD parcel GIS",
  usable: true,
  serving_stale_data: false,
};

test("direct commercial adjacency makes an otherwise typical property complex", () => {
  const assessment = buildPropertyComplexityAssessment({
    subject: {
      gross_living_area_sqft: 2_000,
      actual_age: 30,
      site_area_sqft: 8_000,
      amenities: [],
    },
    peerStatistics: {
      peer_count: 50,
      gla: { count: 50, percentile: 50 },
      age: { count: 50, percentile: 50 },
      site_area: { count: 50, percentile: 50 },
      pool_prevalence_percent: 30,
    },
    spatialContext: {
      parcel_available: true,
      site_percentile: 50,
      site_comparison_count: 50,
      adjacent_influences: [{
        category: "commercial",
        category_label: "Commercial",
        relationship: "rear",
        site_address: "100 RETAIL RD",
      }],
      nearby_influences: [],
      corner_lot: false,
    },
    sourceHealth: [CURRENT_SOURCE],
    geography: "suburban",
  });

  assert.equal(assessment.automatic_complexity, "complex");
  assert.equal(assessment.recommended_search_profile, "suburban_complex");
  assert.equal(assessment.factors[0].code, "commercial_adjacency");
  assert.match(assessment.factors[0].detail, /backs to/i);
});

test("GLA, site, age, pool, and additional amenities contribute independent evidence", () => {
  const assessment = buildPropertyComplexityAssessment({
    subject: {
      gross_living_area_sqft: 5_500,
      actual_age: 90,
      site_area_sqft: 40_000,
      amenities: [
        { key: "pool", label: "Pool", present: true },
        { key: "spa", label: "Spa", present: true },
        { key: "guest_house", label: "Guest house", present: true },
      ],
    },
    peerStatistics: {
      peer_count: 100,
      gla: { count: 100, percentile: 97 },
      age: { count: 100, percentile: 96 },
      site_area: { count: 100, percentile: 98 },
      pool_prevalence_percent: 8,
    },
    spatialContext: {
      parcel_available: true,
      site_percentile: 98,
      site_comparison_count: 100,
      adjacent_influences: [],
      nearby_influences: [],
      corner_lot: false,
    },
    sourceHealth: [CURRENT_SOURCE],
    geography: "urban",
  });

  const factorCodes = new Set(assessment.factors.map((factor) => factor.code));
  assert.equal(factorCodes.has("atypical_gla"), true);
  assert.equal(factorCodes.has("atypical_site_size"), true);
  assert.equal(factorCodes.has("atypical_age"), true);
  assert.equal(factorCodes.has("uncommon_pool"), true);
  assert.equal(factorCodes.has("additional_amenities"), true);
  assert.equal(assessment.automatic_complexity, "complex");
});

test("a failed refresh remains usable and tells the appraiser stale data was used", () => {
  const now = Date.parse("2026-08-12T12:00:00Z");
  const health = normalizeSourceHealth({
    source_key: "dcad_parcels",
    source_label: "Dallas CAD parcel GIS",
    status: "failed",
    row_count: 800_000,
    last_success_at: "2026-08-10T12:00:00Z",
    last_error: "source unavailable",
  }, { staleAfterHours: 72, now });
  const assessment = buildPropertyComplexityAssessment({
    peerStatistics: { peer_count: 25 },
    spatialContext: { parcel_available: true, adjacent_influences: [], nearby_influences: [] },
    sourceHealth: [health],
  });

  assert.equal(health.usable, true);
  assert.equal(health.serving_stale_data, true);
  assert.match(assessment.warnings.join(" "), /most recent locally stored data/i);
});

test("missing parcel compactness is not treated as an irregular parcel", () => {
  const assessment = buildPropertyComplexityAssessment({
    subject: {
      gross_living_area_sqft: 1_470,
      actual_age: 53,
      site_area_sqft: 7_578,
      amenities: [],
    },
    peerStatistics: {
      peer_count: 162,
      gla: { count: 162, percentile: 34 },
      age: { count: 162, percentile: 70 },
      site_area: { count: 147, percentile: 73 },
    },
    spatialContext: {
      parcel_available: false,
      parcel_compactness: null,
      adjacent_influences: [],
      nearby_influences: [],
      corner_lot: false,
    },
    sourceHealth: [],
    geography: "suburban",
  });

  assert.equal(
    assessment.factors.some((factor) => factor.code === "irregular_site"),
    false,
  );
  assert.equal(assessment.automatic_complexity, "simple");
  assert.match(assessment.warnings.join(" "), /parcel is not yet available/i);
});

test("appraiser override changes the effective search profile without rewriting automation", () => {
  const automatic = buildPropertyComplexityAssessment({
    peerStatistics: { peer_count: 25 },
    spatialContext: { parcel_available: true, adjacent_influences: [], nearby_influences: [] },
    geography: "rural",
  });
  const reviewed = applyPropertyComplexityReview(automatic, {
    complexity: "complex",
    notes: "Atypical equestrian improvements require broader support.",
    reviewer: "Appraiser",
  });

  assert.equal(reviewed.automatic_complexity, "simple");
  assert.equal(reviewed.effective_complexity, "complex");
  assert.equal(reviewed.recommended_search_profile, "rural_complex");
  assert.equal(reviewed.review_status, "overridden");
});

test("front, rear, and side relationships use the parcel frontage direction", () => {
  const base = {
    subjectPoint: { type: "Point", coordinates: [0, 0] },
    frontagePoint: { type: "Point", coordinates: [0, 1] },
  };
  assert.equal(determineInfluenceRelationship({
    ...base,
    influencePoint: { type: "Point", coordinates: [0, 2] },
  }), "front");
  assert.equal(determineInfluenceRelationship({
    ...base,
    influencePoint: { type: "Point", coordinates: [0, -2] },
  }), "rear");
  assert.equal(determineInfluenceRelationship({
    ...base,
    influencePoint: { type: "Point", coordinates: [2, 0] },
  }), "side");
});
