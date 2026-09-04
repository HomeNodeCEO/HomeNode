import { createUadAssetUpload, listUadAssets, verifyUadAssetUpload } from "./assets.js";
import { listUadSketches, saveUadSketch } from "./sketches.js";
import { normalizeUadWorkfileId } from "./workfiles.js";
import { renderSketchPng } from "../mobile/sketchPng.js";
import { normalizeManualSketchDocument } from "../mobile/sketches.js";
import { getReportEvidenceVersion } from "../../services/reportEvidenceVersion.js";

const CATEGORY_SECTIONS = Object.freeze({
  front: [8],
  "dwelling front": [8],
  rear: [8],
  "dwelling rear": [8],
  street: [4],
  "street/property access": [4],
  kitchen: [10],
  "living area": [10],
  "living room": [10],
  bedroom: [10],
  bathroom: [10],
  garage: [13],
  "garage/vehicle storage": [13],
  attic: [10],
  "mechanical systems": [10],
  "site/view": [4],
  defect: [8, 10, 11, 12, 13, 14],
  "defect/damage": [8, 10, 11, 12, 13, 14],
  "repair item": [8, 10, 12, 13, 14],
  "additional improvement": [12, 14],
  outbuilding: [12],
  amenity: [14],
  "other exhibit": [],
});

const IMPORT_PROVENANCE_FIELDS = Object.freeze([
  "mobile_photo_id",
  "mobile_photo_revision",
  "mobile_sketch_id",
  "mobile_sketch_revision",
  "source_uad_sketch_id",
  "source_uad_sketch_revision",
  "uad_sketch_editor_revision",
]);

function recommendedSections(photo) {
  const category = String(photo.category || "").trim().toLowerCase();
  if (photo.room_ref || photo.room_label) return [10];
  return CATEGORY_SECTIONS[category] || [];
}

function viewUrl(storage, objectKey) {
  if (!storage?.configured || !objectKey) return { url: null, expiresInSeconds: null };
  const download = storage.createDownloadUrl({ objectKey, expiresInSeconds: 300 });
  return { url: download.url, expiresInSeconds: download.expires_in_seconds };
}

async function reportFileForWorkfile(client, workfileId, { lock = false } = {}) {
  const { rows } = await client.query(
    `SELECT report_file.*, workfile.file_number
       FROM appraisal.uad_workfiles workfile
       JOIN app.report_files report_file ON report_file.uad_workfile_id = workfile.id
      WHERE workfile.id = $1
      ${lock ? "FOR UPDATE OF workfile, report_file" : ""}`,
    [workfileId],
  );
  if (!rows.length) throw new Error("uad_mobile_evidence_report_file_not_found");
  return rows[0];
}

function photoCandidate(storage, row) {
  const view = viewUrl(storage, row.object_key);
  return {
    id: row.id,
    report_file_id: row.report_file_id,
    inspection_session_id: row.inspection_session_id,
    category: row.category,
    room_ref: row.room_ref || null,
    room_label: row.room_label || null,
    caption: row.caption || row.category,
    position: Number(row.position),
    captured_at: row.captured_at || null,
    verified_at: row.verified_at,
    revision: Number(row.revision),
    object: {
      variant: row.variant,
      file_name: row.original_file_name,
      content_type: row.content_type,
      byte_size: Number(row.byte_size || row.expected_byte_size),
      width: row.pixel_width == null ? null : Number(row.pixel_width),
      height: row.pixel_height == null ? null : Number(row.pixel_height),
    },
    view_url: view.url,
    view_url_expires_in_seconds: view.expiresInSeconds,
    recommended_sections: recommendedSections(row),
    imported_asset: row.imported_asset_id ? {
      id: row.imported_asset_id,
      section_number: Number(row.imported_section_number),
      entity_id: row.imported_entity_id || null,
      caption_type: row.imported_caption_type,
      status: row.imported_status,
    } : null,
  };
}

function sketchCandidate(row) {
  if (!row) return null;
  return {
    id: row.id,
    report_file_id: row.report_file_id,
    inspection_session_id: row.inspection_session_id,
    revision: Number(row.revision),
    review_status: row.review_status,
    measurement_standard: row.measurement_standard,
    measurement_method: row.measurement_method,
    summary: row.summary || {},
    confirmed_by_user_id: row.confirmed_by_user_id,
    confirmed_at: row.confirmed_at,
    updated_at: row.updated_at,
    imported_asset: row.imported_asset_id ? {
      id: row.imported_asset_id,
      revision: Number(row.imported_revision || 0),
      status: row.imported_status,
    } : null,
  };
}

