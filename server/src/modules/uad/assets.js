import { randomUUID } from "node:crypto";

import { UAD_ASSET_KINDS } from "./constants.js";
import { buildUadObjectKey } from "./r2Storage.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/svg+xml",
  "application/pdf",
  "application/json",
]);

function normalizeAssetInput(input = {}) {
  const kind = String(input.asset_kind || "").trim();
  const contentType = String(input.content_type || "").trim().toLowerCase();
  const fileName = String(input.file_name || "").trim();
  if (!UAD_ASSET_KINDS.includes(kind)) throw new Error("invalid_uad_asset_kind");
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error("invalid_uad_asset_content_type");
  if (!fileName || fileName.length > 255) throw new Error("invalid_uad_asset_file_name");
  return {
    kind,
    contentType,
    fileName,
    entityId: input.entity_id || null,
    sectionNumber: input.section_number == null ? null : Number(input.section_number),
    captionType: input.caption_type || null,
    caption: input.caption || null,
    captureMetadata: input.capture_metadata || {},
  };
}

export async function createUadAssetUpload(pool, storage, workfileIdValue, input) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const normalized = normalizeAssetInput(input);
  const assetId = randomUUID();
  const workfileResult = await pool.query(
    `SELECT id, organization_id
       FROM appraisal.uad_workfiles
      WHERE id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");

  const organizationId = workfileResult.rows[0].organization_id;
  const objectKey = buildUadObjectKey({
    organizationId,
    workfileId,
    assetId,
    fileName: normalized.fileName,
  });
  const upload = storage.createUploadUrl({ objectKey, contentType: normalized.contentType });
  const expiresAt = new Date(Date.now() + upload.expires_in_seconds * 1000);

  await pool.query(
    `INSERT INTO appraisal.uad_assets (
       id, workfile_id, entity_id, asset_kind, section_number,
       caption_type, caption, storage_provider, storage_bucket, object_key,
       original_file_name, content_type, status, capture_metadata, upload_expires_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12, 'pending_upload', $13::jsonb, $14
     )`,
    [
      assetId,
      workfileId,
      normalized.entityId,
      normalized.kind,
      normalized.sectionNumber,
      normalized.captionType,
      normalized.caption,
      storage.provider,
      storage.bucket,
      objectKey,
      normalized.fileName,
      normalized.contentType,
      JSON.stringify(normalized.captureMetadata),
      expiresAt,
    ],
  );

  return {
    asset_id: assetId,
    object_key: objectKey,
    upload,
    expires_at: expiresAt.toISOString(),
  };
}

export async function verifyUadAssetUpload(pool, storage, workfileIdValue, assetIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const assetId = normalizeUadWorkfileId(assetIdValue);
  const result = await pool.query(
    `SELECT id, object_key
       FROM appraisal.uad_assets
      WHERE id = $1 AND workfile_id = $2 AND status IN ('pending_upload', 'uploaded')`,
    [assetId, workfileId],
  );
  if (!result.rows.length) throw new Error("uad_asset_not_found");
  const inspected = await storage.inspectObject({ objectKey: result.rows[0].object_key });
  const updated = await pool.query(
    `UPDATE appraisal.uad_assets
        SET status = 'verified',
            byte_size = $3,
            uploaded_at = COALESCE(uploaded_at, now()),
            verified_at = now(),
            updated_at = now(),
            capture_metadata = capture_metadata || jsonb_build_object('storage_etag', $4::text)
      WHERE id = $1 AND workfile_id = $2
      RETURNING id, status, byte_size, verified_at`,
    [assetId, workfileId, inspected.byte_size, inspected.etag],
  );
  return updated.rows[0];
}
