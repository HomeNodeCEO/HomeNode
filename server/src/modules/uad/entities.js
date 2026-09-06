import { randomUUID } from "node:crypto";

import { UAD_REPEATABLE_ENTITY_GROUPS } from "./fieldCatalog.js";
import {
  UAD_SUBJECT_AMENITY_CATEGORIES,
  UAD_SUBJECT_AMENITY_CATEGORY_LIMITS,
} from "./subjectPropertyAmenitiesCatalog.js";
import { assertLockedUadWorkfileMutable } from "./workfileLifecycle.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const EDITABLE_ENTITY_TYPES = new Set(Object.keys(UAD_REPEATABLE_ENTITY_GROUPS));

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

export async function createUadEntityWithClient(client, workfileIdValue, input = {}, { actorUserId = null, audit = true, touch = true } = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const entityType = normalizeEntityType(input.entity_type);
  const id = randomUUID();
  const locked = await client.query(
      `SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
      [workfileId],
  );
  if (!locked.rows.length) throw new Error("uad_workfile_not_found");
  await assertLockedUadWorkfileMutable(client, locked.rows[0]);
  const group = UAD_REPEATABLE_ENTITY_GROUPS[entityType];
  let entityData = { ...(input.data || {}) };
  if (["amenity", "sales_comparable_amenity"].includes(entityType)) {
    const amenityCategory = String(entityData.amenity_category || "").trim();
    if (!UAD_SUBJECT_AMENITY_CATEGORIES.includes(amenityCategory)) {
      throw new Error("invalid_uad_amenity_category");
    }
    entityData = { ...entityData, amenity_category: amenityCategory };
  }
  let parentEntityId = input.parent_entity_id == null ? null : normalizeUadWorkfileId(input.parent_entity_id);
  const parentEntityTypes = group.parentEntityTypes
    || (group.parentEntityType ? [group.parentEntityType] : []);
  if (parentEntityTypes.length) {
    const parents = await client.query(
        `SELECT id
           FROM appraisal.uad_entities
          WHERE workfile_id = $1 AND entity_type = ANY($2::text[])
          ORDER BY ordinal, id`,
        [workfileId, parentEntityTypes],
    );
    if (!parentEntityId && parents.rows.length === 1) parentEntityId = parents.rows[0].id;
    if (!parentEntityId) throw new Error("uad_parent_entity_required");
    if (!parents.rows.some((row) => row.id === parentEntityId)) throw new Error("invalid_uad_parent_entity");
  } else if (parentEntityId) {
    throw new Error("invalid_uad_parent_entity");
  }
  if (Number(group.maxItems || 0) > 0) {
    const count = await client.query(
        `SELECT count(*)::integer AS count
           FROM appraisal.uad_entities
          WHERE workfile_id = $1
            AND entity_type = $2
            AND parent_entity_id IS NOT DISTINCT FROM $3::uuid`,
        [workfileId, entityType, parentEntityId],
    );
    if (Number(count.rows[0].count) >= Number(group.maxItems)) {
      throw new Error("invalid_uad_entity_maximum_reached");
    }
  }
  if (["amenity", "sales_comparable_amenity"].includes(entityType)) {
    const categoryCount = await client.query(
        `SELECT count(*)::integer AS count
           FROM appraisal.uad_entities
          WHERE workfile_id = $1
            AND entity_type = $2
            AND parent_entity_id IS NOT DISTINCT FROM $3::uuid
            AND data->>'amenity_category' = $4`,
        [workfileId, entityType, parentEntityId, entityData.amenity_category],
    );
    if (Number(categoryCount.rows[0].count) >= UAD_SUBJECT_AMENITY_CATEGORY_LIMITS[entityData.amenity_category]) {
      throw new Error("invalid_uad_amenity_category_maximum_reached");
    }
  }
  if (entityType === "amenity_defect") {
    const defectCount = await client.query(
        `SELECT count(*)::integer AS count
           FROM appraisal.uad_entities
          WHERE workfile_id = $1 AND entity_type = 'amenity_defect'`,
        [workfileId],
    );
    if (Number(defectCount.rows[0].count) >= 6) {
      throw new Error("invalid_uad_amenity_defect_maximum_reached");
    }
  }
  const ordinalResult = await client.query(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
         FROM appraisal.uad_entities
        WHERE workfile_id = $1 AND entity_type = $2`,
      [workfileId, entityType],
  );
  const ordinal = Number(ordinalResult.rows[0].ordinal);
  const singular = group.title.replace(/ies$/, "y").replace(/s$/, "");
  const inserted = await client.query(
      `INSERT INTO appraisal.uad_entities (
         id, workfile_id, parent_entity_id, entity_type, entity_identifier, ordinal, label, data
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       RETURNING *`,
      [
        id,
        workfileId,
        parentEntityId,
        entityType,
        `${entityType.replaceAll("_", "-")}-${ordinal}`,
        ordinal,
        String(input.label || `${singular} ${ordinal}`).trim().slice(0, 120),
        JSON.stringify(entityData),
      ],
    );
  const calculatedOrdinal = entityType === "sales_comparable"
    ? { context: "sales_comparable", uid: "1800.0192", reportFieldId: "21.007" }
    : entityType === "sales_comparison_additional_property"
      ? { context: "sales_comparison_additional_property", uid: "1900.0017", reportFieldId: "22.17.01" }
      : null;
  if (calculatedOrdinal) {
    await client.query(
      `INSERT INTO appraisal.uad_field_values (
         id, workfile_id, entity_id, field_context, uad_uid, report_field_id,
         value, source_type, source_reference, is_appraiser_confirmed
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::jsonb, 'calculated', 'uad_entity.ordinal', false
       )`,
      [
        randomUUID(), workfileId, id,
        calculatedOrdinal.context, calculatedOrdinal.uid, calculatedOrdinal.reportFieldId,
        JSON.stringify(ordinal),
      ],
    );
  }
  if (audit) {
    await client.query(
        `INSERT INTO appraisal.uad_audit_events (
           workfile_id, actor_user_id, event_type, entity_type, entity_id, after_data
         ) VALUES ($1, $2, 'uad_entity.created', $3, $4, $5::jsonb)`,
      [workfileId, actorUserId, entityType, id, JSON.stringify(entityResponse(inserted.rows[0]))],
    );
  }
  if (touch) {
    await client.query(
      "UPDATE appraisal.uad_workfiles SET status = 'draft', updated_at = now() WHERE id = $1",
      [workfileId],
    );
  }
  return entityResponse(inserted.rows[0]);
}

