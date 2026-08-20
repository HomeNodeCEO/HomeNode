import { randomUUID } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { getUadEditor } from "./editor.js";
import {
  buildUadGeneratedArtifactObjectKey,
  sanitizeUadFileName,
} from "./r2Storage.js";
import { listUadSketches } from "./sketches.js";
import { validateUadSubschema } from "./uadSubschema.js";
import { buildUadMismoXml } from "./uadXml.js";
import { buildUadValidationInputDigest } from "./validation.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const XML_CONTENT_TYPE = "application/xml";
const DOWNLOADABLE_WORKFILE_STATUSES = new Set(["ready", "signed", "exported", "submitted"]);

function artifactResponse(row, workfile, storage) {
  if (!row) return null;
  const currentRevision = Number(workfile.current_revision);
  const revisionNumber = Number(row.revision_number);
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
    const download = storage.createDownloadUrl({ objectKey: row.object_key });
    response.download = download;
  }
  return response;
}

function schemaValidationResponse(run, findings = []) {
  if (!run) return null;
  return {
    id: run.id,
    workfile_id: run.workfile_id,
    revision_number: Number(run.revision_number),
    specification_release_key: run.specification_release_key,
    validator_type: run.validator_type,
    status: run.status,
    fatal_count: Number(run.fatal_count),
    warning_count: Number(run.warning_count),
    started_at: run.started_at,
    completed_at: run.completed_at,
    metadata: run.metadata || {},
    findings: findings.map((finding) => ({
      id: finding.id,
      rule_id: finding.rule_id || null,
      severity: finding.severity,
      message: finding.message,
      status: finding.status,
      metadata: finding.metadata || {},
      created_at: finding.created_at,
    })),
  };
}

