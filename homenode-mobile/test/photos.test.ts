import assert from "node:assert/strict";
import test from "node:test";

import {
  availablePhotoPositions,
  automaticPhotoLabel,
  displayWidth,
  inferredImageContentType,
  isPhotoVisible,
  photoSyncErrorMessage,
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

test("hides photos as soon as removal is queued", () => {
  assert.equal(isPhotoVisible("synchronized", null), true);
  assert.equal(isPhotoVisible("remove_pending", "remove-operation"), false);
  assert.equal(isPhotoVisible("failed", "remove-operation"), false);
  assert.equal(isPhotoVisible("excluded", null), false);
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

test("turns cloud photo failures into actionable field messages", () => {
  assert.equal(
    photoSyncErrorMessage("mobile_photo_upload_http_401:Unauthorized"),
    "HomeNode's cloud-storage credential is not authorized. Service configuration must be repaired before retrying.",
  );
  assert.equal(
    photoSyncErrorMessage("mobile_photo_upload_http_403:SignatureDoesNotMatch"),
    "Cloud storage rejected the upload (HTTP 403 · SignatureDoesNotMatch).",
  );
  assert.equal(
    photoSyncErrorMessage("mobile_photo_verification_failed"),
    "Cloud storage received the photo, but verification could not be completed.",
  );
  assert.match(
    photoSyncErrorMessage("mobile_photo_upload_transport_failed:Network request failed"),
    /iPhone could not transfer/,
  );
});
