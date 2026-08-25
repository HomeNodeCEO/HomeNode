import assert from "node:assert/strict";
import test from "node:test";

import {
  applyContiguousPocketClassification,
  applyAdaptivePrimaryPopulation,
  applyLandUsePrerequisite,
  ensureNeighborhoodRelevanceSchema,
  generateNeighborhoodRelevance,
  normalizeLegalNeighborhoodName,
  summarizeRelevantPopulation,
} from "../src/services/neighborhoodRelevanceEngine.js";

test("derives stable neighborhood identity from subdivision or legal description", () => {
  assert.equal(normalizeLegalNeighborhoodName("Holiday Park North 6", null), "HOLIDAY PARK NORTH 6");
  assert.equal(
    normalizeLegalNeighborhoodName(null, "HOLIDAY PARK NORTH 6 BLK F LOT 15"),
    "HOLIDAY PARK NORTH 6",
  );
  assert.equal(normalizeLegalNeighborhoodName(null, "LOT 15"), null);
});

const boundary = {
  type: "Polygon",
  coordinates: [[
    [-96.66, 32.96],
    [-96.64, 32.96],
    [-96.64, 32.98],
    [-96.66, 32.98],
    [-96.66, 32.96],
  ]],
};

function potential(parcelObjectId) {
  return {
    parcel_object_id: parcelObjectId,
    statistical_classification: "potential_dissimilar_cluster_member",
    excluded: false,
  };
}

test("excludes a statistically dissimilar pocket only after three parcels connect", () => {
  const result = applyContiguousPocketClassification(
    [potential(1), potential(2), potential(3), potential(4)],
    [[1, 2], [2, 3]],
  );
  assert.equal(result.find((candidate) => candidate.parcel_object_id === 1).excluded, true);
  assert.equal(
    result.find((candidate) => candidate.parcel_object_id === 2).statistical_classification,
    "excluded_dissimilar_pocket",
  );
  assert.equal(result.find((candidate) => candidate.parcel_object_id === 3).contiguous_cluster.size, 3);
  assert.equal(result.find((candidate) => candidate.parcel_object_id === 4).excluded, false);
});

test("treats different land use as a prerequisite instead of diluting the weighted score", () => {
  const result = applyLandUsePrerequisite([
    { parcel_object_id: 1, land_use_category: "one_unit", excluded: false },
    { parcel_object_id: 2, land_use_category: "commercial", excluded: false },
    { parcel_object_id: 3, land_use_category: null, excluded: false },
  ], "one_unit");
  assert.equal(result[0].excluded, false);
  assert.equal(result[1].excluded, true);
  assert.equal(result[1].statistical_classification, "excluded_land_use_mismatch");
  assert.equal(result[2].excluded, false);
});

test("does not remove a same-neighborhood parcel during prerequisite or pocket screening", () => {
  const protectedCandidate = {
    ...potential(10),
    land_use_category: "commercial",
    same_subject_neighborhood: true,
  };
  const screened = applyLandUsePrerequisite([protectedCandidate], "one_unit");
  assert.equal(screened[0].excluded, false);
  const clustered = applyContiguousPocketClassification(screened, []);
  assert.equal(clustered[0].excluded, false);
  assert.equal(clustered[0].statistical_classification, "protected_subject_neighborhood");
});

test("calculates neighborhood ranges from the exact included relevance population", () => {
  const result = summarizeRelevantPopulation([
    { excluded: false, primary_population: true, score: 90, year_built: 1980, site_area_sqft: 8000, sale_price: 300000,
      gla_diagnostic: { candidate_gla_sqft: 1500 } },
    { excluded: false, primary_population: true, score: 80, year_built: 1990, site_area_sqft: 10000, sale_price: 400000,
      gla_diagnostic: { candidate_gla_sqft: 2000 } },
    { excluded: true, score: 10, year_built: 2025, site_area_sqft: 50000, sale_price: 1500000,
      gla_diagnostic: { candidate_gla_sqft: 5000 } },
  ]);
  assert.equal(result.population_rule, "adaptive_primary_relevance_population");
  assert.equal(result.included_property_count, 2);
  assert.equal(result.included_sale_count, 2);
  assert.equal(result.sales_profile.sale_price.median, 350000);
  assert.equal(result.sales_profile.price_per_square_foot.median, 200);
  assert.equal(result.property_profile.age.median, 1985);
});

test("widens the primary population only enough to meet the target sale count", () => {
  const candidates = [
    ...Array.from({ length: 10 }, (_, index) => ({ score: 85, sale_price: 300000 + index, excluded: false })),
    ...Array.from({ length: 25 }, (_, index) => ({ score: 75, sale_price: 310000 + index, excluded: false })),
    ...Array.from({ length: 10 }, (_, index) => ({ score: 65, sale_price: 320000 + index, excluded: false })),
    { score: 95, sale_price: 500000, excluded: true },
  ];
  const result = applyAdaptivePrimaryPopulation(candidates);
  assert.equal(result.threshold, 70);
  assert.equal(result.primary_sale_count, 35);
  assert.equal(result.target_met, true);
  assert.equal(result.candidates.filter((candidate) => candidate.primary_population).length, 35);
  assert.equal(result.candidates.at(-1).primary_population, false);
});

