import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMarketAreaKeys,
  validateCustomMarketGeometry,
} from "../src/services/marketConditions.js";

test("market areas preserve the requested independent scopes", () => {
  const areas = parseMarketAreaKeys([
    "city",
    "zip",
    "radius_1",
    "radius_5",
    "custom",
    "city",
  ]);
  assert.deepEqual(
    areas.map((area) => area.key),
    ["city", "zip", "radius_1", "radius_5", "custom"],
  );
});

test("a valid closed DFW polygon is normalized", () => {
  const geometry = validateCustomMarketGeometry({
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-96.67, 32.9],
          [-96.65, 32.9],
          [-96.65, 32.92],
          [-96.67, 32.9],
        ],
      ],
    },
  });
  assert.equal(geometry.type, "Polygon");
  assert.equal(geometry.coordinates[0].length, 4);
});

test("custom polygons must be closed and remain in the DFW guardrail", () => {
  assert.throws(
    () =>
      validateCustomMarketGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-96.67, 32.9],
            [-96.65, 32.9],
            [-96.65, 32.92],
            [-96.66, 32.91],
          ],
        ],
      }),
    /custom_area_ring_not_closed/,
  );

  assert.throws(
    () =>
      validateCustomMarketGeometry({
        type: "Polygon",
        coordinates: [
          [
            [-101, 32.9],
            [-96.65, 32.9],
            [-96.65, 32.92],
            [-101, 32.9],
          ],
        ],
      }),
    /custom_area_outside_dfw_bounds/,
  );
});
