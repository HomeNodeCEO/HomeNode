import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateNeighborhoodEngineReadiness,
  getNeighborhoodEngineReadiness,
} from "../src/services/neighborhoodEngineReadiness.js";

const healthySources = [
  { source_key: "dcad_parcels", label: "Dallas CAD parcels", status: "current", usable: true },
  { source_key: "tiger_roads_primary", status: "current", usable: true },
  { source_key: "tiger_roads_secondary", status: "current", usable: true },
  { source_key: "txdot_aadt", status: "current", usable: true },
];

test("reports separate prototype and low-review production readiness", () => {
  const result = evaluateNeighborhoodEngineReadiness({
    county: "Dallas",
    accounts: {
      total_accounts: 100_000,
      parcel_accounts: 98_000,
      year_built_accounts: 85_000,
      site_size_accounts: 96_000,
      coordinate_accounts: 95_000,
    },
    sales: {
      usable_sales: 25_000,
      distinct_sale_accounts: 24_000,
      price_sales: 25_000,
      coordinate_sales: 24_000,
      year_built_sales: 22_000,
      site_size_sales: 23_000,
    },
    roads: [
      { road_class: "primary", segment_count: 500 },
      { road_class: "secondary", segment_count: 2_000 },
      { road_class: "local", segment_count: 40_000 },
      { road_class: "txdot_aadt", segment_count: 5_000 },
    ],
    zoning: { provider_count: 8, district_count: 10_000 },
    sourceHealth: healthySources,
  });
  assert.equal(result.prototype_ready, true);
  assert.equal(result.production_ready, true);
  assert.equal(result.accounts.coverage.parcel_geometry_percent, 98);
  assert.equal(result.sales.coordinate_percent, 96);
});

test("identifies physical and spatial coverage blockers without hiding usable stale data", () => {
  const result = evaluateNeighborhoodEngineReadiness({
    county: "Dallas County",
    accounts: {
      total_accounts: 100_000,
      parcel_accounts: 70_000,
      year_built_accounts: 45_000,
      site_size_accounts: 65_000,
      coordinate_accounts: 65_000,
    },
    sales: {
      usable_sales: 50,
      coordinate_sales: 25,
      year_built_sales: 25,
      site_size_sales: 25,
      price_sales: 50,
    },
    roads: [
      { road_class: "primary", segment_count: 100 },
      { road_class: "secondary", segment_count: 500 },
      { road_class: "txdot_aadt", segment_count: 100 },
    ],
    zoning: { provider_count: 1, district_count: 100 },
    sourceHealth: [
      { source_key: "dcad_parcels", status: "current", usable: true },
      { source_key: "tiger_roads_primary", status: "stale", usable: true, serving_stale_data: true, label: "Primary roads" },
      { source_key: "tiger_roads_secondary", status: "current", usable: true },
      { source_key: "txdot_aadt", status: "current", usable: true },
    ],
  });
  assert.equal(result.prototype_ready, false);
  assert.equal(result.production_ready, false);
  assert.ok(result.prototype_blockers.includes("year_built"));
  assert.ok(result.prototype_blockers.includes("sale_coordinates"));
  assert.ok(result.warnings.some((warning) => /last-known-good/i.test(warning)));
});

test("queries the local county mirrors without contacting external services", async () => {
  const statements = [];
  const responses = [
    [{ total_accounts: 1_000, parcel_accounts: 900 }],
    [{ usable_sales: 100 }],
    [{ road_class: "primary", segment_count: 10 }],
    [{ road_class: "txdot_aadt", segment_count: 10 }],
    [{ provider_count: 1, district_count: 10 }],
    healthySources,
  ];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: responses.shift() || [] };
    },
  };
  const result = await getNeighborhoodEngineReadiness(pool, { county: "Dallas" });
  assert.equal(result.county, "Dallas County");
  assert.equal(statements.length, 6);
  assert.match(statements[0], /gis\.dcad_parcels/);
  assert.match(statements[1], /core\.v_sales_enriched/);
  assert.match(statements[2], /gis\.road_segments/);
  assert.match(statements[3], /gis\.traffic_volume_segments/);
  assert.match(statements[4], /gis\.zoning_districts/);
  assert.match(statements[5], /gis\.source_sync_state/);
  const cached = await getNeighborhoodEngineReadiness(pool, { county: "Dallas" });
  assert.equal(cached.cache_hit, true);
  assert.equal(statements.length, 6);
});

test("rejects counties whose parcel mirror is not configured", async () => {
  await assert.rejects(
    getNeighborhoodEngineReadiness({ query: async () => ({ rows: [] }) }, { county: "Collin" }),
    /neighborhood_engine_county_not_configured/,
  );
});
