import { randomUUID } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { listUadEntities } from "./entities.js";
import {
  UAD_EDITOR_SECTION_KEYS,
  UAD_PHASE_ONE_FIELDS,
  getUadEditorSections,
  normalizeAndValidateUadValue,
  uadFieldIsRequired,
  uadFieldIsVisible,
  validateUadSectionValues,
} from "./fieldCatalog.js";
import { isVerifiedSketchReportAsset } from "./sketchCatalog.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

function responseValue(row) {
  return {
    id: row.id,
    entity_id: row.entity_id || null,
    uid: row.uad_uid,
    context_key: row.field_context,
    report_field_id: row.report_field_id,
    value: row.value,
    source_type: row.source_type,
    source_reference: row.source_reference || null,
    is_appraiser_confirmed: Boolean(row.is_appraiser_confirmed),
    is_override: Boolean(row.is_override),
    override_reason: row.override_reason || null,
    updated_at: row.updated_at,
  };
}

function valueKey(value) {
  return `${value.entity_id || "root"}:${value.field_context}:${value.uad_uid}`;
}

function fieldValueKey(field, entityId = null) {
  return `${entityId || "root"}:${field.key}`;
}

function isPresent(value) {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return value.amount !== null && value.amount !== undefined && value.amount !== "" && Boolean(value.unit);
  return true;
}

function valueLookup(valuesByKey, entityId = null) {
  return (requestedKey, options = {}) => {
    if (options.uidOnly) {
      const prefix = `${entityId || "root"}:`;
      const suffix = `:${requestedKey}`;
      for (const [key, value] of valuesByKey) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) return value;
      }
      for (const [key, value] of valuesByKey) {
        if (key.startsWith("root:") && key.endsWith(suffix)) return value;
      }
      return undefined;
    }
    return valuesByKey.get(`${entityId || "root"}:${requestedKey}`)
      ?? valuesByKey.get(`root:${requestedKey}`);
  };
}

function valuesMap(values) {
  return new Map(values.map((value) => [valueKey(value), value.value]));
}

function completionFor(values, entities, assets = []) {
  const byKey = valuesMap(values);
  const result = {};
  for (const section of UAD_EDITOR_SECTION_KEYS) {
    let required = 0;
    let completed = 0;
    for (const field of UAD_PHASE_ONE_FIELDS.filter((candidate) => candidate.section === section)) {
      const instances = field.entityType
        ? entities.filter((entity) => entity.entity_type === field.entityType).map((entity) => entity.id)
        : [null];
      for (const entityId of instances) {
        const lookup = valueLookup(byKey, entityId);
        if (!uadFieldIsVisible(field, lookup) || !uadFieldIsRequired(field, lookup)) continue;
        required += 1;
        if (isPresent(byKey.get(fieldValueKey(field, entityId)))) completed += 1;
      }
    }
    if (section === "sketch" && byKey.get("root:sketch:3300.0002") === true) {
      required += 1;
      if (assets.some(isVerifiedSketchReportAsset)) completed += 1;
    }
    result[section] = {
      completed,
      required,
      percent: required ? Math.round((completed / required) * 100) : 100,
    };
  }
  return result;
}

async function loadValues(queryable, workfileId, suffix = "") {
  const { rows } = await queryable.query(
    `SELECT *
       FROM appraisal.uad_field_values
      WHERE workfile_id = $1
      ORDER BY created_at, id
      ${suffix}`,
    [workfileId],
  );
  return rows;
}

export async function getUadEditor(pool, workfileIdValue) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const workfileResult = await pool.query(
    `SELECT id, account_id, file_number, specification_release_key, status,
            current_revision, updated_at
       FROM appraisal.uad_workfiles
      WHERE id = $1`,
    [workfileId],
  );
  if (!workfileResult.rows.length) throw new Error("uad_workfile_not_found");
  const [rows, entities, assets] = await Promise.all([
    loadValues(pool, workfileId),
    listUadEntities(pool, workfileId),
    listUadAssets(pool, workfileId),
  ]);
  return {
    workfile: { ...workfileResult.rows[0], current_revision: Number(workfileResult.rows[0].current_revision) },
    sections: getUadEditorSections(),
    entities,
    values: rows.map(responseValue),
    completion: completionFor(rows, entities, assets),
  };
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validationError(field, entityId, code, message) {
  return { key: field.key, uid: field.uid, context_key: field.contextKey, entity_id: entityId, code, message };
}

