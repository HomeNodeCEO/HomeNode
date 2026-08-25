import { randomUUID } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { getUadEditor } from "./editor.js";
import { buildUadGeneratedArtifactObjectKey } from "./r2Storage.js";
import { listUadSketches } from "./sketches.js";
import { renderUadNativePdf } from "./uadPdf.js";
import { inspectUadAssetPayload } from "./uadFileSecurity.js";
import { buildUadValidationInputDigest } from "./validation.js";
import { normalizeUadWorkfileId } from "./workfiles.js";
import { runUadArtifactOperation } from "./uadArtifactExecution.js";

const PDF_CONTENT_TYPE = "application/pdf";
const DOWNLOADABLE_WORKFILE_STATUSES = new Set(["ready", "signed", "exported", "submitted"]);
const MAX_RENDER_ASSETS = 250;
const MAX_RENDER_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_RENDER_TOTAL_BYTES = Math.max(
  16 * 1024 * 1024,
  Math.min(Number(process.env.UAD_PDF_MAX_SOURCE_BYTES) || 64 * 1024 * 1024, 100 * 1024 * 1024),
);

function artifactResponse(row, workfile, storage) {
  if (!row) return null;
  const revisionNumber = Number(row.revision_number);
  const currentRevision = Number(workfile.current_revision);
  const current = revisionNumber === currentRevision && DOWNLOADABLE_WORKFILE_STATUSES.has(workfile.status);
  const response = {
    id: row.id,
    workfile_id: row.workfile_id,
    revision_number: revisionNumber,
    artifact_type: row.artifact_type,
    storage_provider: row.storage_provider,
    storage_bucket: row.storage_bucket || null,
    object_key: row.object_key,
    content_type: row.content_type,
    byte_size: row.byte_size == null ? null : Number(row.byte_size),
    checksum_sha256: row.checksum_sha256 || null,
    generation_status: row.generation_status,
    generated_at: row.generated_at || null,
    metadata: row.metadata || {},
    created_at: row.created_at,
    is_current_revision: revisionNumber === currentRevision,
    ready_for_download: row.generation_status === "ready" && current,
  };
  if (response.ready_for_download && storage?.configured) {
    response.download = storage.createDownloadUrl({ objectKey: row.object_key });
  }
  return response;
}

