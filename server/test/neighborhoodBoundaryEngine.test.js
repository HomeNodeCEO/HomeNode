import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoadwayBoundary,
  ensureNeighborhoodBoundarySchema,
  generateNeighborhoodBoundary,
  getLatestNeighborhoodBoundary,
  NEIGHBORHOOD_BOUNDARY_METHODOLOGY_VERSION,
  reviewNeighborhoodBoundary,
} from "../src/services/neighborhoodBoundaryEngine.js";

test("does not fabricate a rectangular boundary from four representative roadway points", () => {
  const result = buildRoadwayBoundary({
    cardinal_boundaries: {
      north: { candidates: [{ selected: true, representative_point: [-96.65, 32.99] }] },
      east: { candidates: [{ selected: true, representative_point: [-96.62, 32.97] }] },
      south: { candidates: [{ selected: true, representative_point: [-96.65, 32.94] }] },
      west: { candidates: [{ selected: true, representative_point: [-96.68, 32.97] }] },
    },
  }, { type: "Point", coordinates: [-96.65, 32.97] });

  assert.equal(result, null);
});

test("does not label an incomplete or non-enclosing road set as roadway-bounded", () => {
  assert.equal(buildRoadwayBoundary({
    cardinal_boundaries: {
      north: { candidates: [{ representative_point: [-96.65, 32.99] }] },
      east: { candidates: [{ representative_point: [-96.62, 32.97] }] },
      south: { candidates: [{ representative_point: [-96.65, 32.94] }] },
    },
  }, { type: "Point", coordinates: [-96.65, 32.97] }), null);
});

test("traces curved selected corridors instead of flattening them to a rectangle", () => {
  const selected = (representativePoint, geometryPaths) => ({
    candidates: [{ selected: true, representative_point: representativePoint, geometry_paths: geometryPaths }],
  });
  const result = buildRoadwayBoundary({
    cardinal_boundaries: {
      north: selected([-96.65, 32.994], [[[-96.675, 32.994], [-96.65, 32.992], [-96.625, 32.994]]]),
      east: selected([-96.625, 32.97], [[[-96.625, 32.994], [-96.623, 32.97], [-96.625, 32.946]]]),
      south: selected([-96.65, 32.946], [[[-96.675, 32.946], [-96.65, 32.944], [-96.625, 32.946]]]),
      west: selected([-96.675, 32.97], [[[-96.675, 32.946], [-96.677, 32.97], [-96.675, 32.994]]]),
    },
  }, { type: "Point", coordinates: [-96.65, 32.97] });

  assert.ok(result.coordinates[0].length > 5);
  assert.ok(result.coordinates[0].some((point) => point[0] === -96.623));
  assert.ok(result.coordinates[0].some((point) => point[1] === 32.992));
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

function generatedRow(overrides = {}) {
  return {
    id: 7,
    account_id: "26272500060150000",
    scope_key: "property",
    assignment_file_id: null,
    methodology_version: NEIGHBORHOOD_BOUNDARY_METHODOLOGY_VERSION,
    status: "generated",
    search_profile: "suburban_simple",
    discovery_radius_miles: 2,
    input_signature: "signature",
    boundary_geojson: boundary,
    evidence: {},
    source_state: {},
    confidence: "high",
    review_required: true,
    generated_at: "2026-08-16T00:00:00.000Z",
    updated_at: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

test("creates versioned assignment-aware boundary persistence", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
    },
  };
  await ensureNeighborhoodBoundarySchema(pool);
  assert.ok(statements.some((sql) => /app\.neighborhood_boundary_assessments/.test(sql)));
  assert.ok(statements.some((sql) => /boundary geometry\(Polygon, 4326\)/.test(sql)));
  assert.ok(statements.some((sql) => /input_signature/.test(sql)));
  assert.ok(statements.some((sql) => /assignment_file_id/.test(sql)));
});

test("generates a local, persisted broad boundary without a remote road dependency", async () => {
  const statements = [];
  const calls = [];
  const responses = [
    // ensureAssignmentFilesSchema
    [],
    // ensurePropertyContextSchema
    [],
    [],
    [],
    // ensureNeighborhoodBoundarySchema
    [],
    // property complexity profile
    [{ geography: "suburban", complexity: "simple" }],
    // generated PostGIS boundary
    [{
      subject_parcel_object_id: 100,
      subject_parcel_account_id: "26272500060150000",
      subject_low_parcel_id: "26272500060150000",
      subject_land_use_category: "one_unit",
      subject_year_built: 1975,
      subject_site_area_sqft: 9000,
      subject_market_value: 285000,
      subject_point: { type: "Point", coordinates: [-96.65, 32.97] },
      boundary,
      boundary_area_square_miles: 1.25,
      candidate_count: 150,
      year_built_count: 145,
      site_size_count: 148,
      market_value_count: 149,
      sampled_max_distance_miles: 1.9,
    }],
    // local TxDOT traffic-backed boundary roads
    [
      { name: "Arapaho Rd", route_name: "CS", current_aadt: 42000, geometry: { type: "MultiLineString", coordinates: [[[-96.675, 32.994], [-96.625, 32.994]]] } },
      { name: "N Garland Ave", route_name: "SH0078-KG", current_aadt: 38000, geometry: { type: "MultiLineString", coordinates: [[[-96.625, 32.946], [-96.625, 32.994]]] } },
      { name: "Belt Line Rd", route_name: "CS", current_aadt: 40000, geometry: { type: "MultiLineString", coordinates: [[[-96.675, 32.946], [-96.625, 32.946]]] } },
      { name: "S Jupiter Rd", route_name: "CS", current_aadt: 34000, geometry: { type: "MultiLineString", coordinates: [[[-96.675, 32.946], [-96.675, 32.994]]] } },
    ],
    // zoning evidence
    [{
      subject: { zoning_code: "PD", generalized_use: "residential" },
      intersecting_district_count: 2,
      generalized_use_count: 1,
      districts: [],
    }],
    // source health
    [],
    // zoning registry repair called by getPropertyContextSourceHealth is not repeated
    // saved assessment
    [generatedRow()],
  ];
  const pool = {
    async query(sql, params = []) {
      statements.push(String(sql));
      calls.push({ sql: String(sql), params });
      return { rows: responses.shift() || [], rowCount: 1 };
    },
  };
  const result = await generateNeighborhoodBoundary(pool, {
    accountId: "26272500060150000",
  });
  assert.equal(result.methodology_version, NEIGHBORHOOD_BOUNDARY_METHODOLOGY_VERSION);
  assert.equal(result.search_profile, "suburban_simple");
  assert.equal(result.review_required, true);
  assert.ok(statements.some((sql) => /ST_ConcaveHull/.test(sql)));
  assert.ok(statements.some((sql) => /gis\.traffic_volume_segments/.test(sql)));
  assert.ok(statements.some((sql) => /gis\.zoning_districts/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO app\.neighborhood_boundary_assessments/.test(sql)));
  const savedBoundary = JSON.parse(calls.find((call) =>
    /INSERT INTO app\.neighborhood_boundary_assessments/.test(call.sql),
  ).params[7]);
  assert.ok(savedBoundary.coordinates[0].length >= 5);
  assert.deepEqual(savedBoundary.coordinates[0][0], savedBoundary.coordinates[0].at(-1));
  assert.ok(savedBoundary.coordinates[0].some((point) => point[0] === -96.625));
  assert.ok(savedBoundary.coordinates[0].some((point) => point[1] === 32.994));
});

test("rejects an invalid explicit profile before spatial analysis", async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
    },
  };
  await assert.rejects(
    generateNeighborhoodBoundary(pool, {
      accountId: "26272500060150000",
      searchProfileKey: "oceanfront_impossible",
    }),
    /invalid_neighborhood_search_profile/,
  );
  assert.equal(statements.some((sql) => /ST_ConcaveHull/.test(sql)), false);
});