export async function createUadEntity(pool, workfileIdValue, input = {}, actorUserId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const entity = await createUadEntityWithClient(client, workfileIdValue, input, { actorUserId });
    await client.query("COMMIT");
    return entity;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteUadEntityWithClient(client, workfileIdValue, entityIdValue, { actorUserId = null } = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const entityId = normalizeUadWorkfileId(entityIdValue);
  const locked = await client.query(
    `SELECT id, status, signed_at FROM appraisal.uad_workfiles WHERE id = $1 FOR UPDATE`,
    [workfileId],
  );
  if (!locked.rows.length) throw new Error("uad_workfile_not_found");
  await assertLockedUadWorkfileMutable(client, locked.rows[0]);
  const selected = await client.query(
      `SELECT * FROM appraisal.uad_entities
        WHERE id = $1 AND workfile_id = $2
        FOR UPDATE`,
      [entityId, workfileId],
  );
  if (!selected.rows.length) throw new Error("uad_entity_not_found");
  if (!EDITABLE_ENTITY_TYPES.has(selected.rows[0].entity_type)) throw new Error("invalid_uad_entity_type");
  const group = UAD_REPEATABLE_ENTITY_GROUPS[selected.rows[0].entity_type];
  if (Number(group.minItems || 0) > 0) {
    const siblings = await client.query(
        `SELECT count(*)::integer AS count
           FROM appraisal.uad_entities
          WHERE workfile_id = $1
            AND entity_type = $2
            AND parent_entity_id IS NOT DISTINCT FROM $3::uuid`,
        [workfileId, selected.rows[0].entity_type, selected.rows[0].parent_entity_id],
    );
    if (Number(siblings.rows[0].count) <= Number(group.minItems)) throw new Error("uad_entity_minimum_required");
  }
  const deleted = entityResponse(selected.rows[0]);
  await client.query("DELETE FROM appraisal.uad_entities WHERE id = $1", [entityId]);
  await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, actor_user_id, event_type, entity_type, entity_id, before_data
       ) VALUES ($1, $2, 'uad_entity.deleted', $3, $4, $5::jsonb)`,
    [workfileId, actorUserId, selected.rows[0].entity_type, entityId, JSON.stringify(deleted)],
  );
  await client.query(
    "UPDATE appraisal.uad_workfiles SET status = 'draft', updated_at = now() WHERE id = $1",
    [workfileId],
  );
  return deleted;
}

export async function deleteUadEntity(pool, workfileIdValue, entityIdValue, actorUserId = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const deleted = await deleteUadEntityWithClient(client, workfileIdValue, entityIdValue, { actorUserId });
    await client.query("COMMIT");
    return deleted;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
