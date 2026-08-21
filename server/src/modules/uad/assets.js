import { randomUUID } from "node:crypto";

import { UAD_ASSET_KINDS } from "./constants.js";
import {
  UAD_CERTIFICATION_SIGNATURE_CAPTION_TYPES,
  UAD_CERTIFICATION_SIGNATURE_CONTENT_TYPES,
} from "./certificationsCatalog.js";
import { buildUadObjectKey, buildUadVerifiedAssetObjectKey } from "./r2Storage.js";
import { inspectUadAssetPayload } from "./uadFileSecurity.js";
import {
  UAD_DWELLING_EXTERIOR_CAPTION_TYPES,
  UAD_DWELLING_EXTERIOR_IMAGE_CONTENT_TYPES,
} from "./dwellingExteriorCatalog.js";
import {
  UAD_MANUFACTURED_HOME_CAPTION_TYPES,
  UAD_MANUFACTURED_HOME_IMAGE_CONTENT_TYPES,
} from "./manufacturedHomeCatalog.js";
import {
  UAD_HIGHEST_BEST_USE_CAPTION_TYPES,
  UAD_HIGHEST_BEST_USE_IMAGE_CONTENT_TYPES,
} from "./highestBestUseCatalog.js";
import {
  UAD_MARKET_CAPTION_TYPES,
  UAD_MARKET_IMAGE_CONTENT_TYPES,
} from "./marketCatalog.js";
import {
  UAD_PROJECT_INFORMATION_CAPTION_TYPES,
  UAD_PROJECT_INFORMATION_IMAGE_CONTENT_TYPES,
} from "./projectInformationCatalog.js";
import {
  UAD_PRIOR_TRANSFER_CAPTION_TYPES,
  UAD_PRIOR_TRANSFER_IMAGE_CONTENT_TYPES,
} from "./priorSaleTransferCatalog.js";
import {
  UAD_RECONCILIATION_CAPTION_TYPES,
  UAD_RECONCILIATION_IMAGE_CONTENT_TYPES,
} from "./reconciliationCatalog.js";
import {
  UAD_SALES_CONTRACT_CAPTION_TYPES,
  UAD_SALES_CONTRACT_IMAGE_CONTENT_TYPES,
} from "./salesContractCatalog.js";
import {
  UAD_SALES_COMPARISON_CAPTION_TYPES,
  UAD_SALES_COMPARISON_IMAGE_CONTENT_TYPES,
} from "./salesComparisonCatalog.js";
import {
  UAD_OUTBUILDING_CAPTION_TYPES,
  UAD_OUTBUILDING_IMAGE_CONTENT_TYPES,
} from "./outbuildingCatalog.js";
import {
  UAD_FUNCTIONAL_OBSOLESCENCE_CAPTION_TYPES,
  UAD_FUNCTIONAL_OBSOLESCENCE_IMAGE_CONTENT_TYPES,
} from "./functionalObsolescenceCatalog.js";
import {
  UAD_SKETCH_REPORT_CAPTION_TYPES,
  UAD_SKETCH_REPORT_CONTENT_TYPES,
} from "./sketchCatalog.js";
import { UAD_SITE_CAPTION_TYPES } from "./siteCatalog.js";
import {
  UAD_SUBJECT_PROPERTY_AMENITIES_CAPTION_TYPES,
  UAD_SUBJECT_PROPERTY_AMENITIES_IMAGE_CONTENT_TYPES,
  UAD_SUBJECT_PROPERTY_AMENITIES_MAX_IMAGES,
} from "./subjectPropertyAmenitiesCatalog.js";
import {
  UAD_SUBJECT_LISTING_CAPTION_TYPES,
  UAD_SUBJECT_LISTING_IMAGE_CONTENT_TYPES,
} from "./subjectListingCatalog.js";
import {
  UAD_UNIT_INTERIOR_CAPTION_TYPES,
  UAD_UNIT_INTERIOR_IMAGE_CONTENT_TYPES,
} from "./unitInteriorCatalog.js";
import {
  UAD_VEHICLE_STORAGE_CAPTION_TYPES,
  UAD_VEHICLE_STORAGE_IMAGE_CONTENT_TYPES,
} from "./vehicleStorageCatalog.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const ALLOWED_CONTENT_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/json",
]);

