import assert from "node:assert/strict";
import test from "node:test";

import {
  availablePhotoPositions,
  automaticPhotoLabel,
  displayWidth,
  inferredImageContentType,
  remainingPhotoCapacity,
  safePhotoFileName,
  UAD_PHOTO_CATEGORIES,
} from "../src/photos/model";

test("photo capacity is bounded to 100 active inspection photos", () => {
  assert.equal(remainingPhotoCapacity(0), 100);
  assert.equal(remainingPhotoCapacity(99), 1);
  assert.equal(remainingPhotoCapacity(100), 0);
  assert.equal(remainingPhotoCapacity(120), 0);
});

test("offline photo positions reuse an excluded slot", () => {
  const occupied = Array.from({ length: 100 }, (_unused, index) => index + 1)
    .filter((position) => position !== 37);
  assert.deepEqual(availablePhotoPositions(occupied), [37]);
});

test("room selection creates an automatic photo label", () => {
  assert.equal(automaticPhotoLabel({ roomLabel: "Kitchen", category: "Interior" }), "Kitchen");
  assert.equal(automaticPhotoLabel({ category: "Front" }), "Front");
});

test("normalizes image types, display dimensions, and durable file names", () => {
  assert.equal(inferredImageContentType("IMG_1001.HEIC"), "image/heic");
  assert.equal(inferredImageContentType("anything", "image/webp"), "image/webp");
  assert.equal(displayWidth(4032), 2048);
  assert.equal(displayWidth(1200), 1200);
  assert.equal(safePhotoFileName("Front view #1.HEIC", "original.heic"), "Front-view-1.HEIC");
});

test("offers UAD-specific evidence labels during UAD inspections", () => {
  assert.ok(UAD_PHOTO_CATEGORIES.includes("Dwelling front"));
  assert.ok(UAD_PHOTO_CATEGORIES.includes("Street/property access"));
  assert.ok(UAD_PHOTO_CATEGORIES.includes("Defect/damage"));
});
