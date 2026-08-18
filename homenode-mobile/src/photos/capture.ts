import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";

import {
  automaticPhotoLabel,
  displayWidth,
  inferredImageContentType,
  type PreparedPhoto,
  type PreparedPhotoObject,
  safePhotoFileName,
} from "./model";

export type PhotoLabelSelection = Readonly<{
  category: string;
  categorySource: PreparedPhoto["categorySource"];
  roomRef?: string | null;
  roomLabel?: string | null;
}>;

async function ensurePermission(kind: "camera" | "library") {
  const response = kind === "camera"
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!response.granted) throw new Error(`mobile_${kind}_permission_required`);
}

export async function captureCameraPhoto() {
  await ensurePermission("camera");
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    allowsEditing: false,
    exif: true,
    quality: 1,
  });
  return result.canceled ? [] : result.assets;
}

export async function importLibraryPhotos(selectionLimit: number) {
  await ensurePermission("library");
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    orderedSelection: true,
    selectionLimit: Math.max(1, Math.min(100, Math.floor(selectionLimit))),
    exif: true,
    quality: 1,
  });
  return result.canceled ? [] : result.assets;
}

export async function recoverInterruptedPickerPhotos() {
  const result = await ImagePicker.getPendingResultAsync();
  if (!result || "canceled" in result && result.canceled) return [];
  if ("code" in result) throw new Error(result.code || "mobile_photo_picker_failed");
  return result.assets || [];
}

function fileExtension(fileName: string, contentType: string) {
  const extension = fileName.match(/\.[A-Za-z0-9]{2,5}$/)?.[0];
  if (extension) return extension.toLowerCase();
  const extensions: Record<string, string> = {
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/heic": ".heic",
    "image/heif": ".heif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/tiff": ".tiff",
    "image/webp": ".webp",
  };
  return extensions[contentType] || ".jpg";
}

async function copyToDurableFile(sourceUri: string, directory: Directory, name: string) {
  const source = new File(sourceUri);
  if (!source.exists || !source.size) throw new Error("empty_mobile_photo_file");
  const destination = new File(directory, name);
  await source.copy(destination, { overwrite: true });
  if (!destination.exists || !destination.size) throw new Error("empty_mobile_photo_file");
  return destination;
}

async function displayDerivative(original: File, directory: Directory, width: number | null) {
  const context = ImageManipulator.manipulate(original.uri);
  context.resize({ width: displayWidth(width), height: null });
  const rendered = await context.renderAsync();
  const temporary = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.86 });
  const derivative = await copyToDurableFile(temporary.uri, directory, "display.jpg");
  if (temporary.uri !== derivative.uri) {
    try { new File(temporary.uri).delete(); } catch { /* cache cleanup is best effort */ }
  }
  return { file: derivative, width: rendered.width, height: rendered.height };
}

export async function preparePickedPhoto(
  asset: ImagePicker.ImagePickerAsset,
  options: {
    ownerUserId: string;
    sessionId: string;
    source: "camera" | "library";
    label: PhotoLabelSelection;
  },
): Promise<PreparedPhoto> {
  if (asset.type && asset.type !== "image") throw new Error("invalid_mobile_photo_type");
  const clientPhotoId = Crypto.randomUUID();
  const directory = new Directory(
    Paths.document,
    "homenode-appraisal-photos",
    options.ownerUserId,
    options.sessionId,
    clientPhotoId,
  );
  await directory.create({ idempotent: true, intermediates: true });
  const contentType = inferredImageContentType(asset.fileName, asset.mimeType);
  const originalName = safePhotoFileName(
    asset.fileName,
    `original${fileExtension(asset.fileName || "", contentType)}`,
  );
  const original = await copyToDurableFile(asset.uri, directory, `original${fileExtension(originalName, contentType)}`);
  const display = await displayDerivative(original, directory, asset.width || null);
  const objects: PreparedPhotoObject[] = [
    {
      clientObjectId: Crypto.randomUUID(),
      variant: "original",
      uri: original.uri,
      fileName: originalName,
      contentType,
      byteSize: Number(original.size),
      width: asset.width > 0 ? asset.width : null,
      height: asset.height > 0 ? asset.height : null,
    },
    {
      clientObjectId: Crypto.randomUUID(),
      variant: "display",
      uri: display.file.uri,
      fileName: `${originalName.replace(/\.[^.]+$/, "")}-display.jpg`,
      contentType: "image/jpeg",
      byteSize: Number(display.file.size),
      width: display.width,
      height: display.height,
    },
  ];
  return {
    clientPhotoId,
    category: options.label.category,
    categorySource: options.label.categorySource,
    roomRef: options.label.roomRef || null,
    roomLabel: options.label.roomLabel || null,
    caption: automaticPhotoLabel({
      roomLabel: options.label.roomLabel,
      category: options.label.category,
    }),
    source: options.source,
    capturedAt: new Date().toISOString(),
    captureMetadata: {
      platform: Platform.OS,
      orientation: asset.width >= asset.height ? "landscape" : "portrait",
      picker_asset_id: asset.assetId || null,
      exif_orientation: typeof asset.exif?.Orientation === "number" ? asset.exif.Orientation : null,
    },
    objects,
  };
}

export async function deletePreparedPhotoFiles(photo: PreparedPhoto) {
  for (const object of photo.objects) {
    try { new File(object.uri).delete(); } catch { /* already removed */ }
  }
  const first = photo.objects[0];
  if (first) {
    try { new File(first.uri).parentDirectory.delete(); } catch { /* already removed */ }
  }
}
