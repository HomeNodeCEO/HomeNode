import { randomUUID } from "node:crypto";

import { UAD_SITE_ENTITY_GROUPS } from "./siteCatalog.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const EDITABLE_ENTITY_TYPES = new Set(Object.keys(UAD_SITE_ENTITY_GROUPS));

function entityResponse(row) {
  return {
    id: row.id,
    workfile_id: row.workfile_id,
    parent_entity_id: row.parent_entity_id || null,
    entity_type: row.entity_type,
    entity_identifier: row.entity_identifier,
    ordinal: Number(row.ordinal),
    label: row.label || null,
    data: row.data || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeEntityType(value) {
  const entityType = String(value || "").trim();
  if (!EDITABLE_ENTITY_TYPES.has(entityType)) throw new Error("invalid_uad_entity_type");
  return entityType;
}

export async function listUadEntities(queryable, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const { rows } = await queryable.query(
    `SELECT *
       FROM appraisal.uad_entities
      WHERE workfile_id = $1
      ORDER BY entity_type, ordinal, id`,
    [workfileId],
  );
  return rows.map(entityResponse);
}

export async function createUadEntity(pool, workfileIdValue, input = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const entityType = normalizeEntityType(input.entity_type);
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");
    const ordinalResult = await client.query(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
         FROM appraisal.uad_entities
        WHERE workfile_id = $1 AND entity_type = $2`,
      [workfileId, entityType],
    );
    const ordinal = Number(ordinalResult.rows[0].ordinal);
    const group = UAD_SITE_ENTITY_GROUPS[entityType];
    const singular = group.title.replace(/ies$/, "y").replace(/s$/, "");
    const inserted = await client.query(
      `INSERT INTO appraisal.uad_entities (
         id, workfile_id, entity_type, entity_identifier, ordinal, label, data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        id,
        workfileId,
        entityType,
        `${entityType.replaceAll("_", "-")}-${ordinal}`,
        ordinal,
        String(input.label || `${singular} ${ordinal}`).trim().slice(0, 120),
        JSON.stringify(input.data || {}),
      ],
    );
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, after_data
       ) VALUES ($1, 'uad_entity.created', $2, $3, $4::jsonb)`,
      [workfileId, entityType, id, JSON.stringify({ ordinal, label: inserted.rows[0].label })],
    );
    await client.query("UPDATE appraisal.uad_workfiles SET updated_at = now() WHERE id = $1", [workfileId]);
    await client.query("COMMIT");
    return entityResponse(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteUadEntity(pool, workfileIdValue, entityIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const entityId = normalizeUadWorkfileId(entityIdValue);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query(
      `SELECT * FROM appraisal.uad_entities
        WHERE id = $1 AND workfile_id = $2
        FOR UPDATE`,
      [entityId, workfileId],
    );
    if (!selected.rows.length) throw new Error("uad_entity_not_found");
    if (!EDITABLE_ENTITY_TYPES.has(selected.rows[0].entity_type)) throw new Error("invalid_uad_entity_type");
    await client.query("DELETE FROM appraisal.uad_entities WHERE id = $1", [entityId]);
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, before_data
       ) VALUES ($1, 'uad_entity.deleted', $2, $3, $4::jsonb)`,
      [workfileId, selected.rows[0].entity_type, entityId, JSON.stringify(entityResponse(selected.rows[0]))],
    );
    await client.query("UPDATE appraisal.uad_workfiles SET updated_at = now() WHERE id = $1", [workfileId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
