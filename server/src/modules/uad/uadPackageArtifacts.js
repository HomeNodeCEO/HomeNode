import { createHash, randomUUID } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { getUadEditor } from "./editor.js";
import { buildUadGeneratedArtifactObjectKey, sanitizeUadFileName } from "./r2Storage.js";
import { listUadSketches } from "./sketches.js";
import {
  buildDeterministicZip,
  buildUadDeliveryAssetEntries,
  buildUadImagesManifest,
} from "./uadDeliveryPackage.js";
import { buildUadValidationInputDigest } from "./validation.js";
import { inspectUadAssetPayload } from "./uadFileSecurity.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const MANIFEST_CONTENT_TYPE = "application/json";
const PACKAGE_CONTENT_TYPE = "application/zip";
const MAX_PACKAGE_ASSETS = 500;
const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;
const DOWNLOADABLE_WORKFILE_STATUSES = new Set(["signed", "exported", "submitted"]);

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

async function loadDeliveryAssets(queryable, workfileId) {
  const result = await queryable.query(
    `SELECT asset.id, asset.entity_id, asset.asset_kind, asset.section_number,
            asset.caption_type, asset.caption, asset.object_key, asset.original_file_name,
            asset.content_type, asset.byte_size, asset.checksum_sha256, asset.status,
            asset.created_at
       FROM appraisal.uad_assets AS asset
      WHERE asset.workfile_id = $1 AND asset.status = 'verified'
      ORDER BY asset.section_number NULLS LAST, asset.created_at, asset.id`,
    [workfileId],
  );
  return result.rows;
}

async function downloadVerified(storage, row, errorPrefix) {
  const downloaded = await storage.getObject({ objectKey: row.object_key });
  const checksum = createHash("sha256").update(downloaded.body).digest("hex");
  const expectedByteSize = row.expected_byte_size ?? row.byte_size;
  const expectedChecksum = row.expected_checksum_sha256 ?? row.checksum_sha256;
  if (expectedByteSize != null && Number(expectedByteSize) !== downloaded.body.length) {
    throw new Error(`${errorPrefix}_size_mismatch`);
  }
  if (expectedChecksum && expectedChecksum !== checksum) {
    throw new Error(`${errorPrefix}_checksum_mismatch`);
  }
  return { body: downloaded.body, byte_size: downloaded.body.length, checksum_sha256: checksum };
}