function validateCompleteSection(section, existingRows, submitted, entities, assets = []) {
  const merged = valuesMap(existingRows);
  for (const item of submitted) merged.set(fieldValueKey(item.field, item.entityId), item.value);
  const errors = [];
  for (const field of UAD_PHASE_ONE_FIELDS.filter((candidate) => candidate.section === section)) {
    const instances = field.entityType
      ? entities.filter((entity) => entity.entity_type === field.entityType).map((entity) => entity.id)
      : [null];
    for (const entityId of instances) {
      const lookup = valueLookup(merged, entityId);
      if (!uadFieldIsVisible(field, lookup) || !uadFieldIsRequired(field, lookup)) continue;
      const rawValue = merged.get(fieldValueKey(field, entityId));
      if (!isPresent(rawValue)) {
        errors.push(validationError(field, entityId, "required", `${field.label} is required.`));
        continue;
      }
      const result = normalizeAndValidateUadValue(field, rawValue);
      if (result.error) errors.push({ ...result.error, entity_id: entityId });
    }
  }

  if (section === "site") {
    const rootLookup = valueLookup(merged);
    const parcelCount = Number(rootLookup("site:1500.0094"));
    const parcels = entities.filter((entity) => entity.entity_type === "site_parcel");
    if (Number.isInteger(parcelCount) && parcelCount !== parcels.length) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "site:1500.0094");
      errors.push(validationError(field, null, "parcel_count", `Parcel count must match the ${parcels.length} parcel record${parcels.length === 1 ? "" : "s"} in this workfile.`));
    }
    const defectsExist = rootLookup("site:1500.0178");
    const defects = entities.filter((entity) => entity.entity_type === "site_defect");
    if (defectsExist === true && defects.length === 0) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "site:1500.0178");
      errors.push(validationError(field, null, "site_defect_required", "Add at least one site defect when site defects exist."));
    }
    if (defectsExist === false && defects.length > 0) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "site:1500.0178");
      errors.push(validationError(field, null, "site_defect_conflict", "Remove site defect records or change the site-defects answer to Yes."));
    }
  }

  if (section === "disaster_mitigation") {
    const rootLookup = valueLookup(merged);
    const features = rootLookup("disaster_mitigation:3700.0002");
    if (Array.isArray(features) && features.includes("None") && features.length > 1) {
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "disaster_mitigation:3700.0002");
      errors.push(validationError(field, null, "mitigation_none_conflict", "Select None by itself, or remove None before selecting disaster mitigation features."));
    }
  }

  if (section === "energy_green") {
    const rootLookup = valueLookup(merged);
    const entityRequirements = [
      {
        key: "energy_green:2600.0005",
        entityType: "renewable_energy_component",
        label: "renewable energy component",
      },
      {
        key: "energy_green:2600.0004",
        entityType: "green_building_certification",
        label: "building certification",
      },
      {
        key: "energy_green:2600.0003",
        entityType: "green_efficiency_rating",
        label: "efficiency rating",
      },
    ];
    for (const requirement of entityRequirements) {
      const indicator = rootLookup(requirement.key);
      const matchingEntities = entities.filter((entity) => entity.entity_type === requirement.entityType);
      const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === requirement.key);
      if (indicator === true && matchingEntities.length === 0) {
        errors.push(validationError(field, null, "energy_detail_required", `Add at least one ${requirement.label} when the known-features answer is Yes.`));
      }
      if (indicator === false && matchingEntities.length > 0) {
        errors.push(validationError(field, null, "energy_detail_conflict", `Remove ${requirement.label} records or change the known-features answer to Yes.`));
      }
    }
  }

  if (section === "sketch") {
    const rootLookup = valueLookup(merged);
    const sketchExists = rootLookup("sketch:3300.0002");
    const reportAssets = assets.filter(isVerifiedSketchReportAsset);
    const field = UAD_PHASE_ONE_FIELDS.find((candidate) => candidate.key === "sketch:3300.0002");
    if (sketchExists === true && reportAssets.length === 0) {
      errors.push(validationError(field, null, "sketch_asset_required", "Upload and verify at least one sketch or floor plan image."));
    }
    if (sketchExists === false && reportAssets.length > 0) {
      errors.push(validationError(field, null, "sketch_asset_conflict", "Remove the saved sketch or floor plan images, or change the provided answer to Yes."));
    }
  }
  return errors;
}

