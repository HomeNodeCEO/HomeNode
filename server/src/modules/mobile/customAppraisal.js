import { createHash } from "node:crypto";

import { validateAssignmentDetails, validateReportManualSection } from "../../util/reportManualValues.js";
import { normalizeUuid, sessionResponse } from "./reportFiles.js";
import { canonicalJson } from "./sync.js";

const PROPERTY_SECTION = "report.property_characteristics";
const ASSIGNMENT_SECTION = "report.assignment_details";
const CONDITION_RATINGS = new Set([
  "", "C1", "C2-C1", "C2", "C3-C2", "C3", "C4-C3", "C4", "C5-C4", "C5", "C6-C5", "C6",
]);

const FIELD_DEFINITIONS = Object.freeze([
  field("custom_appraisal.property_characteristics.main_improvement.living_area_sqft", "Basics", "Living area (sq ft)", ["main_improvement", "living_area_sqft"], "integer", { minimum: 0, maximum: 1_000_000 }),
  field("custom_appraisal.property_characteristics.main_improvement.bedroom_count", "Basics", "Bedrooms", ["main_improvement", "bedroom_count"], "integer", { minimum: 0, maximum: 100 }),
  field("custom_appraisal.property_characteristics.main_improvement.bath_count", "Basics", "Total baths", ["main_improvement", "bath_count"], "number", { minimum: 0, maximum: 100 }),
  field("custom_appraisal.property_characteristics.main_improvement.baths_full", "Basics", "Full baths", ["main_improvement", "baths_full"], "integer", { minimum: 0, maximum: 100 }),
  field("custom_appraisal.property_characteristics.main_improvement.baths_half", "Basics", "Half baths", ["main_improvement", "baths_half"], "integer", { minimum: 0, maximum: 100 }),
  field("custom_appraisal.property_characteristics.main_improvement.stories", "Basics", "Stories", ["main_improvement", "stories"], "number", { minimum: 0, maximum: 20 }),
  field("custom_appraisal.property_characteristics.main_improvement.year_built", "Basics", "Year built", ["main_improvement", "year_built"], "integer", { minimum: 1700, maximum: 2200 }),
  field("custom_appraisal.property_characteristics.main_improvement.effective_year_built", "Basics", "Effective year built", ["main_improvement", "effective_year_built"], "integer", { minimum: 1700, maximum: 2200 }),
  field("custom_appraisal.property_characteristics.main_improvement.construction_type", "Exterior", "Construction type", ["main_improvement", "construction_type"], "text"),
  field("custom_appraisal.property_characteristics.main_improvement.foundation", "Exterior", "Foundation", ["main_improvement", "foundation"], "text"),
  field("custom_appraisal.property_characteristics.main_improvement.exterior_material", "Exterior", "Exterior walls", ["main_improvement", "exterior_material"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.skirting", "Exterior", "Skirting", ["inspection_details", "skirting"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.window_type", "Exterior", "Window type", ["inspection_details", "window_type"], "text"),
  field("custom_appraisal.property_characteristics.main_improvement.roof_type", "Exterior", "Roof type", ["main_improvement", "roof_type"], "text"),
  field("custom_appraisal.property_characteristics.main_improvement.roof_material", "Exterior", "Roof material", ["main_improvement", "roof_material"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.interior_floor_type", "Interior", "Interior floor", ["inspection_details", "interior_floor_type"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.bath_floor_type", "Interior", "Bath floor", ["inspection_details", "bath_floor_type"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.kitchen_countertop_type", "Interior", "Kitchen countertops", ["inspection_details", "kitchen_countertop_type"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.interior_wall_type", "Interior", "Interior walls", ["inspection_details", "interior_wall_type"], "text"),
  field("custom_appraisal.property_characteristics.main_improvement.heating", "Systems & amenities", "Heating", ["main_improvement", "heating"], "text"),
  field("custom_appraisal.property_characteristics.main_improvement.air_conditioning", "Systems & amenities", "Air conditioning", ["main_improvement", "air_conditioning"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.garage_carport", "Systems & amenities", "Garage / carport", ["inspection_details", "garage_carport"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.pool_amenities", "Systems & amenities", "Pool / amenities", ["inspection_details", "pool_amenities"], "text"),
  field("custom_appraisal.property_characteristics.inspection_details.updates_remodeling", "Condition & repairs", "Updates / remodeling", ["inspection_details", "updates_remodeling"], "text", { maximumLength: 3000, multiline: true }),
  field("custom_appraisal.property_characteristics.inspection_details.additions", "Condition & repairs", "Additions", ["inspection_details", "additions"], "text", { maximumLength: 3000, multiline: true }),
  field("custom_appraisal.property_characteristics.inspection_details.defects_deferred_maintenance", "Condition & repairs", "Defects / deferred maintenance", ["inspection_details", "defects_deferred_maintenance"], "text", { maximumLength: 5000, multiline: true }),
  field("custom_appraisal.property_characteristics.inspection_details.repair_cost_to_cure", "Condition & repairs", "Repair cost to cure", ["inspection_details", "repair_cost_to_cure"], "number", { minimum: 0, maximum: 1_000_000_000 }),
  field("custom_appraisal.property_characteristics.inspection_details.additional_improvements_notes", "Condition & repairs", "Additional improvements", ["inspection_details", "additional_improvements_notes"], "text", { maximumLength: 3000, multiline: true }),
  field("inspection.general.appraiser_comments", "Condition & repairs", "Appraiser field comments", ["inspection_details", "appraiser_comments"], "text", { maximumLength: 5000, multiline: true }),
  assignmentField("custom_appraisal.assignment_details.subject_condition_rating", "Condition & repairs", "Overall condition rating", ["subject_condition_rating"], "condition"),
  assignmentField("custom_appraisal.assignment_details.subject_condition_notes", "Condition & repairs", "Condition notes", ["subject_condition_notes"], "text", { maximumLength: 5000, multiline: true }),
  assignmentField("custom_appraisal.assignment_details.significant_physical_deficiencies", "Condition & repairs", "Significant physical deficiencies", ["significant_physical_deficiencies"], "boolean"),
  assignmentField("custom_appraisal.assignment_details.subject_conforms_to_neighborhood", "Condition & repairs", "Conforms to neighborhood", ["subject_conforms_to_neighborhood"], "boolean"),
]);

const FIELD_BY_PATH = new Map(FIELD_DEFINITIONS.map((definition) => [definition.field_path, definition]));

function field(fieldPath, group, label, targetPath, valueType, options = {}) {
  return Object.freeze({
    field_path: fieldPath,
    group,
    label,
    target_kind: "report_section",
    section_key: PROPERTY_SECTION,
    target_path: Object.freeze(targetPath),
    value_type: valueType,
    minimum: options.minimum ?? null,
    maximum: options.maximum ?? null,
    maximum_length: options.maximumLength ?? (valueType === "text" ? 500 : null),
    multiline: Boolean(options.multiline),
  });
}

function assignmentField(fieldPath, group, label, targetPath, valueType, options = {}) {
  return Object.freeze({
    ...field(fieldPath, group, label, targetPath, valueType, options),
    target_kind: "assignment_details",
    section_key: ASSIGNMENT_SECTION,
  });
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, allowed, code) {
  if (!plainObject(value) || Object.keys(value).some((key) => !allowed.has(key))) throw new Error(code);
}

function organizationIds(auth) {
  return auth.organizations.map((item) => item.organizationId);
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
    const part = path[index];
    current[part] = cloneObject(current[part]);
    current = current[part];
  }
  const leaf = path[path.length - 1];
  if (state.exists) current[leaf] = state.value;
  else delete current[leaf];
  return root;
}

function sameState(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeProposedValue(definition, value) {
  if (definition.value_type === "boolean") {
    if (typeof value !== "boolean") throw new Error("invalid_custom_appraisal_boolean");
    return value;
  }
  if (definition.value_type === "condition") {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (!CONDITION_RATINGS.has(normalized)) throw new Error("invalid_custom_appraisal_condition");
    return normalized;
  }
  if (definition.value_type === "text") {
    if (typeof value !== "string") throw new Error("invalid_custom_appraisal_text");
    const normalized = value.trim();
    if (normalized.length > definition.maximum_length) throw new Error("invalid_custom_appraisal_text");
    return normalized;
  }
  if (typeof value === "string" && !value.trim()) throw new Error("invalid_custom_appraisal_number");
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) throw new Error("invalid_custom_appraisal_number");
  if (definition.value_type === "integer" && !Number.isInteger(normalized)) {
    throw new Error("invalid_custom_appraisal_integer");
  }
  if (normalized < definition.minimum || normalized > definition.maximum) {
    throw new Error("invalid_custom_appraisal_number");
  }
  return normalized;
}

export function customAppraisalFieldCatalog() {
  return FIELD_DEFINITIONS.map((definition) => ({ ...definition, target_path: [...definition.target_path] }));
}

export function customAppraisalFieldDefinition(fieldPath) {
  return FIELD_BY_PATH.get(String(fieldPath || "")) || null;
}

export function normalizeCustomAppraisalFieldValue(fieldPath, value) {
  const definition = customAppraisalFieldDefinition(fieldPath);
  if (!definition) throw new Error("invalid_custom_appraisal_field_path");
  return normalizeProposedValue(definition, value);
}

function proposalState(row, prefix) {
  if (!row[`${prefix}_exists`]) return Object.freeze({ exists: false });
  return Object.freeze({ exists: true, value: row[`${prefix}_value`] });
}

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function proposalResponse(row, current = null) {
  return {
    id: row.id,
    field_edit_id: row.field_edit_id,
    field_path: row.field_path,
    label: FIELD_BY_PATH.get(row.field_path)?.label || row.field_path,
    group: FIELD_BY_PATH.get(row.field_path)?.group || "Other",
    target_kind: row.target_kind,
    section_key: row.section_key,
    target_path: row.target_path,
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

async function customSession(client, auth, sessionId, { lock = false, writable = false } = {}) {
  const locking = lock ? "FOR UPDATE OF session, report_file, assignment_file, workfile" : "";
  const { rows } = await client.query(
    `SELECT session.*,
            report_file.workflow_type, report_file.account_id, report_file.file_number,
            report_file.registry_revision, report_file.custom_assignment_file_id,
            assignment_file.assignment_details, assignment_file.revision AS assignment_revision,
            assignment_file.reviewer AS assignment_reviewer,
            workfile.status AS custom_appraisal_workfile_status
       FROM app.inspection_sessions session
       JOIN app.report_files report_file ON report_file.id = session.report_file_id
       JOIN app.assignment_files assignment_file ON assignment_file.id = report_file.custom_assignment_file_id
       JOIN app.custom_appraisal_workfiles workfile ON workfile.assignment_file_id = assignment_file.id
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3
        AND report_file.workflow_type = 'custom_appraisal'
      ${locking}`,
    [sessionId, organizationIds(auth), auth.userId],
  );
  if (!rows.length) throw new Error("custom_appraisal_session_not_found");
  if (writable && rows[0].status === "completed") throw new Error("inspection_session_completed_conflict");
  if (writable && rows[0].custom_appraisal_workfile_status === "signed") {
    throw new Error("custom_appraisal_workfile_signed");
  }
  return rows[0];
}

async function loadPropertySection(client, session) {
  const assignmentFileId = Number(session.custom_assignment_file_id);
  const section = await client.query(
    `SELECT section_value, revision
       FROM app.custom_appraisal_sections
      WHERE assignment_file_id = $1 AND section_key = $2`,
    [assignmentFileId, PROPERTY_SECTION],
  );
  if (section.rows.length) {
    return { value: cloneObject(section.rows[0].section_value), revision: Number(section.rows[0].revision), source: "assignment_file" };
  }
  const manualTable = await client.query(
    "SELECT to_regclass('app.property_attribute_manual_values') IS NOT NULL AS available",
  );
  if (!manualTable.rows[0]?.available) {
    return { value: {}, revision: 0, source: "empty_seed" };
  }
  const fallback = await client.query(
    `SELECT attribute_value
       FROM app.property_attribute_manual_values
      WHERE account_id = $1 AND attribute_key = $2`,
    [session.account_id, PROPERTY_SECTION],
  );
  return {
    value: cloneObject(fallback.rows[0]?.attribute_value),
    revision: 0,
    source: fallback.rows.length ? "property_report_seed" : "empty_seed",
  };
}

async function targetSnapshot(client, session, definition) {
  if (definition.target_kind === "assignment_details") {
    const value = cloneObject(session.assignment_details);
    return {
      container: value,
      state: stateAtPath(value, definition.target_path),
      revision: Number(session.assignment_revision),
      source: "assignment_file",
    };
  }
  const section = await loadPropertySection(client, session);
  return { container: section.value, state: stateAtPath(section.value, definition.target_path), revision: section.revision, source: section.source };
}

function reviewRequest(input) {
  exactKeys(input, new Set(["client_operation_id", "decision"]), "invalid_custom_appraisal_review");
  const decision = String(input.decision || "");
  if (!new Set(["accept", "reject"]).has(decision)) throw new Error("invalid_custom_appraisal_review_decision");
  return Object.freeze({
    clientOperationId: normalizeUuid(input.client_operation_id, "invalid_client_operation_id"),
    decision,
  });
}

function requestHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

async function insertAdapterEvent(client, session, proposalId, actorUserId, eventType, metadata = {}) {
  await client.query(
    `INSERT INTO app.custom_appraisal_adapter_events (
       inspection_session_id, report_file_id, assignment_file_id,
       proposal_id, actor_user_id, event_type, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [session.id, session.report_file_id, session.custom_assignment_file_id, proposalId, actorUserId, eventType, JSON.stringify(metadata)],
  );
}

async function updateReviewStatus(client, sessionId) {
  const pending = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM app.custom_appraisal_proposals
        WHERE inspection_session_id = $1 AND status = 'pending'
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

export async function refreshCustomAppraisalProposals(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await customSession(client, auth, sessionId, { lock: true, writable: true });
    const edits = await client.query(
      `SELECT DISTINCT ON (field_path)
              id, field_path, entered_value, is_tombstone, source_type,
              appraiser_confirmed, session_revision, created_at
         FROM app.inspection_field_edits
        WHERE inspection_session_id = $1 AND sync_status = 'applied'
        ORDER BY field_path, session_revision DESC, created_at DESC, id DESC`,
      [sessionId],
    );
    const created = [];
    const invalidFields = [];
    for (const edit of edits.rows) {
      const definition = FIELD_BY_PATH.get(edit.field_path);
      if (!definition) continue;
      const existing = await client.query(
        "SELECT * FROM app.custom_appraisal_proposals WHERE field_edit_id = $1",
        [edit.id],
      );
      if (existing.rows.length) continue;
      const superseded = await client.query(
        `UPDATE app.custom_appraisal_proposals
            SET status = 'superseded', updated_at = now()
          WHERE inspection_session_id = $1 AND field_path = $2 AND status = 'pending'
          RETURNING id`,
        [sessionId, edit.field_path],
      );
      for (const row of superseded.rows) {
        await insertAdapterEvent(client, session, row.id, auth.userId, "custom_adapter.proposal_superseded", {
          replacement_field_edit_id: edit.id,
        });
      }
      let proposed;
      try {
        proposed = edit.is_tombstone
          ? { exists: false }
          : { exists: true, value: normalizeProposedValue(definition, edit.entered_value) };
      } catch (error) {
        invalidFields.push({ field_path: edit.field_path, error: error.message });
        continue;
      }
      const target = await targetSnapshot(client, session, definition);
      const inserted = await client.query(
        `INSERT INTO app.custom_appraisal_proposals (
           inspection_session_id, report_file_id, assignment_file_id, field_edit_id,
           field_path, target_kind, section_key, target_path, base_target_revision,
           base_exists, base_value, proposed_exists, proposed_value,
           source_type, appraiser_confirmed
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::text[], $9,
           $10, $11::jsonb, $12, $13::jsonb, $14, $15
         ) RETURNING *`,
        [
          sessionId, session.report_file_id, session.custom_assignment_file_id, edit.id,
          edit.field_path, definition.target_kind, definition.section_key, definition.target_path,
          target.revision, target.state.exists, target.state.exists ? JSON.stringify(target.state.value) : null,
          proposed.exists, proposed.exists ? JSON.stringify(proposed.value) : null,
          edit.source_type, edit.appraiser_confirmed,
        ],
      );
      await insertAdapterEvent(client, session, inserted.rows[0].id, auth.userId, "custom_adapter.proposal_created", {
        field_path: edit.field_path,
        target_source: target.source,
        source_type: edit.source_type,
        appraiser_confirmed: Boolean(edit.appraiser_confirmed),
      });
      created.push(proposalResponse(inserted.rows[0], target.state));
    }
    await updateReviewStatus(client, sessionId);
    await client.query("COMMIT");
    return { created, invalid_fields: invalidFields };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function reviewOperation(client, sessionId, proposalId, request) {
  const hash = requestHash({ proposal_id: proposalId, decision: request.decision });
  const existing = await client.query(
    `SELECT request_sha256, result
       FROM app.custom_appraisal_review_operations
      WHERE inspection_session_id = $1 AND client_operation_id = $2`,
    [sessionId, request.clientOperationId],
  );
  if (existing.rows.length) {
    if (existing.rows[0].request_sha256 !== hash) throw new Error("client_operation_id_conflict");
    return { hash, existing: existing.rows[0].result };
  }
  return { hash, existing: null };
}

async function applyAcceptedProposal(client, auth, session, proposal, definition, proposed) {
  if (definition.target_kind === "assignment_details") {
    const nextValue = setStateAtPath(session.assignment_details, definition.target_path, proposed);
    validateAssignmentDetails(nextValue);
    const reviewer = `HomeNode mobile · ${auth.email || auth.userId}`.slice(0, 200);
    const updated = await client.query(
      `UPDATE app.assignment_files
          SET assignment_details = $1::jsonb, reviewer = $2,
              revision = revision + 1, updated_at = now()
        WHERE id = $3
        RETURNING account_id, file_number, assignment_details, reviewer, revision`,
      [JSON.stringify(nextValue), reviewer, session.custom_assignment_file_id],
    );
    const row = updated.rows[0];
    await client.query(
      `INSERT INTO app.assignment_file_history (
         assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [session.custom_assignment_file_id, row.account_id, row.file_number, JSON.stringify(row.assignment_details), row.reviewer, row.revision],
    );
    return { revision: Number(row.revision), value: row.assignment_details };
  }

  const propertySection = await loadPropertySection(client, session);
  const nextValue = setStateAtPath(propertySection.value, definition.target_path, proposed);
  validateReportManualSection(PROPERTY_SECTION, nextValue);
  const updated = await client.query(
    `INSERT INTO app.custom_appraisal_sections (
       assignment_file_id, section_key, section_value, revision,
       last_applied_session_id, last_applied_by_user_id
     ) VALUES ($1, $2, $3::jsonb, 1, $4, $5)
     ON CONFLICT (assignment_file_id, section_key) DO UPDATE SET
       section_value = EXCLUDED.section_value,
       revision = app.custom_appraisal_sections.revision + 1,
       last_applied_session_id = EXCLUDED.last_applied_session_id,
       last_applied_by_user_id = EXCLUDED.last_applied_by_user_id,
       updated_at = now()
     RETURNING section_value, revision`,
    [session.custom_assignment_file_id, PROPERTY_SECTION, JSON.stringify(nextValue), session.id, auth.userId],
  );
  const row = updated.rows[0];
  await client.query(
    `INSERT INTO app.custom_appraisal_section_history (
       assignment_file_id, section_key, section_value, revision,
       inspection_session_id, actor_user_id, proposal_id, changed_path
     ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8::text[])`,
    [session.custom_assignment_file_id, PROPERTY_SECTION, JSON.stringify(row.section_value), row.revision, session.id, auth.userId, proposal.id, definition.target_path],
  );
  return { revision: Number(row.revision), value: row.section_value };
}

async function bumpReportRevision(client, auth, session, proposal, appliedTargetRevision) {
  const updated = await client.query(
    `UPDATE app.report_files
        SET registry_revision = registry_revision + 1, updated_at = now()
      WHERE id = $1
      RETURNING registry_revision`,
    [session.report_file_id],
  );
  const nextRevision = Number(updated.rows[0].registry_revision);
  await client.query(
    `INSERT INTO app.report_file_events (
       report_file_id, actor_user_id, event_type, prior_registry_revision,
       next_registry_revision, changed_fields, metadata
     ) VALUES ($1, $2, 'custom_appraisal.mobile_field_accepted', $3, $4, $5::text[], $6::jsonb)`,
    [
      session.report_file_id, auth.userId, nextRevision - 1, nextRevision, [proposal.field_path],
      JSON.stringify({ proposal_id: proposal.id, target_kind: proposal.target_kind, section_key: proposal.section_key, target_path: proposal.target_path, applied_target_revision: appliedTargetRevision }),
    ],
  );
  await client.query(
    `UPDATE app.inspection_sessions
        SET base_report_revision = $2, updated_at = now()
      WHERE id = $1`,
    [session.id, nextRevision],
  );
  return nextRevision;
}

export async function reviewCustomAppraisalProposal(pool, auth, sessionIdValue, proposalIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const proposalId = normalizeUuid(proposalIdValue, "invalid_custom_appraisal_proposal_id");
  const request = reviewRequest(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await customSession(client, auth, sessionId, { lock: true, writable: true });
    const operation = await reviewOperation(client, sessionId, proposalId, request);
    if (operation.existing) {
      await client.query("COMMIT");
      return operation.existing;
    }
    const selected = await client.query(
      `SELECT * FROM app.custom_appraisal_proposals
        WHERE id = $1 AND inspection_session_id = $2
        FOR UPDATE`,
      [proposalId, sessionId],
    );
    const proposal = selected.rows[0];
    if (!proposal) throw new Error("custom_appraisal_proposal_not_found");
    if (proposal.status !== "pending") throw new Error("custom_appraisal_proposal_status_conflict");
    const definition = FIELD_BY_PATH.get(proposal.field_path);
    if (!definition) throw new Error("invalid_custom_appraisal_field_path");

    let result;
    let operationStatus = "applied";
    if (request.decision === "reject") {
      const rejected = await client.query(
        `UPDATE app.custom_appraisal_proposals
            SET status = 'rejected', reviewed_by_user_id = $2,
                reviewed_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [proposalId, auth.userId],
      );
      await insertAdapterEvent(client, session, proposalId, auth.userId, "custom_adapter.proposal_rejected", { field_path: proposal.field_path });
      result = { proposal: proposalResponse(rejected.rows[0]), report_registry_revision: Number(session.registry_revision) };
    } else {
      const target = await targetSnapshot(client, session, definition);
      const base = proposalState(proposal, "base");
      if (!sameState(target.state, base)) {
        const conflict = { base, current: target.state, detected_at: new Date().toISOString() };
        const conflicted = await client.query(
          `UPDATE app.custom_appraisal_proposals
              SET status = 'conflict', conflict = $2::jsonb,
                  reviewed_by_user_id = $3, reviewed_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [proposalId, JSON.stringify(conflict), auth.userId],
        );
        await insertAdapterEvent(client, session, proposalId, auth.userId, "custom_adapter.proposal_conflict", { field_path: proposal.field_path, conflict });
        operationStatus = "conflict";
        result = { proposal: proposalResponse(conflicted.rows[0], target.state), report_registry_revision: Number(session.registry_revision) };
      } else {
        const proposed = proposalState(proposal, "proposed");
        const applied = await applyAcceptedProposal(client, auth, session, proposal, definition, proposed);
        const reportRevision = await bumpReportRevision(client, auth, session, proposal, applied.revision);
        const accepted = await client.query(
          `UPDATE app.custom_appraisal_proposals
              SET status = 'accepted', reviewed_by_user_id = $2, reviewed_at = now(),
                  applied_target_revision = $3, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [proposalId, auth.userId, applied.revision],
        );
        await insertAdapterEvent(client, session, proposalId, auth.userId, "custom_adapter.proposal_accepted", {
          field_path: proposal.field_path,
          applied_target_revision: applied.revision,
          report_registry_revision: reportRevision,
        });
        result = { proposal: proposalResponse(accepted.rows[0], proposed), report_registry_revision: reportRevision };
      }
    }
    await client.query(
      `INSERT INTO app.custom_appraisal_review_operations (
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

export async function getCustomAppraisalReview(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const client = await pool.connect();
  try {
    const session = await customSession(client, auth, sessionId);
    const [propertySection, proposals, photos, updatedSession] = await Promise.all([
      loadPropertySection(client, session),
      client.query(
        `SELECT * FROM app.custom_appraisal_proposals
          WHERE inspection_session_id = $1
          ORDER BY created_at DESC, id DESC`,
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
    const targets = new Map();
    for (const proposal of proposals.rows) {
      const definition = FIELD_BY_PATH.get(proposal.field_path);
      if (!definition) continue;
      const container = definition.target_kind === "assignment_details"
        ? session.assignment_details
        : propertySection.value;
      targets.set(proposal.id, stateAtPath(container, definition.target_path));
    }
    return {
      session: sessionResponse(updatedSession.rows[0]),
      report_file: {
        id: session.report_file_id,
        account_id: session.account_id,
        file_number: session.file_number,
        registry_revision: Number(session.registry_revision),
        assignment_file_id: Number(session.custom_assignment_file_id),
      },
      catalog: customAppraisalFieldCatalog(),
      sections: {
        [ASSIGNMENT_SECTION]: { value: cloneObject(session.assignment_details), revision: Number(session.assignment_revision), source: "assignment_file" },
        [PROPERTY_SECTION]: propertySection,
      },
      proposals: proposals.rows.map((row) => proposalResponse(row, targets.get(row.id) || null)),
      photos: {
        verified_count: photos.rows.length,
        items: photos.rows.map((row) => ({ ...row, position: Number(row.position) })),
      },
    };
  } finally {
    client.release();
  }
}
