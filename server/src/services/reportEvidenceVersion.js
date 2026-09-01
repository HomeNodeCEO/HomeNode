import { createHash } from "node:crypto";

import { canonicalJson } from "../modules/mobile/sync.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPhotoRows(rows = []) {
  return rows.map((row) => ({
    id: String(row.id || ""),
    position: Number(row.position || 0),
    revision: Number(row.revision || 0),
    status: String(row.status || ""),
    updatedAt: row.updated_at == null ? null : new Date(row.updated_at).toISOString(),
  }));
}

export function buildVerifiedPhotoVersion(rows = []) {
  const photos = normalizedPhotoRows(rows).filter((row) => row.status === "verified");
  return `pv1:${photos.length}:${sha256(canonicalJson(photos)).slice(0, 24)}`;
}

export function buildReportEvidenceVersion({ photoRows = [], sketch = null } = {}) {
  const photoVersion = buildVerifiedPhotoVersion(photoRows);
  const sketchState = sketch ? {
    revision: Number(sketch.revision || 0),
    reviewStatus: String(sketch.review_status || "draft"),
    updatedAt: sketch.updated_at == null ? null : new Date(sketch.updated_at).toISOString(),
  } : null;
  const version = `ev1:${sha256(canonicalJson({ photoVersion, sketchState })).slice(0, 24)}`;
  return Object.freeze({
    evidence_version: version,
    photo_version: photoVersion,
    verified_photo_count: photoRows.filter((row) => row.status === "verified").length,
    sketch_revision: sketchState?.revision || null,
    sketch_review_status: sketchState?.reviewStatus || null,
    sketch_updated_at: sketchState?.updatedAt || null,
  });
}

export async function getReportEvidenceVersion(client, reportFileId) {
  const { rows } = await client.query(
    `SELECT
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', photo.id,
           'position', photo.position,
           'revision', photo.revision,
           'status', photo.status,
           'updated_at', photo.updated_at
         ) ORDER BY photo.position, photo.created_at, photo.id)
         FROM app.inspection_photos photo
         WHERE photo.report_file_id = $1
           AND photo.status = 'verified'
       ), '[]'::jsonb) AS verified_photos,
       (
         SELECT jsonb_build_object(
           'revision', sketch.revision,
           'review_status', sketch.review_status,
           'updated_at', sketch.updated_at
         )
         FROM app.inspection_sketches sketch
         WHERE sketch.report_file_id = $1
         ORDER BY sketch.updated_at DESC, sketch.id DESC
         LIMIT 1
       ) AS sketch`,
    [reportFileId],
  );
  return buildReportEvidenceVersion({
    photoRows: rows[0]?.verified_photos || [],
    sketch: rows[0]?.sketch || null,
  });
}
