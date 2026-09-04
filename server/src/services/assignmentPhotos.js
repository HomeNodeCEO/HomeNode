import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";

import { sanitizeUadFileName } from "../modules/uad/r2Storage.js";
import {
  MAX_UAD_IMAGE_DIMENSION,
  inspectUadAssetPayload,
} from "../modules/uad/uadFileSecurity.js";
import { normalizeUuid } from "../modules/mobile/reportFiles.js";
import { canonicalJson } from "../modules/mobile/sync.js";
import { getReportEvidenceVersion } from "./reportEvidenceVersion.js";

export const ASSIGNMENT_PHOTO_CATEGORIES = Object.freeze([
  "Front", "Rear", "Street", "Kitchen", "Living area", "Bedroom",
  "Bathroom", "Garage", "Attic", "Mechanical systems", "Site/view",
  "Defect", "Repair item", "Additional improvement", "Other",
]);

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp",
]);
const DISPLAY_CONTENT_TYPES = new Set(["image/jpeg", "image/webp"]);
const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
const MAX_PHOTOS_PER_FILE = 100;
const MAX_ASSIGNMENT_PHOTO_PIXELS = 60_000_000;
const SHARP_FORMATS_BY_CONTENT_TYPE = new Map([
  ["image/jpeg", new Set(["jpeg"])],
  ["image/png", new Set(["png"])],
  ["image/webp", new Set(["webp"])],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function inspectAssignmentPhotoPayload(bodyValue, contentType) {
  let baseline;
  try {
    if (!Buffer.isBuffer(bodyValue)) throw new Error("invalid_assignment_photo_upload");
    const body = bodyValue;
    baseline = inspectUadAssetPayload(body, contentType);
    const acceptedFormats = SHARP_FORMATS_BY_CONTENT_TYPE.get(contentType);
    if (!acceptedFormats) throw new Error("invalid_assignment_photo_upload");
    const decoder = sharp(body, {
      failOn: "error",
      limitInputPixels: MAX_ASSIGNMENT_PHOTO_PIXELS,
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
          || width * height > MAX_ASSIGNMENT_PHOTO_PIXELS
          || Number(metadata.pages || 1) !== 1) {
        throw new Error("invalid_assignment_photo_upload");
      }
      // Metadata parsing alone does not prove the pixel stream is decodable.
      // Computing channel statistics forces libvips to decode the complete image.
      await decoder.stats();
      return Object.freeze({
        ...baseline,
        dimensions: Object.freeze({ width, height, pixels: width * height }),
      });
    } finally {
      decoder.destroy();
    }
  } catch {
    throw new Error("invalid_assignment_photo_upload");
  }
}

function buildVerifiedAssignmentPhotoObjectKey(objectKey, checksumSha256) {
  return `${objectKey}.verified-${randomUUID()}-${checksumSha256}`;
}

function boundedText(value, code, maximum, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function normalizeObject(input) {
  const variant = String(input?.variant || "").trim();
  if (!new Set(["original", "display"]).has(variant)) throw new Error("invalid_assignment_photo_variant");
  const contentType = String(input?.content_type || "").trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error("invalid_assignment_photo_content_type");
  if (variant === "display" && !DISPLAY_CONTENT_TYPES.has(contentType)) {
    throw new Error("invalid_assignment_photo_display_content_type");
  }
  const byteSize = Number(input?.byte_size);
  if (!Number.isInteger(byteSize) || byteSize < 1 || byteSize > MAX_PHOTO_BYTES) {
    throw new Error("invalid_assignment_photo_byte_size");
  }
  const width = input.width == null ? null : Number(input.width);
  const height = input.height == null ? null : Number(input.height);
  if (width != null && (!Number.isInteger(width) || width < 1)) throw new Error("invalid_assignment_photo_width");
  if (height != null && (!Number.isInteger(height) || height < 1)) throw new Error("invalid_assignment_photo_height");
  return Object.freeze({
    clientObjectId: normalizeUuid(input.client_object_id, "invalid_assignment_photo_object_id"),
    variant,
    fileName: boundedText(input.file_name, "invalid_assignment_photo_file_name", 255),
    contentType,
    byteSize,
    width,
    height,
  });
}

export function normalizeAssignmentPhotoUpload(input = {}) {
  const clientPhotoId = normalizeUuid(input.client_photo_id, "invalid_assignment_photo_id");
  const category = boundedText(input.category, "invalid_assignment_photo_category", 80);
  const caption = input.caption == null || String(input.caption).trim() === ""
    ? category
    : boundedText(input.caption, "invalid_assignment_photo_caption", 200);
  const objects = Array.isArray(input.objects) ? input.objects.map(normalizeObject) : [];
  const variants = new Set(objects.map((item) => item.variant));
  const objectIds = new Set(objects.map((item) => item.clientObjectId));
  if (!variants.has("original") || variants.size !== objects.length || objectIds.size !== objects.length) {
    throw new Error("invalid_assignment_photo_objects");
  }
  const capturedAt = input.captured_at == null ? null : new Date(input.captured_at);
  if (capturedAt && Number.isNaN(capturedAt.getTime())) throw new Error("invalid_assignment_photo_captured_at");
  const normalized = {
    clientPhotoId,
    category,
    caption,
    capturedAt: capturedAt?.toISOString() || null,
    objects,
  };
  return Object.freeze({ ...normalized, requestSha256: sha256(canonicalJson(normalized)) });
}

export function normalizeAssignmentPhotoMetadata(input = {}) {
  const baseRevision = Number(input.base_revision);
  if (!Number.isInteger(baseRevision) || baseRevision < 1) {
    throw new Error("invalid_assignment_photo_revision");
  }
  const category = boundedText(input.category, "invalid_assignment_photo_category", 80);
  const caption = input.caption == null || String(input.caption).trim() === ""
    ? category
    : boundedText(input.caption, "invalid_assignment_photo_caption", 200);
  return Object.freeze({ baseRevision, category, caption });
}

export function buildAssignmentPhotoObjectKey({ organizationId, reportFileId, photoId, objectId, variant, fileName }) {
  return [
    "organizations", organizationId || "unassigned", "report-files", reportFileId,
    "photos", photoId, variant, objectId, sanitizeUadFileName(fileName),
  ].join("/");
}

function ensureStorage(storage) {
  if (!storage?.configured || !storage.bucket) throw new Error("assignment_photo_storage_not_configured");
}

async function assignmentReport(client, accountId, assignmentFileId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT report_file.*, workfile.status AS workfile_status
       FROM app.assignment_files assignment_file
       JOIN app.report_files report_file ON report_file.custom_assignment_file_id = assignment_file.id
       JOIN app.custom_appraisal_workfiles workfile ON workfile.assignment_file_id = assignment_file.id
      WHERE assignment_file.id = $1 AND assignment_file.account_id = $2
      ${lock ? "FOR UPDATE OF report_file, workfile" : ""}`,
    [assignmentFileId, accountId],
  );
  if (!rows.length) throw new Error("assignment_photo_file_not_found");
  return rows[0];
}

async function photoObjects(client, photoId) {
  const { rows } = await client.query(
    `SELECT * FROM app.inspection_photo_objects
      WHERE photo_id = $1
      ORDER BY CASE variant WHEN 'display' THEN 0 ELSE 1 END, id`,
    [photoId],
  );
  return rows;
}

function photoPayload(storage, row, objects) {
  const viewObject = objects.find((item) => item.variant === "display" && item.status === "verified")
    || objects.find((item) => item.variant === "original" && item.status === "verified");
  const view = viewObject && storage?.configured
    ? storage.createDownloadUrl({ objectKey: viewObject.object_key, expiresInSeconds: 300 })
    : null;
  return {
    id: row.id,
    client_photo_id: row.client_photo_id,
    origin_channel: row.origin_channel || "mobile",
    category: row.category,
    room_ref: row.room_ref || null,
    room_label: row.room_label || null,
    caption: row.caption || null,
    position: Number(row.position),
    captured_at: row.captured_at || null,
    status: row.status,
    revision: Number(row.revision),
    verified_at: row.verified_at || null,
    retention_until: row.retention_until || null,
    required_retention_years: Number(row.required_retention_years || 5),
    view_url: view?.url || null,
    view_url_expires_in_seconds: view?.expires_in_seconds || null,
    objects: objects.map((item) => ({
      id: item.id,
      variant: item.variant,
      file_name: item.original_file_name,
      content_type: item.content_type,
      byte_size: item.byte_size == null ? Number(item.expected_byte_size) : Number(item.byte_size),
      width: item.pixel_width == null ? null : Number(item.pixel_width),
      height: item.pixel_height == null ? null : Number(item.pixel_height),
      status: item.status,
    })),
  };
}

export function buildAssignmentPhotoVersion(rows = []) {
  const photos = rows.map((row) => ({
    id: String(row.id || ""),
    position: Number(row.position || 0),
    revision: Number(row.revision || 0),
    status: String(row.status || ""),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
  }));
  return `v1:${photos.length}:${sha256(canonicalJson(photos)).slice(0, 24)}`;
}

function uploadPayload(storage, object) {
  const upload = storage.createUploadUrl({ objectKey: object.object_key, contentType: object.content_type });
  return {
    object_id: object.id,
    variant: object.variant,
    method: upload.method,
    url: upload.url,
    headers: upload.headers,
    expires_in_seconds: upload.expires_in_seconds,
  };
}

export async function listAssignmentPhotos(pool, storage, { accountId, assignmentFileId }) {
  const client = await pool.connect();
  try {
    const report = await assignmentReport(client, accountId, assignmentFileId);
    // Read the token first. If evidence changes while the full payload is assembled,
    // the next lightweight check observes a newer token and reloads safely.
    const evidenceVersion = await getReportEvidenceVersion(client, report.id);
    const { rows } = await client.query(
      `SELECT * FROM app.inspection_photos
        WHERE report_file_id = $1 AND status NOT IN ('excluded', 'deleted')
        ORDER BY position, created_at, id`,
      [report.id],
    );
    const objectsByPhoto = new Map();
    if (rows.length) {
      const objectResult = await client.query(
        `SELECT * FROM app.inspection_photo_objects
          WHERE photo_id = ANY($1::uuid[])
          ORDER BY photo_id, CASE variant WHEN 'display' THEN 0 ELSE 1 END, id`,
        [rows.map((row) => row.id)],
      );
      for (const object of objectResult.rows) {
        const objects = objectsByPhoto.get(object.photo_id) || [];
        objects.push(object);
        objectsByPhoto.set(object.photo_id, objects);
      }
    }
    const photos = rows.map((row) => photoPayload(
      storage,
      row,
      objectsByPhoto.get(row.id) || [],
    ));
    return {
      report_file_id: report.id,
      workfile_status: report.workfile_status,
      version: buildAssignmentPhotoVersion(rows),
      ...evidenceVersion,
      photos,
    };
  } finally {
    client.release();
  }
}

export async function getAssignmentPhotoVersion(pool, { accountId, assignmentFileId }) {
  const client = await pool.connect();
  try {
    const report = await assignmentReport(client, accountId, assignmentFileId);
    const { rows } = await client.query(
      `SELECT id, position, revision, status, updated_at
         FROM app.inspection_photos
        WHERE report_file_id = $1 AND status NOT IN ('excluded', 'deleted')
        ORDER BY position, created_at, id`,
      [report.id],
    );
    return {
      report_file_id: report.id,
      workfile_status: report.workfile_status,
      version: buildAssignmentPhotoVersion(rows),
      photo_count: rows.length,
    };
  } finally {
    client.release();
  }
}

export async function getAssignmentEvidenceVersion(pool, { accountId, assignmentFileId }) {
  const client = await pool.connect();
  try {
    const report = await assignmentReport(client, accountId, assignmentFileId);
    return {
      report_file_id: report.id,
      workfile_status: report.workfile_status,
      ...await getReportEvidenceVersion(client, report.id),
    };
  } finally {
    client.release();
  }
}

export async function createAssignmentPhotoUpload(pool, storage, { accountId, assignmentFileId, input }) {
  ensureStorage(storage);
  const normalized = normalizeAssignmentPhotoUpload(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await assignmentReport(client, accountId, assignmentFileId, { lock: true });
    if (report.workfile_status === "signed") throw new Error("custom_appraisal_workfile_signed");
    const existing = await client.query(
      `SELECT * FROM app.inspection_photos
        WHERE report_file_id = $1 AND client_photo_id = $2 FOR UPDATE`,
      [report.id, normalized.clientPhotoId],
    );
    let photo = existing.rows[0] || null;
    if (photo && photo.request_sha256 !== normalized.requestSha256) {
      throw new Error("assignment_photo_id_conflict");
    }
    if (!photo) {
      const count = await client.query(
        `SELECT count(*)::integer AS count,
                COALESCE(array_agg(position), ARRAY[]::integer[]) AS positions
           FROM app.inspection_photos
          WHERE report_file_id = $1 AND status NOT IN ('excluded', 'deleted')`,
        [report.id],
      );
      if (Number(count.rows[0].count) >= MAX_PHOTOS_PER_FILE) throw new Error("assignment_photo_limit_conflict");
      const occupied = new Set((count.rows[0].positions || []).map(Number));
      const position = Array.from({ length: MAX_PHOTOS_PER_FILE }, (_value, index) => index + 1)
        .find((value) => !occupied.has(value));
      const photoId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO app.inspection_photos (
           id, inspection_session_id, report_file_id, organization_id,
           client_photo_id, request_sha256, workflow_type, category,
           category_source, caption, caption_source, source, position,
           captured_at, capture_metadata, origin_channel
         ) VALUES (
           $1, NULL, $2, $3, $4, $5, 'custom_appraisal', $6,
           'custom_catalog', $7, 'manual', 'library', $8,
           $9, '{"origin":"desktop"}'::jsonb, 'desktop'
         ) RETURNING *`,
        [photoId, report.id, report.organization_id, normalized.clientPhotoId,
          normalized.requestSha256, normalized.category, normalized.caption, position,
          normalized.capturedAt],
      );
      photo = inserted.rows[0];
      for (const object of normalized.objects) {
        const objectId = randomUUID();
        await client.query(
          `INSERT INTO app.inspection_photo_objects (
             id, photo_id, client_object_id, variant, storage_provider, storage_bucket,
             object_key, original_file_name, content_type, expected_byte_size,
             pixel_width, pixel_height
           ) VALUES ($1, $2, $3, $4, 'r2', $5, $6, $7, $8, $9, $10, $11)`,
          [objectId, photo.id, object.clientObjectId, object.variant, storage.bucket,
            buildAssignmentPhotoObjectKey({
              organizationId: report.organization_id, reportFileId: report.id, photoId: photo.id,
              objectId, variant: object.variant, fileName: object.fileName,
            }), object.fileName, object.contentType, object.byteSize, object.width, object.height],
        );
      }
      await client.query(
        `INSERT INTO app.inspection_photo_events (
           photo_id, inspection_session_id, event_type, next_revision, metadata
         ) VALUES ($1, NULL, 'photo.created', 1, '{"origin":"desktop"}'::jsonb)`,
        [photo.id],
      );
    }
    const objects = await photoObjects(client, photo.id);
    const uploads = objects.filter((item) => item.status !== "verified").map((item) => uploadPayload(storage, item));
    for (const upload of uploads) {
      await client.query(
        `UPDATE app.inspection_photo_objects
            SET upload_expires_at = now() + ($2::integer * interval '1 second'), updated_at = now()
          WHERE id = $1`,
        [upload.object_id, upload.expires_in_seconds],
      );
    }
    await client.query("COMMIT");
    return { photo: photoPayload(storage, photo, objects), uploads };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Same-origin fallback for browsers that cannot reach a private R2 presigned
 * URL because the bucket CORS policy is missing or temporarily unavailable.
 * The object must already belong to the exact authorized appraisal file and
 * the byte count/content type must match the registered upload request.
 */
export async function uploadAssignmentPhotoObject(pool, storage, {
  accountId,
  assignmentFileId,
  photoId: photoValue,
  objectId: objectValue,
  contentType: suppliedContentType,
  content,
}) {
  ensureStorage(storage);
  const photoId = normalizeUuid(photoValue, "invalid_assignment_photo_id");
  const objectId = normalizeUuid(objectValue, "invalid_assignment_photo_object_id");
  const contentBuffer = Buffer.isBuffer(content) ? content : null;
  if (!contentBuffer) {
    throw new Error("invalid_assignment_photo_upload_body");
  }
  const byteSize = Buffer.byteLength(contentBuffer);
  if (byteSize < 1 || byteSize > MAX_PHOTO_BYTES) throw new Error("invalid_assignment_photo_upload_body");
  const report = await assignmentReport(pool, accountId, assignmentFileId);
  if (report.workfile_status === "signed") throw new Error("custom_appraisal_workfile_signed");
  const { rows } = await pool.query(
    `SELECT photo_object.*
       FROM app.inspection_photo_objects photo_object
       JOIN app.inspection_photos photo ON photo.id = photo_object.photo_id
      WHERE photo_object.id = $1
        AND photo.id = $2
        AND photo.report_file_id = $3
        AND photo.status NOT IN ('excluded', 'deleted')`,
    [objectId, photoId, report.id],
  );
  const object = rows[0];
  if (!object) throw new Error("assignment_photo_object_not_found");
  const contentType = String(suppliedContentType || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== object.content_type || byteSize !== Number(object.expected_byte_size)) {
    throw new Error("invalid_assignment_photo_upload");
  }
  const verified = await inspectAssignmentPhotoPayload(contentBuffer, object.content_type);
  const uploaded = await storage.putObject({
    objectKey: object.object_key,
    contentType: object.content_type,
    body: contentBuffer,
  });
  await pool.query(
    `UPDATE app.inspection_photo_objects
        SET storage_etag = $2, checksum_sha256 = $4,
            uploaded_at = COALESCE(uploaded_at, now()), updated_at = now()
      WHERE id = $1 AND photo_id = $3`,
    [object.id, uploaded?.etag || null, photoId, verified.checksum_sha256],
  );
  return {
    object_id: object.id,
    photo_id: photoId,
    variant: object.variant,
    byte_size: byteSize,
    uploaded: true,
  };
}

export async function verifyAssignmentPhoto(pool, storage, { accountId, assignmentFileId, photoId: value }) {
  ensureStorage(storage);
  const photoId = normalizeUuid(value, "invalid_assignment_photo_id");
  const report = await assignmentReport(pool, accountId, assignmentFileId);
  const photoResult = await pool.query(
    `SELECT * FROM app.inspection_photos
      WHERE id = $1 AND report_file_id = $2 AND status NOT IN ('excluded', 'deleted')`,
    [photoId, report.id],
  );
  if (!photoResult.rows.length) throw new Error("assignment_photo_not_found");
  const photo = photoResult.rows[0];
  const objects = await photoObjects(pool, photo.id);
  if (photo.status === "verified") return photoPayload(storage, photo, objects);
  if (!objects.length) throw new Error("invalid_assignment_photo_upload");
  const inspected = [];
  try {
    for (const object of objects) {
      const result = await storage.inspectObject({ objectKey: object.object_key });
      const contentType = String(result.content_type || "").split(";", 1)[0].trim().toLowerCase();
      if (Number(result.byte_size) !== Number(object.expected_byte_size)
          || Number(result.byte_size) < 1 || Number(result.byte_size) > MAX_PHOTO_BYTES
          || (contentType && contentType !== object.content_type)) {
        throw new Error("invalid_assignment_photo_upload");
      }
      const downloaded = await storage.getObject({
        objectKey: object.object_key,
        maxBytes: MAX_PHOTO_BYTES,
      });
      const downloadedType = String(downloaded.content_type || "").split(";", 1)[0].trim().toLowerCase();
      if (Number(downloaded.byte_size) !== Number(result.byte_size)
          || Number(downloaded.byte_size) !== Number(object.expected_byte_size)
          || (downloadedType && downloadedType !== object.content_type)) {
        throw new Error("invalid_assignment_photo_upload");
      }
      const verified = await inspectAssignmentPhotoPayload(downloaded.body, object.content_type);
      if (object.checksum_sha256 && object.checksum_sha256 !== verified.checksum_sha256) {
        throw new Error("invalid_assignment_photo_upload");
      }
      const verifiedObjectKey = buildVerifiedAssignmentPhotoObjectKey(
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
        throw new Error("invalid_assignment_photo_upload");
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
    if (String(error?.message || "") === "invalid_assignment_photo_upload") {
      await Promise.all(objects.map((object) => storage.deleteObject?.({
        objectKey: object.object_key,
      }).catch(() => undefined)));
    }
    throw error;
  }
  const client = await pool.connect();
  let verifiedPayload = null;
  let verificationCommitted = false;
  try {
    await client.query("BEGIN");
    const lockedReport = await assignmentReport(client, accountId, assignmentFileId, { lock: true });
    if (lockedReport.workfile_status === "signed") throw new Error("custom_appraisal_workfile_signed");
    const locked = await client.query(
      `SELECT * FROM app.inspection_photos WHERE id = $1 AND report_file_id = $2 FOR UPDATE`,
      [photoId, lockedReport.id],
    );
    if (!locked.rows.length) throw new Error("assignment_photo_not_found");
    if (locked.rows[0].status === "verified") {
      const currentObjects = await photoObjects(client, photoId);
      verifiedPayload = photoPayload(storage, locked.rows[0], currentObjects);
      await client.query("COMMIT");
      return verifiedPayload;
    }
    for (const item of inspected) {
      await client.query(
        `UPDATE app.inspection_photo_objects
            SET status = 'verified', byte_size = $2, storage_etag = $3,
                checksum_sha256 = $4, object_key = $5, upload_expires_at = NULL,
                pixel_width = COALESCE($6, pixel_width),
                pixel_height = COALESCE($7, pixel_height),
                uploaded_at = COALESCE(uploaded_at, now()), verified_at = now(), updated_at = now()
          WHERE id = $1`,
        [
          item.id,
          item.byteSize,
          item.etag,
          item.checksumSha256,
          item.verifiedObjectKey,
          item.dimensions?.width || null,
          item.dimensions?.height || null,
        ],
      );
    }
    const priorRevision = Number(locked.rows[0].revision);
    const updated = await client.query(
      `UPDATE app.inspection_photos
          SET status = 'verified', revision = revision + 1, verified_at = now(),
              retention_starts_at = now(), retention_until = now() + interval '5 years', updated_at = now()
        WHERE id = $1 RETURNING *`,
      [photoId],
    );
    await client.query(
      `INSERT INTO app.inspection_photo_events (
         photo_id, inspection_session_id, event_type, prior_revision, next_revision, metadata
       ) VALUES ($1, NULL, 'photo.verified', $2, $3, $4::jsonb)`,
      [photoId, priorRevision, priorRevision + 1, JSON.stringify({
        origin: "desktop",
        object_count: inspected.length,
        checksum_bound: true,
        immutable_object_keys: true,
      })],
    );
    const registry = await client.query(
      `UPDATE app.report_files SET registry_revision = registry_revision + 1, updated_at = now()
        WHERE id = $1 RETURNING registry_revision`,
      [lockedReport.id],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, event_type, prior_registry_revision, next_registry_revision,
         changed_fields, metadata
       ) VALUES ($1, 'desktop_photo.verified', $2, $3, ARRAY['inspection_photos'], $4::jsonb)`,
      [lockedReport.id, Number(registry.rows[0].registry_revision) - 1,
        Number(registry.rows[0].registry_revision), JSON.stringify({ photo_id: photoId })],
    );
    const verifiedObjects = await photoObjects(client, photoId);
    verifiedPayload = photoPayload(storage, updated.rows[0], verifiedObjects);
    await client.query("COMMIT");
    verificationCommitted = true;
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
  return verifiedPayload;
}

export async function removeAssignmentPhoto(pool, { accountId, assignmentFileId, photoId: value }) {
  const photoId = normalizeUuid(value, "invalid_assignment_photo_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await assignmentReport(client, accountId, assignmentFileId, { lock: true });
    if (report.workfile_status === "signed") throw new Error("custom_appraisal_workfile_signed");
    const locked = await client.query(
      `SELECT * FROM app.inspection_photos
        WHERE id = $1 AND report_file_id = $2 AND origin_channel = 'desktop' FOR UPDATE`,
      [photoId, report.id],
    );
    if (!locked.rows.length) throw new Error("assignment_photo_not_found");
    const photo = locked.rows[0];
    const retained = photo.status === "verified" || photo.verified_at != null;
    const status = retained ? "excluded" : "deleted";
    await client.query(
      `UPDATE app.inspection_photos
          SET status = $2, revision = revision + 1,
              excluded_at = CASE WHEN $2 = 'excluded' THEN COALESCE(excluded_at, now()) ELSE excluded_at END,
              deleted_at = CASE WHEN $2 = 'deleted' THEN COALESCE(deleted_at, now()) ELSE deleted_at END,
              updated_at = now()
        WHERE id = $1`,
      [photoId, status],
    );
    await client.query(
      `INSERT INTO app.inspection_photo_events (
         photo_id, inspection_session_id, event_type, prior_revision, next_revision, metadata
       ) VALUES ($1, NULL, $2, $3, $4, $5::jsonb)`,
      [photoId, retained ? "photo.excluded" : "photo.placeholder_deleted", Number(photo.revision),
        Number(photo.revision) + 1, JSON.stringify({ origin: "desktop", retained_as_evidence: retained })],
    );
    const registry = await client.query(
      `UPDATE app.report_files SET registry_revision = registry_revision + 1, updated_at = now()
        WHERE id = $1 RETURNING registry_revision`,
      [report.id],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, event_type, prior_registry_revision, next_registry_revision,
         changed_fields, metadata
       ) VALUES ($1, 'desktop_photo.removed', $2, $3, ARRAY['inspection_photos'], $4::jsonb)`,
      [report.id, Number(registry.rows[0].registry_revision) - 1,
        Number(registry.rows[0].registry_revision), JSON.stringify({ photo_id: photoId, retained })],
    );
    await client.query("COMMIT");
    return { disposition: retained ? "excluded_retained" : "placeholder_deleted" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function updateAssignmentPhotoMetadata(pool, storage, {
  accountId,
  assignmentFileId,
  photoId: value,
  input = {},
}) {
  const photoId = normalizeUuid(value, "invalid_assignment_photo_id");
  const normalized = normalizeAssignmentPhotoMetadata(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await assignmentReport(client, accountId, assignmentFileId, { lock: true });
    if (report.workfile_status === "signed") throw new Error("custom_appraisal_workfile_signed");
    const locked = await client.query(
      `SELECT * FROM app.inspection_photos
        WHERE id = $1 AND report_file_id = $2 AND status NOT IN ('excluded', 'deleted')
        FOR UPDATE`,
      [photoId, report.id],
    );
    if (!locked.rows.length) throw new Error("assignment_photo_not_found");
    const photo = locked.rows[0];
    if (Number(photo.revision) !== normalized.baseRevision) {
      throw new Error("assignment_photo_revision_conflict");
    }
    const categoryChanged = String(photo.category || "") !== normalized.category;
    const captionChanged = String(photo.caption || "") !== normalized.caption;
    if (!categoryChanged && !captionChanged) {
      const objects = await photoObjects(client, photoId);
      await client.query("COMMIT");
      return photoPayload(storage, photo, objects);
    }
    const updated = await client.query(
      `UPDATE app.inspection_photos
          SET category = $2,
              category_source = CASE WHEN category IS DISTINCT FROM $2 THEN 'manual' ELSE category_source END,
              room_ref = CASE WHEN category IS DISTINCT FROM $2 THEN NULL ELSE room_ref END,
              room_label = CASE WHEN category IS DISTINCT FROM $2 THEN NULL ELSE room_label END,
              caption = $3, caption_source = 'manual',
              revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [photoId, normalized.category, normalized.caption],
    );
    const changedFields = [
      categoryChanged ? "category" : null,
      captionChanged ? "caption" : null,
    ].filter(Boolean);
    await client.query(
      `INSERT INTO app.inspection_photo_events (
         photo_id, inspection_session_id, event_type, prior_revision, next_revision, metadata
       ) VALUES ($1, $2, 'photo.metadata_updated', $3, $4, $5::jsonb)`,
      [photoId, photo.inspection_session_id || null, normalized.baseRevision,
        normalized.baseRevision + 1, JSON.stringify({ origin: "custom_appraisal", changed_fields: changedFields })],
    );
    const registry = await client.query(
      `UPDATE app.report_files SET registry_revision = registry_revision + 1, updated_at = now()
        WHERE id = $1 RETURNING registry_revision`,
      [report.id],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, event_type, prior_registry_revision, next_registry_revision,
         changed_fields, metadata
       ) VALUES ($1, 'desktop_photo.metadata_updated', $2, $3, ARRAY['inspection_photos'], $4::jsonb)`,
      [report.id, Number(registry.rows[0].registry_revision) - 1,
        Number(registry.rows[0].registry_revision), JSON.stringify({ photo_id: photoId, changed_fields: changedFields })],
    );
    const objects = await photoObjects(client, photoId);
    await client.query("COMMIT");
    return photoPayload(storage, updated.rows[0], objects);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
