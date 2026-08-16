import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchBoundaryStreetNames,
  loadBoundaryStreetNames,
  normalizeBoundaryStreetNames,
  rankBoundaryStreetNames,
  summarizeBusyCardinalBoundaries,
  summarizeCardinalBoundaries,
} from "../src/services/boundaryStreets.js";

const geometry = {
  type: "Polygon",
  coordinates: [[
    [-96.66, 32.96],
    [-96.64, 32.96],
    [-96.64, 32.98],
    [-96.66, 32.98],
    [-96.66, 32.96],
  ]],
};

test("normalizes and deduplicates TIGERweb boundary street names", () => {
  assert.deepEqual(normalizeBoundaryStreetNames([
    { attributes: { NAME: "Snowmass Ln", BASENAME: "Snowmass" } },
    { attributes: { NAME: "  Snowmass   Ln " } },
    { attributes: { NAME: null, BASENAME: "Vail" } },
    { attributes: { NAME: null, BASENAME: null } },
  ]), ["Snowmass Ln", "Vail"]);
});

test("prioritizes streets running along the boundary over crossing streets", () => {
  const features = [
    {
      attributes: { NAME: "Boundary Rd" },
      geometry: { paths: [[[-96.659, 32.9601], [-96.641, 32.9601]]] },
    },
    {
      attributes: { NAME: "Crossing Rd" },
      geometry: { paths: [[[-96.65, 32.95], [-96.65, 32.97]]] },
    },
  ];
  assert.deepEqual(rankBoundaryStreetNames(features, geometry.coordinates[0]), ["Boundary Rd"]);
});

test("selects one dominant road for each cardinal side", () => {
  const features = [
    { attributes: { NAME: "Apollo Rd" }, road_layer: 1, geometry: { paths: [[[-96.659, 32.9799], [-96.641, 32.9799]]] } },
    { attributes: { NAME: "N Garland Ave" }, road_layer: 1, geometry: { paths: [[[-96.6401, 32.961], [-96.6401, 32.979]]] } },
    { attributes: { NAME: "W Buckingham Rd" }, road_layer: 1, geometry: { paths: [[[-96.659, 32.9601], [-96.641, 32.9601]]] } },
    { attributes: { NAME: "N Jupiter Rd" }, road_layer: 1, geometry: { paths: [[[-96.6599, 32.961], [-96.6599, 32.979]]] } },
    { attributes: { NAME: "Short Local St" }, road_layer: 2, geometry: { paths: [[[-96.651, 32.9798], [-96.649, 32.9798]]] } },
  ];
  const result = summarizeCardinalBoundaries(features, geometry.coordinates[0]);
  assert.equal(result.north.primary_street, "Apollo Rd");
  assert.equal(result.east.primary_street, "N Garland Ave");
  assert.equal(result.south.primary_street, "W Buckingham Rd");
  assert.equal(result.west.primary_street, "N Jupiter Rd");
  assert.equal(result.north.candidates[1].name, "Short Local St");
});

test("prefers a continuous perimeter road over a shorter internal road", () => {
  const features = [
    {
      attributes: { NAME: "N Garland Ave" },
      road_layer: 2,
      geometry: { paths: [[[-96.6404, 32.90], [-96.6404, 33.05]]] },
    },
    {
      attributes: { NAME: "Wagon Wheel Rd" },
      road_layer: 2,
      geometry: { paths: [[[-96.6401, 32.961], [-96.6401, 32.979]]] },
    },
  ];
  const result = summarizeCardinalBoundaries(features, geometry.coordinates[0]);
  assert.equal(result.east.primary_street, "N Garland Ave");
});

test("queries all TIGERweb road layers along the drawn boundary", async () => {
  const requestedLayers = [];
  const result = await fetchBoundaryStreetNames(geometry, {
    fetchImpl: async (url) => {
      const layer = Number(url.pathname.split("/").at(-2));
      requestedLayers.push(layer);
      return {
        ok: true,
        async json() {
          return {
            features: [{
              attributes: { NAME: `Road ${layer + 1}` },
              geometry: { paths: [[[-96.659, 32.9601], [-96.641, 32.9601]]] },
            }],
          };
        },
      };
    },
    now: () => new Date("2026-08-11T14:00:00.000Z"),
  });
  assert.deepEqual(requestedLayers, [0, 1, 2]);
  assert.deepEqual(result.street_names, ["Road 1"]);
  assert.equal(result.cardinal_boundaries.south.primary_street, "Road 1");
  assert.equal(result.summary, "South: Road 1");
  assert.equal(result.review_required, true);
  assert.equal(result.boundary_buffer_meters, 75);
});

