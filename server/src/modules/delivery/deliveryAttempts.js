import { randomUUID } from "node:crypto";

import { buildGuidedDeliveryPlan, resolveDeliveryDestination } from "./platformCatalog.js";
import { normalizeUadWorkfileId } from "../uad/workfiles.js";

const UAD_PACKAGE_MAX_BYTES = 60 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function optionalText(value, maximum, errorCode) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text || text.length > maximum || /[\0-\x1f\x7f]/.test(text)) throw new Error(errorCode);
  return text;
}

function normalizeAttemptId(value) {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) throw new Error("delivery_attempt_id_invalid");
  return id;
}

function validatePackageArtifact(workfile, artifact) {
  if (!artifact) throw new Error("delivery_submission_package_required");
  if (artifact.artifact_type !== "submission_package" || artifact.generation_status !== "ready") {
    throw new Error("delivery_submission_package_not_ready");
  }
  if (Number(artifact.revision_number) !== Number(workfile.current_revision)) {
    throw new Error("delivery_submission_package_stale");
  }
  if (artifact.content_type !== "application/zip") throw new Error("delivery_submission_package_type_invalid");
  if (!Number.isSafeInteger(Number(artifact.byte_size)) || Number(artifact.byte_size) <= 0
    || Number(artifact.byte_size) > UAD_PACKAGE_MAX_BYTES) {
    throw new Error("delivery_submission_package_size_invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(String(artifact.checksum_sha256 || ""))) {
    throw new Error("delivery_submission_package_checksum_invalid");
  }
}

function attemptResponse(row) {
  return {
    id: row.id,
    workfile_id: row.workfile_id,
    revision_number: Number(row.revision_number),
    artifact_id: row.artifact_id,
    status: row.status,
    delivery_mode: row.delivery_mode,
    external_order_id: row.external_order_id || null,
    external_delivery_id: row.external_delivery_id || null,
    receipt_reference: row.receipt_reference || null,
    package_byte_size: Number(row.package_byte_size),
    package_checksum_sha256: row.package_checksum_sha256,
    prepared_at: row.prepared_at,
    delivered_at: row.delivered_at || null,
    failed_at: row.failed_at || null,
    failure_code: row.failure_code || null,
    metadata: row.metadata || {},
    destination: {
      id: row.destination_id,
      platform_key: row.platform_key,
      tenant_key: row.tenant_key,
      display_name: row.destination_display_name,
      base_url: row.base_url,
      direct_integration: row.direct_integration,
    },
  };
}

const ATTEMPT_SELECT = `
  SELECT attempt.*, destination.platform_key, destination.tenant_key,
         destination.display_name AS destination_display_name,
         destination.base_url, destination.direct_integration
    FROM appraisal.delivery_attempts AS attempt
    JOIN appraisal.delivery_destinations AS destination ON destination.id = attempt.destination_id
`;

export async function createGuidedDeliveryAttempt(pool, workfileIdValue, input = {}, actorUserId = null) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const resolved = resolveDeliveryDestination(input);
  const externalOrderId = optionalText(input.external_order_id, 200, "delivery_external_order_id_invalid");
  const displayName = optionalText(input.display_name, 160, "delivery_destination_name_invalid")
    || resolved.tenant_display_name
    || resolved.platform.display_name;
  const idempotencyKey = optionalText(input.idempotency_key, 160, "delivery_idempotency_key_invalid")
    || randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workfileResult = await client.query(
      `SELECT id, organization_id, current_revision, status
         FROM appraisal.uad_workfiles
        WHERE id = $1 FOR SHARE`,
      [workfileId],
    );
    if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
    const workfile = workfileResult.rows[0];
    if (!workfile.organization_id) throw new Error("delivery_organization_required");
    if (!["signed", "exported", "submitted"].includes(workfile.status)) {
      throw new Error("delivery_signed_revision_required");
    }

    const artifactResult = await client.query(
      `SELECT * FROM appraisal.uad_generated_artifacts
        WHERE workfile_id = $1
          AND revision_number = $2
          AND artifact_type = 'submission_package'
        ORDER BY created_at DESC LIMIT 1`,
      [workfileId, Number(workfile.current_revision)],
    );
    const artifact = artifactResult.rows[0] || null;
    validatePackageArtifact(workfile, artifact);

    const destinationResult = await client.query(
      `INSERT INTO appraisal.delivery_destinations (
         id, organization_id, platform_key, tenant_key, display_name, base_url,
         delivery_mode, direct_integration, configuration, created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 'guided_manual', $7, '{}'::jsonb, $8)
       ON CONFLICT (organization_id, platform_key, tenant_key) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             base_url = EXCLUDED.base_url,
             direct_integration = EXCLUDED.direct_integration,
             enabled = true,
             updated_at = now()
       RETURNING *`,
      [
        randomUUID(), workfile.organization_id, resolved.platform_key, resolved.tenant_key,
        displayName, resolved.portal_url, resolved.platform.direct_integration, actorUserId,
      ],
    );
    const destination = destinationResult.rows[0];

    const attemptResult = await client.query(
      `INSERT INTO appraisal.delivery_attempts (
         id, destination_id, workfile_id, revision_number, artifact_id,
         idempotency_key, delivery_mode, status, external_order_id,
         package_byte_size, package_checksum_sha256, created_by_user_id,
         metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, 'guided_manual', 'prepared', $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (destination_id, idempotency_key) DO UPDATE
         SET external_order_id = COALESCE(appraisal.delivery_attempts.external_order_id, EXCLUDED.external_order_id)
       RETURNING *`,
      [
        randomUUID(), destination.id, workfile.id, Number(workfile.current_revision), artifact.id,
        idempotencyKey, externalOrderId, Number(artifact.byte_size), artifact.checksum_sha256,
        actorUserId, JSON.stringify({ known_tenant: resolved.known_tenant, hostname: resolved.hostname }),
      ],
    );
    const storedAttempt = attemptResult.rows[0];
    const hydrated = {
      ...storedAttempt,
      platform_key: destination.platform_key,
      tenant_key: destination.tenant_key,
      destination_display_name: destination.display_name,
      base_url: destination.base_url,
      direct_integration: destination.direct_integration,
    };
    await client.query("COMMIT");
    return {
      attempt: attemptResponse(hydrated),
      plan: buildGuidedDeliveryPlan({ destination, attempt: storedAttempt, artifact }),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listDeliveryAttempts(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const result = await pool.query(
    `${ATTEMPT_SELECT} WHERE attempt.workfile_id = $1 ORDER BY attempt.prepared_at DESC, attempt.id DESC`,
    [workfileId],
  );
  return result.rows.map(attemptResponse);
}

export async function recordGuidedDeliveryResult(pool, workfileIdValue, attemptIdValue, input = {}, actorUserId = null) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const attemptId = normalizeAttemptId(attemptIdValue);
  const status = String(input.status || "").trim();
  if (!["delivered", "failed", "cancelled"].includes(status)) throw new Error("delivery_status_invalid");
  const externalDeliveryId = optionalText(input.external_delivery_id, 200, "delivery_external_delivery_id_invalid");
  const receiptReference = optionalText(input.receipt_reference, 500, "delivery_receipt_reference_invalid");
  const failureCode = optionalText(input.failure_code, 120, "delivery_failure_code_invalid");
  if (failureCode && !/^[a-z0-9_.-]+$/.test(failureCode)) {
    throw new Error("delivery_failure_code_invalid");
  }
  if (status === "delivered" && !externalDeliveryId && !receiptReference) {
    throw new Error("delivery_receipt_required");
  }
  if (status === "failed" && !failureCode) throw new Error("delivery_failure_code_required");
  const result = await pool.query(
    `UPDATE appraisal.delivery_attempts
        SET status = $3,
            external_delivery_id = CASE WHEN $3 = 'delivered' THEN $4 ELSE external_delivery_id END,
            receipt_reference = CASE WHEN $3 = 'delivered' THEN $5 ELSE receipt_reference END,
            delivered_at = CASE WHEN $3 = 'delivered' THEN now() ELSE delivered_at END,
            failed_at = CASE WHEN $3 = 'failed' THEN now() ELSE failed_at END,
            failure_code = CASE WHEN $3 = 'failed' THEN $6 ELSE failure_code END,
            completed_by_user_id = $7,
            updated_at = now()
      WHERE id = $1 AND workfile_id = $2 AND status = 'prepared'
      RETURNING *`,
    [attemptId, workfileId, status, externalDeliveryId, receiptReference, failureCode, actorUserId],
  );
  if (!result.rows.length) throw new Error("delivery_attempt_not_found_or_completed");
  const hydrated = await pool.query(`${ATTEMPT_SELECT} WHERE attempt.id = $1`, [attemptId]);
  return attemptResponse(hydrated.rows[0]);
}