async function upsertGeneratingArtifact(queryable, {
  artifactId, workfile, storage, artifactType, contentType,
  byteSize, checksumSha256, fileName, metadata,
}) {
  const objectKey = buildUadGeneratedArtifactObjectKey({
    organizationId: workfile.organization_id,
    workfileId: workfile.id,
    revisionNumber: workfile.current_revision,
    artifactType,
    checksumSha256,
    fileName,
  });
  const result = await queryable.query(
    `INSERT INTO appraisal.uad_generated_artifacts (
       id, workfile_id, revision_number, artifact_type, storage_provider,
       storage_bucket, object_key, content_type, byte_size, checksum_sha256,
       generation_status, generated_at, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'generating', NULL, $11::jsonb)
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
      artifactId, workfile.id, Number(workfile.current_revision), artifactType,
      storage.provider, storage.bucket, objectKey, contentType, byteSize, checksumSha256,
      JSON.stringify({ file_name: fileName, ...metadata }),
    ],
  );
  return result.rows[0];
}

export async function getLatestUadSubmissionPackage(pool, storage, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const [workfileResult, artifactsResult] = await Promise.all([
    pool.query("SELECT id, current_revision, status FROM appraisal.uad_workfiles WHERE id = $1", [workfileId]),
    pool.query(
      `SELECT * FROM appraisal.uad_generated_artifacts
        WHERE workfile_id = $1 AND artifact_type IN ('images_manifest', 'submission_package')
        ORDER BY revision_number DESC, created_at DESC`,
      [workfileId],
    ),
  ]);
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const byType = new Map();
  for (const row of artifactsResult.rows) if (!byType.has(row.artifact_type)) byType.set(row.artifact_type, row);
  const workfile = workfileResult.rows[0];
  return {
    manifest: artifactResponse(byType.get("images_manifest") || null, workfile, storage),
    package: artifactResponse(byType.get("submission_package") || null, workfile, storage),
  };
}

export async function generateUadSubmissionPackage(pool, storage, workfileIdValue) {
  if (!storage?.configured) throw new Error("uad_object_storage_not_configured");
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const client = await pool.connect();
  let workfile;
  let inputDigest;
  let deliveryEntries;
  let sourceArtifacts;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, organization_id, file_number, current_revision,
              specification_release_key, status, updated_at
         FROM appraisal.uad_workfiles
        WHERE id = $1 FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");
    workfile = locked.rows[0];
    if (!DOWNLOADABLE_WORKFILE_STATUSES.has(workfile.status)) throw new Error("uad_package_signature_required");

    const editor = await getUadEditor(client, workfileId);
    const [assetSnapshot, rawAssets, sketches, validationResult, signaturesResult, artifactsResult] = await Promise.all([
      listUadAssets(client, workfileId),
      loadDeliveryAssets(client, workfileId),
      listUadSketches(client, workfileId),
      client.query(
        `SELECT * FROM appraisal.uad_validation_runs
          WHERE workfile_id = $1 AND validator_type = 'local_compliance'
          ORDER BY started_at DESC, id DESC LIMIT 1`,
        [workfileId],
      ),
      client.query(
        `SELECT signer_role FROM appraisal.uad_signatures
          WHERE workfile_id = $1 AND revision_number = $2`,
        [workfileId, Number(workfile.current_revision)],
      ),
      client.query(
        `SELECT * FROM appraisal.uad_generated_artifacts
          WHERE workfile_id = $1 AND revision_number = $2
            AND artifact_type IN ('xml', 'pdf')`,
        [workfileId, Number(workfile.current_revision)],
      ),
    ]);
    inputDigest = buildUadValidationInputDigest(editor, assetSnapshot, sketches);
    const validation = validationResult.rows[0];
    if (!validation || validation.status !== "passed" || validation.metadata?.input_digest_sha256 !== inputDigest) {
      throw new Error("uad_package_local_validation_stale");
    }
    if (!signaturesResult.rows.some((row) => row.signer_role === "appraiser")) {
      throw new Error("uad_package_appraiser_signature_missing");
    }
    deliveryEntries = buildUadDeliveryAssetEntries(rawAssets, editor.entities || []);
    if (deliveryEntries.length > MAX_PACKAGE_ASSETS) throw new Error("uad_package_asset_count_exceeded");
    sourceArtifacts = new Map(artifactsResult.rows.map((row) => [row.artifact_type, row]));
    const pdf = sourceArtifacts.get("pdf");
    const xml = sourceArtifacts.get("xml");
    if (!pdf || pdf.generation_status !== "ready" || pdf.metadata?.input_digest_sha256 !== inputDigest) {
      throw new Error("uad_package_pdf_required");
    }
    if (!xml || xml.generation_status !== "ready" || xml.metadata?.input_digest_sha256 !== inputDigest
      || xml.metadata?.schema_valid !== true) {
      throw new Error("uad_package_schema_valid_xml_required");
    }
    if (Number(xml.metadata?.image_reference_count || 0) !== deliveryEntries.length) {
      throw new Error("uad_package_xml_image_references_stale");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const pdfArtifact = sourceArtifacts.get("pdf");
  const xmlArtifact = sourceArtifacts.get("xml");
  const pdf = await downloadVerified(storage, pdfArtifact, "uad_package_pdf");
  const xml = await downloadVerified(storage, xmlArtifact, "uad_package_xml");
  const verifiedEntries = [];
  let totalAssetBytes = 0;
  for (const entry of deliveryEntries) {
    const downloaded = await downloadVerified(storage, entry, "uad_package_asset");
    try {
      inspectUadAssetPayload(downloaded.body, entry.content_type);
    } catch {
      throw new Error("uad_package_asset_payload_invalid");
    }
    totalAssetBytes += downloaded.byte_size;
    if (totalAssetBytes > MAX_PACKAGE_BYTES) throw new Error("uad_package_bytes_exceeded");
    verifiedEntries.push({ ...entry, ...downloaded });
  }
  const manifest = buildUadImagesManifest({ workfile, inputDigest, entries: verifiedEntries });
  const pdfFileName = sanitizeUadFileName(pdfArtifact.metadata?.file_name || `${workfile.file_number}.pdf`);
  const xmlFileName = sanitizeUadFileName(xmlArtifact.metadata?.file_name || `${workfile.file_number}.xml`);
  const manifestFileName = "images-manifest.json";
  const packageFileName = sanitizeUadFileName(`${workfile.file_number || workfile.id}-revision-${workfile.current_revision}.zip`);
  const zip = buildDeterministicZip([
    { path: pdfFileName, body: pdf.body },
    { path: xmlFileName, body: xml.body },
    ...verifiedEntries.map((entry) => ({ path: entry.package_path, body: entry.body })),
  ]);
  if (zip.byte_size > MAX_PACKAGE_BYTES) throw new Error("uad_package_bytes_exceeded");

  const persistClient = await pool.connect();
  let manifestRow;
  let packageRow;
  try {
    await persistClient.query("BEGIN");
    const unchanged = await persistClient.query(
      `SELECT id, organization_id, file_number, current_revision,
              specification_release_key, status, updated_at
         FROM appraisal.uad_workfiles
        WHERE id = $1 FOR UPDATE`,
      [workfileId],
    );
    if (!unchanged.rows.length
      || Number(unchanged.rows[0].current_revision) !== Number(workfile.current_revision)
      || new Date(unchanged.rows[0].updated_at).getTime() !== new Date(workfile.updated_at).getTime()
      || !DOWNLOADABLE_WORKFILE_STATUSES.has(unchanged.rows[0].status)) {
      throw new Error("uad_package_workfile_changed");
    }
    const commonMetadata = {
      input_digest_sha256: inputDigest,
      source_pdf_artifact_id: pdfArtifact.id,
      source_xml_artifact_id: xmlArtifact.id,
      source_pdf_checksum_sha256: pdf.checksum_sha256,
      source_xml_checksum_sha256: xml.checksum_sha256,
      image_count: verifiedEntries.length,
    };
    manifestRow = await upsertGeneratingArtifact(persistClient, {
      artifactId: randomUUID(), workfile, storage, artifactType: "images_manifest",
      contentType: MANIFEST_CONTENT_TYPE, byteSize: manifest.byte_size,
      checksumSha256: manifest.checksum_sha256, fileName: manifestFileName,
      metadata: commonMetadata,
    });
    packageRow = await upsertGeneratingArtifact(persistClient, {
      artifactId: randomUUID(), workfile, storage, artifactType: "submission_package",
      contentType: PACKAGE_CONTENT_TYPE, byteSize: zip.byte_size,
      checksumSha256: zip.checksum_sha256, fileName: packageFileName,
      metadata: { ...commonMetadata, entry_count: zip.entry_count, manifest_artifact_id: manifestRow.id },
    });
    for (const entry of verifiedEntries) {
      await persistClient.query(
        `UPDATE appraisal.uad_assets SET checksum_sha256 = COALESCE(checksum_sha256, $2)
          WHERE id = $1 AND status = 'verified'`,
        [entry.asset_id, entry.checksum_sha256],
      );
    }
    await persistClient.query("COMMIT");
  } catch (error) {
    await persistClient.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    persistClient.release();
  }

  try {
    const [manifestUpload, packageUpload] = await Promise.all([
      storage.putObject({ objectKey: manifestRow.object_key, contentType: MANIFEST_CONTENT_TYPE, body: manifest.content }),
      storage.putObject({ objectKey: packageRow.object_key, contentType: PACKAGE_CONTENT_TYPE, body: zip.content }),
    ]);
    const finalized = await pool.query(
      `WITH finalized AS (
         UPDATE appraisal.uad_generated_artifacts
            SET generation_status = 'ready', generated_at = now(),
                metadata = metadata || CASE artifact_type
                  WHEN 'images_manifest' THEN $3::jsonb ELSE $4::jsonb END
          WHERE id IN ($1, $2)
          RETURNING *
       ), exported AS (
         UPDATE appraisal.uad_workfiles SET status = 'exported', updated_at = now()
          WHERE id = $5 AND current_revision = $6
       ), audit AS (
         INSERT INTO appraisal.uad_audit_events (
           workfile_id, event_type, entity_type, entity_id, after_data, metadata
         ) VALUES ($5, 'uad_package.generated', 'uad_generated_artifact', $2,
                   jsonb_build_object('checksum_sha256', $7::text, 'byte_size', $8::bigint),
                   jsonb_build_object('revision_number', $6::integer, 'image_count', $9::integer))
       ) SELECT * FROM finalized`,
      [
        manifestRow.id, packageRow.id,
        JSON.stringify({ storage_etag: manifestUpload.etag || null }),
        JSON.stringify({ storage_etag: packageUpload.etag || null }),
        workfileId, Number(workfile.current_revision), zip.checksum_sha256, zip.byte_size,
        verifiedEntries.length,
      ],
    );
    const byType = new Map(finalized.rows.map((row) => [row.artifact_type, row]));
    const currentWorkfile = { ...workfile, status: "exported" };
    return {
      manifest: artifactResponse(byType.get("images_manifest"), currentWorkfile, storage),
      package: artifactResponse(byType.get("submission_package"), currentWorkfile, storage),
    };
  } catch (error) {
    await pool.query(
      `UPDATE appraisal.uad_generated_artifacts
          SET generation_status = 'failed', metadata = metadata || $3::jsonb
        WHERE id IN ($1, $2)`,
      [manifestRow.id, packageRow.id, JSON.stringify({ upload_error: String(error.message).split(":")[0] })],
    );
    throw error;
  }
}
