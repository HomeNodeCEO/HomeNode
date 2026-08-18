import { createHash, randomUUID } from "node:crypto";

import { normalizeUuid, sessionResponse } from "./reportFiles.js";

const MAX_BATCH_SIZE = 25;
const MAX_FIELD_PATH = 200;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const FIELD_PATH_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,9}$/;
const PAYLOAD_HASH_PATTERN = /^[a-f0-9]{64}$/;
const FIELD_SOURCES = new Set(["appraiser", "measurement", "device", "imported", "suggested"]);
const OPERATION_KINDS = new Set(["field.upsert", "field.delete", "conflict.resolve"]);
const RESOLUTIONS = new Set(["accept_server", "apply_mobile"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_sync_payload");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!plainObject(value)) throw new Error("invalid_sync_payload");
  const entries = Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new Error("invalid_sync_payload");
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  });
  return `{${entries.join(",")}}`;
}

export function syncPayloadSha256(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function exactKeys(value, allowed) {
  if (!plainObject(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("invalid_sync_payload");
  }
}

function normalizedJsonValue(value) {
  const canonical = canonicalJson(value);
  if (Buffer.byteLength(canonical, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("invalid_sync_payload");
  return JSON.parse(canonical);
}

function normalizeFieldState(value) {
  exactKeys(value, new Set(["exists", "value"]));
  if (typeof value.exists !== "boolean") throw new Error("invalid_sync_payload");
  if (!value.exists) {
    if (Object.hasOwn(value, "value")) throw new Error("invalid_sync_payload");
    return Object.freeze({ exists: false });
  }
  if (!Object.hasOwn(value, "value")) throw new Error("invalid_sync_payload");
  return Object.freeze({ exists: true, value: normalizedJsonValue(value.value) });
}

function normalizeFieldPath(value) {
  const fieldPath = String(value || "").trim();
  if (fieldPath.length > MAX_FIELD_PATH || !FIELD_PATH_PATTERN.test(fieldPath)) {
    throw new Error("invalid_field_path");
  }
  return fieldPath;
}

function normalizeFieldPayload(kind, payload) {
  exactKeys(payload, new Set([
    "field_path", "base", "value", "source_type", "appraiser_confirmed",
  ]));
  const fieldPath = normalizeFieldPath(payload.field_path);
  const base = normalizeFieldState(payload.base);
  const sourceType = payload.source_type == null ? "appraiser" : String(payload.source_type);
  if (!FIELD_SOURCES.has(sourceType)) throw new Error("invalid_field_source");
  const appraiserConfirmed = payload.appraiser_confirmed == null ? true : payload.appraiser_confirmed;
  if (typeof appraiserConfirmed !== "boolean") throw new Error("invalid_sync_payload");
  if (kind === "field.delete") {
    if (Object.hasOwn(payload, "value")) throw new Error("invalid_sync_payload");
    return Object.freeze({ field_path: fieldPath, base, source_type: sourceType, appraiser_confirmed: appraiserConfirmed });
  }
  if (!Object.hasOwn(payload, "value")) throw new Error("invalid_sync_payload");
  return Object.freeze({
    field_path: fieldPath,
    base,
    value: normalizedJsonValue(payload.value),
    source_type: sourceType,
    appraiser_confirmed: appraiserConfirmed,
  });
}

function normalizeResolutionPayload(payload) {
  exactKeys(payload, new Set(["conflict_client_operation_id", "resolution"]));
  const resolution = String(payload.resolution || "");
  if (!RESOLUTIONS.has(resolution)) throw new Error("invalid_conflict_resolution");
  return Object.freeze({
    conflict_client_operation_id: normalizeUuid(
      payload.conflict_client_operation_id,
      "invalid_conflict_client_operation_id",
    ),
    resolution,
  });
}

export function normalizeSyncBatch(input = {}) {
  exactKeys(input, new Set(["operations"]));
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > MAX_BATCH_SIZE) {
    throw new Error("invalid_sync_batch");
  }
  return input.operations.map((operation) => {
    exactKeys(operation, new Set([
      "client_operation_id", "operation_kind", "base_session_revision", "payload_sha256", "payload",
    ]));
    const operationKind = String(operation.operation_kind || "");
    if (!OPERATION_KINDS.has(operationKind)) throw new Error("invalid_operation_kind");
    const baseSessionRevision = Number(operation.base_session_revision);
    if (!Number.isInteger(baseSessionRevision) || baseSessionRevision < 1) {
      throw new Error("invalid_base_session_revision");
    }
    const payloadSha256 = String(operation.payload_sha256 || "").toLowerCase();
    if (!PAYLOAD_HASH_PATTERN.test(payloadSha256) || syncPayloadSha256(operation.payload) !== payloadSha256) {
      throw new Error("invalid_payload_sha256");
    }
    const payload = operationKind === "conflict.resolve"
      ? normalizeResolutionPayload(operation.payload)
      : normalizeFieldPayload(operationKind, operation.payload);
    return Object.freeze({
      clientOperationId: normalizeUuid(operation.client_operation_id, "invalid_client_operation_id"),
      operationKind,
      baseSessionRevision,
      payloadSha256,
      payload,
    });
  });
}

function organizationIds(auth) {
  return auth.organizations.map((item) => item.organizationId);
}

async function lockSession(client, auth, sessionId) {
  const { rows } = await client.query(
    `SELECT session.*
       FROM app.inspection_sessions session
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3
      FOR UPDATE`,
    [sessionId, organizationIds(auth), auth.userId],
  );
  if (!rows.length) throw new Error("inspection_session_not_found");
  if (rows[0].status === "completed") throw new Error("inspection_session_completed_conflict");
  return rows[0];
}

function fieldStateFromRow(row) {
  if (!row || row.is_tombstone) return Object.freeze({ exists: false });
  return Object.freeze({ exists: true, value: row.entered_value });
}

async function latestFieldState(client, sessionId, fieldPath) {
  const { rows } = await client.query(
    `SELECT entered_value, is_tombstone, session_revision
       FROM app.inspection_field_edits
      WHERE inspection_session_id = $1 AND field_path = $2 AND sync_status = 'applied'
      ORDER BY session_revision DESC, created_at DESC, id DESC
      LIMIT 1`,
    [sessionId, fieldPath],
  );
  return fieldStateFromRow(rows[0]);
}

function sameFieldState(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function existingOperationResponse(row) {
  return {
    client_operation_id: row.client_operation_id,
    operation_kind: row.operation_kind,
    status: row.status,
    result: row.result || null,
    conflict: row.conflict || null,
    resolved_at: row.resolved_at || null,
    resolution: row.resolution || null,
  };
}

async function findExistingOperation(client, sessionId, operation) {
  const { rows } = await client.query(
    `SELECT * FROM app.mobile_sync_operations
      WHERE inspection_session_id = $1 AND client_operation_id = $2`,
    [sessionId, operation.clientOperationId],
  );
  const existing = rows[0];
  if (!existing) return null;
  if (existing.operation_kind !== operation.operationKind || existing.payload_sha256 !== operation.payloadSha256) {
    throw new Error("client_operation_id_conflict");
  }
  return existingOperationResponse(existing);
}

async function insertSyncOperation(client, sessionId, operation, status, { result = null, conflict = null } = {}) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO app.mobile_sync_operations (
       id, inspection_session_id, client_operation_id, operation_kind,
       base_session_revision, payload_sha256, status, result, conflict, applied_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb,
       CASE WHEN $7 = 'applied' THEN now() ELSE NULL END)`,
    [
      id,
      sessionId,
      operation.clientOperationId,
      operation.operationKind,
      operation.baseSessionRevision,
      operation.payloadSha256,
      status,
      result == null ? null : JSON.stringify(result),
      conflict == null ? null : JSON.stringify(conflict),
    ],
  );
  return id;
}

async function recordSessionEvent(client, sessionId, userId, eventType, priorRevision, nextRevision, metadata) {
  await client.query(
    `INSERT INTO app.inspection_session_events (
       inspection_session_id, actor_user_id, event_type,
       prior_revision, next_revision, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [sessionId, userId, eventType, priorRevision, nextRevision, JSON.stringify(metadata)],
  );
}

async function applyFieldOperation(client, auth, sessionId, operation, currentRevision) {
  const server = await latestFieldState(client, sessionId, operation.payload.field_path);
  if (operation.baseSessionRevision > currentRevision) throw new Error("sync_revision_ahead_conflict");
  if (!sameFieldState(server, operation.payload.base)) {
    const nextRevision = currentRevision + 1;
    const conflict = {
      field_path: operation.payload.field_path,
      base: operation.payload.base,
      server,
      mobile: operation.operationKind === "field.delete"
        ? { exists: false }
        : { exists: true, value: operation.payload.value },
      detected_at: new Date().toISOString(),
      session_revision: nextRevision,
    };
    await insertSyncOperation(client, sessionId, operation, "conflict", { conflict });
    await recordSessionEvent(
      client,
      sessionId,
      auth.userId,
      "inspection_sync.conflict",
      currentRevision,
      nextRevision,
      { client_operation_id: operation.clientOperationId, field_path: operation.payload.field_path },
    );
    return {
      revision: nextRevision,
      response: {
        client_operation_id: operation.clientOperationId,
        operation_kind: operation.operationKind,
        status: "conflict",
        result: null,
        conflict,
      },
    };
  }

  const nextRevision = currentRevision + 1;
  const result = {
    field_path: operation.payload.field_path,
    state: operation.operationKind === "field.delete"
      ? { exists: false }
      : { exists: true, value: operation.payload.value },
    session_revision: nextRevision,
  };
  const syncOperationId = await insertSyncOperation(client, sessionId, operation, "applied", { result });
  await client.query(
    `INSERT INTO app.inspection_field_edits (
       inspection_session_id, client_operation_id, field_path, base_value,
       entered_value, is_tombstone, source_type, appraiser_confirmed,
       sync_status, session_revision, created_by_user_id, applied_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, 'applied', $9, $10, now())`,
    [
      sessionId,
      syncOperationId,
      operation.payload.field_path,
      JSON.stringify(operation.payload.base),
      operation.operationKind === "field.delete" ? null : JSON.stringify(operation.payload.value),
      operation.operationKind === "field.delete",
      operation.payload.source_type,
      operation.payload.appraiser_confirmed,
      nextRevision,
      auth.userId,
    ],
  );
  await recordSessionEvent(
    client,
    sessionId,
    auth.userId,
    operation.operationKind === "field.delete" ? "inspection_field.deleted" : "inspection_field.updated",
    currentRevision,
    nextRevision,
    { client_operation_id: operation.clientOperationId, field_path: operation.payload.field_path },
  );
  return {
    revision: nextRevision,
    response: {
      client_operation_id: operation.clientOperationId,
      operation_kind: operation.operationKind,
      status: "applied",
      result,
      conflict: null,
    },
  };
}

async function applyConflictResolution(client, auth, sessionId, operation, currentRevision) {
  const { rows } = await client.query(
    `SELECT * FROM app.mobile_sync_operations
      WHERE inspection_session_id = $1 AND client_operation_id = $2
        AND status = 'conflict'
      FOR UPDATE`,
    [sessionId, operation.payload.conflict_client_operation_id],
  );
  const target = rows[0];
  if (!target) throw new Error("sync_conflict_not_found");
  if (target.resolved_at) throw new Error("sync_conflict_already_resolved_conflict");
  if (operation.payload.resolution === "apply_mobile" && operation.baseSessionRevision !== currentRevision) {
    throw new Error("sync_resolution_revision_conflict");
  }
  const nextRevision = currentRevision + 1;
  const originalPayload = target.conflict;
  const result = {
    resolved_client_operation_id: operation.payload.conflict_client_operation_id,
    resolution: operation.payload.resolution,
    session_revision: nextRevision,
  };
  const resolutionSyncOperationId = await insertSyncOperation(
    client,
    sessionId,
    operation,
    "applied",
    { result },
  );
  if (operation.payload.resolution === "apply_mobile") {
    const server = await latestFieldState(client, sessionId, originalPayload.field_path);
    await client.query(
      `INSERT INTO app.inspection_field_edits (
         inspection_session_id, client_operation_id, field_path, base_value,
         entered_value, is_tombstone, source_type, appraiser_confirmed,
         sync_status, session_revision, created_by_user_id, applied_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6,
         'appraiser', true, 'applied', $7, $8, now())`,
      [
        sessionId,
        resolutionSyncOperationId,
        originalPayload.field_path,
        JSON.stringify(server),
        originalPayload.mobile.exists ? JSON.stringify(originalPayload.mobile.value) : null,
        !originalPayload.mobile.exists,
        nextRevision,
        auth.userId,
      ],
    );
  }
  await client.query(
    `UPDATE app.mobile_sync_operations
        SET resolved_at = now(), resolved_by_user_id = $3, resolution = $4
      WHERE inspection_session_id = $1 AND client_operation_id = $2`,
    [sessionId, operation.payload.conflict_client_operation_id, auth.userId, operation.payload.resolution],
  );
  await recordSessionEvent(
    client,
    sessionId,
    auth.userId,
    "inspection_sync.conflict_resolved",
    currentRevision,
    nextRevision,
    result,
  );
  return {
    revision: nextRevision,
    response: {
      client_operation_id: operation.clientOperationId,
      operation_kind: operation.operationKind,
      status: "applied",
      result,
      conflict: null,
    },
  };
}

async function hasUnresolvedConflicts(client, sessionId) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM app.mobile_sync_operations
        WHERE inspection_session_id = $1 AND status = 'conflict' AND resolved_at IS NULL
     ) AS has_conflicts`,
    [sessionId],
  );
  return Boolean(rows[0]?.has_conflicts);
}

export async function syncInspectionOperations(pool, auth, sessionIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const operations = normalizeSyncBatch(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await lockSession(client, auth, sessionId);
    let revision = Number(session.revision);
    const responses = [];
    for (const operation of operations) {
      const existing = await findExistingOperation(client, sessionId, operation);
      if (existing) {
        responses.push(existing);
        continue;
      }
      const applied = operation.operationKind === "conflict.resolve"
        ? await applyConflictResolution(client, auth, sessionId, operation, revision)
        : await applyFieldOperation(client, auth, sessionId, operation, revision);
      revision = applied.revision;
      responses.push(applied.response);
    }
    const reviewRequired = await hasUnresolvedConflicts(client, sessionId);
    const updated = await client.query(
      `UPDATE app.inspection_sessions
          SET revision = $2,
              status = $3,
              started_at = COALESCE(started_at, now()),
              last_synced_at = now(),
              review_required_at = CASE WHEN $3 = 'review_required' THEN COALESCE(review_required_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [sessionId, revision, reviewRequired ? "review_required" : "synchronized"],
    );
    await client.query("COMMIT");
    return Object.freeze({ session: sessionResponse(updated.rows[0]), operations: responses });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getInspectionSnapshot(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const sessionResult = await pool.query(
    `SELECT session.*
       FROM app.inspection_sessions session
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3`,
    [sessionId, organizationIds(auth), auth.userId],
  );
  if (!sessionResult.rows.length) throw new Error("inspection_session_not_found");
  const [fieldResult, conflictResult] = await Promise.all([
    pool.query(
      `SELECT DISTINCT ON (field_path)
              field_path, entered_value, is_tombstone, source_type,
              appraiser_confirmed, session_revision, created_at, applied_at
         FROM app.inspection_field_edits
        WHERE inspection_session_id = $1 AND sync_status = 'applied'
        ORDER BY field_path, session_revision DESC, created_at DESC, id DESC`,
      [sessionId],
    ),
    pool.query(
      `SELECT client_operation_id, operation_kind, base_session_revision,
              conflict, received_at
         FROM app.mobile_sync_operations
        WHERE inspection_session_id = $1 AND status = 'conflict' AND resolved_at IS NULL
        ORDER BY received_at, id`,
      [sessionId],
    ),
  ]);
  return Object.freeze({
    session: sessionResponse(sessionResult.rows[0]),
    fields: fieldResult.rows.map((row) => ({
      field_path: row.field_path,
      state: fieldStateFromRow(row),
      source_type: row.source_type,
      appraiser_confirmed: row.appraiser_confirmed,
      session_revision: Number(row.session_revision),
      applied_at: row.applied_at,
    })),
    conflicts: conflictResult.rows.map((row) => ({
      client_operation_id: row.client_operation_id,
      operation_kind: row.operation_kind,
      base_session_revision: Number(row.base_session_revision),
      conflict: row.conflict,
      received_at: row.received_at,
    })),
  });
}