test("uses the sixty-percent floor and reports a sparse primary sample", () => {
  const result = applyAdaptivePrimaryPopulation([
    { score: 81, sale_price: 300000, excluded: false },
    { score: 61, sale_price: 310000, excluded: false },
    { score: 59, sale_price: 320000, excluded: false },
  ]);
  assert.equal(result.threshold, 60);
  assert.equal(result.primary_sale_count, 2);
  assert.equal(result.target_met, false);
});

test("creates normalized assessment and candidate persistence", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
    },
  };
  await ensureNeighborhoodRelevanceSchema(pool);
  assert.ok(statements.some((sql) => /app\.neighborhood_relevance_assessments/.test(sql)));
  assert.ok(statements.some((sql) => /app\.neighborhood_relevance_candidates/.test(sql)));
  assert.ok(statements.some((sql) => /point geometry\(Point, 4326\)/.test(sql)));
});

test("scores and persists the local parcel population without time-adjusting sales", async () => {
  const statements = [];
  const boundaryRow = {
    id: 7,
    account_id: "26272500060150000",
    scope_key: "property",
    assignment_file_id: null,
    methodology_version: 1,
    status: "generated",
    search_profile: "suburban_simple",
    discovery_radius_miles: 2,
    input_signature: "boundary-signature",
    boundary_geojson: boundary,
    evidence: {},
    source_state: {},
    confidence: "high",
    review_required: true,
    generated_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
  };
  const candidateRows = [
    [101, "A", 1975, 9000, 1700, 0.2],
    [102, "B", 1978, 9500, 1750, 0.5],
    [103, "C", 1972, 8800, 1650, 0.8],
  ].map(([parcelObjectId, accountId, yearBuilt, site, gla, distance]) => ({
    parcel_object_id: parcelObjectId,
    account_id: accountId,
    address: `${parcelObjectId} Test Ln`,
    land_use_category: "one_unit",
    year_built: yearBuilt,
    site_area_sqft: site,
    gla_sqft: gla,
    distance_miles: distance,
    point: { type: "Point", coordinates: [-96.65, 32.97] },
    subject_land_use_category: "one_unit",
    subject_year_built: 1975,
    subject_site_area_sqft: 9000,
    subject_gla_sqft: 1700,
  }));
  const saleRows = [
    ["A", 290000],
    ["B", 300000],
    ["C", 280000],
  ].map(([accountId, price]) => ({
    primary_account_id: accountId,
    sale_price: price,
    sale_date: "2026-01-01",
  }));
  const savedRow = {
    id: 9,
    account_id: "26272500060150000",
    scope_key: "property",
    assignment_file_id: null,
    boundary_assessment_id: 7,
    methodology_version: 1,
    input_signature: "relevance-signature",
    summary: {
      candidate_count: 3,
      included_count: 3,
      excluded_count: 0,
      sale_prices_time_adjusted: false,
    },
    distributions: {},
    confidence: { confidence: "limited" },
    source_state: {},
    disclosure: "Broad boundary disclosure",
    generated_at: "2026-08-16T01:00:00.000Z",
    updated_at: "2026-08-16T01:00:00.000Z",
  };
  const pool = {
    async query(sql) {
      const statement = String(sql);
      statements.push(statement);
      if (/FROM app\.neighborhood_boundary_assessments/.test(statement) && /LIMIT 1/.test(statement)) {
        return { rows: [boundaryRow], rowCount: 1 };
      }
      if (/WITH boundary AS MATERIALIZED/.test(statement) && /candidate_location/.test(statement)) {
        return { rows: candidateRows, rowCount: candidateRows.length };
      }
      if (/SELECT DISTINCT ON \(sale\.primary_account_id\)/.test(statement)) {
        return { rows: saleRows, rowCount: saleRows.length };
      }
      if (/FROM gis\.source_sync_state/.test(statement)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO app\.neighborhood_relevance_assessments/.test(statement)) {
        return { rows: [savedRow], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const result = await generateNeighborhoodRelevance(pool, {
    accountId: "26272500060150000",
  });
  assert.equal(result.summary.candidate_count, 3);
  assert.equal(result.summary.sale_prices_time_adjusted, false);
  assert.ok(statements.some((sql) => /core\.v_sales_enriched/.test(sql)));
  assert.equal(statements.filter((sql) => /core\.v_sales_enriched/.test(sql)).length, 1);
  assert.ok(statements.some((sql) => /primary_account_id = ANY\(\$1::text\[\]\)/.test(sql)));
  assert.ok(statements.some((sql) => /subject\.legal_description/.test(sql)));
  assert.ok(statements.some((sql) => /\$4::double precision \* 1609\.344/.test(sql)));
  assert.ok(statements.every((sql) => !/LEFT JOIN LATERAL[\s\S]+core\.v_sales_enriched/.test(sql)));
  assert.ok(statements.some((sql) => /DELETE FROM app\.neighborhood_relevance_candidates/.test(sql)));
  assert.ok(statements.some((sql) => /jsonb_to_recordset/.test(sql)));
});