test("rejects an open boundary polygon", async () => {
  await assert.rejects(
    fetchBoundaryStreetNames({
      type: "Polygon",
      coordinates: [[[-96.6, 32.9], [-96.5, 32.9], [-96.5, 33]]],
    }),
    /invalid_boundary_geometry/,
  );
});

test("uses busy TxDOT perimeter roads and excludes local neighborhood streets", () => {
  const trafficFeatures = [
    { attributes: { NAME: "Arapaho Rd", AADT: 42_000 }, geometry: { paths: [[[-96.68, 32.994], [-96.62, 32.994]]] } },
    { attributes: { NAME: "Apollo Rd", AADT: 18_000 }, geometry: { paths: [[[-96.68, 32.984], [-96.62, 32.984]]] } },
    { attributes: { NAME: "N Garland Ave", AADT: 38_000 }, geometry: { paths: [[[-96.625, 32.94], [-96.625, 33.00]]] } },
    { attributes: { NAME: "Belt Line Rd", AADT: 40_000 }, geometry: { paths: [[[-96.68, 32.946], [-96.62, 32.946]]] } },
    { attributes: { NAME: "S Jupiter Rd", AADT: 34_000 }, geometry: { paths: [[[-96.675, 32.94], [-96.675, 33.00]]] } },
    { attributes: { NAME: "State Hwy 190", AADT: 110_000 }, geometry: { paths: [[[-96.68, 33.008], [-96.62, 33.008]]] } },
    { attributes: { NAME: "261590", AADT: 65_000 }, geometry: { paths: [[[-96.68, 32.95], [-96.62, 32.95]]] } },
    { attributes: { NAME: "Holford Rd", AADT: 7_000 }, geometry: { paths: [[[-96.68, 32.982], [-96.62, 32.982]]] } },
    { attributes: { NAME: "Kingsbridge Rd", AADT: 4_000 }, geometry: { paths: [[[-96.68, 32.958], [-96.62, 32.958]]] } },
  ];
  const result = summarizeBusyCardinalBoundaries(trafficFeatures, geometry.coordinates[0]);
  assert.equal(result.north.primary_street, "Arapaho Rd");
  assert.equal(result.east.primary_street, "N Garland Ave");
  assert.equal(result.south.primary_street, "Belt Line Rd");
  assert.equal(result.west.primary_street, "S Jupiter Rd");
  assert.equal(result.north.candidates.some(({ name }) => name === "Holford Rd"), false);
  assert.equal(result.south.candidates.some(({ name }) => name === "Kingsbridge Rd"), false);
  assert.equal(result.south.candidates.some(({ name }) => name === "261590"), false);
  assert.equal(result.north.candidates[0].annual_average_daily_traffic, 42_000);
});

test("uses the local TxDOT AADT mirror before TIGERweb", async () => {
  const statements = [];
  const pool = {
    async query(sql, values) {
      statements.push({ sql: String(sql), values });
      return {
        rows: [{
          name: "Road 1",
          base_name: "Road 1",
          route_name: "FM0001-KG",
          current_aadt: 32000,
          source_date: "2025-01-01",
          geometry: {
            type: "MultiLineString",
            coordinates: [[[-96.68, 32.946], [-96.62, 32.946]]],
          },
        }],
      };
    },
  };
  const result = await loadBoundaryStreetNames(pool, geometry, {
    fetchImpl: async () => {
      throw new Error("remote TIGERweb must not be contacted");
    },
  });
  assert.equal(result.served_from_local_mirror, true);
  assert.equal(result.source, "Local TxDOT AADT mirror with Census road names");
  assert.equal(result.cardinal_boundaries.south.primary_street, "Road 1");
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /gis\.traffic_volume_segments/);
  assert.match(statements[0].sql, /ST_DWithin/);
  assert.match(statements[0].sql, /current_aadt >= \$2/);
  assert.doesNotMatch(statements[0].sql, /road_class IN \('primary', 'secondary', 'local'\)/);
  assert.equal(result.minimum_aadt, 10000);
});

test("falls back to TIGERweb only when explicitly enabled", async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({
      features: url.toString().includes("/0/query")
        ? [{
          attributes: { NAME: "Road 1" },
          geometry: { paths: [[[-96.659, 32.9601], [-96.641, 32.9601]]] },
        }]
        : [],
    }),
  });
  const result = await loadBoundaryStreetNames(pool, geometry, {
    fetchImpl,
    allowRemoteFallback: true,
  });
  assert.equal(result.served_from_local_mirror, false);
  assert.equal(result.source, "U.S. Census Bureau TIGERweb Transportation");
  assert.equal(result.fallback_reason, "local_boundary_roads_unavailable");
});

