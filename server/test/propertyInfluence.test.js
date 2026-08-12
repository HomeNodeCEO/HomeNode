import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPropertyInfluenceSignature,
  comparePropertyInfluenceSignatures,
  decorateAndRankByInfluence,
} from "../src/util/propertyInfluence.js";
import { detectCornerLot } from "../src/services/propertyContext.js";

test("a mapped commercial rear adjacency produces a stable material influence signature", () => {
  const signature = buildPropertyInfluenceSignature({
    parcel_available: true,
    adjacent_influences: [{
      category: "commercial",
      relationship: "rear",
      use_description: "Neighborhood retail",
    }],
    nearby_influences: [],
    nearest_major_road: { road_class: "secondary", distance_feet: 225 },
    corner_lot: false,
    zoning_context: { generalized_use: "residential", zoning_code: "SF-7.5" },
  });

  assert.equal(signature.context_available, true);
  assert.equal(signature.material_influence_present, true);
  assert.deepEqual(signature.material_keys, [
    "external_use:commercial:rear",
    "major_road:secondary:within_300ft",
  ]);
  assert.ok(signature.zoning_keys.includes("zoning_use:residential"));
});

test("an exact material influence match receives the highest priority tier", () => {
  const subject = buildPropertyInfluenceSignature({
    parcel_available: true,
    adjacent_influences: [{ category: "commercial", relationship: "rear" }],
    corner_lot: true,
  });
  const exact = buildPropertyInfluenceSignature({
    parcel_available: true,
    adjacent_influences: [{ category: "commercial", relationship: "rear" }],
    corner_lot: true,
  });
  const ordinary = buildPropertyInfluenceSignature({
    parcel_available: true,
    adjacent_influences: [],
    nearby_influences: [],
    corner_lot: false,
  });

  assert.equal(comparePropertyInfluenceSignatures(subject, exact).priority_tier, 4);
  assert.equal(comparePropertyInfluenceSignatures(subject, exact).exact_material_match, true);
  assert.equal(comparePropertyInfluenceSignatures(subject, ordinary).priority_tier, 1);
});

test("influence matching outranks a closer newer sale after coverage is sufficient", () => {
  const subject = {
    context_available: true,
    material_keys: ["railroad:within_250ft"],
    zoning_keys: [],
  };
  const match = {
    context_available: true,
    material_keys: ["railroad:within_250ft"],
    zoning_keys: [],
  };
  const ordinary = {
    context_available: true,
    material_keys: [],
    zoning_keys: [],
  };
  const result = decorateAndRankByInfluence([
    { id: "close-new", comparableScore: 98, distanceMiles: 0.1, signature: ordinary },
    { id: "far-older-match", comparableScore: 70, distanceMiles: 4, signature: match },
  ], subject, (sale) => sale.signature);

  assert.equal(result.policy.influence_priority_applied, true);
  assert.deepEqual(result.sales.map((sale) => sale.id), ["far-older-match", "close-new"]);
});

test("ranking stays on the validated numeric score until influence coverage reaches eighty percent", () => {
  const subject = {
    context_available: true,
    material_keys: ["corner:corner_lot"],
    zoning_keys: [],
  };
  const match = {
    context_available: true,
    material_keys: ["corner:corner_lot"],
    zoning_keys: [],
  };
  const result = decorateAndRankByInfluence([
    { id: "high-score", comparableScore: 95, distanceMiles: 0.2, signature: null },
    { id: "match", comparableScore: 70, distanceMiles: 2, signature: match },
  ], subject, (sale) => sale.signature);

  assert.equal(result.policy.coverage_ratio, 0.5);
  assert.equal(result.policy.influence_priority_applied, false);
  assert.deepEqual(result.sales.map((sale) => sale.id), ["high-score", "match"]);
});

test("corner detection requires different non-parallel road frontage directions", () => {
  const center = { type: "Point", coordinates: [-96.6, 32.9] };
  assert.equal(detectCornerLot(center, [
    { name: "Snowmass Ln", closest_point: { type: "Point", coordinates: [-96.6, 32.901] } },
    { name: "Matterhorn Dr", closest_point: { type: "Point", coordinates: [-96.599, 32.9] } },
  ]), true);
  assert.equal(detectCornerLot(center, [
    { name: "North Service Rd", closest_point: { type: "Point", coordinates: [-96.6, 32.901] } },
    { name: "South Service Rd", closest_point: { type: "Point", coordinates: [-96.6, 32.899] } },
  ]), false);
});