export async function listUadMobileEvidence(pool, storage, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const reportFile = await reportFileForWorkfile(pool, workfileId);
  const evidenceVersion = await getReportEvidenceVersion(pool, reportFile.id);
  const photos = await pool.query(
    `SELECT photo.*, object.variant, object.object_key, object.original_file_name,
            object.content_type, object.expected_byte_size, object.byte_size,
            object.pixel_width, object.pixel_height,
            imported.id AS imported_asset_id, imported.section_number AS imported_section_number,
            imported.entity_id AS imported_entity_id, imported.caption_type AS imported_caption_type,
            imported.status AS imported_status
       FROM app.inspection_photos photo
       JOIN LATERAL (
         SELECT photo_object.*
           FROM app.inspection_photo_objects photo_object
          WHERE photo_object.photo_id = photo.id AND photo_object.status = 'verified'
          ORDER BY CASE photo_object.variant WHEN 'display' THEN 0 ELSE 1 END, photo_object.created_at, photo_object.id
          LIMIT 1
       ) object ON true
       LEFT JOIN LATERAL (
         SELECT asset.*
           FROM appraisal.uad_assets asset
          WHERE asset.workfile_id = $1
            AND asset.status <> 'deleted'
            AND asset.capture_metadata ->> 'mobile_photo_id' = photo.id::text
          ORDER BY asset.created_at DESC, asset.id
          LIMIT 1
       ) imported ON true
      WHERE photo.report_file_id = $2 AND photo.status = 'verified'
      ORDER BY photo.position, photo.created_at, photo.id`,
    [workfileId, reportFile.id],
  );
  const sketch = await pool.query(
    `SELECT sketch.*,
            imported.id AS imported_asset_id,
            imported.status AS imported_status,
            imported.capture_metadata ->> 'mobile_sketch_revision' AS imported_revision
       FROM app.inspection_sketches sketch
       LEFT JOIN LATERAL (
         SELECT asset.*
           FROM appraisal.uad_assets asset
          WHERE asset.workfile_id = $1
            AND asset.status <> 'deleted'
            AND asset.capture_metadata ->> 'mobile_sketch_id' = sketch.id::text
          ORDER BY asset.created_at DESC, asset.id
          LIMIT 1
       ) imported ON true
      WHERE sketch.report_file_id = $2 AND sketch.review_status = 'appraiser_confirmed'
      ORDER BY sketch.updated_at DESC, sketch.id
      LIMIT 1`,
    [workfileId, reportFile.id],
  );
  return {
    report_file_id: reportFile.id,
    ...evidenceVersion,
    photos: photos.rows.map((row) => photoCandidate(storage, row)),
    sketch: sketchCandidate(sketch.rows[0]),
  };
}

export async function getUadMobileEvidenceVersion(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const reportFile = await reportFileForWorkfile(pool, workfileId);
  return {
    report_file_id: reportFile.id,
    ...await getReportEvidenceVersion(pool, reportFile.id),
  };
}

async function existingImport(pool, workfileId, key, value) {
  const { rows } = await pool.query(
    `SELECT * FROM appraisal.uad_assets
      WHERE workfile_id = $1 AND status <> 'deleted'
        AND capture_metadata ->> $2 = $3
      ORDER BY created_at DESC, id
      LIMIT 1`,
    [workfileId, key, value],
  );
  return rows[0] || null;
}

function sameTarget(asset, input) {
  return Number(asset.section_number) === Number(input.section_number)
    && (asset.entity_id || null) === (input.entity_id || null)
    && asset.asset_kind === input.asset_kind
    && asset.caption_type === input.caption_type
    && (asset.caption || null) === (input.caption || null)
    && asset.content_type === input.content_type
    && asset.original_file_name === input.file_name
    && IMPORT_PROVENANCE_FIELDS.every((field) => (
      input.capture_metadata?.[field] === undefined
      || String(asset.capture_metadata?.[field] ?? "") === String(input.capture_metadata[field])
    ));
}

