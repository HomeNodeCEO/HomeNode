import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { cameraRollPhotos, cameraRollResultMessage, saveCameraRollBatch, type CameraRollDependencies, type CameraRollReceipt } from "../src/photos/cameraRollCore";
import type { PreparedPhoto } from "../src/photos/model";
import type { LocalPhotoDraft } from "../src/offline/store";

const photo = (id: string): PreparedPhoto => ({
  clientPhotoId: id, category: "Front", categorySource: "custom_catalog", roomRef: null, roomLabel: null,
  caption: "Front", source: "camera", capturedAt: "2026-10-08T12:00:00Z", captureMetadata: {},
  objects: [{ clientObjectId: `${id}-original`, variant: "original", uri: `file:///private/${id}/original.jpg`, fileName: "original.jpg", contentType: "image/jpeg", byteSize: 900000, width: 4000, height: 3000 }],
});
function fixture() {
  const receipts = new Map<string, CameraRollReceipt>();
  const copied: string[] = [];
  let permissions = 0;
  const dependencies: CameraRollDependencies = {
    requestPermission: async () => { permissions += 1; return true; },
    originalUri: (item) => item.objects.find((object) => object.variant === "original")!.uri,
    readReceipt: async (item) => receipts.get(item.clientPhotoId) || null,
    writeReceipt: async (item, state) => { receipts.set(item.clientPhotoId, state); },
    clearReceipt: async (item) => { receipts.delete(item.clientPhotoId); },
    createAsset: async (uri) => { copied.push(uri); },
  };
  return { dependencies, receipts, copied, permissions: () => permissions };
}

test("saves full originals offline sequentially without mutating drafts", async () => {
  const f = fixture();
  const photos = [photo("a"), photo("b")];
  const before = JSON.stringify(photos);
  const progress: number[] = [];
  let active = 0;
  const result = await saveCameraRollBatch(photos, { ...f.dependencies, createAsset: async (uri) => {
    assert.equal(++active, 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    f.copied.push(uri); active -= 1;
  } }, (count) => progress.push(count));
  assert.deepEqual(result, { saved: 2, alreadySaved: 0, failed: 0, uncertain: 0 });
  assert.deepEqual(f.copied, photos.map((item) => item.objects[0]!.uri));
  assert.deepEqual(progress, [1, 2]);
  assert.equal(f.permissions(), 1);
  assert.equal(JSON.stringify(photos), before);
});
test("durable receipts skip previous saves after restart and save only new photos", async () => {
  const f = fixture();
  await saveCameraRollBatch([photo("a")], f.dependencies);
  const restarted = { ...f.dependencies, readReceipt: async (item: PreparedPhoto) => f.receipts.get(item.clientPhotoId) || null };
  assert.deepEqual(await saveCameraRollBatch([photo("a"), photo("b")], restarted), { saved: 1, alreadySaved: 1, failed: 0, uncertain: 0 });
  assert.equal(f.copied.length, 2);
});
test("denied permission performs no writes or copies and empty selection requests nothing", async () => {
  const f = fixture();
  await assert.rejects(saveCameraRollBatch([photo("a")], { ...f.dependencies, requestPermission: async () => false }), /camera_roll_permission_required/);
  assert.equal(f.receipts.size, 0); assert.equal(f.copied.length, 0);
  await saveCameraRollBatch([], f.dependencies);
  assert.equal(f.permissions(), 0);
});
test("failed original is reported while remaining photos succeed and can retry", async () => {
  const f = fixture();
  const result = await saveCameraRollBatch([photo("a"), photo("b")], { ...f.dependencies, createAsset: async (uri) => {
    if (uri.includes("/a/")) throw new Error("device_storage_full");
    f.copied.push(uri);
  } });
  assert.equal(result.failed, 1); assert.equal(result.saved, 1);
  assert.equal(f.receipts.has("a"), false);
  assert.equal((await saveCameraRollBatch([photo("a"), photo("b")], f.dependencies)).saved, 1);
});
test("missing originals do not use display substitutes or mark a save", async () => {
  const f = fixture();
  const result = await saveCameraRollBatch([photo("a")], { ...f.dependencies, originalUri: () => { throw new Error("missing_original"); } });
  assert.equal(result.failed, 1); assert.equal(f.receipts.size, 0); assert.equal(f.copied.length, 0);
});
test("interrupted OS copy is not blindly duplicated after restart", async () => {
  const f = fixture(); f.receipts.set("a", "pending");
  const result = await saveCameraRollBatch([photo("a"), photo("b")], f.dependencies);
  assert.equal(result.uncertain, 1); assert.equal(result.saved, 1);
  assert.equal(f.copied.length, 1);
  assert.match(cameraRollResultMessage(result), /Check Photos.*interrupted save/);
});
test("receipt failure after successful OS copy remains pending rather than duplicating", async () => {
  const f = fixture();
  const result = await saveCameraRollBatch([photo("a")], { ...f.dependencies, writeReceipt: async (item, state) => {
    if (state === "saved") throw new Error("receipt_write_failed");
    f.receipts.set(item.clientPhotoId, state);
  } });
  assert.equal(result.uncertain, 1); assert.equal(f.copied.length, 1);
  await saveCameraRollBatch([photo("a")], f.dependencies);
  assert.equal(f.copied.length, 1);
});
test("selection includes staged photos once, excludes removed photos, and remains bounded", () => {
  const draft = (id: string, state = "queued", removeOperationId: string | null = null) => ({ ...photo(id), state, removeOperationId }) as LocalPhotoDraft;
  assert.deepEqual(cameraRollPhotos([draft("a"), draft("b", "excluded"), draft("c", "remove_pending", "remove")], [photo("a"), photo("b"), photo("c"), photo("d")]).map((item) => item.clientPhotoId), ["a", "d"]);
  assert.equal(cameraRollPhotos([], Array.from({ length: 110 }, (_, i) => photo(String(i)))).length, 100);
});
test("native adapter requests add-only access on demand with scoped receipts and no API", () => {
  const adapter = fs.readFileSync(new URL("../src/photos/cameraRoll.ts", import.meta.url), "utf8");
  const panel = fs.readFileSync(new URL("../src/photos/PhotoCapturePanel.tsx", import.meta.url), "utf8");
  const config = JSON.parse(fs.readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  const plugin = config.expo.plugins.find((entry: unknown[]) => entry[0] === "expo-media-library")[1];
  assert.match(adapter, /requestPermissionsAsync\(true, \["photo"\]\)/);
  assert.match(adapter, /await Asset\.create\(uri\)/);
  assert.match(adapter, /const existing = running\.get\(key\)/);
  assert.match(adapter, /homenode-camera-roll-receipts.*, owner, session/);
  assert.doesNotMatch(adapter, /fetch\(|MobileApi|SQLite|getAssets|Query\(|deleteAsset|saveToLibraryAsync/);
  assert.deepEqual(plugin.granularPermissions, ["photo"]);
  assert.equal(plugin.isAccessMediaLocationEnabled, false);
  assert.match(plugin.savePhotosPermission, /save inspection photos/);
  assert.match(panel, /Save all photos to phone/);
  assert.match(panel, /Photos may sync to iCloud/);
});
