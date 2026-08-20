import { randomUUID } from "node:crypto";

import { createUadEntityWithClient, listUadEntities } from "./entities.js";
import {
  UAD_REPEATABLE_ENTITY_GROUPS,
  getUadField,
  normalizeAndValidateUadValue,
  uadFieldAppliesToEntity,
} from "./fieldCatalog.js";
import { loadUadCompletionSuggestions } from "./completionSuggestions.js";
import { normalizeUadWorkfileId } from "./workfiles.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SELECTED_SUGGESTIONS = 100;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueKey(value) {
  return `${value.entity_id || "root"}:${value.field_context}:${value.uad_uid}`;
}

function parseFieldKey(fieldKey) {
  const separator = String(fieldKey || "").lastIndexOf(":");
  if (separator <= 0) throw new Error("invalid_uad_completion_suggestion_field");
  return {
    contextKey: fieldKey.slice(0, separator),
    uid: fieldKey.slice(separator + 1),
  };
}

function normalizeRequest(input = {}) {
  const selected = Array.isArray(input.selected_suggestion_ids)
    ? [...new Set(input.selected_suggestion_ids.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
  const digest = String(input.expected_source_digest_sha256 || "").trim().toLowerCase();
  const adapterVersion = String(input.expected_adapter_version || "").trim();
  const expectedRevision = Number(input.expected_revision);
  if (input.confirmed !== true) throw new Error("uad_completion_confirmation_required");
  if (input.preserve_existing !== true) throw new Error("uad_completion_preserve_existing_required");
  if (!DIGEST_PATTERN.test(digest) || !adapterVersion) throw new Error("invalid_uad_completion_provenance");
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("invalid_uad_completion_revision");
  if (!selected.length || selected.length > MAX_SELECTED_SUGGESTIONS) {
    throw new Error("invalid_uad_completion_selection");
  }
  return {
    selectedSuggestionIds: selected,
    expectedSourceDigest: digest,
    expectedAdapterVersion: adapterVersion,
    expectedRevision,
  };
}

function validateFieldSuggestion(suggestion, entity = null) {
  if (!plainObject(suggestion)) throw new Error("invalid_uad_completion_suggestion_field");
  const { contextKey, uid } = parseFieldKey(suggestion.field_key);
  const field = getUadField(contextKey, uid);
  if (!field || (entity ? !uadFieldAppliesToEntity(field, entity) : Boolean(field.entityType))) {
    throw new Error("invalid_uad_completion_suggestion_field");
  }
  const validation = normalizeAndValidateUadValue(field, suggestion.value);
  if (validation.error) {
    const error = new Error("invalid_uad_completion_suggestion_value");
    error.details = [validation.error];
    throw error;
  }
  return {
    field,
    value: validation.value,
    sourceReference: String(suggestion.source_reference || "").slice(0, 1_000),
    sourceObservedAt: suggestion.observed_at || null,
  };
}

function validateEntitySuggestion(suggestion, parentType = null) {
  if (!plainObject(suggestion) || !UAD_REPEATABLE_ENTITY_GROUPS[suggestion.entity_type]) {
    throw new Error("invalid_uad_completion_suggestion_entity");
  }
  const group = UAD_REPEATABLE_ENTITY_GROUPS[suggestion.entity_type];
  const parentTypes = group.parentEntityTypes || (group.parentEntityType ? [group.parentEntityType] : []);
  if ((parentTypes.length && !parentTypes.includes(parentType)) || (!parentTypes.length && parentType)) {
    throw new Error("invalid_uad_completion_suggestion_parent");
  }
  const entity = { entity_type: suggestion.entity_type, data: suggestion.data || {} };
  const fields = [];
  for (const [fieldKey, value] of Object.entries(suggestion.values || {})) {
    const parsed = validateFieldSuggestion({
      field_key: fieldKey,
      value,
      source_reference: suggestion.source_reference,
      observed_at: suggestion.observed_at,
    }, entity);
    if (!parsed.field.calculated) fields.push(parsed);
  }
  const children = (suggestion.related_entities || []).map((child) => (
    validateEntitySuggestion(child, suggestion.entity_type)
  ));
  return { suggestion, fields, children };
}

function resolveTargetEntity(existingEntities, suggestion) {
  if (!plainObject(suggestion.target_entity)) return { entity: null, conflict: null };
  const entityType = String(suggestion.target_entity.entity_type || "").trim();
  const entityIdentifier = String(suggestion.target_entity.entity_identifier || "").trim();
  if (!entityType || !entityIdentifier) throw new Error("invalid_uad_completion_target_entity");
  const matches = existingEntities.filter((entity) => (
    entity.entity_type === entityType && entity.entity_identifier === entityIdentifier
  ));
  if (!matches.length) return { entity: null, conflict: "target_entity_not_found" };
  if (matches.length > 1) return { entity: null, conflict: "target_entity_ambiguous" };
  return { entity: matches[0], conflict: null };
}

function existingEntityConflict(existingEntities, suggestion) {
  const sameType = existingEntities.filter((entity) => entity.entity_type === suggestion.entity_type);
  const exact = sameType.find((entity) => (
    entity.data?.custom_completion?.suggestion_id === suggestion.suggestion_id
  ));
  if (exact) return "already_applied";
  return sameType.length ? "entity_type_already_populated" : null;
}

export function buildUadCompletionApplyPlan(document, input, {
  existingValues = [],
  existingEntities = [],
} = {}) {
  const request = normalizeRequest(input);
  if (!plainObject(document) || document.requires_appraiser_confirmation !== true) {
    throw new Error("invalid_uad_completion_suggestions");
  }
  if (document.source_completion?.source_digest_sha256 !== request.expectedSourceDigest) {
    throw new Error("uad_completion_source_changed");
  }
  if (document.adapter_version !== request.expectedAdapterVersion) {
    throw new Error("uad_completion_adapter_changed");
  }

  const fieldSuggestions = [
    ...(document.suggestions?.assignment_fields || []),
    ...(document.suggestions?.subject_entity_fields || []),
    ...(document.suggestions?.highest_best_use_fields || []),
    ...(document.suggestions?.subject_listing_fields || []),
    ...(document.suggestions?.sales_contract_fields || []),
    ...(document.suggestions?.subject_prior_transfer_fields || []),
    ...(document.suggestions?.market_fields || []),
    ...(document.suggestions?.sales_comparison_fields || []),
  ];
  const entitySuggestions = [
    ...(document.suggestions?.subject_listing_entities || []),
    ...(document.suggestions?.subject_prior_transfer_entities || []),
    ...(document.suggestions?.market_entities || []),
    ...(document.suggestions?.sales_comparable_entities || []),
  ];
  const allById = new Map([...fieldSuggestions, ...entitySuggestions].map((item) => [item.suggestion_id, item]));
  if (request.selectedSuggestionIds.some((id) => !allById.has(id))) {
    throw new Error("uad_completion_selection_changed");
  }

  const existingFieldKeys = new Set(existingValues.map(valueKey));
  const fields = [];
  const entities = [];
  const conflicts = [];
  for (const suggestionId of request.selectedSuggestionIds) {
    const suggestion = allById.get(suggestionId);
    if (suggestion.field_key) {
      const target = resolveTargetEntity(existingEntities, suggestion);
      if (target.conflict) {
        conflicts.push({ suggestion_id: suggestionId, reason: target.conflict });
        continue;
      }
      const validated = validateFieldSuggestion(suggestion, target.entity);
      const entityId = target.entity?.id || null;
      const key = `${entityId || "root"}:${validated.field.contextKey}:${validated.field.uid}`;
      if (existingFieldKeys.has(key)) {
        conflicts.push({ suggestion_id: suggestionId, reason: "existing_value_preserved" });
      } else {
        fields.push({ suggestion, entityId, ...validated });
      }
      continue;
    }
    const conflict = existingEntityConflict(existingEntities, suggestion);
    if (conflict) {
      conflicts.push({ suggestion_id: suggestionId, reason: conflict });
    } else {
      entities.push(validateEntitySuggestion(suggestion));
    }
  }
  return { request, fields, entities, conflicts };
}

async function insertFieldValue(client, workfileId, entityId, item) {
  await client.query(
    `INSERT INTO appraisal.uad_field_values (
       id, workfile_id, entity_id, field_context, uad_uid, report_field_id, value,
       source_type, source_reference, source_observed_at, is_appraiser_confirmed
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'homenode', $8, $9, true)`,
    [
      randomUUID(), workfileId, entityId, item.field.contextKey, item.field.uid,
      item.field.reportFieldId, JSON.stringify(item.value), item.sourceReference,
      item.sourceObservedAt,
    ],
  );
}

async function insertEntityTree(client, workfileId, plan, source, parentEntityId = null, path = "") {
  const suggestion = plan.suggestion;
  const metadata = {
    custom_completion: {
      suggestion_id: suggestion.suggestion_id || path,
      source_reference: suggestion.source_reference || source.sourceReference,
      source_digest_sha256: source.sourceDigest,
      adapter_version: source.adapterVersion,
    },
  };
  const label = suggestion.entity_type === "sales_comparable"
    ? String(suggestion.values?.["sales_comparable_address:1800.0001"] || `Comparable ${suggestion.ordinal || ""}`).trim()
    : suggestion.entity_type === "market_price_trend_source"
      ? "Custom Appraisal market source"
      : undefined;
  const entity = await createUadEntityWithClient(client, workfileId, {
    entity_type: suggestion.entity_type,
    parent_entity_id: parentEntityId,
    label,
    data: metadata,
  }, { audit: false, touch: false });
  for (const item of plan.fields) await insertFieldValue(client, workfileId, entity.id, item);
  const children = [];
  for (let index = 0; index < plan.children.length; index += 1) {
    children.push(await insertEntityTree(
      client,
      workfileId,
      plan.children[index],
      source,
      entity.id,
      `${path}.${index}`,
    ));
  }
  return { id: entity.id, entity_type: entity.entity_type, children };
}

async function loadValues(queryable, workfileId, suffix = "") {
  const { rows } = await queryable.query(
    `SELECT * FROM appraisal.uad_field_values
      WHERE workfile_id = $1
      ORDER BY created_at, id
      ${suffix}`,
    [workfileId],
  );
  return rows;
}

export async function applyUadCompletionSuggestions(pool, workfileIdValue, input = {}) {
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
    const currentRevision = Number(locked.rows[0].current_revision);
    const suggestions = await loadUadCompletionSuggestions(client, workfileId);
    const [existingValues, existingEntities] = await Promise.all([
      loadValues(client, workfileId, "FOR UPDATE"),
      listUadEntities(client, workfileId),
    ]);
    const plan = buildUadCompletionApplyPlan(suggestions, input, { existingValues, existingEntities });
    if (plan.request.expectedRevision !== currentRevision) throw new Error("uad_completion_stale_revision");

    for (const item of plan.fields) await insertFieldValue(client, workfileId, item.entityId, item);
    const createdEntities = [];
    for (const entity of plan.entities) {
      createdEntities.push(await insertEntityTree(client, workfileId, entity, {
        sourceReference: entity.suggestion.source_reference,
        sourceDigest: suggestions.source_completion.source_digest_sha256,
        adapterVersion: suggestions.adapter_version,
      }, null, entity.suggestion.suggestion_id));
    }
    const appliedCount = plan.fields.length + plan.entities.length;
    if (!appliedCount) {
      await client.query("COMMIT");
      return {
        current_revision: currentRevision,
        applied_suggestion_count: 0,
        conflicts: plan.conflicts,
        created_entities: [],
      };
    }

    const revisionNumber = currentRevision + 1;
    const [allRows, allEntities] = await Promise.all([
      loadValues(client, workfileId),
      listUadEntities(client, workfileId),
    ]);
    const revisionDocument = {
      entities: allEntities,
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
        randomUUID(), workfileId, revisionNumber, locked.rows[0].specification_release_key,
        JSON.stringify(revisionDocument),
        `Applied ${appliedCount} reviewed Custom Appraisal suggestion${appliedCount === 1 ? "" : "s"}`,
      ],
    );
    await client.query(
      `INSERT INTO appraisal.uad_audit_events (
         workfile_id, event_type, entity_type, entity_id, after_data, metadata
       ) VALUES (
         $1::uuid, 'uad_completion_suggestions.applied', 'uad_workfile',
         ($1::uuid)::text, $2::jsonb, $3::jsonb
       )`,
      [
        workfileId,
        JSON.stringify({
          applied_suggestion_ids: [
            ...plan.fields.map((item) => item.suggestion.suggestion_id),
            ...plan.entities.map((item) => item.suggestion.suggestion_id),
          ],
          created_entities: createdEntities,
        }),
        JSON.stringify({
          revision_number: revisionNumber,
          source_report_file_id: suggestions.source_completion.source_report_file_id,
          subject_snapshot_id: suggestions.source_completion.subject_snapshot_id,
          source_digest_sha256: suggestions.source_completion.source_digest_sha256,
          adapter_version: suggestions.adapter_version,
          preserve_existing: true,
          conflict_count: plan.conflicts.length,
        }),
      ],
    );
    await client.query("COMMIT");
    return {
      current_revision: revisionNumber,
      applied_suggestion_count: appliedCount,
      applied_field_count: plan.fields.length,
      applied_entity_count: plan.entities.length,
      conflicts: plan.conflicts,
      created_entities: createdEntities,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