async function loadLatestSchemaValidation(queryable, workfileId) {
  const runResult = await queryable.query(
    `SELECT *
       FROM appraisal.uad_validation_runs
      WHERE workfile_id = $1 AND validator_type = 'local_schema'
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
    [workfileId],
  );
  if (!runResult.rows.length) return null;
  const findingsResult = await queryable.query(
    `SELECT *
       FROM appraisal.uad_validation_findings
      WHERE validation_run_id = $1
      ORDER BY created_at, id`,
    [runResult.rows[0].id],
  );
  return schemaValidationResponse(runResult.rows[0], findingsResult.rows);
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

async function persistUploadFailure(pool, artifactId, message) {
  await pool.query(
    `UPDATE appraisal.uad_generated_artifacts
        SET generation_status = 'failed',
            metadata = metadata || $2::jsonb
      WHERE id = $1`,
    [artifactId, JSON.stringify({ upload_error: String(message || "uad_object_upload_failed").split(":")[0] })],
  );
}

export async function getLatestUadXmlArtifact(pool, storage, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfileResult = await pool.query(
    "SELECT id, current_revision, status FROM appraisal.uad_workfiles WHERE id = $1",
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const artifactResult = await pool.query(
    `SELECT *
       FROM appraisal.uad_generated_artifacts
      WHERE workfile_id = $1 AND artifact_type = 'xml'
      ORDER BY revision_number DESC, created_at DESC
      LIMIT 1`,
    [workfileId],
  );
  return {
    artifact: artifactResponse(artifactResult.rows[0] || null, workfileResult.rows[0], storage),
    schema_validation: await loadLatestSchemaValidation(pool, workfileId),
  };
}

export async function generateUadXmlArtifact(pool, storage, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const client = await pool.connect();
  let artifactRow;
  let schemaRunRow;
  let schemaFindingRows = [];
  let generated;
  let workfile;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, organization_id, file_number, current_revision, specification_release_key, status
         FROM appraisal.uad_workfiles
        WHERE id = $1
        FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");
    workfile = locked.rows[0];
    if (workfile.status !== "ready") throw new Error("uad_xml_local_validation_required");

    const editor = await getUadEditor(client, workfileId);
    const assets = await listUadAssets(client, workfileId);
    const sketches = await listUadSketches(client, workfileId);
    const inputDigest = buildUadValidationInputDigest(editor, assets, sketches);
    const localValidation = await loadCurrentLocalValidation(client, workfileId);
    if (
      !localValidation
      || localValidation.status !== "passed"
      || Number(localValidation.revision_number) !== Number(workfile.current_revision)
      || localValidation.metadata?.input_digest_sha256 !== inputDigest
    ) throw new Error("uad_xml_local_validation_stale");

    generated = buildUadMismoXml(editor);
    const schema = await validateUadSubschema(generated.xml);
    const schemaRunId = randomUUID();
    const schemaStatus = schema.valid ? "passed" : "failed";
    const schemaMetadata = {
      validator_version: schema.validator_version,
      subschema_version: schema.subschema_version,
      schema_sha256: schema.schema_sha256,
      input_digest_sha256: inputDigest,
      xml_checksum_sha256: generated.checksum_sha256,
      xml_byte_size: generated.byte_size,
      generator_version: generated.generator_version,
      delivery_specification_version: generated.delivery_specification_version,
      mapped_value_count: generated.mapped_value_count,
    };
    const insertedSchemaRun = await client.query(
      `INSERT INTO appraisal.uad_validation_runs (
         id, workfile_id, revision_number, specification_release_key,
         validator_type, status, fatal_count, warning_count, completed_at, metadata
       ) VALUES ($1, $2, $3, $4, 'local_schema', $5, $6, 0, now(), $7::jsonb)
       RETURNING *`,
      [
        schemaRunId,
        workfileId,
        Number(workfile.current_revision),
        workfile.specification_release_key,
        schemaStatus,
        schema.errors.length,
        JSON.stringify(schemaMetadata),
      ],
    );
    schemaRunRow = insertedSchemaRun.rows[0];
    await client.query(
      `UPDATE appraisal.uad_validation_findings AS finding
          SET status = 'superseded'
         FROM appraisal.uad_validation_runs AS run
        WHERE finding.validation_run_id = run.id
          AND run.workfile_id = $1
          AND run.validator_type = 'local_schema'
          AND run.id <> $2
          AND finding.status = 'open'`,
      [workfileId, schemaRunId],
    );
    for (const error of schema.errors) {
      const findingId = randomUUID();
      const insertedFinding = await client.query(
        `INSERT INTO appraisal.uad_validation_findings (
           id, validation_run_id, rule_id, severity, message, metadata
         ) VALUES ($1, $2, $3, 'fatal', $4, $5::jsonb)
         RETURNING *`,
        [
          findingId,
          schemaRunId,
          `uad.schema.xsd.${error.code || "validation"}`,
          error.message,
          JSON.stringify({
            line: error.line,
            column: error.column,
            code: error.code,
            validator_version: schema.validator_version,
          }),
        ],
      );
      schemaFindingRows.push(insertedFinding.rows[0]);
    }

    const fileName = sanitizeUadFileName(`${workfile.file_number || workfileId}.xml`);
    const objectKey = buildUadGeneratedArtifactObjectKey({
      organizationId: workfile.organization_id,
      workfileId,
      revisionNumber: workfile.current_revision,
      artifactType: "xml",
      checksumSha256: generated.checksum_sha256,
      fileName,
    });
    const artifactId = randomUUID();
    const artifactMetadata = {
      file_name: fileName,
      input_digest_sha256: inputDigest,
      validation_run_id: schemaRunId,
      generator_version: generated.generator_version,
      delivery_specification_version: generated.delivery_specification_version,
      subschema_version: generated.subschema_version,
      schema_valid: schema.valid,
    };
    const artifactResult = await client.query(
      `INSERT INTO appraisal.uad_generated_artifacts (
         id, workfile_id, revision_number, artifact_type, storage_provider,
         storage_bucket, object_key, content_type, byte_size, checksum_sha256,
         generation_status, generated_at, metadata
       ) VALUES ($1, $2, $3, 'xml', $4, $5, $6, $7, $8, $9, $10, NULL, $11::jsonb)
       ON CONFLICT (workfile_id, revision_number, artifact_type) DO UPDATE
         SET storage_provider = EXCLUDED.storage_provider,
             storage_bucket = EXCLUDED.storage_bucket,
             object_key = EXCLUDED.object_key,
             content_type = EXCLUDED.content_type,
             byte_size = EXCLUDED.byte_size,
             checksum_sha256 = EXCLUDED.checksum_sha256,
             generation_status = EXCLUDED.generation_status,
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
        XML_CONTENT_TYPE,
        generated.byte_size,
        generated.checksum_sha256,
        schema.valid ? "generating" : "failed",
        JSON.stringify(artifactMetadata),
      ],
    );
    artifactRow = artifactResult.rows[0];
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, after_data, metadata
       ) VALUES ($1, 'uad_xml.generated', 'uad_generated_artifact', $2, $3::jsonb, $4::jsonb)`,
      [
        workfileId,
        artifactRow.id,
        JSON.stringify({
          generation_status: artifactRow.generation_status,
          checksum_sha256: generated.checksum_sha256,
          byte_size: generated.byte_size,
        }),
        JSON.stringify({
          revision_number: Number(workfile.current_revision),
          validation_run_id: schemaRunId,
          schema_valid: schema.valid,
        }),
      ],
    );
    await client.query("COMMIT");

    if (!schema.valid) {
      return {
        artifact: artifactResponse(artifactRow, workfile, storage),
        schema_validation: schemaValidationResponse(schemaRunRow, schemaFindingRows),
      };
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  try {
    if (!storage.configured) throw new Error("uad_object_storage_not_configured");
    const uploaded = await storage.putObject({
      objectKey: artifactRow.object_key,
      contentType: XML_CONTENT_TYPE,
      body: generated.xml,
    });
    const updated = await pool.query(
      `UPDATE appraisal.uad_generated_artifacts
          SET generation_status = 'ready', generated_at = now(),
              byte_size = $2,
              metadata = metadata || $3::jsonb
        WHERE id = $1
        RETURNING *`,
      [
        artifactRow.id,
        Number(uploaded.byte_size || generated.byte_size),
        JSON.stringify({ storage_etag: uploaded.etag || null }),
      ],
    );
    artifactRow = updated.rows[0];
    const currentWorkfile = await pool.query(
      "SELECT id, current_revision, status FROM appraisal.uad_workfiles WHERE id = $1",
      [workfileId],
    );
    return {
      artifact: artifactResponse(artifactRow, currentWorkfile.rows[0] || workfile, storage),
      schema_validation: schemaValidationResponse(schemaRunRow, schemaFindingRows),
    };
  } catch (error) {
    await persistUploadFailure(pool, artifactRow.id, error.message);
    throw error;
  }
}
