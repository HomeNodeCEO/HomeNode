import { createHash } from "node:crypto";

import { normalizeAccountId, normalizeUuid } from "./reportFiles.js";
import { mergePropertyTaxWorkfileUpdate } from "./propertyTaxWorkfile.js";
import { activeRooms, sketchResponse } from "./sketches.js";
import { canonicalJson } from "./sync.js";
import { getReportEvidenceVersion } from "../../services/reportEvidenceVersion.js";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function response(row, extras = {}) {
  return {
    report_file_id: row.report_file_id,
    tax_protest_file_id: row.tax_protest_file_id,
    organization_id: row.organization_id,
    assigned_appraiser_user_id: row.assigned_appraiser_user_id || null,
    account_id: row.account_id,
    file_number: row.file_number,
    previous_file_id: row.previous_file_id || null,
    workfile_data: plainObject(row.workfile_data) ? row.workfile_data : {},
    status: row.status,
    revision: Number(row.revision),
    registry_revision: Number(row.registry_revision),
    is_current: Boolean(row.is_current),
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...extras,
  };
}

async function selectFile(queryable, accountId, fileId = null, {
  lock = false,
  organizationIds = null,
} = {}) {
  const result = await queryable.query(
    `SELECT report_file.id AS report_file_id, report_file.registry_revision,
            report_file.is_current, report_file.organization_id,
            protest.id AS tax_protest_file_id, protest.account_id,
            protest.file_number, protest.previous_file_id, protest.workfile_data,
            protest.assigned_appraiser_user_id,
            protest.status, protest.revision, protest.completed_at,
            protest.created_at, protest.updated_at
       FROM app.report_files report_file
       JOIN app.tax_protest_files protest ON protest.id = report_file.tax_protest_file_id
      WHERE report_file.account_id = $1
        AND report_file.workflow_type = 'property_tax_protest'
        AND ($2::uuid IS NULL OR protest.id = $2)
        AND ($3::uuid[] IS NULL OR report_file.organization_id = ANY($3::uuid[]))
      ORDER BY report_file.is_current DESC, protest.updated_at DESC, protest.created_at DESC
      LIMIT 1
      ${lock ? "FOR UPDATE OF report_file, protest" : ""}`,
    [accountId, fileId, organizationIds],
  );
  return result.rows[0] || null;
}

export async function getDesktopPropertyTaxFile(pool, accountIdValue, fileIdValue = null, {
  organizationIds = null,
} = {}) {
  const accountId = normalizeAccountId(accountIdValue);
  const fileId = fileIdValue ? normalizeUuid(fileIdValue, "invalid_property_tax_protest_file_id") : null;
  const row = await selectFile(pool, accountId, fileId, { organizationIds });
  if (!row) return null;
  // Capture the lightweight token before the full evidence. A concurrent commit
  // can make the payload newer than this token, but never older without detection.
  const evidenceVersion = await getReportEvidenceVersion(pool, row.report_file_id);
  const [photos, sketch] = await Promise.all([
    pool.query(
      `SELECT photo.id, photo.category, photo.room_label, photo.caption,
              photo.position, photo.verified_at, photo.retention_until
         FROM app.inspection_photos photo
        WHERE photo.report_file_id = $1 AND photo.status = 'verified'
        ORDER BY photo.position, photo.created_at, photo.id`,
      [row.report_file_id],
    ),
    pool.query(
      `SELECT *
         FROM app.inspection_sketches
        WHERE report_file_id = $1
        ORDER BY revision DESC, updated_at DESC, id DESC LIMIT 1`,
      [row.report_file_id],
    ),
  ]);
  return response(row, {
    ...evidenceVersion,
    photos: {
      verified_count: photos.rows.length,
      items: photos.rows.map((item) => ({ ...item, position: Number(item.position) })),
    },
    sketch: sketch.rows[0]
      ? sketchResponse(sketch.rows[0], await activeRooms(pool, sketch.rows[0].id))
      : null,
  });
}

export async function getDesktopPropertyTaxEvidenceVersion(pool, accountIdValue, fileIdValue, {
  organizationIds = null,
} = {}) {
  const accountId = normalizeAccountId(accountIdValue);
  const fileId = normalizeUuid(fileIdValue, "invalid_property_tax_protest_file_id");
  const row = await selectFile(pool, accountId, fileId, { organizationIds });
  if (!row) return null;
  return {
    report_file_id: row.report_file_id,
    tax_protest_file_id: row.tax_protest_file_id,
    organization_id: row.organization_id,
    assigned_appraiser_user_id: row.assigned_appraiser_user_id || null,
    account_id: row.account_id,
    ...await getReportEvidenceVersion(pool, row.report_file_id),
  };
}

