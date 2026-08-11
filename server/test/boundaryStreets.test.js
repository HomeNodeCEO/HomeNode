import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchBoundaryStreetNames,
  normalizeBoundaryStreetNames,
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

test("queries all TIGERweb road layers along the drawn boundary", async () => {
  const requestedLayers = [];
  const result = await fetchBoundaryStreetNames(geometry, {
    fetchImpl: async (url) => {
      const layer = Number(url.pathname.split("/").at(-2));
      requestedLayers.push(layer);
      return {
        ok: true,
        async json() {
          return { features: [{ attributes: { NAME: `Road ${layer + 1}` } }] };
        },
      };
    },
    now: () => new Date("2026-08-11T14:00:00.000Z"),
  });
  assert.deepEqual(requestedLayers, [0, 1, 2]);
  assert.deepEqual(result.street_names, ["Road 1", "Road 2", "Road 3"]);
  assert.equal(result.review_required, true);
  assert.equal(result.boundary_buffer_meters, 45);
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