export async function saveUadSection(pool, workfileIdValue, section, input = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, current_revision, specification_release_key
         FROM appraisal.uad_workfiles
        WHERE id = $1
        FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");

    const [existingRows, entities, assets] = await Promise.all([
      loadValues(client, workfileId, "FOR UPDATE"),
      listUadEntities(client, workfileId),
      listUadAssets(client, workfileId),
    ]);
    const entityTypesById = new Map(entities.map((entity) => [entity.id, entity.entity_type]));
    const validation = validateUadSectionValues(section, input.values, { entityTypesById });
    if (validation.errors.length) {
      const error = new Error("invalid_uad_field_values");
      error.details = validation.errors;
      throw error;
    }
    const completeSectionErrors = validateCompleteSection(section, existingRows, validation.normalized, entities, assets);
    if (completeSectionErrors.length) {
      const error = new Error("invalid_uad_field_values");
      error.details = completeSectionErrors;
      throw error;
    }

    const existingByKey = new Map(existingRows.map((row) => [valueKey(row), row]));
    const changed = [];
    for (const { field, value, entityId } of validation.normalized) {
      const key = fieldValueKey(field, entityId);
      const previous = existingByKey.get(key);
      const changedFromPrevious = !previous || !jsonEqual(previous.value, value);
      const isOverride = Boolean(previous && previous.source_type !== "appraiser" && changedFromPrevious);
      const sourceType = previous && !changedFromPrevious ? previous.source_type : "appraiser";
      const sourceReference = previous && !changedFromPrevious ? previous.source_reference : "uad_workspace.section_save";
      const overrideReason = isOverride ? "Appraiser edited a HomeNode-prefilled value." : null;
      const id = previous?.id || randomUUID();

      if (previous) {
        await client.query(
          `UPDATE appraisal.uad_field_values
              SET value = $2::jsonb, report_field_id = $3, source_type = $4,
                  source_reference = $5, is_appraiser_confirmed = true,
                  is_override = $6, override_reason = $7, updated_at = now()
            WHERE id = $1`,
          [id, JSON.stringify(value), field.reportFieldId, sourceType, sourceReference, isOverride, overrideReason],
        );
      } else {
        await client.query(
          `INSERT INTO appraisal.uad_field_values (
             id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
             source_type, source_reference, is_appraiser_confirmed
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'appraiser', 'uad_workspace.section_save', true)`,
          [id, workfileId, entityId, field.contextKey, field.uid, field.reportFieldId, JSON.stringify(value)],
        );
      }
      if (changedFromPrevious || !previous?.is_appraiser_confirmed) {
        changed.push({ key: field.key, uid: field.uid, context_key: field.contextKey, entity_id: entityId, before: previous?.value ?? null, after: value });
      }
    }

    const revisionNumber = Number(locked.rows[0].current_revision) + 1;
    const allRows = await loadValues(client, workfileId);
    const revisionDocument = {
      entities,
      field_values: allRows.map((row) => ({
        entity_id: row.entity_id || null,
        uid: row.uad_uid,
        context_key: row.field_context,
        report_field_id: row.report_field_id,
        value: row.value,
        source_type: row.source_type,
        is_appraiser_confirmed: row.is_appraiser_confirmed,
      })),
    };
    await client.query(
      `UPDATE appraisal.uad_workfiles SET current_revision = $2, status = 'draft', updated_at = now() WHERE id = $1`,
      [workfileId, revisionNumber],
    );
    await client.query(
      `INSERT INTO appraisal.uad_revisions (
         id, workfile_id, revision_number, specification_release_key, document, change_summary
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [randomUUID(), workfileId, revisionNumber, locked.rows[0].specification_release_key, JSON.stringify(revisionDocument), `Saved ${section} information`],
    );
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, before_data, after_data, metadata
       ) VALUES ($1, 'uad_section.saved', 'uad_section', $2, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        workfileId,
        section,
        JSON.stringify(changed.map(({ key, uid, context_key, entity_id, before }) => ({ key, uid, context_key, entity_id, value: before }))),
        JSON.stringify(changed.map(({ key, uid, context_key, entity_id, after }) => ({ key, uid, context_key, entity_id, value: after }))),
        JSON.stringify({ revision_number: revisionNumber, submitted_field_count: validation.normalized.length }),
      ],
    );
    await client.query("COMMIT");

    return {
      section,
      current_revision: revisionNumber,
      saved_field_count: validation.normalized.length,
      changed_field_count: changed.length,
      values: allRows.map(responseValue),
      completion: completionFor(allRows, entities, assets),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