export async function saveDesktopPropertyTaxFile(
  pool,
  accountIdValue,
  fileIdValue,
  input = {},
  { actorUserId = null, actorLabel = null } = {},
) {
  const accountId = normalizeAccountId(accountIdValue);
  const fileId = normalizeUuid(fileIdValue, "invalid_property_tax_protest_file_id");
  if (!plainObject(input) || Object.keys(input).some((key) => !new Set([
    "expected_revision",
    "workfile_data",
    "reviewer",
    "client_operation_id",
  ]).has(key))) {
    throw new Error("invalid_property_tax_protest_update");
  }
  const expectedRevision = Number(input.expected_revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("invalid_property_tax_protest_revision");
  const clientOperationId = input.client_operation_id == null
    ? null
    : normalizeUuid(input.client_operation_id, "invalid_property_tax_protest_client_operation_id");
  const normalizedActorUserId = actorUserId
    ? normalizeUuid(actorUserId, "invalid_property_tax_protest_actor")
    : null;
  const reviewer = normalizedActorUserId
    ? String(actorLabel || "Authenticated HomeNode user").trim().slice(0, 200)
      || "Authenticated HomeNode user"
    : String(input.reviewer || "HomeNode desktop").trim().slice(0, 200) || "HomeNode desktop";
  let requestSha256 = null;
  if (clientOperationId) {
    try {
      requestSha256 = createHash("sha256").update(canonicalJson({
        expected_revision: expectedRevision,
        workfile_data: input.workfile_data,
      })).digest("hex");
    } catch {
      throw new Error("invalid_property_tax_protest_workfile");
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await selectFile(client, accountId, fileId, { lock: true });
    if (!row) throw new Error("property_tax_protest_file_not_found");
    if (clientOperationId) {
      const prior = await client.query(
        `SELECT request_sha256, base_revision, applied_revision, result, actor_user_id
           FROM app.tax_protest_save_operations
          WHERE tax_protest_file_id = $1 AND client_operation_id = $2`,
        [fileId, clientOperationId],
      );
      if (prior.rows.length) {
        const operation = prior.rows[0];
        if (
          operation.request_sha256 !== requestSha256
          || Number(operation.base_revision) !== expectedRevision
          || (operation.actor_user_id || null) !== normalizedActorUserId
        ) {
          throw new Error("property_tax_protest_save_operation_conflict");
        }
        await client.query("COMMIT");
        // Return the current locked file, which can be newer than the original
        // result when another reviewed save followed the retried operation.
        return response(row);
      }
    }
    if (Number(row.revision) !== expectedRevision) {
      const error = new Error("property_tax_protest_revision_conflict");
      error.currentRevision = Number(row.revision);
      throw error;
    }
    const workfileData = mergePropertyTaxWorkfileUpdate(row.workfile_data || {}, input.workfile_data);
    const nextRevision = expectedRevision + 1;
    const updated = await client.query(
      `UPDATE app.tax_protest_files
          SET workfile_data = $2::jsonb, revision = $3, status = 'in_progress',
              updated_by_user_id = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [fileId, JSON.stringify(workfileData), nextRevision, normalizedActorUserId],
    );
    await client.query(
      `INSERT INTO app.tax_protest_file_history (
         tax_protest_file_id, revision, workfile_data, status,
         changed_by_user_id, change_summary
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        fileId,
        nextRevision,
        JSON.stringify(workfileData),
        updated.rows[0].status,
        normalizedActorUserId,
        `${reviewer} saved the desktop protest workfile`,
      ],
    );
    const registry = await client.query(
      `UPDATE app.report_files
          SET registry_revision = registry_revision + 1, updated_at = now()
        WHERE id = $1 RETURNING registry_revision`,
      [row.report_file_id],
    );
    const nextRegistryRevision = Number(registry.rows[0].registry_revision);
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, actor_user_id, event_type, prior_registry_revision,
         next_registry_revision, changed_fields, metadata
       ) VALUES ($1, $2, 'property_tax_protest.desktop_saved', $3, $4, $5::text[], $6::jsonb)`,
      [
        row.report_file_id,
        normalizedActorUserId,
        nextRegistryRevision - 1,
        nextRegistryRevision,
        ["property_tax_protest.workfile_data"],
        JSON.stringify({
          tax_protest_revision: nextRevision,
          reviewer,
          authentication_mode: normalizedActorUserId ? "authenticated" : "legacy_editor_key",
        }),
      ],
    );
    const result = response({
      ...row,
      ...updated.rows[0],
      report_file_id: row.report_file_id,
      tax_protest_file_id: fileId,
      registry_revision: nextRegistryRevision,
    });
    if (clientOperationId) {
      await client.query(
        `INSERT INTO app.tax_protest_save_operations (
           tax_protest_file_id, client_operation_id, request_sha256,
           base_revision, applied_revision, result, actor_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          fileId,
          clientOperationId,
          requestSha256,
          expectedRevision,
          nextRevision,
          JSON.stringify(result),
          normalizedActorUserId,
        ],
      );
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
