import { createHash, randomUUID } from "node:crypto";

import { getUadEditorSections, normalizeAndValidateUadValue } from "../uad/fieldCatalog.js";
import { assertLockedUadWorkfileMutable } from "../uad/workfileLifecycle.js";
import { normalizeUuid, sessionResponse } from "./reportFiles.js";
import { canonicalJson } from "./sync.js";

const SUPPORTED_WORKFLOWS = new Set(["uad_3_6", "property_tax_protest"]);
const PROTEST_CONDITIONS = ["C1", "C2-C1", "C2", "C3-C2", "C3", "C4-C3", "C4", "C5-C4", "C5", "C6-C5", "C6"];
const PROTEST_QUALITIES = ["Q1", "Q2-Q1", "Q2", "Q3-Q2", "Q3", "Q4-Q3", "Q4", "Q5-Q4", "Q5", "Q6-Q5", "Q6"];

function protestField(fieldPath, group, label, targetPath, valueType, options = {}) {
  return Object.freeze({
    field_path: fieldPath,
    group,
    label,
    value_type: valueType,
    target_reference: Object.freeze({ kind: "property_tax_protest", target_path: Object.freeze(targetPath) }),
    options: Object.freeze(options.options || []),
    units: Object.freeze([]),
    required: Boolean(options.required),
    minimum: options.minimum ?? null,
    maximum: options.maximum ?? null,
    maximum_length: options.maximumLength ?? (valueType === "text" ? 5000 : null),
    multiline: Boolean(options.multiline),
  });
}

