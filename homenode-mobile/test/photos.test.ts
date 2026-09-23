import assert from "node:assert/strict";
import test from "node:test";

import {
  availablePhotoPositions,
  automaticPhotoLabel,
  displayWidth,
  inferredImageContentType,
  isPhotoVisible,
  photoSyncErrorMessage,
  photoUploadTimeoutMs,
  remainingPhotoCapacity,
  safePhotoFileName,
  UAD_PHOTO_CATEGORIES,
} from "../src/photos/model";
import { runWithConcurrency } from "../src/offline/concurrency";
import type { MobileApi, PresignedPhotoUpload } from "../src/api/client";
import type { LocalPhotoDraft, OfflineStore } from "../src/offline/store";
import { synchronizeDuePhotosWithDependencies, uploadPhotoObject } from "../src/photos/syncCore";

test("photo capacity is bounded to 100 active inspection photos", () => {
  assert.equal(remainingPhotoCapacity(0), 100);
  assert.equal(remainingPhotoCapacity(99), 1);
  assert.equal(remainingPhotoCapacity(100), 0);
  assert.equal(remainingPhotoCapacity(120), 0);
});

test("photo upload deadlines allow slow originals but have an upper bound", () => {
  assert.equal(photoUploadTimeoutMs(1_000_000), 120_000);
  assert.equal(photoUploadTimeoutMs(10 * 1024 * 1024), 190_000);
  assert.equal(photoUploadTimeoutMs(50 * 1024 * 1024), 830_000);
  assert.equal(photoUploadTimeoutMs(100 * 1024 * 1024), 900_000);
  assert.match(photoSyncErrorMessage("mobile_photo_upload_timeout"), /saved on this device/);
});

test("a stalled photo PUT aborts and remains queued for a verified retry", async () => {
  const photo = {
    clientPhotoId: "photo_1",
    sessionId: "inspection_1",
    serverPhotoId: null,
    serverRevision: null,
    removeOperationId: null,
    metadataOperationId: null,
    objects: [{ variant: "original", uri: "file://original.jpg", byteSize: 512 }],
  } as unknown as LocalPhotoDraft;
  const upload: PresignedPhotoUpload = {
    variant: "original",
    object_id: "object_1",
    method: "PUT",
    url: "https://storage.example.test/signed-secret",
    headers: { "content-type": "image/jpeg" },
    expires_in_seconds: 900,
  };
  let draft: LocalPhotoDraft | null = photo;
  let storedFailure: string | null = null;
  let verified = 0;
  let deleted = 0;
  let uploadAttempts = 0;
  let firstSignal: AbortSignal | undefined;
  const store = {
    async ensureReady() {},
    async duePhotoDrafts() { return draft ? [draft] : []; },
    async markPhotoDraftState() {},
    photoUploadRequest() { return { client_photo_id: "photo_1" }; },
    async cacheRegisteredPhoto() {},
    async recordPhotoFailure(_owner: string, _draft: LocalPhotoDraft, code: string) { storedFailure = code; },
    async applyServerPhoto() { draft = null; },
    async deletePhotoDraft() { deleted += 1; draft = null; },
  } as unknown as OfflineStore;
  const api = {
    async createPhotoUploadRequests() {
      return { photos: [{ photo: { id: "server_photo_1", status: "pending" }, uploads: [upload] }] };
    },
    async verifyPhoto() { verified += 1; return { id: "server_photo_1", status: "verified" }; },
  } as unknown as MobileApi;
  const dependencies = {
    uploadObject: (draftPhoto: LocalPhotoDraft, presigned: PresignedPhotoUpload) => uploadPhotoObject(
      draftPhoto,
      presigned,
      {
        createFile: () => ({ exists: true, size: 512 }),
        put: async (url: string, request: { signal: AbortSignal; headers: Record<string, string> }) => {
          assert.equal(url, upload.url);
          assert.deepEqual(request.headers, upload.headers);
          uploadAttempts += 1;
          if (uploadAttempts === 1) {
            firstSignal = request.signal;
            return new Promise<Response>(() => {});
          }
          return new Response(null, { status: 200 });
        },
        timeoutMs: 10,
      },
    ),
    async deletePreparedPhotoFiles() { deleted += 1; },
  };

  await synchronizeDuePhotosWithDependencies(store, api, "appraiser_1", dependencies);
  assert.equal(firstSignal?.aborted, true);
  assert.equal(storedFailure, "mobile_photo_upload_timeout");
  assert.equal(verified, 0);
  assert.equal(deleted, 0);
  assert.equal(draft, photo);

  await synchronizeDuePhotosWithDependencies(store, api, "appraiser_1", dependencies);
  assert.equal(uploadAttempts, 2);
  assert.equal(verified, 1);
  assert.equal(draft, null);
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
  assert.match(photoSyncErrorMessage("mobile_photo_upload_transport_failed"), /saved locally/);
  assert.doesNotMatch(
    photoSyncErrorMessage("mobile_photo_upload_transport_failed:https://signed.example/token"),
    /signed\.example|token/,
  );
});

test("photo queue work is bounded while allowing independent uploads to overlap", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed: number[] = [];
  await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(value);
    active -= 1;
  });
  assert.equal(maximumActive, 3);
  assert.deepEqual(completed.sort((left, right) => left - right), [1, 2, 3, 4, 5, 6, 7]);
});
