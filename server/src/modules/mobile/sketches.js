import { createHash } from "node:crypto";

import { calculateManualSketch } from "./manualSketch.js";
import { normalizeUuid, sessionResponse } from "./reportFiles.js";
import { canonicalJson } from "./sync.js";

const MAX_AREAS = 20;
const MAX_ROOMS = 100;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const AREA_CLASSIFICATIONS = new Set([
  "above_grade_finished",
  "above_grade_nonstandard_finished",
  "above_grade_noncontinuous_finished",
  "above_grade_unfinished",
  "below_grade_finished",
  "below_grade_nonstandard_finished",
  "below_grade_unfinished",
  "garage",
  "porch",
  "patio",
  "deck",
  "outbuilding",
  "other",
]);
const ROOM_TYPES = new Set([
  "living_room",
  "family_room",
  "dining_room",
  "kitchen",
  "bedroom",
  "bathroom",
  "utility",
  "office",
  "foyer",
  "hall",
  "closet",
  "garage",
  "storage",
  "other",
]);
const MEASUREMENT_STANDARDS = new Set(["ansi_z765_2021", "jurisdiction_required_other"]);
const MEASUREMENT_METHODS = new Set(["exterior", "interior_perimeter", "plans", "mixed"]);
const REVIEW_STATUSES = new Set(["draft", "appraiser_confirmed"]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedText(value, code, maximum, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function finiteCoordinate(value, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 100_000) throw new Error(code);
  return Math.round(number * 1000) / 1000;
}

function boundedInteger(value, code, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(code);
  return number;
}

function enumValue(value, allowed, code) {
  const normalized = String(value || "").trim();
  if (!allowed.has(normalized)) throw new Error(code);
  return normalized;
}

function pointInsidePolygon(point, vertices) {
  let inside = false;
  for (let left = 0, right = vertices.length - 1; left < vertices.length; right = left, left += 1) {
    const a = vertices[left];
    const b = vertices[right];
    const cross = ((point.y - a.y) * (b.x - a.x)) - ((point.x - a.x) * (b.y - a.y));
    const onEdge = Math.abs(cross) < 1e-7
      && point.x >= Math.min(a.x, b.x) - 1e-7
      && point.x <= Math.max(a.x, b.x) + 1e-7
      && point.y >= Math.min(a.y, b.y) - 1e-7
      && point.y <= Math.max(a.y, b.y) + 1e-7;
    if (onEdge) return true;
    const crosses = ((a.y > point.y) !== (b.y > point.y))
      && point.x < (((b.x - a.x) * (point.y - a.y)) / (b.y - a.y)) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function roomRef(clientRoomId) {
  return `sketch-room:${clientRoomId}`;
}

function normalizeArea(input, index) {
  if (!plainObject(input)) throw new Error("invalid_sketch_area");
  const id = normalizeUuid(input.id || input.client_area_id, "invalid_sketch_area_id");
  const calculation = calculateManualSketch({
    vertices: input.vertices,
    closure_tolerance_feet: input.closure_tolerance_feet,
  });
  return Object.freeze({
    id,
    label: boundedText(input.label || `Area ${index + 1}`, "invalid_sketch_area_label", 80),
    level_label: boundedText(input.level_label || "Level 1", "invalid_sketch_level_label", 80),
    classification: enumValue(
      input.classification || "above_grade_finished",
      AREA_CLASSIFICATIONS,
      "invalid_sketch_area_classification",
    ),
    notes: input.notes == null ? null : boundedText(input.notes, "invalid_sketch_area_notes", 1000, { nullable: true }),
    vertices: calculation.vertices,
    calculation,
    position: boundedInteger(input.position ?? index + 1, "invalid_sketch_area_position", 1, MAX_AREAS),
  });
}

function normalizeRoom(input, index, areaMap) {
  if (!plainObject(input)) throw new Error("invalid_sketch_room");
  const id = normalizeUuid(input.id || input.client_room_id, "invalid_sketch_room_id");
  const areaId = normalizeUuid(input.area_id || input.area_ref, "invalid_sketch_room_area_id");
  const area = areaMap.get(areaId);
  if (!area || !area.calculation.ready_for_area_classification) throw new Error("invalid_sketch_room_area");
  const anchor = {
    x: finiteCoordinate(input.anchor?.x, "invalid_sketch_room_anchor"),
    y: finiteCoordinate(input.anchor?.y, "invalid_sketch_room_anchor"),
  };
  if (!pointInsidePolygon(anchor, area.vertices)) throw new Error("invalid_sketch_room_anchor");
  return Object.freeze({
    id,
    room_ref: roomRef(id),
    area_id: areaId,
    label: boundedText(input.label, "invalid_sketch_room_label", 80),
    room_type: enumValue(input.room_type || "other", ROOM_TYPES, "invalid_sketch_room_type"),
    level_label: area.level_label,
    anchor,
    position: boundedInteger(input.position ?? index + 1, "invalid_sketch_room_position", 1, MAX_ROOMS),
  });
}

function sketchSummary(areas, rooms) {
  const byClassification = {};
  for (const area of areas) {
    const squareFeet = area.calculation.reported_area_sqft || 0;
    byClassification[area.classification] = (byClassification[area.classification] || 0) + squareFeet;
  }
  return Object.freeze({
    area_count: areas.length,
    room_count: rooms.length,
    all_areas_closed: areas.every((area) => area.calculation.closed),
    any_self_intersections: areas.some((area) => area.calculation.self_intersecting),
    above_grade_finished_sqft: byClassification.above_grade_finished || 0,
    below_grade_finished_sqft: byClassification.below_grade_finished || 0,
    above_grade_nonstandard_finished_sqft: byClassification.above_grade_nonstandard_finished || 0,
    below_grade_nonstandard_finished_sqft: byClassification.below_grade_nonstandard_finished || 0,
    above_grade_noncontinuous_finished_sqft: byClassification.above_grade_noncontinuous_finished || 0,
    above_grade_unfinished_sqft: byClassification.above_grade_unfinished || 0,
    below_grade_unfinished_sqft: byClassification.below_grade_unfinished || 0,
    garage_sqft: byClassification.garage || 0,
    porch_patio_deck_sqft: (byClassification.porch || 0)
      + (byClassification.patio || 0)
      + (byClassification.deck || 0),
    by_classification: byClassification,
  });
}

export function normalizeManualSketchDocument(input = {}) {
  if (!plainObject(input)) throw new Error("invalid_manual_sketch");
  if (!Array.isArray(input.areas) || input.areas.length < 1 || input.areas.length > MAX_AREAS) {
    throw new Error("invalid_sketch_areas");
  }
  if (!Array.isArray(input.rooms) || input.rooms.length > MAX_ROOMS) throw new Error("invalid_sketch_rooms");
  const areas = input.areas.map(normalizeArea).sort((left, right) => left.position - right.position);
  if (new Set(areas.map((area) => area.id)).size !== areas.length) throw new Error("duplicate_sketch_area_id");
  const areaMap = new Map(areas.map((area) => [area.id, area]));
  const rooms = input.rooms.map((room, index) => normalizeRoom(room, index, areaMap))
    .sort((left, right) => left.position - right.position);
  if (new Set(rooms.map((room) => room.id)).size !== rooms.length) throw new Error("duplicate_sketch_room_id");
  const measurementStandard = enumValue(
    input.measurement_standard || "ansi_z765_2021",
    MEASUREMENT_STANDARDS,
    "invalid_sketch_measurement_standard",
  );
  const alternateStandardName = input.alternate_standard_name == null
    ? null
    : boundedText(input.alternate_standard_name, "invalid_sketch_alternate_standard", 120, { nullable: true });
  if (measurementStandard === "jurisdiction_required_other" && !alternateStandardName) {
    throw new Error("invalid_sketch_alternate_standard");
  }
  const reviewStatus = enumValue(input.review_status || "draft", REVIEW_STATUSES, "invalid_sketch_review_status");
  const readyForReview = areas.every((area) => area.calculation.ready_for_area_classification);
  if (reviewStatus === "appraiser_confirmed" && !readyForReview) throw new Error("sketch_not_ready_for_confirmation");
  const summary = sketchSummary(areas, rooms);
  const document = {
    schema_version: "2.0",
    source: "manual",
    units: "feet",
    dimension_precision_feet: 0.1,
    measurement_standard: measurementStandard,
    alternate_standard_name: alternateStandardName,
    measurement_method: enumValue(
      input.measurement_method || "exterior",
      MEASUREMENT_METHODS,
      "invalid_sketch_measurement_method",
    ),
    review_status: reviewStatus,
    review_notes: input.review_notes == null
      ? null
      : boundedText(input.review_notes, "invalid_sketch_review_notes", 4000, { nullable: true }),
    areas,
    rooms,
    summary,
    ansi_review_required: reviewStatus !== "appraiser_confirmed",
  };
  if (Buffer.byteLength(canonicalJson(document), "utf8") > MAX_DOCUMENT_BYTES) {
    throw new Error("invalid_sketch_document_size");
  }
  return Object.freeze(document);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function accessibleSession(client, auth, sessionId, { lock = false } = {}) {
  const organizationIds = auth.organizations.map((item) => item.organizationId);
  const { rows } = await client.query(
    `SELECT session.*, report_file.workflow_type, report_file.account_id,
            report_file.file_number, report_file.registry_revision
       FROM app.inspection_sessions session
       JOIN app.report_files report_file ON report_file.id = session.report_file_id
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3
      ${lock ? "FOR UPDATE OF session, report_file" : ""}`,
    [sessionId, organizationIds, auth.userId],
  );
  if (!rows.length) throw new Error("inspection_session_not_found");
  return rows[0];
}

function normalizedTimestamp(value) {
  return value instanceof Date ? value.toISOString() : value;
}

export function sketchResponse(row, rooms = []) {
  return Object.freeze({
    id: row.id,
    client_sketch_id: row.client_sketch_id,
    inspection_session_id: row.inspection_session_id,
    report_file_id: row.report_file_id,
    workflow_type: row.workflow_type,
    revision: Number(row.revision),
    document: row.document,
    summary: row.summary,
    review_status: row.review_status,
    ansi_review_required: row.review_status !== "appraiser_confirmed",
    confirmed_by_user_id: row.confirmed_by_user_id || null,
    confirmed_at: normalizedTimestamp(row.confirmed_at) || null,
    rooms: rooms.map((room) => ({
      id: room.client_room_id,
      room_ref: room.room_ref,
      area_id: room.area_ref,
      label: room.label,
      room_type: room.room_type,
      level_label: room.level_label,
      anchor: room.anchor,
      position: Number(room.position),
      photo_count: Number(room.photo_count || 0),
    })),
    created_at: normalizedTimestamp(row.created_at),
    updated_at: normalizedTimestamp(row.updated_at),
  });
}

export async function activeRooms(client, sketchId) {
  const { rows } = await client.query(
    `SELECT room.*,
            count(photo.id) FILTER (WHERE photo.status NOT IN ('excluded', 'deleted')) AS photo_count
       FROM app.inspection_sketch_rooms room
       LEFT JOIN app.inspection_photos photo
         ON photo.inspection_session_id = room.inspection_session_id
        AND photo.room_ref = room.room_ref
      WHERE room.sketch_id = $1 AND room.deleted_at IS NULL
      GROUP BY room.id
      ORDER BY room.position, room.created_at, room.id`,
    [sketchId],
  );
  return rows;
}

export async function getInspectionSketch(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const client = await pool.connect();
  try {
    const session = await accessibleSession(client, auth, sessionId);
    const { rows } = await client.query(
      "SELECT * FROM app.inspection_sketches WHERE inspection_session_id = $1",
      [sessionId],
    );
    return Object.freeze({
      session: sessionResponse(session),
      sketch: rows[0] ? sketchResponse(rows[0], await activeRooms(client, rows[0].id)) : null,
    });
  } finally {
    client.release();
  }
}

export async function synchronizeRooms(client, sketchRow, document) {
  const roomIds = document.rooms.map((room) => room.id);
  await client.query(
    `UPDATE app.inspection_sketch_rooms
        SET deleted_at = now(), revision = revision + 1, updated_at = now()
      WHERE sketch_id = $1 AND deleted_at IS NULL
        AND NOT (client_room_id = ANY($2::uuid[]))`,
    [sketchRow.id, roomIds],
  );
  let relabeledPhotos = 0;
  for (const room of document.rooms) {
    const previous = await client.query(
      `SELECT label FROM app.inspection_sketch_rooms
        WHERE sketch_id = $1 AND client_room_id = $2`,
      [sketchRow.id, room.id],
    );
    await client.query(
      `INSERT INTO app.inspection_sketch_rooms (
         sketch_id, inspection_session_id, report_file_id, client_room_id, room_ref,
         area_ref, label, room_type, level_label, anchor, position
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
       ON CONFLICT (sketch_id, client_room_id) DO UPDATE SET
         area_ref = excluded.area_ref,
         label = excluded.label,
         room_type = excluded.room_type,
         level_label = excluded.level_label,
         anchor = excluded.anchor,
         position = excluded.position,
         deleted_at = NULL,
         revision = app.inspection_sketch_rooms.revision + 1,
         updated_at = now()`,
      [
        sketchRow.id,
        sketchRow.inspection_session_id,
        sketchRow.report_file_id,
        room.id,
        room.room_ref,
        room.area_id,
        room.label,
        room.room_type,
        room.level_label,
        JSON.stringify(room.anchor),
        room.position,
      ],
    );
    if (previous.rows.length && previous.rows[0].label !== room.label) {
      const updated = await client.query(
        `UPDATE app.inspection_photos
            SET category = $3,
                room_label = $3,
                caption = CASE WHEN caption_source = 'room_auto' THEN $3 ELSE caption END,
                revision = revision + 1,
                updated_at = now()
          WHERE inspection_session_id = $1 AND room_ref = $2 AND status <> 'deleted'
          RETURNING id`,
        [sketchRow.inspection_session_id, room.room_ref, room.label],
      );
      relabeledPhotos += updated.rows.length;
    }
  }
  return relabeledPhotos;
}

export async function saveInspectionSketch(pool, auth, sessionIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const clientOperationId = normalizeUuid(input.client_operation_id, "invalid_sketch_operation_id");
  const clientSketchId = normalizeUuid(input.client_sketch_id, "invalid_client_sketch_id");
  const baseRevision = boundedInteger(input.base_revision, "invalid_sketch_base_revision", 0, 1_000_000_000);
  const document = normalizeManualSketchDocument(input.sketch);
  const requestHash = sha256(canonicalJson({ clientSketchId, baseRevision, document }));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await accessibleSession(client, auth, sessionId, { lock: true });
    const priorOperation = await client.query(
      `SELECT request_sha256, result FROM app.inspection_sketch_operations
        WHERE inspection_session_id = $1 AND client_operation_id = $2`,
      [sessionId, clientOperationId],
    );
    if (priorOperation.rows.length) {
      if (priorOperation.rows[0].request_sha256 !== requestHash) throw new Error("sketch_operation_conflict");
      await client.query("COMMIT");
      return priorOperation.rows[0].result;
    }
    const current = await client.query(
      "SELECT * FROM app.inspection_sketches WHERE inspection_session_id = $1 FOR UPDATE",
      [sessionId],
    );
    const existing = current.rows[0] || null;
    if (existing && existing.client_sketch_id !== clientSketchId) throw new Error("sketch_identity_conflict");
    const currentRevision = existing ? Number(existing.revision) : 0;
    if (baseRevision !== currentRevision) throw new Error("sketch_revision_conflict");
    const nextRevision = currentRevision + 1;
    const confirmed = document.review_status === "appraiser_confirmed";
    let sketchRow;
    if (!existing) {
      const inserted = await client.query(
        `INSERT INTO app.inspection_sketches (
           inspection_session_id, report_file_id, organization_id, client_sketch_id,
           workflow_type, measurement_standard, measurement_method, review_status,
           document, summary, revision, confirmed_by_user_id, confirmed_at,
           created_by_user_id, updated_by_user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 1,
                   $11, CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END, $12, $12)
         RETURNING *`,
        [
          sessionId,
          session.report_file_id,
          session.organization_id,
          clientSketchId,
          session.workflow_type,
          document.measurement_standard,
          document.measurement_method,
          document.review_status,
          JSON.stringify(document),
          JSON.stringify(document.summary),
          confirmed ? auth.userId : null,
          auth.userId,
        ],
      );
      sketchRow = inserted.rows[0];
    } else {
      const updated = await client.query(
        `UPDATE app.inspection_sketches
            SET measurement_standard = $2,
                measurement_method = $3,
                review_status = $4,
                document = $5::jsonb,
                summary = $6::jsonb,
                revision = revision + 1,
                confirmed_by_user_id = CASE WHEN $4 = 'appraiser_confirmed' THEN $7 ELSE NULL END,
                confirmed_at = CASE WHEN $4 = 'appraiser_confirmed' THEN COALESCE(confirmed_at, now()) ELSE NULL END,
                updated_by_user_id = $7,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [
          existing.id,
          document.measurement_standard,
          document.measurement_method,
          document.review_status,
          JSON.stringify(document),
          JSON.stringify(document.summary),
          auth.userId,
        ],
      );
      sketchRow = updated.rows[0];
    }
    const relabeledPhotos = await synchronizeRooms(client, sketchRow, document);
    const rooms = await activeRooms(client, sketchRow.id);
    await client.query(
      `INSERT INTO app.inspection_sketch_history (
         sketch_id, inspection_session_id, revision, document, summary, rooms,
         review_status, changed_by_user_id, client_operation_id
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9)`,
      [
        sketchRow.id,
        sessionId,
        nextRevision,
        JSON.stringify(document),
        JSON.stringify(document.summary),
        JSON.stringify(document.rooms),
        document.review_status,
        auth.userId,
        clientOperationId,
      ],
    );
    const reportRevision = await client.query(
      `UPDATE app.report_files
          SET registry_revision = registry_revision + 1, updated_at = now()
        WHERE id = $1
        RETURNING registry_revision`,
      [session.report_file_id],
    );
    const updatedSession = await client.query(
      `UPDATE app.inspection_sessions
          SET last_synced_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [sessionId],
    );
    const eventType = confirmed
      ? "sketch.appraiser_confirmed"
      : existing ? "sketch.updated" : "sketch.created";
    await client.query(
      `INSERT INTO app.inspection_sketch_events (
         sketch_id, inspection_session_id, report_file_id, actor_user_id,
         client_operation_id, event_type, prior_revision, next_revision, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        sketchRow.id,
        sessionId,
        session.report_file_id,
        auth.userId,
        clientOperationId,
        eventType,
        currentRevision || null,
        nextRevision,
        JSON.stringify({
          area_count: document.summary.area_count,
          room_count: document.summary.room_count,
          relabeled_photo_count: relabeledPhotos,
          measurement_standard: document.measurement_standard,
        }),
      ],
    );
    await client.query(
      `INSERT INTO app.inspection_session_events (
         inspection_session_id, actor_user_id, event_type, prior_revision, next_revision, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        sessionId,
        auth.userId,
        eventType,
        Number(session.revision),
        Number(session.revision),
        JSON.stringify({ sketch_revision: nextRevision }),
      ],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, actor_user_id, event_type, prior_registry_revision,
         next_registry_revision, changed_fields, metadata
       ) VALUES ($1, $2, 'mobile_sketch.updated', $3, $4, ARRAY['inspection_sketch'], $5::jsonb)`,
      [
        session.report_file_id,
        auth.userId,
        Number(session.registry_revision),
        Number(reportRevision.rows[0].registry_revision),
        JSON.stringify({ sketch_revision: nextRevision, review_status: document.review_status }),
      ],
    );
    const result = JSON.parse(JSON.stringify({
      session: sessionResponse(updatedSession.rows[0]),
      sketch: sketchResponse(sketchRow, rooms),
      report_registry_revision: Number(reportRevision.rows[0].registry_revision),
    }));
    await client.query(
      `INSERT INTO app.inspection_sketch_operations (
         inspection_session_id, client_operation_id, request_sha256,
         base_sketch_revision, status, result, actor_user_id
       ) VALUES ($1, $2, $3, $4, 'applied', $5::jsonb, $6)`,
      [sessionId, clientOperationId, requestHash, baseRevision, JSON.stringify(result), auth.userId],
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

export async function validateSketchRoom(client, sessionId, roomRefValue, roomLabelValue) {
  const roomRefValueNormalized = String(roomRefValue || "").trim().toLowerCase();
  const match = /^sketch-room:([0-9a-f-]{36})$/.exec(roomRefValueNormalized);
  if (!match) throw new Error("invalid_mobile_photo_sketch_room");
  normalizeUuid(match[1], "invalid_mobile_photo_sketch_room");
  const { rows } = await client.query(
    `SELECT room_ref, label, client_room_id
       FROM app.inspection_sketch_rooms
      WHERE inspection_session_id = $1 AND room_ref = $2 AND deleted_at IS NULL`,
    [sessionId, roomRefValueNormalized],
  );
  if (!rows.length) throw new Error("mobile_photo_sketch_room_not_found");
  const suppliedLabel = String(roomLabelValue || "").trim();
  if (!suppliedLabel || suppliedLabel.length > 80) throw new Error("invalid_mobile_photo_room_label");
  return Object.freeze({
    roomRef: rows[0].room_ref,
    roomLabel: rows[0].label,
    clientRoomId: rows[0].client_room_id,
  });
}

export const MANUAL_SKETCH_AREA_CLASSIFICATIONS = Object.freeze([...AREA_CLASSIFICATIONS]);
