import { randomUUID } from "node:crypto";

import { listUadAssets } from "./assets.js";
import { UAD_CERTIFICATION_FIELD_KEYS } from "./certificationsCatalog.js";
import { listUadEntities } from "./entities.js";
import { validateUadSectionValues } from "./fieldCatalog.js";
import { UAD_RECONCILIATION_FIELD_KEYS } from "./reconciliationCatalog.js";
import { assertLockedUadWorkfileMutable } from "./workfileLifecycle.js";

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Bind the existing editor domain functions once; never accept dependencies from
// a request. The caller authorizes and normalizes the request, owns a checked-out
// client in a READ COMMITTED transaction, and commits or rolls back/releases it.
// This helper locks the workfile before checking its fresh signature state and
// returns internal persistence state, not a committed or formatted API response.
export function createUadSectionPersistence({
  loadValues,
  calculatedSalesComparisonFields,
  valueLookup,
  valuesMap,
  calculateSalesComparisonSummaryValues,
  calculateReconciliationRepairTotal,
  calculateCertificationSystemValues,
  validateCompleteSection,
  valueKey,
  fieldValueKey,
}) {
  return async function persistUadSectionWithClient(client, {
    workfileId,
    expectedRevision,
    saveReason,
    allowIncomplete,
    section,
    input,
    actorUserId,
    trustedSource,
  }) {
    const locked = await client.query(
      `SELECT id, current_revision, specification_release_key, status, signed_at
         FROM appraisal.uad_workfiles
        WHERE id = $1
        FOR UPDATE`,
      [workfileId],
    );
    if (!locked.rows.length) throw new Error("uad_workfile_not_found");
    await assertLockedUadWorkfileMutable(client, locked.rows[0]);
    const currentRevision = Number(locked.rows[0].current_revision);
    if (expectedRevision !== currentRevision) {
      const error = new Error("uad_section_stale_revision");
      error.details = { current_revision: currentRevision };
      throw error;
    }

    const [existingRows, entities, assets] = await Promise.all([
      loadValues(client, workfileId, "FOR UPDATE"),
      listUadEntities(client, workfileId),
      listUadAssets(client, workfileId),
    ]);
    const entityTypesById = new Map(entities.map((entity) => [entity.id, entity.entity_type]));
    const entityDataById = new Map(entities.map((entity) => [entity.id, entity.data]));
    const calculatedFieldKeys = new Set([
      ...calculatedSalesComparisonFields().map((field) => field.key),
      UAD_CERTIFICATION_FIELD_KEYS.governmentAgency,
    ]);
    const submittedRepairMethod = Array.isArray(input.values)
      ? input.values.find((item) => (
          `${item.context_key}:${item.uid}` === UAD_RECONCILIATION_FIELD_KEYS.repairCostMethod
          && !item.entity_id
        ))?.value
      : undefined;
    const existingRepairMethod = valueLookup(valuesMap(existingRows))(
      UAD_RECONCILIATION_FIELD_KEYS.repairCostMethod,
    );
    const repairCostMethod = submittedRepairMethod ?? existingRepairMethod;
    const submittedValues = Array.isArray(input.values)
      ? input.values.filter((item) => {
          const key = `${item.context_key}:${item.uid}`;
          if (["sales_comparison", "certifications"].includes(section) && calculatedFieldKeys.has(key)) return false;
          return !(
            section === "reconciliation"
            && repairCostMethod === "Itemized"
            && key === UAD_RECONCILIATION_FIELD_KEYS.repairCostTotal
          );
        })
      : input.values;
    const validation = validateUadSectionValues(section, submittedValues, {
      entityTypesById,
      entityDataById,
      allowIncomplete,
    });
    if (validation.errors.length) {
      const error = new Error("invalid_uad_field_values");
      error.details = validation.errors;
      throw error;
    }
    const normalized = section === "sales_comparison"
      ? [
          ...validation.normalized,
          ...calculateSalesComparisonSummaryValues(existingRows, validation.normalized, entities),
        ]
      : section === "reconciliation"
        ? [
            ...validation.normalized,
            ...calculateReconciliationRepairTotal(existingRows, validation.normalized, entities),
          ]
        : section === "certifications"
          ? [
              ...validation.normalized,
              ...calculateCertificationSystemValues(existingRows, validation.normalized),
            ]
        : validation.normalized;
    const completeSectionErrors = allowIncomplete
      ? []
      : validateCompleteSection(section, existingRows, normalized, entities, assets);
    if (completeSectionErrors.length) {
      const error = new Error("invalid_uad_field_values");
      error.details = completeSectionErrors;
      throw error;
    }

    const existingByKey = new Map(existingRows.map((row) => [valueKey(row), row]));
    const trustedSourceType = String(trustedSource.sourceType || "").trim();
    const trustedSourceReference = String(trustedSource.sourceReference || "").trim().slice(0, 1_000);
    if (trustedSourceType && ![
      "homenode", "public_record", "mls", "document", "measurement",
      "calculated", "appraiser", "imported",
    ].includes(trustedSourceType)) {
      throw new Error("invalid_uad_trusted_source_type");
    }
    const changed = [];
    for (const { field, value, entityId } of normalized) {
      const key = fieldValueKey(field, entityId);
      const previous = existingByKey.get(key);
      const changedFromPrevious = !previous || !jsonEqual(previous.value, value);
      const calculated = field.calculated === true;
      const isOverride = Boolean(!calculated && previous && previous.source_type !== "appraiser" && changedFromPrevious);
      const sourceType = calculated
        ? "calculated"
        : previous && !changedFromPrevious
          ? previous.source_type
          : trustedSourceType || "appraiser";
      const sourceReference = calculated
        ? section === "reconciliation"
          ? "uad.reconciliation_repair_total"
          : section === "certifications"
            ? "uad.certifications_government_agency"
            : "uad.sales_comparison_summary"
        : previous && !changedFromPrevious
          ? previous.source_reference
          : trustedSourceReference
            || (saveReason === "autosave" ? "uad_workspace.autosave" : "uad_workspace.section_save");
      const overrideReason = isOverride
        ? trustedSourceType === "document"
          ? "Appraiser-confirmed document evidence replaced the prior value."
          : "Appraiser edited a HomeNode-prefilled value."
        : null;
      const id = previous?.id || randomUUID();

      if (previous && !changedFromPrevious && previous.is_appraiser_confirmed) continue;

      if (previous) {
        await client.query(
          `UPDATE appraisal.uad_field_values
              SET value = $2::jsonb, report_field_id = $3, source_type = $4,
                  source_reference = $5, is_appraiser_confirmed = true,
                  is_override = $6, override_reason = $7,
                  updated_by_user_id = $8, updated_at = now()
            WHERE id = $1`,
          [id, JSON.stringify(value), field.reportFieldId, sourceType, sourceReference, isOverride, overrideReason, actorUserId],
        );
      } else {
        await client.query(
          `INSERT INTO appraisal.uad_field_values (
             id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
             source_type, source_reference, is_appraiser_confirmed,
             updated_by_user_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, true, $10)`,
          [id, workfileId, entityId, field.contextKey, field.uid, field.reportFieldId, JSON.stringify(value), sourceType, sourceReference, actorUserId],
        );
      }
      if (changedFromPrevious || !previous?.is_appraiser_confirmed) {
        changed.push({ key: field.key, uid: field.uid, context_key: field.contextKey, entity_id: entityId, before: previous?.value ?? null, after: value });
      }
    }

    if (!changed.length) {
      return {
        section,
        currentRevision,
        saveReason,
        normalizedCount: normalized.length,
        changedCount: 0,
        rows: existingRows,
        entities,
        assets,
      };
    }

    const revisionNumber = currentRevision + 1;
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
         id, workfile_id, revision_number, specification_release_key, document, change_summary,
          created_by_user_id
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        randomUUID(),
        workfileId,
        revisionNumber,
        locked.rows[0].specification_release_key,
        JSON.stringify(revisionDocument),
        String(trustedSource.changeSummary || "").trim().slice(0, 500)
          || (saveReason === "autosave" ? `Autosaved ${section} draft` : `Saved ${section} information`),
        actorUserId,
      ],
    );
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, before_data, after_data, metadata,
          actor_user_id
        ) VALUES ($1, 'uad_section.saved', 'uad_section', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)`,
      [
        workfileId,
        section,
        JSON.stringify(changed.map(({ key, uid, context_key, entity_id, before }) => ({ key, uid, context_key, entity_id, value: before }))),
        JSON.stringify(changed.map(({ key, uid, context_key, entity_id, after }) => ({ key, uid, context_key, entity_id, value: after }))),
        JSON.stringify({
          revision_number: revisionNumber,
          submitted_field_count: normalized.length,
          changed_field_count: changed.length,
          save_reason: saveReason,
          ...(trustedSourceType ? { source_type: trustedSourceType } : {}),
          ...(trustedSourceReference ? { source_reference: trustedSourceReference } : {}),
        }),
        actorUserId,
      ],
    );
    return {
      section,
      currentRevision: revisionNumber,
      saveReason,
      normalizedCount: normalized.length,
      changedCount: changed.length,
      rows: allRows,
      entities,
      assets,
    };
  };
}