const MAX_UAD_ASSET_BYTES = 50 * 1024 * 1024;
const SECTION_CAPTION_TYPES = new Map([
  [4, new Set(UAD_SITE_CAPTION_TYPES)],
  [5, new Set(["DisasterMitigationExhibit"])],
  [6, new Set(["EnergyEfficientAndGreenFeaturesExhibit"])],
  [7, new Set([...UAD_SKETCH_REPORT_CAPTION_TYPES, "MeasurementSource"])],
  [8, new Set(UAD_DWELLING_EXTERIOR_CAPTION_TYPES)],
  [9, new Set(UAD_MANUFACTURED_HOME_CAPTION_TYPES)],
  [10, new Set(UAD_UNIT_INTERIOR_CAPTION_TYPES)],
  [11, new Set(UAD_FUNCTIONAL_OBSOLESCENCE_CAPTION_TYPES)],
  [12, new Set(UAD_OUTBUILDING_CAPTION_TYPES)],
  [13, new Set(UAD_VEHICLE_STORAGE_CAPTION_TYPES)],
  [14, new Set(UAD_SUBJECT_PROPERTY_AMENITIES_CAPTION_TYPES)],
  [16, new Set(UAD_HIGHEST_BEST_USE_CAPTION_TYPES)],
  [17, new Set(UAD_MARKET_CAPTION_TYPES)],
  [18, new Set(UAD_PROJECT_INFORMATION_CAPTION_TYPES)],
  [19, new Set(UAD_SUBJECT_LISTING_CAPTION_TYPES)],
  [20, new Set(UAD_SALES_CONTRACT_CAPTION_TYPES)],
  [21, new Set(UAD_PRIOR_TRANSFER_CAPTION_TYPES)],
  [22, new Set(UAD_SALES_COMPARISON_CAPTION_TYPES)],
  [26, new Set(UAD_RECONCILIATION_CAPTION_TYPES)],
  [29, new Set(UAD_CERTIFICATION_SIGNATURE_CAPTION_TYPES)],
]);

function assetResponse(row) {
  return {
    id: row.id,
    entity_id: row.entity_id || null,
    asset_kind: row.asset_kind,
    section_number: row.section_number == null ? null : Number(row.section_number),
    caption_type: row.caption_type || null,
    caption: row.caption || null,
    original_file_name: row.original_file_name || null,
    content_type: row.content_type,
    byte_size: row.byte_size == null ? null : Number(row.byte_size),
    status: row.status,
    capture_metadata: row.capture_metadata || {},
    uploaded_at: row.uploaded_at || null,
    verified_at: row.verified_at || null,
    created_at: row.created_at,
  };
}