const PROPERTY_TAX_FIELDS = Object.freeze([
  protestField("property_tax_protest.subject.condition_rating", "Subject", "Overall condition rating", ["subject", "condition_rating"], "enum", { options: PROTEST_CONDITIONS }),
  protestField("property_tax_protest.subject.quality_rating", "Subject", "Quality rating", ["subject", "quality_rating"], "enum", { options: PROTEST_QUALITIES }),
  protestField("property_tax_protest.subject.living_area_sqft", "Subject", "Living area (sq ft)", ["subject", "living_area_sqft"], "integer", { minimum: 0, maximum: 1_000_000 }),
  protestField("property_tax_protest.subject.site_size_sqft", "Subject", "Site size (sq ft)", ["subject", "site_size_sqft"], "number", { minimum: 0, maximum: 1_000_000_000 }),
  protestField("property_tax_protest.subject.age_years", "Subject", "Actual age (years)", ["subject", "age_years"], "integer", { minimum: 0, maximum: 500 }),
  protestField("property_tax_protest.subject.bedroom_count", "Subject", "Bedrooms", ["subject", "bedroom_count"], "integer", { minimum: 0, maximum: 100 }),
  protestField("property_tax_protest.subject.bath_count", "Subject", "Total baths", ["subject", "bath_count"], "number", { minimum: 0, maximum: 100 }),
  protestField("property_tax_protest.subject.garage_spaces", "Subject", "Garage spaces", ["subject", "garage_spaces"], "number", { minimum: 0, maximum: 100 }),
  protestField("property_tax_protest.subject.pool", "Subject", "Pool", ["subject", "pool"], "enum", { options: ["yes", "no"] }),
  protestField("property_tax_protest.subject.solar_panels", "Subject", "Solar panels", ["subject", "solar_panels"], "enum", { options: ["yes", "no"] }),
  protestField("property_tax_protest.subject.condition_notes", "Subject", "Condition notes", ["subject", "condition_notes"], "text", { multiline: true }),
  protestField("property_tax_protest.condition.defects_deferred_maintenance", "Condition & repairs", "Defects / deferred maintenance", ["condition", "defects_deferred_maintenance"], "text", { multiline: true }),
  protestField("property_tax_protest.condition.repair_cost_to_cure", "Condition & repairs", "Repair cost to cure", ["condition", "repair_cost_to_cure"], "number", { minimum: 0, maximum: 1_000_000_000 }),
  protestField("property_tax_protest.condition.repair_cost_to_cure_notes", "Condition & repairs", "Cost-to-cure support", ["condition", "repair_cost_to_cure_notes"], "text", { multiline: true }),
  protestField("property_tax_protest.valuation.tax_year", "Valuation", "Tax year", ["valuation", "tax_year"], "integer", { minimum: 2000, maximum: 2200 }),
  protestField("property_tax_protest.valuation.district_appraised_value", "Valuation", "District appraised value", ["valuation", "district_appraised_value"], "number", { minimum: 0, maximum: 10_000_000_000 }),
  protestField("property_tax_protest.valuation.requested_market_value", "Valuation", "Requested market value", ["valuation", "requested_market_value"], "number", { minimum: 0, maximum: 10_000_000_000 }),
  protestField("property_tax_protest.valuation.appraiser_opinion_of_value", "Valuation", "Appraiser opinion of value", ["valuation", "appraiser_opinion_of_value"], "number", { minimum: 0, maximum: 10_000_000_000 }),
  protestField("property_tax_protest.analysis.sales_comparison_notes", "Analysis", "Sales comparison analysis", ["analysis", "sales_comparison_notes"], "text", { multiline: true }),
  protestField("property_tax_protest.analysis.adjustment_notes", "Analysis", "Adjustment support", ["analysis", "adjustment_notes"], "text", { multiline: true }),
  protestField("property_tax_protest.analysis.district_evidence_summary", "Analysis", "District evidence summary", ["analysis", "district_evidence_summary"], "text", { multiline: true }),
  protestField("property_tax_protest.analysis.protest_rationale", "Analysis", "Protest rationale", ["analysis", "protest_rationale"], "text", { multiline: true }),
  protestField("property_tax_protest.inspection.appraiser_comments", "Inspection", "Appraiser field comments", ["inspection", "appraiser_comments"], "text", { multiline: true }),
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cloneObject(value) {
  return plainObject(value) ? JSON.parse(canonicalJson(value)) : {};
}

function stateAtPath(value, path) {
  let current = value;
  for (const part of path) {
    if (!plainObject(current) || !Object.hasOwn(current, part)) return Object.freeze({ exists: false });
    current = current[part];
  }
  return Object.freeze({ exists: true, value: current });
}

function setStateAtPath(value, path, state) {
  const root = cloneObject(value);
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    current[path[index]] = cloneObject(current[path[index]]);
    current = current[path[index]];
  }
  if (state.exists) current[path.at(-1)] = state.value;
  else delete current[path.at(-1)];
  return root;
}

function sameState(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}
function storedTargetBase(value, fallback) {
  if (value == null) return fallback;
  if (!plainObject(value) || typeof value.exists !== "boolean") throw new Error("invalid_target_field_base");
  const keys = Object.keys(value);
  if (keys.some((key) => !new Set(["exists", "value"]).has(key))) throw new Error("invalid_target_field_base");
  if (!value.exists) {
    if (Object.hasOwn(value, "value")) throw new Error("invalid_target_field_base");
    return { exists: false };
  }
  if (!Object.hasOwn(value, "value")) throw new Error("invalid_target_field_base");
  return { exists: true, value: value.value };
}

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function publicDefinition(definition) {
  const { uad_field: _uadField, target_reference: targetReference, ...rest } = definition;
  return { ...rest, target_reference: JSON.parse(canonicalJson(targetReference)) };
}

function uadSegment(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function uadFieldPath(field, entityId = null) {
  const base = `uad.${uadSegment(field.section)}.${uadSegment(field.contextKey)}.f${uadSegment(field.uid)}`;
  return entityId ? `${base}.e${String(entityId).replaceAll("-", "").toLowerCase()}` : base;
}

function uadCatalog(sections, entities) {
  const definitions = [];
  for (const section of sections) {
    for (const group of section.groups) {
      for (const field of group.fields) {
        const instances = field.entityType
          ? entities.filter((entity) => entity.entity_type === field.entityType)
          : [null];
        for (const entity of instances) {
          const entityId = entity?.id || null;
          const entityLabel = entity ? ` · ${entity.label || entity.entity_identifier}` : "";
          definitions.push(Object.freeze({
            field_path: uadFieldPath(field, entityId),
            group: `${section.officialSectionNumber}. ${section.title} · ${group.name}${entityLabel}`,
            label: field.label,
            value_type: field.dataType,
            target_reference: Object.freeze({
              kind: "uad_field_value", section: field.section, context_key: field.contextKey,
              uid: field.uid, report_field_id: field.reportFieldId, entity_id: entityId,
            }),
            options: Object.freeze(field.options || []),
            units: Object.freeze(field.units || []),
            required: Boolean(field.required),
            minimum: field.minimum ?? field.minimumExclusive ?? null,
            maximum: field.maximum ?? null,
            maximum_length: field.maxLength ?? null,
            multiline: field.dataType === "text",
            uad_field: field,
          }));
        }
      }
    }
  }
  return definitions;
}

function valueKey(reference) {
  return `${reference.entity_id || "root"}:${reference.context_key}:${reference.uid}`;
}

async function targetSession(client, auth, sessionId, { lock = false, writable = false } = {}) {
  const { rows } = await client.query(
    `SELECT session.*, report_file.workflow_type, report_file.account_id,
            report_file.file_number, report_file.registry_revision,
            report_file.uad_workfile_id, report_file.tax_protest_file_id
       FROM app.inspection_sessions session
       JOIN app.report_files report_file ON report_file.id = session.report_file_id
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3
      ${lock ? "FOR UPDATE OF session, report_file" : ""}`,
    [sessionId, auth.organizations.map((item) => item.organizationId), auth.userId],
  );
  if (!rows.length || !SUPPORTED_WORKFLOWS.has(rows[0].workflow_type)) throw new Error("target_field_session_not_found");
  if (writable && rows[0].status === "completed") throw new Error("inspection_session_completed_conflict");
  return rows[0];
}

async function loadTargetContext(client, session, { lock = false } = {}) {
  if (session.workflow_type === "property_tax_protest") {
    const result = await client.query(
      `SELECT id, workfile_data, revision, status
         FROM app.tax_protest_files WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
      [session.tax_protest_file_id],
    );
    if (!result.rows.length) throw new Error("property_tax_protest_file_not_found");
    const row = result.rows[0];
    const values = new Map(PROPERTY_TAX_FIELDS.map((definition) => [
      definition.field_path,
      stateAtPath(row.workfile_data, definition.target_reference.target_path),
    ]));
    return {
      revision: Number(row.revision),
      definitions: PROPERTY_TAX_FIELDS,
      definitionByPath: new Map(PROPERTY_TAX_FIELDS.map((item) => [item.field_path, item])),
      values,
      entities: [],
      target: { id: row.id, status: row.status, workfile_data: cloneObject(row.workfile_data) },
    };
  }

  const workfile = await client.query(
    `SELECT id, current_revision, status, specification_release_key, signed_at
       FROM appraisal.uad_workfiles WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [session.uad_workfile_id],
  );
  if (!workfile.rows.length) throw new Error("uad_workfile_not_found");
  const [valuesResult, entitiesResult] = await Promise.all([
    client.query("SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1 ORDER BY created_at, id", [session.uad_workfile_id]),
    client.query("SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 ORDER BY entity_type, ordinal, created_at, id", [session.uad_workfile_id]),
  ]);
  const definitions = uadCatalog(getUadEditorSections(), entitiesResult.rows);
  const rowsByKey = new Map(valuesResult.rows.map((row) => [
    `${row.entity_id || "root"}:${row.field_context}:${row.uad_uid}`,
    row,
  ]));
  const values = new Map(definitions.map((definition) => {
    const row = rowsByKey.get(valueKey(definition.target_reference));
    return [definition.field_path, row ? { exists: true, value: row.value } : { exists: false }];
  }));
  return {
    revision: Number(workfile.rows[0].current_revision),
    definitions,
    definitionByPath: new Map(definitions.map((item) => [item.field_path, item])),
    values,
    entities: entitiesResult.rows,
    target: { ...workfile.rows[0], rowsByKey },
  };
}

function normalizeProtestValue(definition, value) {
  if (definition.value_type === "enum") {
    const normalized = String(value || "").trim();
    if (!definition.options.includes(normalized)) throw new Error("invalid_property_tax_protest_enum");
    return normalized;
  }
  if (definition.value_type === "text" || definition.value_type === "string") {
    if (typeof value !== "string") throw new Error("invalid_property_tax_protest_text");
    const normalized = value.trim();
    if (definition.maximum_length && normalized.length > definition.maximum_length) throw new Error("invalid_property_tax_protest_text");
    return normalized;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) throw new Error("invalid_property_tax_protest_number");
  if (definition.value_type === "integer" && !Number.isInteger(normalized)) throw new Error("invalid_property_tax_protest_integer");
  if ((definition.minimum != null && normalized < definition.minimum) || (definition.maximum != null && normalized > definition.maximum)) {
    throw new Error("invalid_property_tax_protest_number");
  }
  return normalized;
}

export function normalizePropertyTaxWorkfileData(value) {
  if (!plainObject(value)) throw new Error("invalid_property_tax_protest_workfile");
  let normalized = cloneObject(value);
  for (const definition of PROPERTY_TAX_FIELDS) {
    const state = stateAtPath(normalized, definition.target_reference.target_path);
    if (!state.exists) continue;
    normalized = setStateAtPath(normalized, definition.target_reference.target_path, {
      exists: true,
      value: normalizeProtestValue(definition, state.value),
    });
  }
  return normalized;
}

function normalizeProposed(definition, edit) {
  if (edit.is_tombstone) {
    if (definition.required) throw new Error("invalid_required_target_field_clear");
    return { exists: false };
  }
  if (definition.target_reference.kind === "uad_field_value") {
    const result = normalizeAndValidateUadValue(definition.uad_field, edit.entered_value);
    if (result.error) {
      const error = new Error("invalid_uad_mobile_field_value");
      error.details = [result.error];
      throw error;
    }
    return { exists: true, value: result.value };
  }
  return { exists: true, value: normalizeProtestValue(definition, edit.entered_value) };
}

function proposalState(row, prefix) {
  return row[`${prefix}_exists`]
    ? { exists: true, value: row[`${prefix}_value`] }
    : { exists: false };
}

function proposalResponse(row, definition, current = null) {
  return {
    id: row.id,
    field_edit_id: row.field_edit_id,
    workflow_type: row.workflow_type,
    field_path: row.field_path,
    label: definition?.label || row.field_path,
    group: definition?.group || "Other",
    target_reference: row.target_reference,
    base_target_revision: Number(row.base_target_revision),
    base: proposalState(row, "base"),
    proposed: proposalState(row, "proposed"),
    current,
    source_type: row.source_type,
    appraiser_confirmed: Boolean(row.appraiser_confirmed),
    status: row.status,
    conflict: row.conflict || null,
    reviewed_at: timestamp(row.reviewed_at),
    applied_target_revision: row.applied_target_revision == null ? null : Number(row.applied_target_revision),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
}

async function insertEvent(client, session, proposalId, actorUserId, eventType, metadata = {}) {
  await client.query(
    `INSERT INTO app.mobile_target_adapter_events (
       inspection_session_id, report_file_id, proposal_id, workflow_type,
       actor_user_id, event_type, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [session.id, session.report_file_id, proposalId, session.workflow_type, actorUserId, eventType, JSON.stringify(metadata)],
  );
}

async function updateReviewStatus(client, sessionId) {
  const pending = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM app.mobile_target_field_proposals
        WHERE inspection_session_id = $1 AND status IN ('pending', 'conflict')
       UNION ALL
       SELECT 1 FROM app.mobile_uad_entity_proposals
        WHERE inspection_session_id = $1 AND status IN ('pending', 'conflict')
       UNION ALL
       SELECT 1 FROM app.mobile_sync_operations
        WHERE inspection_session_id = $1 AND status = 'conflict' AND resolved_at IS NULL
     ) AS pending`,
    [sessionId],
  );
  await client.query(
    `UPDATE app.inspection_sessions
        SET status = CASE WHEN $2 THEN 'review_required' ELSE 'synchronized' END,
            review_required_at = CASE WHEN $2 THEN COALESCE(review_required_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE id = $1 AND status <> 'completed'`,
    [sessionId, Boolean(pending.rows[0]?.pending)],
  );
}

export function propertyTaxFieldCatalog() {
  return PROPERTY_TAX_FIELDS.map(publicDefinition);
}

export async function refreshTargetFieldProposals(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await targetSession(client, auth, sessionId, { lock: true, writable: true });
    const context = await loadTargetContext(client, session, { lock: true });
    const edits = await client.query(
      `SELECT DISTINCT ON (field_path)
              id, field_path, entered_value, is_tombstone, source_type,
              appraiser_confirmed, session_revision, target_base,
              target_base_revision, created_at
         FROM app.inspection_field_edits
        WHERE inspection_session_id = $1 AND sync_status = 'applied'
        ORDER BY field_path, session_revision DESC, created_at DESC, id DESC`,
      [sessionId],
    );
    const created = [];
    const invalidFields = [];
    for (const edit of edits.rows) {
      const definition = context.definitionByPath.get(edit.field_path);
      if (!definition) continue;
      const existing = await client.query("SELECT id FROM app.mobile_target_field_proposals WHERE field_edit_id = $1", [edit.id]);
      if (existing.rows.length) continue;
      let proposed;
      try {
        proposed = normalizeProposed(definition, edit);
      } catch (error) {
        invalidFields.push({ field_path: edit.field_path, error: error.message, details: error.details || [] });
        continue;
      }
      const superseded = await client.query(
        `UPDATE app.mobile_target_field_proposals SET status = 'superseded', updated_at = now()
          WHERE inspection_session_id = $1 AND field_path = $2 AND status IN ('pending', 'conflict')
          RETURNING id`,
        [sessionId, edit.field_path],
      );
      for (const row of superseded.rows) {
        await insertEvent(client, session, row.id, auth.userId, "target_adapter.proposal_superseded", { replacement_field_edit_id: edit.id });
      }
      const base = storedTargetBase(
        edit.target_base,
        context.values.get(edit.field_path) || { exists: false },
      );
      const baseTargetRevision = edit.target_base_revision == null ? context.revision : Number(edit.target_base_revision);
      const inserted = await client.query(
        `INSERT INTO app.mobile_target_field_proposals (
           inspection_session_id, report_file_id, field_edit_id, workflow_type,
           field_path, target_reference, base_target_revision,
           base_exists, base_value, proposed_exists, proposed_value,
           source_type, appraiser_confirmed
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11::jsonb, $12, $13)
         RETURNING *`,
        [
          sessionId, session.report_file_id, edit.id, session.workflow_type,
          edit.field_path, JSON.stringify(definition.target_reference), baseTargetRevision,
          base.exists, base.exists ? JSON.stringify(base.value) : null,
          proposed.exists, proposed.exists ? JSON.stringify(proposed.value) : null,
          edit.source_type, edit.appraiser_confirmed,
        ],
      );
      await insertEvent(client, session, inserted.rows[0].id, auth.userId, "target_adapter.proposal_created", {
        field_path: edit.field_path, source_type: edit.source_type,
        appraiser_confirmed: Boolean(edit.appraiser_confirmed),
      });
      created.push(proposalResponse(inserted.rows[0], definition, base));
    }
    await updateReviewStatus(client, sessionId);
    await client.query("COMMIT");
    return { workflow_type: session.workflow_type, created, invalid_fields: invalidFields };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function reviewRequest(input) {
  const allowed = new Set(["client_operation_id", "decision"]);
  if (!plainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) throw new Error("invalid_target_field_review");
  const decision = String(input.decision || "");
  if (!new Set(["accept", "reject"]).has(decision)) throw new Error("invalid_target_field_review_decision");
  return {
    clientOperationId: normalizeUuid(input.client_operation_id, "invalid_client_operation_id"),
    decision,
  };
}

async function reviewOperation(client, sessionId, proposalId, request) {
  const hash = createHash("sha256")
    .update(canonicalJson({ proposal_id: proposalId, decision: request.decision }))
    .digest("hex");
  const existing = await client.query(
    `SELECT request_sha256, result FROM app.mobile_target_review_operations
      WHERE inspection_session_id = $1 AND client_operation_id = $2`,
    [sessionId, request.clientOperationId],
  );
  if (existing.rows.length) {
    if (existing.rows[0].request_sha256 !== hash) throw new Error("client_operation_id_conflict");
    return { hash, existing: existing.rows[0].result };
  }
  return { hash, existing: null };
}

async function applyPropertyTaxProposal(client, auth, session, context, proposal, proposed) {
  const nextValue = setStateAtPath(context.target.workfile_data, proposal.target_reference.target_path, proposed);
  const nextRevision = context.revision + 1;
  const updated = await client.query(
    `UPDATE app.tax_protest_files
        SET workfile_data = $2::jsonb, revision = $3, status = 'in_progress',
            updated_by_user_id = $4, updated_at = now()
      WHERE id = $1 RETURNING workfile_data, revision, status`,
    [session.tax_protest_file_id, JSON.stringify(nextValue), nextRevision, auth.userId],
  );
  await client.query(
    `INSERT INTO app.tax_protest_file_history (
       tax_protest_file_id, revision, workfile_data, status,
       changed_by_user_id, change_summary
     ) VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      session.tax_protest_file_id,
      nextRevision,
      JSON.stringify(updated.rows[0].workfile_data),
      updated.rows[0].status,
      auth.userId,
      `Accepted mobile field ${proposal.field_path}`,
    ],
  );
  return nextRevision;
}

async function applyUadProposal(client, auth, session, context, proposal, definition, proposed) {
  // The review owner already holds this workfile's lock. Even equal values
  // rewrite provenance/revision, so every canonical acceptance needs this guard.
  await assertLockedUadWorkfileMutable(client, context.target);
  const reference = definition.target_reference;
  const row = context.target.rowsByKey.get(valueKey(reference));
  const changed = !row || !proposed.exists || canonicalJson(row.value) !== canonicalJson(proposed.value);
  if (!proposed.exists) {
    await client.query(
      `DELETE FROM appraisal.uad_field_values
        WHERE workfile_id = $1 AND field_context = $2 AND uad_uid = $3
          AND entity_id IS NOT DISTINCT FROM $4::uuid`,
      [session.uad_workfile_id, reference.context_key, reference.uid, reference.entity_id],
    );
  } else if (row) {
    const override = row.source_type !== "appraiser" && changed;
    await client.query(
      `UPDATE appraisal.uad_field_values
          SET value = $2::jsonb, report_field_id = $3, source_type = 'appraiser',
              source_reference = 'mobile_target_adapter', is_appraiser_confirmed = true,
              is_override = $4, override_reason = $5,
              updated_by_user_id = $6, updated_at = now()
        WHERE id = $1`,
      [
        row.id,
        JSON.stringify(proposed.value),
        reference.report_field_id,
        override,
        override ? "Appraiser accepted a mobile inspection observation." : null,
        auth.userId,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO appraisal.uad_field_values (
         id, workfile_id, entity_id, field_context, uad_uid, report_field_id,
         value, source_type, source_reference, is_appraiser_confirmed, updated_by_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'appraiser', 'mobile_target_adapter', true, $8)`,
      [randomUUID(), session.uad_workfile_id, reference.entity_id, reference.context_key, reference.uid, reference.report_field_id, JSON.stringify(proposed.value), auth.userId],
    );
  }

  const nextRevision = context.revision + 1;
  const [allValues, entities] = await Promise.all([
    client.query("SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1 ORDER BY created_at, id", [session.uad_workfile_id]),
    client.query("SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 ORDER BY entity_type, ordinal, created_at, id", [session.uad_workfile_id]),
  ]);
  const document = {
    entities: entities.rows,
    field_values: allValues.rows.map((item) => ({
      entity_id: item.entity_id || null,
      uid: item.uad_uid,
      context_key: item.field_context,
      report_field_id: item.report_field_id,
      value: item.value,
      source_type: item.source_type,
      is_appraiser_confirmed: item.is_appraiser_confirmed,
    })),
  };
  await client.query(
    `UPDATE appraisal.uad_workfiles
        SET current_revision = $2, status = 'draft', updated_by_user_id = $3, updated_at = now()
      WHERE id = $1`,
    [session.uad_workfile_id, nextRevision, auth.userId],
  );
  await client.query(
    `INSERT INTO appraisal.uad_revisions (
       id, workfile_id, revision_number, specification_release_key,
       document, change_summary, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      randomUUID(), session.uad_workfile_id, nextRevision,
      context.target.specification_release_key, JSON.stringify(document),
      `Accepted mobile field ${proposal.field_path}`, auth.userId,
    ],
  );
  await client.query(
    `INSERT INTO appraisal.uad_audit_events (
       workfile_id, actor_user_id, event_type, entity_type, entity_id,
       before_data, after_data, metadata
     ) VALUES ($1, $2, 'uad_mobile_field.accepted', 'uad_field', $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
    [
      session.uad_workfile_id,
      auth.userId,
      reference.entity_id,
      JSON.stringify({ field_path: proposal.field_path, state: proposalState(proposal, "base") }),
      JSON.stringify({ field_path: proposal.field_path, state: proposed }),
      JSON.stringify({ revision_number: nextRevision, proposal_id: proposal.id, context_key: reference.context_key, uid: reference.uid }),
    ],
  );
  return nextRevision;
}

async function bumpReportRevision(client, auth, session, proposal, appliedTargetRevision) {
  const updated = await client.query(
    `UPDATE app.report_files SET registry_revision = registry_revision + 1, updated_at = now()
      WHERE id = $1 RETURNING registry_revision`,
    [session.report_file_id],
  );
  const nextRevision = Number(updated.rows[0].registry_revision);
  await client.query(
    `INSERT INTO app.report_file_events (
       report_file_id, actor_user_id, event_type, prior_registry_revision,
       next_registry_revision, changed_fields, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb)`,
    [
      session.report_file_id, auth.userId, `${session.workflow_type}.mobile_field_accepted`,
      nextRevision - 1, nextRevision, [proposal.field_path],
      JSON.stringify({ proposal_id: proposal.id, target_reference: proposal.target_reference, applied_target_revision: appliedTargetRevision }),
    ],
  );
  await client.query(
    "UPDATE app.inspection_sessions SET base_report_revision = $2, updated_at = now() WHERE id = $1",
    [session.id, nextRevision],
  );
  return nextRevision;
}

export async function reviewTargetFieldProposal(pool, auth, sessionIdValue, proposalIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const proposalId = normalizeUuid(proposalIdValue, "invalid_target_field_proposal_id");
  const request = reviewRequest(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const session = await targetSession(client, auth, sessionId, { lock: true, writable: true });
    const operation = await reviewOperation(client, sessionId, proposalId, request);
    if (operation.existing) {
      await client.query("COMMIT");
      return operation.existing;
    }
    const selected = await client.query(
      `SELECT * FROM app.mobile_target_field_proposals
        WHERE id = $1 AND inspection_session_id = $2 FOR UPDATE`,
      [proposalId, sessionId],
    );
    const proposal = selected.rows[0];
    if (!proposal) throw new Error("target_field_proposal_not_found");
    const mayRejectConflict = request.decision === "reject" && proposal.status === "conflict";
    if (proposal.status !== "pending" && !mayRejectConflict) {
      throw new Error("target_field_proposal_status_conflict");
    }
    const context = await loadTargetContext(client, session, { lock: true });
    const definition = context.definitionByPath.get(proposal.field_path);
    if (request.decision !== "reject" && (!definition || canonicalJson(definition.target_reference) !== canonicalJson(proposal.target_reference))) {
      throw new Error("target_field_definition_conflict");
    }

    let result;
    let operationStatus = "applied";
    if (request.decision === "reject") {
      const rejected = await client.query(
        `UPDATE app.mobile_target_field_proposals
            SET status = 'rejected', reviewed_by_user_id = $2,
                reviewed_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [proposalId, auth.userId],
      );
      await insertEvent(client, session, proposalId, auth.userId, "target_adapter.proposal_rejected", { field_path: proposal.field_path });
      result = { proposal: proposalResponse(rejected.rows[0], definition), report_registry_revision: Number(session.registry_revision) };
    } else {
      const current = context.values.get(proposal.field_path) || { exists: false };
      const base = proposalState(proposal, "base");
      if (!sameState(current, base)) {
        const conflict = { base, current, detected_at: new Date().toISOString() };
        const conflicted = await client.query(
          `UPDATE app.mobile_target_field_proposals
              SET status = 'conflict', conflict = $2::jsonb,
                  reviewed_by_user_id = $3, reviewed_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [proposalId, JSON.stringify(conflict), auth.userId],
        );
        await insertEvent(client, session, proposalId, auth.userId, "target_adapter.proposal_conflict", { field_path: proposal.field_path, conflict });
        operationStatus = "conflict";
        result = { proposal: proposalResponse(conflicted.rows[0], definition, current), report_registry_revision: Number(session.registry_revision) };
      } else {
        const proposed = proposalState(proposal, "proposed");
        const targetRevision = session.workflow_type === "uad_3_6"
          ? await applyUadProposal(client, auth, session, context, proposal, definition, proposed)
          : await applyPropertyTaxProposal(client, auth, session, context, proposal, proposed);
        const reportRevision = await bumpReportRevision(client, auth, session, proposal, targetRevision);
        const accepted = await client.query(
          `UPDATE app.mobile_target_field_proposals
              SET status = 'accepted', reviewed_by_user_id = $2, reviewed_at = now(),
                  applied_target_revision = $3, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [proposalId, auth.userId, targetRevision],
        );
        await insertEvent(client, session, proposalId, auth.userId, "target_adapter.proposal_accepted", {
          field_path: proposal.field_path,
          applied_target_revision: targetRevision,
          report_registry_revision: reportRevision,
        });
        result = { proposal: proposalResponse(accepted.rows[0], definition, proposed), report_registry_revision: reportRevision };
      }
    }
    await client.query(
      `INSERT INTO app.mobile_target_review_operations (
       inspection_session_id, proposal_id, client_operation_id, request_sha256,
       decision, status, result, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [sessionId, proposalId, request.clientOperationId, operation.hash, request.decision, operationStatus, JSON.stringify(result), auth.userId],
    );
    await updateReviewStatus(client, sessionId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getTargetFieldReview(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const client = await pool.connect();
  try {
    const session = await targetSession(client, auth, sessionId);
    const context = await loadTargetContext(client, session);
    const [proposals, photos, updatedSession] = await Promise.all([
      client.query(
        `SELECT * FROM app.mobile_target_field_proposals
          WHERE inspection_session_id = $1 ORDER BY created_at DESC, id DESC`,
        [sessionId],
      ),
      client.query(
        `SELECT id, category, room_ref, room_label, caption, position,
                retention_until, verified_at
           FROM app.inspection_photos
          WHERE inspection_session_id = $1 AND report_file_id = $2 AND status = 'verified'
          ORDER BY position, created_at, id`,
        [sessionId, session.report_file_id],
      ),
      client.query("SELECT * FROM app.inspection_sessions WHERE id = $1", [sessionId]),
    ]);
    return {
      session: sessionResponse(updatedSession.rows[0]),
      report_file: {
        id: session.report_file_id,
        account_id: session.account_id,
        file_number: session.file_number,
        workflow_type: session.workflow_type,
        registry_revision: Number(session.registry_revision),
        target_id: session.workflow_type === "uad_3_6" ? session.uad_workfile_id : session.tax_protest_file_id,
      },
      target: {
        revision: context.revision,
        status: context.target.status,
        specification_release_key: context.target.specification_release_key || null,
      },
      catalog: context.definitions.map(publicDefinition),
      values: Object.fromEntries(context.values),
      entities: context.entities.map((entity) => ({
        id: entity.id,
        parent_entity_id: entity.parent_entity_id || null,
        entity_type: entity.entity_type,
        entity_identifier: entity.entity_identifier,
        ordinal: Number(entity.ordinal),
        label: entity.label || null,
      })),
      proposals: proposals.rows.map((row) => proposalResponse(
        row,
        context.definitionByPath.get(row.field_path),
        context.values.get(row.field_path) || { exists: false },
      )),
      photos: {
        verified_count: photos.rows.length,
        items: photos.rows.map((row) => ({ ...row, position: Number(row.position) })),
      },
    };
  } finally {
    client.release();
  }
}