async function recordImportAudit({
  pool,
  workfileId,
  asset,
  actorUserId,
  eventType,
  provenanceKey,
  provenanceValue,
}) {
  await pool.query(
    `WITH import_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtext($2::text), hashtext($6::text || ':' || $7::text))
     ), attributed_asset AS (
       UPDATE appraisal.uad_assets
          SET created_by_user_id = $3::uuid, updated_at = now()
        WHERE id = $1::uuid AND workfile_id = $2::uuid
          AND created_by_user_id IS NULL AND $3::uuid IS NOT NULL
          AND EXISTS (SELECT 1 FROM import_lock)
        RETURNING id
     ), selected_asset AS (
       SELECT id
         FROM appraisal.uad_assets
        WHERE id = $1::uuid AND workfile_id = $2::uuid
          AND EXISTS (SELECT 1 FROM import_lock)
     )
     INSERT INTO appraisal.uad_audit_events (
       workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data, metadata
     )
     SELECT $2::uuid, $3::uuid, $4, 'uad_asset', $1::text, $5::jsonb,
            jsonb_build_object('provenance_key', $6::text, 'provenance_value', $7::text)
       FROM selected_asset
      WHERE NOT EXISTS (
        SELECT 1
          FROM appraisal.uad_audit_events audit
         WHERE audit.workfile_id = $2::uuid
           AND audit.event_type = $4
           AND audit.entity_type = 'uad_asset'
           AND audit.entity_id = $1::text
           AND audit.metadata ->> 'provenance_key' = $6
           AND audit.metadata ->> 'provenance_value' = $7
      )`,
    [
      asset.id,
      workfileId,
      actorUserId || null,
      eventType,
      JSON.stringify(asset),
      provenanceKey,
      provenanceValue,
    ],
  );
}

async function finalizeBufferImport({
  pool,
  storage,
  workfileId,
  input,
  body,
  loadBody,
  actorUserId,
  provenanceKey,
  provenanceValue,
  eventType,
}) {
  let existing = await existingImport(pool, workfileId, provenanceKey, provenanceValue);
  if (existing?.status === "rejected") {
    await pool.query(
      "UPDATE appraisal.uad_assets SET status = 'deleted', updated_at = now() WHERE id = $1 AND workfile_id = $2",
      [existing.id, workfileId],
    );
    existing = null;
  }
  if (existing && !sameTarget(existing, input)) throw new Error("uad_mobile_evidence_import_conflict");
  if (existing?.status === "verified") {
    const asset = (await listUadAssets(pool, workfileId)).find((item) => item.id === existing.id);
    if (!asset) throw new Error("uad_mobile_evidence_import_state_missing");
    await recordImportAudit({
      pool,
      workfileId,
      asset,
      actorUserId,
      eventType,
      provenanceKey,
      provenanceValue,
    });
    return { asset, idempotent: true };
  }
  const resolvedBody = body ?? await loadBody?.();
  const created = existing || await createUadAssetUpload(pool, storage, workfileId, {
    ...input,
    byte_size: resolvedBody?.length,
  });
  const assetId = existing?.id || created.asset_id;
  const objectKey = existing?.object_key || created.object_key;
  await storage.putObject({ objectKey, contentType: input.content_type, body: resolvedBody });
  const asset = await verifyUadAssetUpload(pool, storage, workfileId, assetId);
  await recordImportAudit({
    pool,
    workfileId,
    asset,
    actorUserId,
    eventType,
    provenanceKey,
    provenanceValue,
  });
  return { asset, idempotent: false };
}

export async function importUadMobilePhoto(pool, storage, workfileIdValue, photoIdValue, input = {}, actorUserId = null) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const photoId = normalizeUadWorkfileId(photoIdValue);
  const reportFile = await reportFileForWorkfile(pool, workfileId);
  const { rows } = await pool.query(
    `SELECT photo.*, object.variant, object.object_key, object.original_file_name,
            object.content_type, object.byte_size, object.expected_byte_size,
            object.pixel_width, object.pixel_height
       FROM app.inspection_photos photo
       JOIN LATERAL (
         SELECT photo_object.*
           FROM app.inspection_photo_objects photo_object
          WHERE photo_object.photo_id = photo.id AND photo_object.status = 'verified'
          ORDER BY CASE photo_object.variant WHEN 'display' THEN 0 ELSE 1 END, photo_object.created_at, photo_object.id
          LIMIT 1
       ) object ON true
      WHERE photo.id = $1 AND photo.report_file_id = $2 AND photo.status = 'verified'`,
    [photoId, reportFile.id],
  );
  if (!rows.length) throw new Error("uad_mobile_photo_not_found");
  const photo = rows[0];
  const captureMetadata = {
    ...(input.capture_metadata || {}),
    source: "homenode_mobile",
    mobile_photo_id: photo.id,
    mobile_photo_revision: Number(photo.revision),
    inspection_session_id: photo.inspection_session_id,
    report_file_id: photo.report_file_id,
    captured_at: photo.captured_at,
    verified_at: photo.verified_at,
    original_category: photo.category,
    original_room_ref: photo.room_ref || null,
    original_room_label: photo.room_label || null,
    source_object_variant: photo.variant,
    source_pixel_width: photo.pixel_width == null ? null : Number(photo.pixel_width),
    source_pixel_height: photo.pixel_height == null ? null : Number(photo.pixel_height),
  };
  const assetInput = {
    asset_kind: "photo",
    section_number: input.section_number,
    entity_id: input.entity_id || null,
    caption_type: input.caption_type,
    caption: input.caption || photo.caption || photo.category,
    file_name: photo.original_file_name,
    content_type: photo.content_type,
    capture_metadata: captureMetadata,
  };
  return finalizeBufferImport({
    pool,
    storage,
    workfileId,
    input: assetInput,
    loadBody: async () => (await storage.getObject({ objectKey: photo.object_key })).body,
    actorUserId, provenanceKey: "mobile_photo_id", provenanceValue: photo.id,
    eventType: "uad_asset.mobile_photo_imported",
  });
}