function normalizeAssetInput(input = {}) {
  const kind = String(input.asset_kind || "").trim();
  const contentType = String(input.content_type || "").trim().toLowerCase();
  const fileName = String(input.file_name || "").trim();
  const expectedByteSize = Number(input.byte_size);
  if (!UAD_ASSET_KINDS.includes(kind)) throw new Error("invalid_uad_asset_kind");
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error("invalid_uad_asset_content_type");
  if (!fileName || fileName.length > 255) throw new Error("invalid_uad_asset_file_name");
  if (!Number.isInteger(expectedByteSize) || expectedByteSize <= 0 || expectedByteSize > MAX_UAD_ASSET_BYTES) {
    throw new Error("invalid_uad_asset_byte_size");
  }
  const captionType = input.caption_type == null ? null : String(input.caption_type).trim();
  const caption = input.caption == null ? null : String(input.caption).trim();
  if (captionType && captionType.length > 80) throw new Error("invalid_uad_asset_caption_type");
  if (caption && caption.length > 100) throw new Error("invalid_uad_asset_caption");
  const sectionNumber = input.section_number == null ? null : Number(input.section_number);
  if (sectionNumber != null && (!Number.isInteger(sectionNumber) || sectionNumber < 1 || sectionNumber > 99)) {
    throw new Error("invalid_uad_asset_section");
  }
  const allowedCaptionTypes = SECTION_CAPTION_TYPES.get(sectionNumber);
  if (allowedCaptionTypes && !allowedCaptionTypes.has(captionType)) {
    throw new Error("invalid_uad_asset_caption_type");
  }
  if (
    sectionNumber === 7 && UAD_SKETCH_REPORT_CAPTION_TYPES.includes(captionType)
    && !UAD_SKETCH_REPORT_CONTENT_TYPES.includes(contentType)
  ) {
    throw new Error("invalid_uad_sketch_report_content_type");
  }
  if (
    sectionNumber === 7
    && ((captionType === "FloorPlan" && kind !== "floor_plan")
      || (captionType === "SubjectPropertyImprovementSketch" && kind !== "sketch")
      || (captionType === "MeasurementSource" && kind !== "measurement_source"))
  ) {
    throw new Error("invalid_uad_sketch_asset_kind");
  }
  if (
    sectionNumber === 8
    && !UAD_DWELLING_EXTERIOR_IMAGE_CONTENT_TYPES.includes(contentType)
  ) {
    throw new Error("invalid_uad_dwelling_exterior_content_type");
  }
  if (sectionNumber === 8 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_dwelling_exterior_asset_kind");
  }
  if (
    sectionNumber === 9
    && !UAD_MANUFACTURED_HOME_IMAGE_CONTENT_TYPES.includes(contentType)
  ) {
    throw new Error("invalid_uad_manufactured_home_content_type");
  }
  if (sectionNumber === 9 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_manufactured_home_asset_kind");
  }
  if (sectionNumber === 10 && !UAD_UNIT_INTERIOR_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_unit_interior_content_type");
  }
  if (sectionNumber === 10 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_unit_interior_asset_kind");
  }
  if (sectionNumber === 11 && !UAD_FUNCTIONAL_OBSOLESCENCE_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_functional_obsolescence_content_type");
  }
  if (sectionNumber === 11 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_functional_obsolescence_asset_kind");
  }
  if (sectionNumber === 12 && !UAD_OUTBUILDING_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_outbuilding_content_type");
  }
  if (sectionNumber === 12 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_outbuilding_asset_kind");
  }
  if (sectionNumber === 13 && !UAD_VEHICLE_STORAGE_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_vehicle_storage_content_type");
  }
  if (sectionNumber === 13 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_vehicle_storage_asset_kind");
  }
  if (sectionNumber === 14 && !UAD_SUBJECT_PROPERTY_AMENITIES_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_subject_property_amenities_content_type");
  }
  if (sectionNumber === 14 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_subject_property_amenities_asset_kind");
  }
  if (sectionNumber === 16 && !UAD_HIGHEST_BEST_USE_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_highest_best_use_content_type");
  }
  if (sectionNumber === 16 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_highest_best_use_asset_kind");
  }
  if (sectionNumber === 17 && !UAD_MARKET_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_market_content_type");
  }
  if (sectionNumber === 17 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_market_asset_kind");
  }
  if (sectionNumber === 18 && !UAD_PROJECT_INFORMATION_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_project_information_content_type");
  }
  if (sectionNumber === 18 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_project_information_asset_kind");
  }
  if (sectionNumber === 19 && !UAD_SUBJECT_LISTING_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_subject_listing_content_type");
  }
  if (sectionNumber === 19 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_subject_listing_asset_kind");
  }
  if (sectionNumber === 19 && !caption) {
    throw new Error("invalid_uad_subject_listing_asset_caption");
  }
  if (sectionNumber === 20 && !UAD_SALES_CONTRACT_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_sales_contract_content_type");
  }
  if (sectionNumber === 20 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_sales_contract_asset_kind");
  }
  if (sectionNumber === 20 && !caption) {
    throw new Error("invalid_uad_sales_contract_asset_caption");
  }
  if (sectionNumber === 21 && !UAD_PRIOR_TRANSFER_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_prior_transfer_content_type");
  }
  if (sectionNumber === 21 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_prior_transfer_asset_kind");
  }
  if (sectionNumber === 21 && !caption) {
    throw new Error("invalid_uad_prior_transfer_asset_caption");
  }
  if (sectionNumber === 22 && !UAD_SALES_COMPARISON_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_sales_comparison_content_type");
  }
  if (sectionNumber === 22 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_sales_comparison_asset_kind");
  }
  if (sectionNumber === 22 && !caption) {
    throw new Error("invalid_uad_sales_comparison_asset_caption");
  }
  if (sectionNumber === 26 && !UAD_RECONCILIATION_IMAGE_CONTENT_TYPES.includes(contentType)) {
    throw new Error("invalid_uad_reconciliation_content_type");
  }
  if (sectionNumber === 26 && !["photo", "image"].includes(kind)) {
    throw new Error("invalid_uad_reconciliation_asset_kind");
  }
  if (sectionNumber === 29) {
    if (input.entity_id) throw new Error("invalid_uad_signature_asset_entity");
    if (kind !== "signature") throw new Error("invalid_uad_signature_asset_kind");
    if (!UAD_CERTIFICATION_SIGNATURE_CONTENT_TYPES.includes(contentType)) {
      throw new Error("invalid_uad_signature_asset_content_type");
    }
  }
  return {
    kind,
    contentType,
    fileName,
    entityId: input.entity_id || null,
    sectionNumber,
    captionType,
    caption,
    captureMetadata: { ...(input.capture_metadata || {}), expected_byte_size: expectedByteSize },
  };
}

