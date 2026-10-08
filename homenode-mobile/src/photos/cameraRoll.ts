import { File, Paths } from "expo-file-system";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import type { PreparedPhoto } from "./model";
import { saveCameraRollBatch, type CameraRollResult } from "./cameraRollCore";

const running = new Map<string, Promise<CameraRollResult>>();

function component(value: string) {
  if (!value || value === "." || value === "..") throw new Error("invalid_camera_roll_scope");
  return encodeURIComponent(value);
}

export function savePhotosToCameraRoll(
  ownerUserId: string,
  sessionId: string,
  photos: PreparedPhoto[],
  onProgress: (completed: number, total: number) => void,
): Promise<CameraRollResult> {
  const owner = component(ownerUserId);
  const session = component(sessionId);
  const key = `${owner}/${session}`;
  const existing = running.get(key);
  if (existing) return existing;
  const receiptFile = (photo: PreparedPhoto) => new File(
    Paths.document, "homenode-camera-roll-receipts", owner, session, `${component(photo.clientPhotoId)}.json`,
  );
  const operation = saveCameraRollBatch(photos, {
    requestPermission: async () => (await requestPermissionsAsync(true, ["photo"])).granted,
    originalUri: (photo) => {
      const original = photo.objects.find((object) => object.variant === "original");
      const name = original?.uri.split("/").pop() || "";
      if (!/^original\.[A-Za-z0-9]{2,5}$/.test(name)) throw new Error("camera_roll_original_missing");
      // Resolve under this owner/inspection in the current iOS container, never a signed URL.
      const file = new File(Paths.document, "homenode-appraisal-photos", ownerUserId, sessionId, photo.clientPhotoId, name);
      if (!file.exists || !file.size) throw new Error("camera_roll_original_missing");
      return file.uri;
    },
    readReceipt: async (photo) => {
      const file = receiptFile(photo);
      if (!file.exists) return null;
      const receipt = JSON.parse(await file.text());
      if (receipt.version !== 1 || !["pending", "saved"].includes(receipt.state)) throw new Error("invalid_camera_roll_receipt");
      return receipt.state as "pending" | "saved";
    },
    writeReceipt: async (photo, state) => {
      const file = receiptFile(photo);
      file.parentDirectory.create({ idempotent: true, intermediates: true });
      file.write(JSON.stringify({ version: 1, state }));
    },
    clearReceipt: async (photo) => { const file = receiptFile(photo); if (file.exists) file.delete(); },
    createAsset: async (uri) => { await Asset.create(uri); },
  }, onProgress).finally(() => { running.delete(key); });
  running.set(key, operation);
  return operation;
}