export async function importUadMobileSketch(pool, storage, workfileIdValue, sketchIdValue, input = {}, actorUserId = null) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const sketchId = normalizeUadWorkfileId(sketchIdValue);
  const reportFile = await reportFileForWorkfile(pool, workfileId);
  const { rows } = await pool.query(
    `SELECT * FROM app.inspection_sketches
      WHERE id = $1 AND report_file_id = $2 AND review_status = 'appraiser_confirmed'`,
    [sketchId, reportFile.id],
  );
  if (!rows.length) throw new Error("uad_mobile_sketch_not_found");
  const sketch = rows[0];
  const prior = await existingImport(pool, workfileId, "mobile_sketch_id", sketch.id);
  if (prior && Number(prior.capture_metadata?.mobile_sketch_revision || 0) !== Number(sketch.revision)) {
    throw new Error("uad_mobile_sketch_revision_conflict");
  }
  const body = renderSketchPng(sketch, {
    fileNumber: reportFile.file_number,
    propertyLabel: input.property_label || reportFile.file_number,
    revision: sketch.revision,
  });
  const assetResult = await finalizeBufferImport({
    pool,
    storage,
    workfileId,
    input: {
      asset_kind: input.caption_type === "FloorPlan" ? "floor_plan" : "sketch",
      section_number: 7,
      entity_id: input.entity_id || null,
      caption_type: input.caption_type || "SubjectPropertyImprovementSketch",
      caption: input.caption || "Appraiser-confirmed mobile measured sketch",
      file_name: `${reportFile.file_number || "uad"}-mobile-sketch.png`,
      content_type: "image/png",
      capture_metadata: {
        source: "homenode_mobile",
        mobile_sketch_id: sketch.id,
        mobile_sketch_revision: Number(sketch.revision),
        inspection_session_id: sketch.inspection_session_id,
        report_file_id: sketch.report_file_id,
        review_status: sketch.review_status,
        confirmed_by_user_id: sketch.confirmed_by_user_id,
        confirmed_at: sketch.confirmed_at,
        measurement_standard: sketch.measurement_standard,
        measurement_method: sketch.measurement_method,
      },
    },
    body,
    actorUserId,
    provenanceKey: "mobile_sketch_id",
    provenanceValue: sketch.id,
    eventType: "uad_asset.mobile_sketch_imported",
  });
  const canonicalSketch = await saveUadSketch(pool, workfileId, {
    schema_version: String(sketch.document?.schema_version || "1.0"),
    geometry: sketch.document,
    measurements: {
      standard: sketch.measurement_standard,
      method: sketch.measurement_method,
      rooms: sketch.document?.rooms || [],
    },
    calculated_areas: sketch.summary,
    area_overrides: {},
    rendered_asset_id: assetResult.asset.id,
    source: "mobile",
  }, actorUserId);
  return { ...assetResult, sketch: canonicalSketch };
}

