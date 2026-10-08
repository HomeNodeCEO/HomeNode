import { isPhotoVisible, type PreparedPhoto } from "./model";
import type { LocalPhotoDraft } from "../offline/store";

export type CameraRollReceipt = "pending" | "saved" | null;
export type CameraRollResult = Readonly<{ saved: number; alreadySaved: number; failed: number; uncertain: number }>;
export type CameraRollDependencies = Readonly<{
  requestPermission: () => Promise<boolean>;
  originalUri: (photo: PreparedPhoto) => string;
  readReceipt: (photo: PreparedPhoto) => Promise<CameraRollReceipt>;
  writeReceipt: (photo: PreparedPhoto, state: Exclude<CameraRollReceipt, null>) => Promise<void>;
  clearReceipt: (photo: PreparedPhoto) => Promise<void>;
  createAsset: (uri: string) => Promise<void>;
}>;

export function cameraRollPhotos(photos: LocalPhotoDraft[], staged: PreparedPhoto[]): PreparedPhoto[] {
  const selected = new Map<string, PreparedPhoto>();
  const excluded = new Set(photos.filter((photo) => !isPhotoVisible(photo.state, photo.removeOperationId)).map((photo) => photo.clientPhotoId));
  for (const photo of [...photos, ...staged]) {
    if (!excluded.has(photo.clientPhotoId) && !selected.has(photo.clientPhotoId)) selected.set(photo.clientPhotoId, photo);
  }
  return [...selected.values()].slice(0, 100);
}

// Local-only, sequential OS copies: no cloud requests, queue changes or large image buffers.
export async function saveCameraRollBatch(
  photos: PreparedPhoto[],
  dependencies: CameraRollDependencies,
  onProgress: (completed: number, total: number) => void = () => {},
): Promise<CameraRollResult> {
  const result = { saved: 0, alreadySaved: 0, failed: 0, uncertain: 0 };
  if (!photos.length) return result;
  if (!await dependencies.requestPermission()) throw new Error("camera_roll_permission_required");
  let completed = 0;
  for (const photo of photos) {
    let started = false;
    let copied = false;
    try {
      const receipt = await dependencies.readReceipt(photo);
      if (receipt === "saved") result.alreadySaved += 1;
      else if (receipt === "pending") {
        // A crash can occur between the OS copy and our receipt. Do not blindly duplicate it.
        result.uncertain += 1;
      } else {
        const uri = dependencies.originalUri(photo);
        await dependencies.writeReceipt(photo, "pending");
        started = true;
        await dependencies.createAsset(uri);
        copied = true;
        await dependencies.writeReceipt(photo, "saved");
        result.saved += 1;
      }
    } catch {
      if (copied) result.uncertain += 1;
      else if (started) {
        try { await dependencies.clearReceipt(photo); result.failed += 1; }
        catch { result.uncertain += 1; }
      } else result.failed += 1;
    }
    onProgress(++completed, photos.length);
  }
  return result;
}

export function cameraRollResultMessage(result: CameraRollResult) {
  const parts = [`${result.saved} saved to Photos`];
  if (result.alreadySaved) parts.push(`${result.alreadySaved} already saved`);
  if (result.failed) parts.push(`${result.failed} could not be saved; try again`);
  if (result.uncertain) parts.push(`Check Photos for ${result.uncertain} interrupted save${result.uncertain === 1 ? "" : "s"}; HomeNode will not copy these again automatically`);
  return `${parts.join(". ")}. HomeNode originals and uploads are unchanged.`;
}