test("loads the assignment-specific boundary before the property fallback", async () => {
  const statements = [];
  const responses = [
    [], [], [], [], [],
    [{ exists: 1 }],
    [generatedRow({ scope_key: "assignment:44", assignment_file_id: 44 })],
  ];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      const rows = responses.shift() || [];
      return { rows, rowCount: rows.length };
    },
  };
  const result = await getLatestNeighborhoodBoundary(pool, {
    accountId: "26272500060150000",
    assignmentFileId: 44,
  });
  assert.equal(result.assignment_file_id, 44);
  const latestSql = statements.at(-1);
  assert.match(latestSql, /scope_key IN \(\$2, 'property'\)/);
  assert.match(latestSql, /\(scope_key = \$2\) DESC/);
});

test("records an assignment-specific appraiser confirmation", async () => {
  const statements = [];
  const responses = [
    [], [], [], [], [],
    [{ exists: 1 }],
    [generatedRow({
      scope_key: "assignment:44",
      assignment_file_id: 44,
      status: "confirmed",
      review_required: false,
      reviewer: "HomeNode appraiser",
      confirmed_at: "2026-08-16T12:00:00.000Z",
    })],
  ];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      const rows = responses.shift() || [];
      return { rows, rowCount: rows.length };
    },
  };
  const result = await reviewNeighborhoodBoundary(pool, {
    accountId: "26272500060150000",
    assessmentId: 7,
    assignmentFileId: 44,
    confirmed: true,
  });
  assert.equal(result.status, "confirmed");
  assert.equal(result.review_required, false);
  assert.match(statements.at(-1), /status = CASE WHEN \$4::boolean THEN 'confirmed'/);
  assert.match(statements.at(-1), /scope_key = \$3/);
});