export async function editUadSketch(
  pool,
  storage,
  workfileIdValue,
  sketchIdValue,
  input = {},
  actorUserId = null,
) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const sketchId = normalizeUadWorkfileId(sketchIdValue);
  const expectedRevision = Number(input.expected_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("invalid_uad_sketch_expected_revision");
  }
  const reportFile = await reportFileForWorkfile(pool, workfileId);
  const { rows } = await pool.query(
    `SELECT sketch.*, asset.caption_type, asset.caption, asset.id AS prior_asset_id
       FROM appraisal.uad_sketches sketch
       LEFT JOIN appraisal.uad_assets asset ON asset.id = sketch.rendered_asset_id
      WHERE sketch.id = $1 AND sketch.workfile_id = $2`,
    [sketchId, workfileId],
  );
  if (!rows.length) throw new Error("uad_sketch_not_found");
  const current = rows[0];
  const nextRevision = expectedRevision + 1;
  const provenanceValue = `${sketchId}:${nextRevision}`;
  const priorGenerated = await existingImport(
    pool,
    workfileId,
    "uad_sketch_editor_revision",
    provenanceValue,
  );
  if (
    Number(current.revision || 1) === nextRevision
    && priorGenerated?.status === "verified"
    && current.rendered_asset_id === priorGenerated.id
  ) {
    const asset = (await listUadAssets(pool, workfileId)).find((item) => item.id === priorGenerated.id);
    const sketch = (await listUadSketches(pool, workfileId)).find((item) => item.id === sketchId);
    if (!asset || !sketch) throw new Error("uad_sketch_editor_retry_state_missing");
    return { asset, sketch, idempotent: true };
  }
  if (Number(current.revision || 1) !== expectedRevision) {
    const conflict = new Error("uad_sketch_revision_conflict");
    conflict.currentRevision = Number(current.revision || 1);
    throw conflict;
  }

  const document = normalizeManualSketchDocument(input.sketch);
  const captionType = current.caption_type === "FloorPlan"
    ? "FloorPlan"
    : "SubjectPropertyImprovementSketch";
  const body = renderSketchPng({ document, revision: nextRevision }, {
    fileNumber: reportFile.file_number,
    propertyLabel: input.property_label || reportFile.file_number,
    revision: nextRevision,
  });
  const assetResult = await finalizeBufferImport({
    pool,
    storage,
    workfileId,
    input: {
      asset_kind: captionType === "FloorPlan" ? "floor_plan" : "sketch",
      section_number: 7,
      entity_id: current.entity_id || null,
      caption_type: captionType,
      caption: String(input.caption || current.caption || "HomeNode measured sketch").slice(0, 100),
      file_name: `${reportFile.file_number || "uad"}-sketch-r${nextRevision}.png`,
      content_type: "image/png",
      capture_metadata: {
        source: "homenode_web_sketch_editor",
        source_uad_sketch_id: sketchId,
        source_uad_sketch_revision: expectedRevision,
        uad_sketch_editor_revision: provenanceValue,
        retained_source_asset_id: current.prior_asset_id || null,
      },
    },
    body,
    actorUserId,
    provenanceKey: "uad_sketch_editor_revision",
    provenanceValue,
    eventType: "uad_asset.sketch_editor_rendered",
  });

  let sketch;
  try {
    sketch = await saveUadSketch(pool, workfileId, {
      schema_version: String(document.schema_version || current.schema_version || "1.0"),
      geometry: document,
      measurements: {
        standard: document.measurement_standard,
        method: document.measurement_method,
        rooms: document.rooms,
      },
      calculated_areas: document.summary || {},
      area_overrides: current.area_overrides || {},
      rendered_asset_id: assetResult.asset.id,
      entity_id: current.entity_id || null,
      source: "homenode",
      expected_revision: expectedRevision,
      change_source: "homenode_web_sketch_editor",
    }, actorUserId);
  } catch (error) {
    if (!assetResult.idempotent) {
      await pool.query(
        `UPDATE appraisal.uad_assets
            SET status = 'deleted', updated_at = now(),
                capture_metadata = capture_metadata || '{"orphaned_editor_render":true}'::jsonb
          WHERE id = $1 AND workfile_id = $2`,
        [assetResult.asset.id, workfileId],
      ).catch(() => undefined);
    }
    throw error;
  }

  if (current.prior_asset_id && current.prior_asset_id !== assetResult.asset.id) {
    await pool.query(
      `UPDATE appraisal.uad_assets
          SET status = 'deleted', updated_at = now(),
              capture_metadata = capture_metadata || $3::jsonb
        WHERE id = $1 AND workfile_id = $2 AND status = 'verified'`,
      [
        current.prior_asset_id,
        workfileId,
        JSON.stringify({
          superseded_by_asset_id: assetResult.asset.id,
          superseded_by_sketch_revision: nextRevision,
          retained_for_audit: true,
        }),
      ],
    ).catch((error) => {
      console.warn("Unable to mark prior UAD sketch exhibit as superseded", {
        error: error?.message,
        workfileId,
        sketchId,
        priorAssetId: current.prior_asset_id,
        replacementAssetId: assetResult.asset.id,
      });
    });
  }
  return { ...assetResult, sketch };
}