async function loadCurrentLocalValidation(queryable, workfileId) {
  const result = await queryable.query(
    `SELECT *
       FROM appraisal.uad_validation_runs
      WHERE workfile_id = $1 AND validator_type = 'local_compliance'
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    [workfileId],
  );
  return result.rows[0] || null;
}

async function loadSigners(queryable, workfile) {
  const result = await queryable.query(
    `SELECT signer_role, signature_asset_id, credential_snapshot, execution_date
       FROM appraisal.uad_signatures
      WHERE workfile_id = $1 AND revision_number = $2
      ORDER BY CASE signer_role WHEN 'appraiser' THEN 0 ELSE 1 END`,
    [workfile.id, Number(workfile.current_revision)],
  );
  if (workfile.status === "signed" && !result.rows.length) throw new Error("uad_pdf_signatures_missing");
  return result.rows;
}

async function loadReportAssets(queryable, workfileId) {
  const result = await queryable.query(
    `SELECT id, entity_id, asset_kind, section_number, caption_type, caption,
            object_key, original_file_name, content_type, byte_size,
            checksum_sha256, status, capture_metadata
       FROM appraisal.uad_assets
      WHERE workfile_id = $1
        AND status = 'verified'
        AND section_number IS NOT NULL
        AND content_type LIKE 'image/%'
      ORDER BY section_number, created_at, id`,
    [workfileId],
  );
  if (result.rows.length > MAX_RENDER_ASSETS) throw new Error("uad_pdf_asset_count_exceeded");
  const totalBytes = result.rows.reduce((total, row) => total + Number(row.byte_size || 0), 0);
  if (totalBytes > MAX_RENDER_TOTAL_BYTES) throw new Error("uad_pdf_asset_bytes_exceeded");
  return result.rows.map((row) => ({
    ...row,
    section_number: Number(row.section_number),
    byte_size: row.byte_size == null ? null : Number(row.byte_size),
  }));
}

async function attachRenderableBodies(storage, assets) {
  const result = [];
  for (const asset of assets) {
    const supported = ["image/jpeg", "image/png"].includes(String(asset.content_type).toLowerCase());
    if (!supported) {
      result.push(asset);
      continue;
    }
    if (Number(asset.byte_size || 0) > MAX_RENDER_ASSET_BYTES) throw new Error("uad_pdf_image_bytes_exceeded");
    const downloaded = await storage.getObject({
      objectKey: asset.object_key,
      maxBytes: Math.min(
        MAX_RENDER_ASSET_BYTES,
        Number(asset.byte_size || MAX_RENDER_ASSET_BYTES),
      ),
    });
    if (asset.byte_size != null && Number(downloaded.byte_size) !== Number(asset.byte_size)) {
      throw new Error("uad_pdf_image_size_mismatch");
    }
    let inspected;
    try {
      inspected = inspectUadAssetPayload(downloaded.body, asset.content_type);
    } catch {
      throw new Error("uad_pdf_image_payload_invalid");
    }
    if (asset.checksum_sha256 && asset.checksum_sha256 !== inspected.checksum_sha256) {
      throw new Error("uad_pdf_image_checksum_mismatch");
    }
    result.push({ ...asset, body: downloaded.body });
  }
  return result;
}

export async function getLatestUadPdfArtifact(pool, storage, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const [workfileResult, artifactResult] = await Promise.all([
    pool.query("SELECT id, current_revision, status FROM appraisal.uad_workfiles WHERE id = $1", [workfileId]),
    pool.query(
      `SELECT * FROM appraisal.uad_generated_artifacts
        WHERE workfile_id = $1 AND artifact_type = 'pdf'
        ORDER BY revision_number DESC, created_at DESC
        LIMIT 1`,
      [workfileId],
    ),
  ]);
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  return { artifact: artifactResponse(artifactResult.rows[0] || null, workfileResult.rows[0], storage) };
}

async function generateUadPdfArtifactOperation(pool, storage, workfileIdValue) {
  if (!storage?.configured) throw new Error("uad_object_storage_not_configured");
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const client = await pool.connect();
  let workfile;
  let editor;
  let assetSnapshot;
  let assets;
  let signers;
  let inputDigest;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, organization_id, file_number, current_revision,
              specification_release_key, status, updated_at
         FROM appraisal.uad_workfiles
        WHERE id = $1
        FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");
    workfile = locked.rows[0];
    if (!["ready", "signed"].includes(workfile.status)) throw new Error("uad_pdf_local_validation_required");
    editor = await getUadEditor(client, workfileId);
    [assetSnapshot, assets] = await Promise.all([
      listUadAssets(client, workfileId),
      loadReportAssets(client, workfileId),
    ]);
    const sketches = await listUadSketches(client, workfileId);
    inputDigest = buildUadValidationInputDigest(editor, assetSnapshot, sketches);
    const localValidation = await loadCurrentLocalValidation(client, workfileId);
    if (
      !localValidation
      || localValidation.status !== "passed"
      || Number(localValidation.revision_number) !== Number(workfile.current_revision)
      || localValidation.metadata?.input_digest_sha256 !== inputDigest
    ) throw new Error("uad_pdf_local_validation_stale");
    signers = await loadSigners(client, workfile);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const renderAssets = await attachRenderableBodies(storage, assets);
  const generated = await renderUadNativePdf(editor, { assets: renderAssets, signers });
  const objectKey = buildUadGeneratedArtifactObjectKey({
    organizationId: workfile.organization_id,
    workfileId,
    revisionNumber: workfile.current_revision,
    artifactType: "pdf",
    checksumSha256: generated.checksum_sha256,
    fileName: generated.file_name,
  });
  const artifactId = randomUUID();
  const artifactMetadata = {
    file_name: generated.file_name,
    generation_started_at: new Date().toISOString(),
    input_digest_sha256: inputDigest,
    renderer: generated.renderer,
    renderer_version: generated.renderer_version,
    page_count: generated.page_count,
    rendered_sections: generated.rendered_sections,
    rendered_asset_count: generated.rendered_asset_count,
    signer_count: generated.signer_count,
    display_image_types: ["image/jpeg", "image/png"],
  };
  const inserted = await pool.query(
    `INSERT INTO appraisal.uad_generated_artifacts (
       id, workfile_id, revision_number, artifact_type, storage_provider,
       storage_bucket, object_key, content_type, byte_size, checksum_sha256,
       generation_status, generated_at, metadata
     ) VALUES ($1, $2, $3, 'pdf', $4, $5, $6, $7, $8, $9, 'generating', NULL, $10::jsonb)
     ON CONFLICT (workfile_id, revision_number, artifact_type) DO UPDATE
       SET storage_provider = EXCLUDED.storage_provider,
           storage_bucket = EXCLUDED.storage_bucket,
           object_key = EXCLUDED.object_key,
           content_type = EXCLUDED.content_type,
           byte_size = EXCLUDED.byte_size,
           checksum_sha256 = EXCLUDED.checksum_sha256,
           generation_status = 'generating',
           generated_at = NULL,
           metadata = EXCLUDED.metadata
     RETURNING *`,
    [
      artifactId,
      workfileId,
      Number(workfile.current_revision),
      storage.provider,
      storage.bucket,
      objectKey,
      PDF_CONTENT_TYPE,
      generated.byte_size,
      generated.checksum_sha256,
      JSON.stringify(artifactMetadata),
    ],
  );
  let artifactRow = inserted.rows[0];
  try {
    const uploaded = await storage.putObject({
      objectKey,
      contentType: PDF_CONTENT_TYPE,
      body: generated.content,
    });
    const updated = await pool.query(
      `WITH updated_artifact AS (
         UPDATE appraisal.uad_generated_artifacts
            SET generation_status = 'ready', generated_at = now(),
                byte_size = $2,
                metadata = metadata || $3::jsonb
          WHERE id = $1
          RETURNING *
       ), audit AS (
         INSERT INTO appraisal.uad_audit_events (
           workfile_id, event_type, entity_type, entity_id, after_data, metadata
         ) SELECT $4, 'uad_pdf.generated', 'uad_generated_artifact', id,
                  jsonb_build_object('generation_status', generation_status,
                                     'checksum_sha256', checksum_sha256,
                                     'byte_size', byte_size),
                  jsonb_build_object('revision_number', $5::integer,
                                     'page_count', $6::integer)
             FROM updated_artifact
       ) SELECT * FROM updated_artifact`,
      [
        artifactRow.id,
        Number(uploaded.byte_size || generated.byte_size),
        JSON.stringify({ storage_etag: uploaded.etag || null }),
        workfileId,
        Number(workfile.current_revision),
        generated.page_count,
      ],
    );
    artifactRow = updated.rows[0];
  } catch (error) {
    await pool.query(
      `UPDATE appraisal.uad_generated_artifacts
          SET generation_status = 'failed',
              metadata = metadata || $2::jsonb
        WHERE id = $1`,
      [artifactRow.id, JSON.stringify({ upload_error: String(error.message || "uad_object_upload_failed").split(":")[0] })],
    );
    throw error;
  }
  const current = await pool.query(
    "SELECT id, current_revision, status FROM appraisal.uad_workfiles WHERE id = $1",
    [workfileId],
  );
  return { artifact: artifactResponse(artifactRow, current.rows[0] || workfile, storage) };
}

export function generateUadPdfArtifact(pool, storage, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  return runUadArtifactOperation(
    "pdf",
    workfileId,
    () => generateUadPdfArtifactOperation(pool, storage, workfileId),
  );
}
