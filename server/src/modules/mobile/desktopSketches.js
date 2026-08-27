import { createHash, randomUUID } from "node:crypto";

import { normalizeUuid } from "./reportFiles.js";
import {
  activeRooms,
  normalizeManualSketchDocument,
  sketchResponse,
  synchronizeRooms,
} from "./sketches.js";
import { canonicalJson } from "./sync.js";

function hashRequest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function propertyLabel(row) {
  return [row.address, row.city, row.state, row.postal_code].filter(Boolean).join(", ");
}

async function assignmentSketchRow(client, accountId, assignmentFileId, { lock = false } = {}) {
  const sql = [
    "SELECT sketch.*,",
    "       report_file.file_number AS report_file_number,",
    "       report_file.registry_revision,",
    "       assignment_file.file_number AS assignment_file_number,",
    "       account.address, account.city, account.state, account.postal_code,",
    "       session.revision AS session_revision",
    "  FROM app.assignment_files assignment_file",
    "  JOIN core.accounts account ON account.account_id = assignment_file.account_id",
    "  JOIN app.report_files report_file",
    "    ON report_file.custom_assignment_file_id = assignment_file.id",
    "  JOIN app.inspection_sketches sketch ON sketch.report_file_id = report_file.id",
    "  JOIN app.inspection_sessions session ON session.id = sketch.inspection_session_id",
    " WHERE assignment_file.id = $1 AND assignment_file.account_id = $2",
    " ORDER BY sketch.updated_at DESC, sketch.id DESC",
    " LIMIT 1",
    lock ? " FOR UPDATE OF sketch, report_file, session" : "",
  ].join("\n");
  const { rows } = await client.query(sql, [assignmentFileId, accountId]);
  return rows[0] || null;
}

async function propertyTaxSketchRow(client, accountId, fileId, { lock = false } = {}) {
  const sql = [
    "SELECT sketch.* ,",
    "       report_file.file_number AS report_file_number,",
    "       report_file.registry_revision,",
    "       protest.file_number AS assignment_file_number,",
    "       account.address, account.city, account.state, account.postal_code,",
    "       session.revision AS session_revision",
    "  FROM app.tax_protest_files protest",
    "  JOIN core.accounts account ON account.account_id = protest.account_id",
    "  JOIN app.report_files report_file",
    "    ON report_file.tax_protest_file_id = protest.id",
    "   AND report_file.workflow_type = 'property_tax_protest'",
    "  JOIN app.inspection_sketches sketch ON sketch.report_file_id = report_file.id",
    "  JOIN app.inspection_sessions session ON session.id = sketch.inspection_session_id",
    " WHERE protest.id = $1 AND protest.account_id = $2",
    " ORDER BY sketch.updated_at DESC, sketch.id DESC",
    " LIMIT 1",
    lock ? " FOR UPDATE OF sketch, report_file, session" : "",
  ].join("\n");
  const { rows } = await client.query(sql, [fileId, accountId]);
  return rows[0] || null;
}

export function assignmentSketchArtifactOptions(row) {
  return Object.freeze({
    fileNumber: row.assignment_file_number || row.report_file_number,
    propertyLabel: propertyLabel(row),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
  });
}

export async function getAssignmentInspectionSketch(pool, accountId, assignmentFileId) {
  const client = await pool.connect();
  try {
    const row = await assignmentSketchRow(client, accountId, assignmentFileId);
    if (!row) return null;
    return Object.freeze({
      sketch: sketchResponse(row, await activeRooms(client, row.id)),
      artifact_options: assignmentSketchArtifactOptions(row),
    });
  } finally {
    client.release();
  }
}

