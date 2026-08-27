import type { JsonValue } from "../offline/model";

export const MAX_PHOTOS_PER_INSPECTION = 100;
export const DISPLAY_MAX_WIDTH = 2048;

export const CUSTOM_PHOTO_CATEGORIES = Object.freeze([
  "Front",
  "Rear",
  "Street",
  "Kitchen",
  "Living area",
  "Bedroom",
  "Bathroom",
  "Garage",
  "Attic",
  "Mechanical systems",
  "Site/view",
  "Defect",
  "Repair item",
  "Additional improvement",
  "Other",
] as const);

export const UAD_PHOTO_CATEGORIES = Object.freeze([
  "Dwelling front",
  "Dwelling rear",
  "Street/property access",
  "Site/view",
  "Kitchen",
  "Living room",
  "Bedroom",
  "Bathroom",
  "Garage/vehicle storage",
  "Outbuilding",
  "Amenity",
  "Defect/damage",
  "Other exhibit",
] as const);

export const ROOM_PHOTO_LABELS = Object.freeze([
  "Kitchen",
  "Living room",
  "Dining room",
  "Primary bedroom",
  "Bedroom 2",
  "Bedroom 3",
  "Primary bathroom",
  "Bathroom 2",
  "Utility room",
  "Garage",
  "Other room",
] as const);

export type LocalPhotoState =
  | "queued"
  | "registering"
  | "uploading"
  | "verifying"
  | "synchronized"
  | "metadata_pending"
  | "remove_pending"
  | "excluded"
  | "failed";

export type PreparedPhotoObject = Readonly<{
  clientObjectId: string;
  variant: "original" | "display";
  uri: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}>;

export type PreparedPhoto = Readonly<{
  clientPhotoId: string;
  category: string;
  categorySource: "custom_catalog" | "uad_catalog" | "sketch_room" | "manual";
  roomRef: string | null;
  roomLabel: string | null;
  caption: string;
  source: "camera" | "library";
  capturedAt: string;
  captureMetadata: Record<string, JsonValue>;
  objects: PreparedPhotoObject[];
}>;

export function remainingPhotoCapacity(currentCount: number) {
  return Math.max(0, MAX_PHOTOS_PER_INSPECTION - Math.max(0, Math.floor(currentCount)));
}

export function availablePhotoPositions(positions: number[]) {
  const occupied = new Set(positions.map((position) => Number(position)));
  return Array.from({ length: MAX_PHOTOS_PER_INSPECTION }, (_unused, index) => index + 1)
    .filter((position) => !occupied.has(position));
}

export function displayWidth(width: number | null | undefined) {
  if (!width || !Number.isFinite(width) || width <= 0) return DISPLAY_MAX_WIDTH;
  return Math.min(Math.round(width), DISPLAY_MAX_WIDTH);
}

export function inferredImageContentType(fileName: string | null | undefined, provided?: string | null) {
  const normalized = String(provided || "").trim().toLowerCase();
  if (normalized.startsWith("image/")) return normalized;
  const extension = String(fileName || "").split(".").pop()?.toLowerCase();
  const contentTypes: Record<string, string> = {
    avif: "image/avif",
    bmp: "image/bmp",
    heic: "image/heic",
    heif: "image/heif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    tif: "image/tiff",
    tiff: "image/tiff",
    webp: "image/webp",
  };
  return contentTypes[extension || ""] || "image/jpeg";
}

export function safePhotoFileName(value: string | null | undefined, fallback: string) {
  const sanitized = String(value || fallback)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return sanitized || fallback;
}

export function automaticPhotoLabel({ roomLabel, category }: { roomLabel?: string | null; category: string }) {
  return String(roomLabel || category).trim();
}
