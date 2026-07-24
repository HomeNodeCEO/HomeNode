import test from "node:test";
import assert from "node:assert/strict";
import {
  haversineMiles,
  polygonCentroid,
  scoreComparable,
} from "../src/util/comparableScoring.js";

test("haversine distance is zero for the same parcel center", () => {
  assert.equal(haversineMiles(32.947, -96.656, 32.947, -96.656), 0);
});

test("a ten-percent living-area difference is a soft score, not a filter", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1650,
  });
  assert.equal(score.squareFootageDifferencePercent, 10);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.comparableScore, 80);
});

test("even a large living-area difference remains scoreable", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.948,
    comparableLongitude: -96.657,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 2400,
  });
  assert.ok(score);
  assert.equal(score.squareFootageDifferencePercent, 60);
  assert.ok(score.squareFootageScore > 0);
});

test("location contributes sixty percent and living area forty percent", () => {
  const score = scoreComparable({
    subjectLatitude: 32.947,
    subjectLongitude: -96.656,
    comparableLatitude: 32.947,
    comparableLongitude: -96.656,
    subjectSquareFeet: 1500,
    comparableSquareFeet: 1650,
  });
  assert.equal(score.locationScore, 100);
  assert.equal(score.squareFootageScore, 50);
  assert.equal(score.comparableScore, 80);
});

test("polygon centroid returns the center of a parcel", () => {
  const centroid = polygonCentroid([
    [
      [-97, 32],
      [-96, 32],
      [-96, 33],
      [-97, 33],
      [-97, 32],
    ],
  ]);
  assert.ok(centroid);
  assert.ok(Math.abs(centroid.longitude + 96.5) < 1e-9);
  assert.ok(Math.abs(centroid.latitude - 32.5) < 1e-9);
});