async function saveDesktopInspectionSketch(
  pool,
  loadRow,
  requestScope,
  input = {},
  actorUserId = null,
) {
  const expectedRevision = Number(input.expected_revision);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new Error("invalid_sketch_expected_revision");
  }
  const clientOperationId = input.client_operation_id
    ? normalizeUuid(input.client_operation_id, "invalid_sketch_operation_id")
    : randomUUID();
  const reviewer = String(input.reviewer || "HomeNode editor").trim().slice(0, 200) || "HomeNode editor";
  const document = normalizeManualSketchDocument(input.sketch);
  const requestSha = hashRequest({ ...requestScope, expectedRevision, document });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await loadRow(client, { lock: true });
    if (!row) throw new Error(requestScope.notFoundCode || "assignment_sketch_not_found");

    const priorOperation = await client.query(
      [
        "SELECT request_sha256, result",
        "  FROM app.inspection_sketch_operations",
        " WHERE inspection_session_id = $1 AND client_operation_id = $2",
      ].join("\n"),
      [row.inspection_session_id, clientOperationId],
    );
    if (priorOperation.rows.length) {
      if (priorOperation.rows[0].request_sha256 !== requestSha) {
        throw new Error("sketch_operation_conflict");
      }
      await client.query("COMMIT");
      return priorOperation.rows[0].result;
    }

    if (Number(row.revision) !== expectedRevision) {
      const conflict = new Error("sketch_revision_conflict");
      conflict.currentRevision = Number(row.revision);
      throw conflict;
    }

    const nextRevision = expectedRevision + 1;
    const confirmed = document.review_status === "appraiser_confirmed";
    const updatedResult = await client.query(
      [
        "UPDATE app.inspection_sketches",
        "   SET measurement_standard = $2,",
        "       measurement_method = $3,",
        "       review_status = $4,",
        "       document = $5::jsonb,",
        "       summary = $6::jsonb,",
        "       revision = revision + 1,",
        "       confirmed_by_user_id = CASE WHEN $4 = 'appraiser_confirmed' THEN $7 ELSE NULL END,",
        "       confirmed_at = CASE WHEN $4 = 'appraiser_confirmed' THEN COALESCE(confirmed_at, now()) ELSE NULL END,",
        "       updated_by_user_id = $7,",
        "       updated_at = now()",
        " WHERE id = $1",
        " RETURNING *",
      ].join("\n"),
      [
        row.id,
        document.measurement_standard,
        document.measurement_method,
        document.review_status,
        JSON.stringify(document),
        JSON.stringify(document.summary),
        actorUserId || row.updated_by_user_id,
      ],
    );
    const sketchRow = updatedResult.rows[0];
    const relabeledPhotos = await synchronizeRooms(client, sketchRow, document);
    const rooms = await activeRooms(client, sketchRow.id);

    await client.query(
      [
        "INSERT INTO app.inspection_sketch_history (",
        "  sketch_id, inspection_session_id, revision, document, summary, rooms,",
        "  review_status, changed_by_user_id, client_operation_id",
        ") VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)",
      ].join("\n"),
      [
        sketchRow.id,
        row.inspection_session_id,
        nextRevision,
        JSON.stringify(document),
        JSON.stringify(document.summary),
        JSON.stringify(document.rooms),
        document.review_status,
        actorUserId,
        clientOperationId,
      ],
    );

    const reportRevision = await client.query(
      [
        "UPDATE app.report_files",
        "   SET registry_revision = registry_revision + 1, updated_at = now()",
        " WHERE id = $1",
        " RETURNING registry_revision",
      ].join("\n"),
      [row.report_file_id],
    );
    await client.query(
      "UPDATE app.inspection_sessions SET last_synced_at = now(), updated_at = now() WHERE id = $1",
      [row.inspection_session_id],
    );
    const eventType = confirmed ? "sketch.appraiser_confirmed" : "sketch.updated";
    await client.query(
      [
        "INSERT INTO app.inspection_sketch_events (",
        "  sketch_id, inspection_session_id, report_file_id, actor_user_id,",
        "  client_operation_id, event_type, prior_revision, next_revision, metadata",
        ") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
      ].join("\n"),
      [
        sketchRow.id,
        row.inspection_session_id,
        row.report_file_id,
        actorUserId,
        clientOperationId,
        eventType,
        expectedRevision,
        nextRevision,
        JSON.stringify({
          source: "desktop_review",
          reviewer,
          relabeled_photo_count: relabeledPhotos,
          area_count: document.summary.area_count,
          room_count: document.summary.room_count,
        }),
      ],
    );
    await client.query(
      [
        "INSERT INTO app.inspection_session_events (",
        "  inspection_session_id, actor_user_id, event_type, prior_revision, next_revision, metadata",
        ") VALUES ($1, $2, $3, $4, $4, $5::jsonb)",
      ].join("\n"),
      [
        row.inspection_session_id,
        actorUserId,
        eventType,
        Number(row.session_revision),
        JSON.stringify({ source: "desktop_review", reviewer, sketch_revision: nextRevision }),
      ],
    );
    await client.query(
      [
        "INSERT INTO app.report_file_events (",
        "  report_file_id, actor_user_id, event_type, prior_registry_revision,",
        "  next_registry_revision, changed_fields, metadata",
        ") VALUES ($1, $2, 'mobile_sketch.updated', $3, $4, ARRAY['inspection_sketch'], $5::jsonb)",
      ].join("\n"),
      [
        row.report_file_id,
        actorUserId,
        Number(row.registry_revision),
        Number(reportRevision.rows[0].registry_revision),
        JSON.stringify({
          source: "desktop_review",
          reviewer,
          sketch_revision: nextRevision,
          review_status: document.review_status,
        }),
      ],
    );

    const result = JSON.parse(JSON.stringify({
      sketch: sketchResponse(sketchRow, rooms),
      report_registry_revision: Number(reportRevision.rows[0].registry_revision),
    }));
    await client.query(
      [
        "INSERT INTO app.inspection_sketch_operations (",
        "  inspection_session_id, client_operation_id, request_sha256,",
        "  base_sketch_revision, status, result, actor_user_id",
        ") VALUES ($1, $2, $3, $4, 'applied', $5::jsonb, $6)",
      ].join("\n"),
      [
        row.inspection_session_id,
        clientOperationId,
        requestSha,
        expectedRevision,
        JSON.stringify(result),
        actorUserId,
      ],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function saveAssignmentInspectionSketch(
  pool,
  accountId,
  assignmentFileId,
  input = {},
  actorUserId = null,
) {
  return saveDesktopInspectionSketch(
    pool,
    (client, options) => assignmentSketchRow(client, accountId, assignmentFileId, options),
    {
      workflow: "custom_appraisal",
      accountId,
      assignmentFileId,
      notFoundCode: "assignment_sketch_not_found",
    },
    input,
    actorUserId,
  );
}

export async function savePropertyTaxInspectionSketch(
  pool,
  accountId,
  fileId,
  input = {},
  actorUserId = null,
) {
  return saveDesktopInspectionSketch(
    pool,
    (client, options) => propertyTaxSketchRow(client, accountId, fileId, options),
    {
      workflow: "property_tax_protest",
      accountId,
      fileId,
      notFoundCode: "property_tax_protest_sketch_not_found",
    },
    input,
    actorUserId,
  );
}
