import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

import { sanitizeUadFileName } from "../uad/r2Storage.js";
import {
  MAX_UAD_IMAGE_DIMENSION,
  inspectUadAssetPayload,
} from "../uad/uadFileSecurity.js";
import { normalizeUuid } from "./reportFiles.js";
import { validateSketchRoom } from "./sketches.js";
import { canonicalJson } from "./sync.js";

export const MAX_MOBILE_PHOTOS_PER_INSPECTION = 100;
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
]);
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
]);

const ALLOWED_CONTENT_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);
const DISPLAY_CONTENT_TYPES = new Set(["image/jpeg", "image/webp"]);
const CATEGORY_SOURCES = new Set(["custom_catalog", "uad_catalog", "sketch_room", "manual"]);
const PHOTO_SOURCES = new Set(["camera", "library"]);
const PHOTO_VARIANTS = new Set(["original", "display"]);
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
const MAX_CAPTURE_METADATA_BYTES = 16 * 1024;
const MAX_MOBILE_PHOTO_PIXELS = 60_000_000;
const SHARP_FORMATS_BY_CONTENT_TYPE = new Map([
  ["image/avif", new Set(["heif"])],
  ["image/jpeg", new Set(["jpeg"])],
  ["image/png", new Set(["png"])],
  ["image/tiff", new Set(["tiff"])],
  ["image/webp", new Set(["webp"])],
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function textValue(value, code, { maximum, nullable = false } = {}) {
  if (nullable && value == null) return null;
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function optionalInteger(value, code) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(code);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildVerifiedMobilePhotoObjectKey(objectKey, checksumSha256) {
  return `${objectKey}.verified-${randomUUID()}-${checksumSha256}`;
}

export async function inspectMobilePhotoPayload(bodyValue, contentType) {
  try {
    if (!Buffer.isBuffer(bodyValue)) throw new Error("invalid_mobile_photo_upload");
    const baseline = inspectUadAssetPayload(bodyValue, contentType);
    const acceptedFormats = SHARP_FORMATS_BY_CONTENT_TYPE.get(contentType);
    // The native client always supplies a fully decodable JPEG display object.
    // Preserve the original HEIC/HEIF/BMP evidence after strict container and
    // dimension validation because the deployment's libvips build cannot
    // consistently decode those camera/library formats.
    if (!acceptedFormats) return baseline;
    const decoder = sharp(bodyValue, {
      failOn: "error",
      limitInputPixels: MAX_MOBILE_PHOTO_PIXELS,
      sequentialRead: true,
    });
    try {
      const metadata = await decoder.metadata();
      const width = Number(metadata.width);
      const height = Number(metadata.height);
      if (!acceptedFormats.has(String(metadata.format || ""))
          || !Number.isInteger(width) || !Number.isInteger(height)
          || width < 1 || height < 1
          || width > MAX_UAD_IMAGE_DIMENSION || height > MAX_UAD_IMAGE_DIMENSION
          || width * height > MAX_MOBILE_PHOTO_PIXELS
          || Number(metadata.pages || 1) !== 1) {
        throw new Error("invalid_mobile_photo_upload");
      }
      // Force libvips to consume the complete pixel stream; metadata alone can
      // be present on a truncated or otherwise undecodable image.
      await decoder.stats();
      return Object.freeze({
        ...baseline,
        dimensions: Object.freeze({ width, height, pixels: width * height }),
      });
    } finally {
      decoder.destroy();
    }
  } catch {
    throw new Error("invalid_mobile_photo_upload");
  }
}

function normalizedCapturedAt(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid_mobile_photo_captured_at");
  return date.toISOString();
}

function normalizePhotoObject(input) {
  if (!plainObject(input)) throw new Error("invalid_mobile_photo_object");
  const variant = String(input.variant || "").trim();
  if (!PHOTO_VARIANTS.has(variant)) throw new Error("invalid_mobile_photo_variant");
  const contentType = String(input.content_type || "").trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error("invalid_mobile_photo_content_type");
  if (variant === "display" && !DISPLAY_CONTENT_TYPES.has(contentType)) {
    throw new Error("invalid_mobile_photo_display_content_type");
  }
  const byteSize = Number(input.byte_size);
  if (!Number.isInteger(byteSize) || byteSize <= 0 || byteSize > MAX_PHOTO_BYTES) {
    throw new Error("invalid_mobile_photo_byte_size");
  }
  return Object.freeze({
    clientObjectId: normalizeUuid(input.client_object_id, "invalid_mobile_photo_object_id"),
    variant,
    fileName: textValue(input.file_name, "invalid_mobile_photo_file_name", { maximum: 255 }),
    contentType,
    byteSize,
    width: optionalInteger(input.width, "invalid_mobile_photo_width"),
    height: optionalInteger(input.height, "invalid_mobile_photo_height"),
  });
}

function normalizeCaptureMetadata(value) {
  const metadata = value == null ? {} : value;
  if (!plainObject(metadata)) throw new Error("invalid_mobile_photo_capture_metadata");
  const serialized = canonicalJson(metadata);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CAPTURE_METADATA_BYTES) {
    throw new Error("invalid_mobile_photo_capture_metadata");
  }
  return JSON.parse(serialized);
}

function normalizePhoto(input) {
  if (!plainObject(input)) throw new Error("invalid_mobile_photo");
  const roomRef = input.room_ref == null
    ? null
    : textValue(input.room_ref, "invalid_mobile_photo_room_ref", { maximum: 120 });
  const roomLabel = input.room_label == null
    ? null
    : textValue(input.room_label, "invalid_mobile_photo_room_label", { maximum: 80 });
  const category = textValue(
    input.category || roomLabel,
    "invalid_mobile_photo_category",
    { maximum: 80 },
  );
  const categorySource = String(input.category_source || (roomLabel ? "sketch_room" : "manual"));
  if (!CATEGORY_SOURCES.has(categorySource)) throw new Error("invalid_mobile_photo_category_source");
  if (categorySource === "sketch_room" && (!roomRef || !roomLabel)) {
    throw new Error("invalid_mobile_photo_sketch_room");
  }
  if (categorySource !== "sketch_room" && (roomRef || roomLabel)) {
    throw new Error("invalid_mobile_photo_sketch_room");
  }
  const source = String(input.source || "camera");
  if (!PHOTO_SOURCES.has(source)) throw new Error("invalid_mobile_photo_source");
  const manualCaption = input.caption == null ? "" : String(input.caption).trim();
  if (manualCaption.length > 200) throw new Error("invalid_mobile_photo_caption");
  const objects = Array.isArray(input.objects) ? input.objects.map(normalizePhotoObject) : [];
  const variants = new Set(objects.map((object) => object.variant));
  const objectIds = new Set(objects.map((object) => object.clientObjectId));
  if (objects.length !== variants.size || objects.length !== objectIds.size || !variants.has("original")) {
    throw new Error("invalid_mobile_photo_objects");
  }
  const original = objects.find((object) => object.variant === "original");
  if (original && !variants.has("display")) {
    throw new Error("mobile_photo_display_derivative_required");
  }
  const normalized = {
    clientPhotoId: normalizeUuid(input.client_photo_id, "invalid_mobile_photo_id"),
    category,
    categorySource,
    roomRef,
    roomLabel,
    caption: manualCaption || roomLabel || category,
    captionSource: manualCaption ? "manual" : roomLabel ? "room_auto" : "category",
    source,
    capturedAt: normalizedCapturedAt(input.captured_at),
    captureMetadata: normalizeCaptureMetadata(input.capture_metadata),
    objects,
  };
  return Object.freeze({ ...normalized, requestSha256: sha256(canonicalJson(normalized)) });
}

export function normalizePhotoBatch(input = {}) {
  if (!plainObject(input) || !Array.isArray(input.photos)
      || input.photos.length < 1 || input.photos.length > MAX_MOBILE_PHOTOS_PER_INSPECTION) {
    throw new Error("invalid_mobile_photo_batch");
  }
  const photos = input.photos.map(normalizePhoto);
  if (new Set(photos.map((photo) => photo.clientPhotoId)).size !== photos.length) {
    throw new Error("duplicate_mobile_photo_id");
  }
  return photos;
}

export function buildMobilePhotoObjectKey({ organizationId, reportFileId, photoId, objectId, variant, fileName }) {
  return [
    "organizations",
    organizationId,
    "mobile",
    "report-files",
    reportFileId,
    "photos",
    photoId,
    variant,
    objectId,
    sanitizeUadFileName(fileName),
  ].join("/");
}

export function availableMobilePhotoPositions(positions = []) {
  const occupied = new Set(positions.map((position) => Number(position)));
  return Array.from(
    { length: MAX_MOBILE_PHOTOS_PER_INSPECTION },
    (_unused, index) => index + 1,
  ).filter((position) => !occupied.has(position));
}

function objectResponse(row) {
  return {
    id: row.id,
    client_object_id: row.client_object_id,
    variant: row.variant,
    file_name: row.original_file_name,
    content_type: row.content_type,
    expected_byte_size: Number(row.expected_byte_size),
    byte_size: row.byte_size == null ? null : Number(row.byte_size),
    width: row.pixel_width == null ? null : Number(row.pixel_width),
    height: row.pixel_height == null ? null : Number(row.pixel_height),
    status: row.status,
    uploaded_at: row.uploaded_at || null,
    verified_at: row.verified_at || null,
  };
}

function photoResponse(row, objects = []) {
  return {
    id: row.id,
    inspection_session_id: row.inspection_session_id,
    report_file_id: row.report_file_id,
    client_photo_id: row.client_photo_id,
    workflow_type: row.workflow_type,
    category: row.category,
    category_source: row.category_source,
    room_ref: row.room_ref || null,
    room_label: row.room_label || null,
    caption: row.caption || null,
    caption_source: row.caption_source,
    source: row.source,
    position: Number(row.position),
    captured_at: row.captured_at || null,
    capture_metadata: row.capture_metadata || {},
    status: row.status,
    revision: Number(row.revision),
    retention_starts_at: row.retention_starts_at || null,
    retention_until: row.retention_until || null,
    required_retention_years: Number(row.required_retention_years),
    legal_hold: Boolean(row.legal_hold),
    verified_at: row.verified_at || null,
    excluded_at: row.excluded_at || null,
    objects: objects.map(objectResponse),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function organizationIds(auth) {
  return auth.organizations.map((item) => item.organizationId);
}

async function lockSession(client, auth, sessionId, { allowCompleted = false } = {}) {
  const { rows } = await client.query(
    `SELECT session.*, report_file.workflow_type, report_file.id AS bound_report_file_id
       FROM app.inspection_sessions session
       JOIN app.report_files report_file ON report_file.id = session.report_file_id
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3
      FOR UPDATE OF session`,
    [sessionId, organizationIds(auth), auth.userId],
  );
  if (!rows.length) throw new Error("inspection_session_not_found");
  if (!allowCompleted && rows[0].status === "completed") {
    throw new Error("inspection_session_completed_conflict");
  }
  return rows[0];
}

async function objectRows(client, photoId) {
  const { rows } = await client.query(
    `SELECT * FROM app.inspection_photo_objects
      WHERE photo_id = $1
      ORDER BY CASE variant WHEN 'original' THEN 0 ELSE 1 END, id`,
    [photoId],
  );
  return rows;
}

function ensureStorage(storage) {
  if (!storage?.configured || !storage.bucket) throw new Error("mobile_photo_storage_not_configured");
}

function uploadForObject(storage, row) {
  const upload = storage.createUploadUrl({ objectKey: row.object_key, contentType: row.content_type });
  return {
    object_id: row.id,
    variant: row.variant,
    method: upload.method,
    url: upload.url,
    headers: upload.headers,
    expires_in_seconds: upload.expires_in_seconds,
  };
}

export async function createPhotoUploadBatch(pool, storage, auth, sessionIdValue, input = {}) {
  ensureStorage(storage);
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const normalizedPhotos = normalizePhotoBatch(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await lockSession(client, auth, sessionId);
    const existingResult = await client.query(
      `SELECT * FROM app.inspection_photos
        WHERE inspection_session_id = $1 AND client_photo_id = ANY($2::uuid[])
        FOR UPDATE`,
      [sessionId, normalizedPhotos.map((photo) => photo.clientPhotoId)],
    );
    const existingByClientId = new Map(existingResult.rows.map((row) => [row.client_photo_id, row]));
    for (const photo of normalizedPhotos) {
      const existing = existingByClientId.get(photo.clientPhotoId);
      if (existing && existing.request_sha256 !== photo.requestSha256) {
        throw new Error("mobile_photo_id_conflict");
      }
    }
    const activeCountResult = await client.query(
      `SELECT count(*)::integer AS count,
              COALESCE(array_agg(position ORDER BY position), ARRAY[]::integer[]) AS positions
         FROM app.inspection_photos
        WHERE inspection_session_id = $1 AND status NOT IN ('excluded', 'deleted')`,
      [sessionId],
    );
    const newCount = normalizedPhotos.filter((photo) => !existingByClientId.has(photo.clientPhotoId)).length;
    const activeCount = Number(activeCountResult.rows[0].count);
    if (activeCount + newCount > MAX_MOBILE_PHOTOS_PER_INSPECTION) {
      throw new Error("mobile_photo_limit_conflict");
    }
    const availablePositions = availableMobilePhotoPositions(activeCountResult.rows[0].positions || []);
    const results = [];
    for (const normalized of normalizedPhotos) {
      const verifiedRoom = normalized.categorySource === "sketch_room"
        ? await validateSketchRoom(client, sessionId, normalized.roomRef, normalized.roomLabel)
        : null;
      const effective = verifiedRoom ? {
        ...normalized,
        category: verifiedRoom.roomLabel,
        roomRef: verifiedRoom.roomRef,
        roomLabel: verifiedRoom.roomLabel,
        caption: normalized.captionSource === "room_auto" ? verifiedRoom.roomLabel : normalized.caption,
      } : normalized;
      let photoRow = existingByClientId.get(normalized.clientPhotoId);
      if (!photoRow) {
        const photoId = randomUUID();
        const position = availablePositions.shift();
        if (!position) throw new Error("mobile_photo_limit_conflict");
        const inserted = await client.query(
          `INSERT INTO app.inspection_photos (
             id, inspection_session_id, report_file_id, organization_id,
             captured_by_user_id, client_photo_id, request_sha256, workflow_type,
             category, category_source, room_ref, room_label, caption, caption_source,
             source, position, captured_at, capture_metadata
           ) VALUES (
             $1, $2, $3, $4,
             $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14,
             $15, $16, $17, $18::jsonb
           ) RETURNING *`,
          [
            photoId,
            sessionId,
            session.bound_report_file_id,
            session.organization_id,
            auth.userId,
            normalized.clientPhotoId,
            normalized.requestSha256,
            session.workflow_type,
            effective.category,
            effective.categorySource,
            effective.roomRef,
            effective.roomLabel,
            effective.caption,
            effective.captionSource,
            effective.source,
            position,
            effective.capturedAt,
            JSON.stringify(effective.captureMetadata),
          ],
        );
        photoRow = inserted.rows[0];
        for (const object of effective.objects) {
          const objectId = randomUUID();
          const objectKey = buildMobilePhotoObjectKey({
            organizationId: session.organization_id,
            reportFileId: session.bound_report_file_id,
            photoId,
            objectId,
            variant: object.variant,
            fileName: object.fileName,
          });
          await client.query(
            `INSERT INTO app.inspection_photo_objects (
               id, photo_id, client_object_id, variant, storage_provider, storage_bucket,
               object_key, original_file_name, content_type, expected_byte_size,
               pixel_width, pixel_height
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              objectId,
              photoId,
              object.clientObjectId,
              object.variant,
              storage.provider,
              storage.bucket,
              objectKey,
              object.fileName,
              object.contentType,
              object.byteSize,
              object.width,
              object.height,
            ],
          );
        }
        await client.query(
          `INSERT INTO app.inspection_photo_events (
             photo_id, inspection_session_id, actor_user_id, event_type, next_revision, metadata
           ) VALUES ($1, $2, $3, 'photo.created', 1, $4::jsonb)`,
          [photoId, sessionId, auth.userId, JSON.stringify({
            client_photo_id: effective.clientPhotoId,
            category: effective.category,
            room_ref: effective.roomRef,
            object_count: effective.objects.length,
          })],
        );
      }
      const objects = await objectRows(client, photoRow.id);
      const uploads = [];
      for (const object of objects) {
        if (object.status === "verified") continue;
        const upload = uploadForObject(storage, object);
        uploads.push(upload);
        await client.query(
          `UPDATE app.inspection_photo_objects
              SET status = 'pending_upload',
                  upload_expires_at = now() + ($2::integer * interval '1 second'),
                  updated_at = now()
            WHERE id = $1`,
          [object.id, upload.expires_in_seconds],
        );
      }
      results.push({ photo: photoResponse(photoRow, objects), uploads });
    }
    await client.query(
      `UPDATE app.inspection_sessions
          SET status = CASE WHEN status = 'review_required' THEN status ELSE 'sync_pending' END,
              started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = $1`,
      [sessionId],
    );
    await client.query("COMMIT");
    return Object.freeze({ photos: results });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function accessiblePhoto(pool, auth, sessionId, photoId) {
  const { rows } = await pool.query(
    `SELECT photo.*
       FROM app.inspection_photos photo
       JOIN app.inspection_sessions session ON session.id = photo.inspection_session_id
      WHERE photo.id = $1 AND photo.inspection_session_id = $2
        AND session.organization_id = ANY($3::uuid[])
        AND session.appraiser_user_id = $4`,
    [photoId, sessionId, organizationIds(auth), auth.userId],
  );
  if (!rows.length) throw new Error("mobile_photo_not_found");
  return rows[0];
}

async function recordVerificationFailure(pool, auth, photo, reason, inspected = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT * FROM app.inspection_photos WHERE id = $1 FOR UPDATE",
      [photo.id],
    );
    if (!locked.rows.length) throw new Error("mobile_photo_not_found");
    const priorRevision = Number(locked.rows[0].revision);
    for (const object of inspected) {
      await client.query(
        `UPDATE app.inspection_photo_objects
            SET status = 'rejected', byte_size = $2, storage_etag = $3, updated_at = now()
          WHERE id = $1`,
        [object.id, object.byteSize || null, object.etag || null],
      );
    }
    await client.query(
      `UPDATE app.inspection_photos
          SET status = 'failed', revision = revision + 1, updated_at = now()
        WHERE id = $1`,
      [photo.id],
    );
    await client.query(
      `INSERT INTO app.inspection_photo_events (
         photo_id, inspection_session_id, actor_user_id, event_type,
         prior_revision, next_revision, metadata
       ) VALUES ($1, $2, $3, 'photo.verification_failed', $4, $5, $6::jsonb)`,
      [photo.id, photo.inspection_session_id, auth.userId, priorRevision, priorRevision + 1, JSON.stringify({ reason })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyInspectionPhoto(pool, storage, auth, sessionIdValue, photoIdValue) {
  ensureStorage(storage);
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const photoId = normalizeUuid(photoIdValue, "invalid_mobile_photo_id");
  const photo = await accessiblePhoto(pool, auth, sessionId, photoId);
  const objects = await objectRows(pool, photoId);
  if (photo.status === "verified" || photo.status === "excluded") return photoResponse(photo, objects);
  if (photo.status === "deleted" || !objects.length) throw new Error("mobile_photo_not_found");

  await pool.query(
    "UPDATE app.inspection_photos SET status = 'verifying', updated_at = now() WHERE id = $1",
    [photoId],
  );
  const inspected = [];
  try {
    for (const object of objects) {
      const result = await storage.inspectObject({ objectKey: object.object_key });
      const inspectedType = String(result.content_type || "").split(";", 1)[0].trim().toLowerCase();
      const advertisedByteSize = Number(result.byte_size || 0);
      if (advertisedByteSize !== Number(object.expected_byte_size)
          || advertisedByteSize <= 0 || advertisedByteSize > MAX_PHOTO_BYTES
          || (inspectedType && inspectedType !== object.content_type)) {
        throw new Error("invalid_mobile_photo_upload");
      }
      const downloaded = await storage.getObject({
        objectKey: object.object_key,
        maxBytes: MAX_PHOTO_BYTES,
      });
      const downloadedType = String(downloaded.content_type || "").split(";", 1)[0].trim().toLowerCase();
      if (!Buffer.isBuffer(downloaded.body)
          || Number(downloaded.byte_size) !== advertisedByteSize
          || Number(downloaded.byte_size) !== Number(object.expected_byte_size)
          || (downloadedType && downloadedType !== object.content_type)) {
        throw new Error("invalid_mobile_photo_upload");
      }
      const verified = await inspectMobilePhotoPayload(downloaded.body, object.content_type);
      if (object.checksum_sha256 && object.checksum_sha256 !== verified.checksum_sha256) {
        throw new Error("invalid_mobile_photo_upload");
      }
      const verifiedObjectKey = buildVerifiedMobilePhotoObjectKey(
        object.object_key,
        verified.checksum_sha256,
      );
      let copied;
      try {
        copied = await storage.putObject({
          objectKey: verifiedObjectKey,
          contentType: object.content_type,
          body: downloaded.body,
        });
      } catch (error) {
        await storage.deleteObject?.({ objectKey: verifiedObjectKey }).catch(() => undefined);
        throw error;
      }
      if (Number(copied?.byte_size) !== verified.byte_size) {
        await storage.deleteObject?.({ objectKey: verifiedObjectKey }).catch(() => undefined);
        throw new Error("invalid_mobile_photo_upload");
      }
      inspected.push({
        id: object.id,
        byteSize: verified.byte_size,
        etag: copied.etag || result.etag || null,
        checksumSha256: verified.checksum_sha256,
        dimensions: verified.dimensions,
        sourceObjectKey: object.object_key,
        verifiedObjectKey,
      });
    }
  } catch (error) {
    await Promise.all(inspected.map((item) => storage.deleteObject?.({
      objectKey: item.verifiedObjectKey,
    }).catch(() => undefined)));
    const invalidUpload = String(error?.message || "") === "invalid_mobile_photo_upload";
    if (invalidUpload) {
      await Promise.all(objects.map((object) => storage.deleteObject?.({
        objectKey: object.object_key,
      }).catch(() => undefined)));
    }
    await recordVerificationFailure(
      pool,
      auth,
      photo,
      invalidUpload ? "uploaded_object_does_not_match_request" : "object_storage_verification_failed",
      inspected,
    );
    if (invalidUpload) throw error;
    if (String(error?.message || "").endsWith(":404")) throw new Error("mobile_photo_upload_not_found");
    throw new Error("mobile_photo_verification_failed");
  }

  const client = await pool.connect();
  let verificationCommitted = false;
  let verifiedPhoto = null;
  try {
    await client.query("BEGIN");
    await lockSession(client, auth, sessionId);
    const locked = await client.query(
      "SELECT * FROM app.inspection_photos WHERE id = $1 AND inspection_session_id = $2 FOR UPDATE",
      [photoId, sessionId],
    );
    if (!locked.rows.length) throw new Error("mobile_photo_not_found");
    if (locked.rows[0].status === "verified" || locked.rows[0].status === "excluded") {
      const currentObjects = await objectRows(client, photoId);
      await client.query("COMMIT");
      return photoResponse(locked.rows[0], currentObjects);
    }
    for (const object of inspected) {
      await client.query(
        `UPDATE app.inspection_photo_objects
            SET status = 'verified', byte_size = $2, storage_etag = $3,
                checksum_sha256 = $4, object_key = $5, upload_expires_at = NULL,
                pixel_width = COALESCE($6, pixel_width),
                pixel_height = COALESCE($7, pixel_height),
                uploaded_at = COALESCE(uploaded_at, now()), verified_at = now(), updated_at = now()
          WHERE id = $1`,
        [
          object.id,
          object.byteSize,
          object.etag,
          object.checksumSha256,
          object.verifiedObjectKey,
          object.dimensions?.width || null,
          object.dimensions?.height || null,
        ],
      );
    }
    const priorRevision = Number(locked.rows[0].revision);
    const updated = await client.query(
      `UPDATE app.inspection_photos
          SET status = 'verified', revision = revision + 1,
              verified_at = now(), retention_starts_at = now(),
              retention_until = now() + interval '5 years', updated_at = now()
        WHERE id = $1 RETURNING *`,
      [photoId],
    );
    await client.query(
      `INSERT INTO app.inspection_photo_events (
         photo_id, inspection_session_id, actor_user_id, event_type,
         prior_revision, next_revision, metadata
       ) VALUES ($1, $2, $3, 'photo.verified', $4, $5, $6::jsonb)`,
      [photoId, sessionId, auth.userId, priorRevision, priorRevision + 1, JSON.stringify({
        object_count: inspected.length,
        retention_years: 5,
        checksum_bound: true,
        immutable_object_keys: true,
        display_derivative_required: true,
      })],
    );
    await client.query(
      `UPDATE app.inspection_sessions
          SET status = CASE WHEN status = 'review_required' THEN status ELSE 'synchronized' END,
              last_synced_at = now(), updated_at = now()
        WHERE id = $1`,
      [sessionId],
    );
    const currentObjects = await objectRows(client, photoId);
    await client.query("COMMIT");
    verificationCommitted = true;
    verifiedPhoto = photoResponse(updated.rows[0], currentObjects);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    if (!verificationCommitted) {
      await Promise.all(inspected.map((item) => storage.deleteObject?.({
        objectKey: item.verifiedObjectKey,
      }).catch(() => undefined)));
    }
  }
  await Promise.all(inspected.map((item) => storage.deleteObject?.({
    objectKey: item.sourceObjectKey,
  }).catch(() => undefined)));
  return verifiedPhoto;
}

function normalizeMetadataOperation(input, { removal = false } = {}) {
  if (!plainObject(input)) throw new Error("invalid_mobile_photo_operation");
  const operation = {
    clientOperationId: normalizeUuid(input.client_operation_id, "invalid_client_operation_id"),
    baseRevision: Number(input.base_revision),
  };
  if (!Number.isInteger(operation.baseRevision) || operation.baseRevision < 1) {
    throw new Error("invalid_mobile_photo_revision");
  }
  if (removal) {
    const payload = { client_operation_id: operation.clientOperationId, base_revision: operation.baseRevision };
    return { ...operation, requestSha256: sha256(canonicalJson(payload)) };
  }
  const allowed = ["category", "category_source", "room_ref", "room_label", "caption", "position"];
  const changes = {};
  for (const key of allowed) {
    if (Object.hasOwn(input, key)) changes[key] = input[key];
  }
  if (!Object.keys(changes).length) throw new Error("invalid_mobile_photo_update");
  if (Object.hasOwn(changes, "category")) {
    changes.category = textValue(changes.category, "invalid_mobile_photo_category", { maximum: 80 });
  }
  if (Object.hasOwn(changes, "category_source") && !CATEGORY_SOURCES.has(String(changes.category_source))) {
    throw new Error("invalid_mobile_photo_category_source");
  }
  for (const key of ["room_ref", "room_label"]) {
    if (!Object.hasOwn(changes, key)) continue;
    const maximum = key === "room_ref" ? 120 : 80;
    changes[key] = changes[key] == null || String(changes[key]).trim() === ""
      ? null
      : textValue(changes[key], `invalid_mobile_photo_${key}`, { maximum });
  }
  if (Object.hasOwn(changes, "caption")) {
    changes.caption = changes.caption == null ? "" : String(changes.caption).trim();
    if (changes.caption.length > 200) throw new Error("invalid_mobile_photo_caption");
  }
  if (Object.hasOwn(changes, "position")) {
    changes.position = Number(changes.position);
    if (!Number.isInteger(changes.position) || changes.position < 1 || changes.position > 100) {
      throw new Error("invalid_mobile_photo_position");
    }
  }
  const payload = {
    client_operation_id: operation.clientOperationId,
    base_revision: operation.baseRevision,
    changes,
  };
  return { ...operation, changes, requestSha256: sha256(canonicalJson(payload)) };
}

async function existingPhotoOperation(client, photoId, operation) {
  const { rows } = await client.query(
    `SELECT request_sha256 FROM app.inspection_photo_events
      WHERE photo_id = $1 AND client_operation_id = $2`,
    [photoId, operation.clientOperationId],
  );
  if (!rows.length) return false;
  if (rows[0].request_sha256 !== operation.requestSha256) throw new Error("client_operation_id_conflict");
  return true;
}

async function lockedAccessiblePhoto(client, auth, sessionId, photoId, { includeDeleted = false } = {}) {
  const { rows } = await client.query(
    `SELECT photo.*
       FROM app.inspection_photos photo
       JOIN app.inspection_sessions session ON session.id = photo.inspection_session_id
      WHERE photo.id = $1 AND photo.inspection_session_id = $2
        AND session.organization_id = ANY($3::uuid[])
        AND session.appraiser_user_id = $4
      FOR UPDATE OF photo`,
    [photoId, sessionId, organizationIds(auth), auth.userId],
  );
  if (!rows.length || (!includeDeleted && rows[0].status === "deleted")) {
    throw new Error("mobile_photo_not_found");
  }
  return rows[0];
}

export async function updateInspectionPhoto(pool, auth, sessionIdValue, photoIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const photoId = normalizeUuid(photoIdValue, "invalid_mobile_photo_id");
  const operation = normalizeMetadataOperation(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, auth, sessionId);
    const photo = await lockedAccessiblePhoto(client, auth, sessionId, photoId);
    if (await existingPhotoOperation(client, photoId, operation)) {
      const objects = await objectRows(client, photoId);
      await client.query("COMMIT");
      return photoResponse(photo, objects);
    }
    if (Number(photo.revision) !== operation.baseRevision) throw new Error("mobile_photo_revision_conflict");
    const next = {
      category: Object.hasOwn(operation.changes, "category") ? operation.changes.category : photo.category,
      categorySource: Object.hasOwn(operation.changes, "category_source")
        ? String(operation.changes.category_source) : photo.category_source,
      roomRef: Object.hasOwn(operation.changes, "room_ref") ? operation.changes.room_ref : photo.room_ref,
      roomLabel: Object.hasOwn(operation.changes, "room_label") ? operation.changes.room_label : photo.room_label,
      position: Object.hasOwn(operation.changes, "position") ? operation.changes.position : Number(photo.position),
    };
    const changesRoomLink = ["category_source", "room_ref", "room_label"]
      .some((key) => Object.hasOwn(operation.changes, key));
    if (changesRoomLink && next.categorySource === "sketch_room") {
      const verifiedRoom = await validateSketchRoom(client, sessionId, next.roomRef, next.roomLabel);
      next.category = verifiedRoom.roomLabel;
      next.roomRef = verifiedRoom.roomRef;
      next.roomLabel = verifiedRoom.roomLabel;
    } else if (changesRoomLink && next.categorySource !== "sketch_room") {
      next.roomRef = null;
      next.roomLabel = null;
    }
    const manualCaption = Object.hasOwn(operation.changes, "caption") ? operation.changes.caption : null;
    const caption = manualCaption !== null
      ? (manualCaption || next.roomLabel || next.category)
      : photo.caption;
    const captionSource = manualCaption !== null
      ? (manualCaption ? "manual" : next.roomLabel ? "room_auto" : "category")
      : photo.caption_source;
    const updated = await client.query(
      `UPDATE app.inspection_photos
          SET category = $2, category_source = $3, room_ref = $4, room_label = $5,
              caption = $6, caption_source = $7, position = $8,
              revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [photoId, next.category, next.categorySource, next.roomRef, next.roomLabel,
        caption, captionSource, next.position],
    );
    await client.query(
      `INSERT INTO app.inspection_photo_events (
         photo_id, inspection_session_id, actor_user_id, client_operation_id,
         request_sha256, event_type, prior_revision, next_revision, metadata
       ) VALUES ($1, $2, $3, $4, $5, 'photo.metadata_updated', $6, $7, $8::jsonb)`,
      [photoId, sessionId, auth.userId, operation.clientOperationId, operation.requestSha256,
        operation.baseRevision, operation.baseRevision + 1,
        JSON.stringify({ changed_fields: Object.keys(operation.changes) })],
    );
    const objects = await objectRows(client, photoId);
    await client.query("COMMIT");
    return photoResponse(updated.rows[0], objects);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function removeInspectionPhoto(pool, auth, sessionIdValue, photoIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const photoId = normalizeUuid(photoIdValue, "invalid_mobile_photo_id");
  const operation = normalizeMetadataOperation(input, { removal: true });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockSession(client, auth, sessionId);
    const photo = await lockedAccessiblePhoto(client, auth, sessionId, photoId, { includeDeleted: true });
    if (await existingPhotoOperation(client, photoId, operation)) {
      const objects = await objectRows(client, photoId);
      await client.query("COMMIT");
      return {
        photo: photoResponse(photo, objects),
        disposition: photo.status === "excluded" ? "excluded_retained" : "placeholder_deleted",
      };
    }
    if (photo.status === "deleted") throw new Error("mobile_photo_not_found");
    if (Number(photo.revision) !== operation.baseRevision) throw new Error("mobile_photo_revision_conflict");
    const retain = photo.verified_at != null || photo.status === "verified" || photo.status === "excluded";
    const status = retain ? "excluded" : "deleted";
    const eventType = retain ? "photo.excluded" : "photo.placeholder_deleted";
    const updated = await client.query(
      `UPDATE app.inspection_photos
          SET status = $2, revision = revision + 1,
              excluded_at = CASE WHEN $2 = 'excluded' THEN COALESCE(excluded_at, now()) ELSE excluded_at END,
              deleted_at = CASE WHEN $2 = 'deleted' THEN COALESCE(deleted_at, now()) ELSE deleted_at END,
              updated_at = now()
        WHERE id = $1 RETURNING *`,
      [photoId, status],
    );
    await client.query(
      `INSERT INTO app.inspection_photo_events (
         photo_id, inspection_session_id, actor_user_id, client_operation_id,
         request_sha256, event_type, prior_revision, next_revision, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [photoId, sessionId, auth.userId, operation.clientOperationId, operation.requestSha256,
        eventType, operation.baseRevision, operation.baseRevision + 1,
        JSON.stringify({ retained_as_evidence: retain, retention_until: photo.retention_until || null })],
    );
    const objects = await objectRows(client, photoId);
    await client.query("COMMIT");
    return {
      photo: photoResponse(updated.rows[0], objects),
      disposition: retain ? "excluded_retained" : "placeholder_deleted",
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listInspectionPhotos(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const session = await pool.query(
    `SELECT id FROM app.inspection_sessions
      WHERE id = $1 AND organization_id = ANY($2::uuid[]) AND appraiser_user_id = $3`,
    [sessionId, organizationIds(auth), auth.userId],
  );
  if (!session.rows.length) throw new Error("inspection_session_not_found");
  const { rows } = await pool.query(
    `SELECT * FROM app.inspection_photos
      WHERE inspection_session_id = $1 AND status <> 'deleted'
      ORDER BY position, created_at, id`,
    [sessionId],
  );
  const photos = [];
  for (const row of rows) photos.push(photoResponse(row, await objectRows(pool, row.id)));
  return Object.freeze({ photos });
}
