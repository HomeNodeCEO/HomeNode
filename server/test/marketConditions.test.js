import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMarketContextOverride,
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

test("market context can be overridden without changing subject identity", () => {
  const subject = {
    account_id: "005530000001A0000",
    address: "10010 STRAIT LN, DALLAS",
    city: "DALLAS",
    county: "DALLAS COUNTY",
    postal_code: null,
    latitude: 32.88,
    longitude: -96.82,
    location_status: "matched",
    location_source: "dcad_parcel_query",
    location_precision: "parcel_centroid",
    location_confidence: "high",
    location_review_required: false,
    location_review_reason: null,
  };
  const result = applyMarketContextOverride(subject, {
    source: "dcad_related_parcel",
    source_account_id: "00000416188000000",
    postal_code: "75229-1234",
    latitude: 32.881,
    longitude: -96.823,
    review_note: "Related land parcel selected as the study origin.",
  });
  assert.equal(result.account_id, subject.account_id);
  assert.equal(result.postal_code, "75229");
  assert.equal(result.context_override_active, true);
  assert.equal(result.context_source_account_id, "00000416188000000");
  assert.equal(result.location_source, "dcad_related_parcel_override");
  assert.equal(result.location_review_required, true);
  assert.deepEqual(result.context_overridden_fields, [
    "postal_code",
    "coordinates",
    "source_account_id",
  ]);
});

test("market context override coordinates must be complete and inside DFW", () => {
  const subject = { account_id: "005530000001A0000" };
  assert.throws(
    () => applyMarketContextOverride(subject, { latitude: 32.88 }),
    /market_context_coordinates_incomplete/,
  );
  assert.throws(
    () =>
      applyMarketContextOverride(subject, {
        latitude: 40,
        longitude: -96.8,
      }),
    /market_context_coordinates_outside_dfw/,
  );
});
