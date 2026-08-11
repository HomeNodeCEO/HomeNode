import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchBoundaryStreetNames,
  normalizeBoundaryStreetNames,
  rankBoundaryStreetNames,
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
