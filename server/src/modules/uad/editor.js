import { randomUUID } from "node:crypto";

import { UAD_PHASE_ONE_FIELDS, getUadEditorSections, normalizeAndValidateUadValue, validateUadSectionValues } from "./fieldCatalog.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

function responseValue(row) {
  return {
    id: row.id,
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
  return `${value.field_context}:${value.uad_uid}`;
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);
}

function completionFor(values) {
  const byKey = new Map(values.map((value) => [valueKey(value), value]));
  const result = {};
  for (const section of ["assignment", "subject"]) {
    const requiredFields = UAD_PHASE_ONE_FIELDS.filter((field) => field.section === section && field.required);
    const completed = requiredFields.filter((field) => isPresent(byKey.get(field.key)?.value)).length;
    result[section] = {
      completed,
      required: requiredFields.length,
      percent: requiredFields.length ? Math.round((completed / requiredFields.length) * 100) : 100,
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
  const rows = await loadValues(pool, workfileId);
  const values = rows.map(responseValue);
  return {
    workfile: {
      ...workfileResult.rows[0],
      current_revision: Number(workfileResult.rows[0].current_revision),
    },
    sections: getUadEditorSections(),
    values,
    completion: completionFor(rows),
  };
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateCompleteSection(section, existingRows, submitted) {
  const merged = new Map(existingRows.map((row) => [valueKey(row), row.value]));
  for (const item of submitted) merged.set(item.field.key, item.value);
  const errors = [];
  for (const field of UAD_PHASE_ONE_FIELDS.filter((candidate) => candidate.section === section && candidate.required)) {
    const result = normalizeAndValidateUadValue(field, merged.get(field.key));
    if (result.error) errors.push(result.error);
  }
  return errors;
}

export async function saveUadSection(pool, workfileIdValue, section, input = {}) {
  const workfileId = normalizeUadWorkfileId(workfileIdValue);
  const validation = validateUadSectionValues(section, input.values);
  if (validation.errors.length) {
    const error = new Error("invalid_uad_field_values");
    error.details = validation.errors;
    throw error;
  }

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

    const existingRows = await loadValues(client, workfileId, "FOR UPDATE");
    const completeSectionErrors = validateCompleteSection(section, existingRows, validation.normalized);
    if (completeSectionErrors.length) {
      const error = new Error("invalid_uad_field_values");
      error.details = completeSectionErrors;
      throw error;
    }

    const existingByKey = new Map(existingRows.map((row) => [valueKey(row), row]));
    const changed = [];
    for (const { field, value } of validation.normalized) {
      const previous = existingByKey.get(field.key);
      const changedFromPrevious = !previous || !jsonEqual(previous.value, value);
      const isOverride = Boolean(previous && previous.source_type !== "appraiser" && changedFromPrevious);
      const sourceType = previous && !changedFromPrevious ? previous.source_type : "appraiser";
      const sourceReference = previous && !changedFromPrevious ? previous.source_reference : "uad_workspace.section_save";
      const overrideReason = isOverride ? "Appraiser edited a HomeNode-prefilled value." : null;
      const id = previous?.id || randomUUID();

      if (previous) {
        await client.query(
          `UPDATE appraisal.uad_field_values
              SET value = $2::jsonb,
                  report_field_id = $3,
                  source_type = $4,
                  source_reference = $5,
                  is_appraiser_confirmed = true,
                  is_override = $6,
                  override_reason = $7,
                  updated_at = now()
            WHERE id = $1`,
          [id, JSON.stringify(value), field.reportFieldId, sourceType, sourceReference, isOverride, overrideReason],
        );
      } else {
        await client.query(
          `INSERT INTO appraisal.uad_field_values (
             id, workfile_id, field_context, uad_uid, report_field_id, value,
             source_type, source_reference, is_appraiser_confirmed
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'appraiser', 'uad_workspace.section_save', true)`,
          [id, workfileId, field.contextKey, field.uid, field.reportFieldId, JSON.stringify(value)],
        );
      }
      if (changedFromPrevious || !previous?.is_appraiser_confirmed) {
        changed.push({
          key: field.key,
          uid: field.uid,
          context_key: field.contextKey,
          before: previous?.value ?? null,
          after: value,
        });
      }
    }

    const revisionNumber = Number(locked.rows[0].current_revision) + 1;
    const allRows = await loadValues(client, workfileId);
    const revisionDocument = {
      field_values: allRows.map((row) => ({
        uid: row.uad_uid,
        context_key: row.field_context,
        report_field_id: row.report_field_id,
        value: row.value,
        source_type: row.source_type,
        is_appraiser_confirmed: row.is_appraiser_confirmed,
      })),
    };
    await client.query(
      `UPDATE appraisal.uad_workfiles
          SET current_revision = $2, status = 'draft', updated_at = now()
        WHERE id = $1`,
      [workfileId, revisionNumber],
    );
    await client.query(
      `INSERT INTO appraisal.uad_revisions (
         id, workfile_id, revision_number, specification_release_key, document, change_summary
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        randomUUID(),
        workfileId,
        revisionNumber,
        locked.rows[0].specification_release_key,
        JSON.stringify(revisionDocument),
        `Saved ${section} information`,
      ],
    );
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, before_data, after_data, metadata
       ) VALUES ($1, 'uad_section.saved', 'uad_section', $2, $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        workfileId,
        section,
        JSON.stringify(changed.map(({ key, uid, context_key, before }) => ({ key, uid, context_key, value: before }))),
        JSON.stringify(changed.map(({ key, uid, context_key, after }) => ({ key, uid, context_key, value: after }))),
        JSON.stringify({ revision_number: revisionNumber, submitted_field_count: validation.normalized.length }),
      ],
    );
    await client.query("COMMIT");

    const values = allRows.map(responseValue);
    return {
      section,
      current_revision: revisionNumber,
      saved_field_count: validation.normalized.length,
      changed_field_count: changed.length,
      values,
      completion: completionFor(allRows),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
