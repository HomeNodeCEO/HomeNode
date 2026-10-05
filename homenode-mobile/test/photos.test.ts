import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
import { DatabaseActivityGate } from "../src/offline/databaseActivityGate";
import { ApiError, type MobileApi, type PresignedPhotoUpload } from "../src/api/client";
import type { LocalPhotoDraft, OfflineStore } from "../src/offline/store";
import { createCoalescedSync, drainDuePhotoBatches } from "../src/photos/coalescedSync";
import { synchronizeDuePhotosWithDependencies, uploadPhotoObject } from "../src/photos/syncCore";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test("camera stages photos while encrypted database activity is paused without forcing a close", () => {
  const panel = fs.readFileSync(path.resolve(testDirectory, "../src/photos/PhotoCapturePanel.tsx"), "utf8");
  const capture = fs.readFileSync(path.resolve(testDirectory, "../src/photos/capture.ts"), "utf8");
  const picker = panel.match(/const pickWithDatabasePaused = async \([\s\S]*?\n  };/)?.[0] || "";
  assert.match(picker, /await store\.pauseDatabaseActivity\(\);[\s\S]*await prepareAssets\(assets, source\);[\s\S]*await ensurePhotoDatabaseReady\(store\);[\s\S]*resumeDatabaseActivity\(\);/);
  assert.doesNotMatch(picker, /prepareForExternalActivity/);
  assert.match(capture, /new File\(directory, STAGED_PHOTO_MANIFEST\)\.write\(JSON\.stringify\(prepared\)\)/);
  assert.match(panel, /recoverStagedPhotos\(ownerUserId, sessionId\)/);
  assert.match(panel, /setStagedPhotos\(staged\)/);
  assert.match(panel, /Recover saved photos/);
  assert.match(capture, /new File\(entry, fileName\)/);
  assert.doesNotMatch(panel, /if \(!cached\) \{[\s\S]*deletePreparedPhotoFiles\(photo\)/);
});

test("photo drafts resolve previews in the current app Documents directory", () => {
  const store = fs.readFileSync(path.resolve(testDirectory, "../src/offline/store.ts"), "utf8");
  assert.match(store, /new File\(Paths\.document, "homenode-appraisal-photos", row\.owner_user_id, row\.session_id, row\.client_photo_id, fileName\)/);
  assert.match(store, /uri: currentPhotoUri\(row, row\.display_uri\)/);
  assert.match(store, /uri: currentPhotoUri\(row, row\.original_uri\)/);
});

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
    withDatabaseActivity<T>(operation: () => Promise<T>) { return operation(); },
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

test("a signed-file denial keeps the offline photo and its prepared files", async () => {
  const photo = {
    clientPhotoId: "photo_signed",
    sessionId: "inspection_signed",
    serverPhotoId: null,
    serverRevision: null,
    removeOperationId: null,
    metadataOperationId: null,
  } as unknown as LocalPhotoDraft;
  let failure: string | null = null;
  let deleted = 0;
  const store = {
    withDatabaseActivity<T>(operation: () => Promise<T>) { return operation(); },
    async ensureReady() {},
    async duePhotoDrafts() { return [photo]; },
    async markPhotoDraftState() {},
    photoUploadRequest() { return { client_photo_id: photo.clientPhotoId }; },
    async recordPhotoFailure(_owner: string, draft: LocalPhotoDraft, code: string) {
      assert.equal(draft, photo);
      failure = code;
    },
  } as unknown as OfflineStore;
  const api = {
    async createPhotoUploadRequests() {
      throw new ApiError(409, "custom_appraisal_workfile_signed");
    },
  } as unknown as MobileApi;
  await synchronizeDuePhotosWithDependencies(store, api, "appraiser_1", {
    async uploadObject() { assert.fail("signed files must not receive an upload URL"); },
    async deletePreparedPhotoFiles() { deleted += 1; },
  });
  assert.equal(failure, "custom_appraisal_workfile_signed");
  assert.equal(deleted, 0);
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
  assert.match(photoSyncErrorMessage("custom_appraisal_workfile_signed"), /saved on this device/);
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

test("camera activity pauses photo database writes without waiting for network upload", async () => {
  const gate = new DatabaseActivityGate();
  let releaseUpload!: () => void;
  let uploadStarted!: () => void;
  const started = new Promise<void>((resolve) => { uploadStarted = resolve; });
  const upload = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const photo = {
    clientPhotoId: "photo_camera_overlap",
    sessionId: "inspection_1",
    objects: [{ variant: "original", uri: "file://original.jpg", byteSize: 512 }],
  } as unknown as LocalPhotoDraft;
  let verified = false;
  const store = {
    withDatabaseActivity<T>(operation: () => Promise<T>) { return gate.run(operation); },
    async ensureReady() {},
    async duePhotoDrafts() { return [photo]; },
    async markPhotoDraftState() {},
    photoUploadRequest() { return { client_photo_id: photo.clientPhotoId }; },
    async cacheRegisteredPhoto() {},
    async applyServerPhoto() { verified = true; },
    async recordPhotoFailure() { assert.fail("upload should not fail during capture"); },
  } as unknown as OfflineStore;
  const api = {
    async createPhotoUploadRequests() {
      return { photos: [{ photo: { id: "server_photo_1", status: "pending" }, uploads: [{ variant: "original" }] }] };
    },
    async verifyPhoto() { return { id: "server_photo_1", status: "verified" }; },
  } as unknown as MobileApi;
  const sync = synchronizeDuePhotosWithDependencies(store, api, "appraiser_1", {
    async uploadObject() { uploadStarted(); await upload; },
    async deletePreparedPhotoFiles() {},
  });
  await started;
  const resume = await gate.pause();
  releaseUpload();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(verified, false);
  resume();
  assert.equal(await sync, 1);
  assert.equal(verified, true);
});

test("new captures during a sync coalesce into one later queue pass", async () => {
  let releaseFirst!: () => void;
  const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let passes = 0;
  let active = 0;
  let maximumActive = 0;
  const run = createCoalescedSync(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    passes += 1;
    if (passes === 1) await first;
    active -= 1;
  });
  const initial = run();
  const later = [run(), run(), run()];
  releaseFirst();
  await Promise.all([initial, ...later]);
  assert.equal(passes, 2);
  assert.equal(maximumActive, 1);
});

test("bulk photo sync drains bounded batches without retrying new failures in the same pass", async () => {
  const observedCutoffs: number[] = [];
  const batchSizes = [10, 10, 3, 0];
  await drainDuePhotoBatches(async (dueBefore) => {
    observedCutoffs.push(dueBefore);
    return batchSizes.shift() ?? 0;
  }, 12345);
  assert.deepEqual(observedCutoffs, [12345, 12345, 12345, 12345]);
});