export async function listUadAssets(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const { rows } = await pool.query(
    `SELECT * FROM appraisal.uad_assets
      WHERE workfile_id = $1 AND status <> 'deleted'
      ORDER BY section_number NULLS LAST, created_at, id`,
    [workfileId],
  );
  return rows.map(assetResponse);
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
  let entityType = null;
  if (normalized.entityId) {
    const entityResult = await pool.query(
      `SELECT id, entity_type FROM appraisal.uad_entities WHERE id = $1 AND workfile_id = $2`,
      [normalized.entityId, workfileId],
    );
    if (!entityResult.rows.length) throw new Error("uad_entity_not_found");
    entityType = entityResult.rows[0].entity_type;
  }
  if (normalized.sectionNumber === 14) {
    const requiredEntityType = normalized.captionType === "SubjectPropertyAmenity"
      ? "amenity"
      : normalized.captionType === "SubjectPropertyAmenityDefect"
        ? "amenity_defect"
        : null;
    if (
      (requiredEntityType && entityType !== requiredEntityType)
      || (!requiredEntityType && normalized.entityId)
    ) {
      throw new Error("invalid_uad_subject_property_amenities_asset_entity");
    }
    const maximum = UAD_SUBJECT_PROPERTY_AMENITIES_MAX_IMAGES[normalized.captionType];
    if (maximum) {
      const existingImages = await pool.query(
        `SELECT count(*)::integer AS count
           FROM appraisal.uad_assets
          WHERE workfile_id = $1
            AND entity_id = $2
            AND section_number = 14
            AND caption_type = $3
            AND status NOT IN ('deleted', 'rejected')`,
        [workfileId, normalized.entityId, normalized.captionType],
      );
      if (Number(existingImages.rows[0].count) >= maximum) {
        throw new Error("invalid_uad_subject_property_amenities_asset_limit");
      }
    }
  }
  if (normalized.sectionNumber === 16 && normalized.entityId) {
    throw new Error("invalid_uad_highest_best_use_asset_entity");
  }
  if (normalized.sectionNumber === 17 && normalized.entityId) {
    throw new Error("invalid_uad_market_asset_entity");
  }
  if (normalized.sectionNumber === 18) {
    const requiredEntityType = normalized.captionType === "ProjectAmenity" ? "project_amenity" : null;
    if (
      (requiredEntityType && entityType !== requiredEntityType)
      || (!requiredEntityType && normalized.entityId)
    ) {
      throw new Error("invalid_uad_project_information_asset_entity");
    }
  }
  if (normalized.sectionNumber === 19 && normalized.entityId) {
    throw new Error("invalid_uad_subject_listing_asset_entity");
  }
  if (normalized.sectionNumber === 20 && normalized.entityId) {
    throw new Error("invalid_uad_sales_contract_asset_entity");
  }
  if (normalized.sectionNumber === 21 && normalized.entityId) {
    throw new Error("invalid_uad_prior_transfer_asset_entity");
  }
  if (normalized.sectionNumber === 22) {
    const comparablePhoto = normalized.captionType === "PropertyPhoto";
    if (
      (comparablePhoto && entityType !== "sales_comparable")
      || (!comparablePhoto && normalized.entityId)
    ) {
      throw new Error("invalid_uad_sales_comparison_asset_entity");
    }
  }

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
    `WITH inserted_asset AS (
       INSERT INTO appraisal.uad_assets (
         id, workfile_id, entity_id, asset_kind, section_number,
         caption_type, caption, storage_provider, storage_bucket, object_key,
         original_file_name, content_type, status, capture_metadata, upload_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9, $10,
         $11, $12, 'pending_upload', $13::jsonb, $14
       )
       RETURNING workfile_id
     )
     UPDATE appraisal.uad_workfiles
        SET status = 'draft', updated_at = now()
      WHERE id = $2 AND EXISTS (SELECT 1 FROM inserted_asset)`,
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
    `SELECT asset.id, asset.object_key, asset.original_file_name, asset.content_type,
            asset.capture_metadata, workfile.organization_id
       FROM appraisal.uad_assets AS asset
       JOIN appraisal.uad_workfiles AS workfile ON workfile.id = asset.workfile_id
      WHERE asset.id = $1 AND asset.workfile_id = $2
        AND asset.status IN ('pending_upload', 'uploaded')`,
    [assetId, workfileId],
  );
  if (!result.rows.length) throw new Error("uad_asset_not_found");
  const asset = result.rows[0];
  const inspected = await storage.inspectObject({ objectKey: asset.object_key });
  const expectedSize = Number(asset.capture_metadata?.expected_byte_size || 0);
  const inspectedType = String(inspected.content_type || "").split(";", 1)[0].trim().toLowerCase();
  if (
    inspected.byte_size <= 0 || inspected.byte_size > MAX_UAD_ASSET_BYTES ||
    (expectedSize && inspected.byte_size !== expectedSize) ||
    (inspectedType && inspectedType !== asset.content_type)
  ) {
    await pool.query(
      `UPDATE appraisal.uad_assets
          SET status = 'rejected', updated_at = now(),
              capture_metadata = capture_metadata || $3::jsonb
        WHERE id = $1 AND workfile_id = $2`,
      [assetId, workfileId, JSON.stringify({ verification_error: "uploaded_object_does_not_match_request", inspected })],
    );
    await storage.deleteObject?.({ objectKey: asset.object_key }).catch(() => undefined);
    throw new Error("invalid_uad_uploaded_asset");
  }
  let downloaded;
  let verified;
  try {
    downloaded = await storage.getObject({ objectKey: asset.object_key });
    if (Number(downloaded.byte_size) !== Number(inspected.byte_size)) throw new Error("invalid_uad_asset_byte_size");
    const downloadedType = String(downloaded.content_type || "").split(";", 1)[0].trim().toLowerCase();
    if (downloadedType && downloadedType !== asset.content_type) throw new Error("invalid_uad_asset_content_type");
    verified = inspectUadAssetPayload(downloaded.body, asset.content_type);
  } catch (error) {
    await pool.query(
      `UPDATE appraisal.uad_assets
          SET status = 'rejected', updated_at = now(),
              capture_metadata = capture_metadata || $3::jsonb
        WHERE id = $1 AND workfile_id = $2`,
      [assetId, workfileId, JSON.stringify({ verification_error: String(error?.message || "invalid_uad_uploaded_asset").split(":")[0] })],
    );
    await storage.deleteObject?.({ objectKey: asset.object_key }).catch(() => undefined);
    throw new Error("invalid_uad_uploaded_asset");
  }
  const verifiedObjectKey = buildUadVerifiedAssetObjectKey({
    organizationId: asset.organization_id,
    workfileId,
    assetId,
    checksumSha256: verified.checksum_sha256,
    fileName: asset.original_file_name,
  });
  const copied = await storage.putObject({
    objectKey: verifiedObjectKey,
    contentType: asset.content_type,
    body: downloaded.body,
  });
  if (Number(copied.byte_size) !== verified.byte_size) {
    await storage.deleteObject?.({ objectKey: verifiedObjectKey }).catch(() => undefined);
    throw new Error("invalid_uad_uploaded_asset");
  }
  let updated;
  try {
    updated = await pool.query(
      `WITH updated_asset AS (
       UPDATE appraisal.uad_assets
          SET status = 'verified',
              byte_size = $3,
              checksum_sha256 = $5,
              object_key = $6,
              uploaded_at = COALESCE(uploaded_at, now()),
              verified_at = now(),
              updated_at = now(),
              capture_metadata = capture_metadata || jsonb_build_object(
                'storage_etag', $4::text,
                'verified_dimensions', $7::jsonb,
                'verified_object_immutable', true
              )
        WHERE id = $1 AND workfile_id = $2
        RETURNING *
     ), touched_workfile AS (
       UPDATE appraisal.uad_workfiles
          SET status = 'draft', updated_at = now()
        WHERE id = $2 AND EXISTS (SELECT 1 FROM updated_asset)
     )
     SELECT * FROM updated_asset`,
      [
        assetId, workfileId, verified.byte_size, copied.etag || inspected.etag,
        verified.checksum_sha256, verifiedObjectKey, JSON.stringify(verified.dimensions),
      ],
    );
  } catch (error) {
    await storage.deleteObject?.({ objectKey: verifiedObjectKey }).catch(() => undefined);
    throw error;
  }
  if (!updated.rows.length) {
    await storage.deleteObject?.({ objectKey: verifiedObjectKey }).catch(() => undefined);
    throw new Error("uad_asset_not_found");
  }
  await storage.deleteObject?.({ objectKey: asset.object_key }).catch(() => undefined);
  return assetResponse(updated.rows[0]);
}

export async function deleteUadAsset(pool, storage, workfileIdValue, assetIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const assetId = normalizeUadWorkfileId(assetIdValue);
  if (!storage?.deleteObject) throw new Error("uad_object_storage_not_configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT id, object_key
         FROM appraisal.uad_assets
        WHERE id = $1 AND workfile_id = $2 AND status <> 'deleted'
        FOR UPDATE`,
      [assetId, workfileId],
    );
    if (!selected.rows.length) throw new Error("uad_asset_not_found");
    await storage.deleteObject({ objectKey: selected.rows[0].object_key });
    await client.query(
      `WITH deleted_asset AS (
         UPDATE appraisal.uad_assets
            SET status = 'deleted', updated_at = now()
          WHERE id = $1 AND workfile_id = $2 AND status <> 'deleted'
          RETURNING id
       ), touched_workfile AS (
         UPDATE appraisal.uad_workfiles
            SET status = 'draft', updated_at = now()
          WHERE id = $2 AND EXISTS (SELECT 1 FROM deleted_asset)
       )
       SELECT id FROM deleted_asset`,
      [assetId, workfileId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
