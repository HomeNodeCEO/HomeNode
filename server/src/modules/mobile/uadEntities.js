import { createHash, randomUUID } from "node:crypto";

import {
  createUadEntityWithClient,
  deleteUadEntityWithClient,
} from "../uad/entities.js";
import { UAD_REPEATABLE_ENTITY_GROUPS } from "../uad/fieldCatalog.js";
import { assertLockedUadWorkfileMutable } from "../uad/workfileLifecycle.js";
import { normalizeUuid, sessionResponse } from "./reportFiles.js";
import { canonicalJson } from "./sync.js";

const ACTIONS = new Set(["create", "delete"]);
const DECISIONS = new Set(["accept", "reject"]);
const CREATE_CONFLICTS = new Set([
  "uad_parent_entity_required",
  "invalid_uad_parent_entity",
  "invalid_uad_entity_maximum_reached",
  "invalid_uad_amenity_category_maximum_reached",
  "invalid_uad_amenity_defect_maximum_reached",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function boundedLabel(value) {
  if (value == null || String(value).trim() === "") return null;
  const label = String(value).trim();
  if (label.length > 120) throw new Error("invalid_uad_entity_label");
  return label;
}

function parentTypes(group) {
  return group.parentEntityTypes || (group.parentEntityType ? [group.parentEntityType] : []);
}

function publicGroup(entityType, group, variantTitle = null, variant = null) {
  const definition = variant ? { ...group, ...variant } : group;
  return Object.freeze({
    key: variantTitle ? `${entityType}:${variantTitle}` : entityType,
    entity_type: entityType,
    title: variantTitle || group.title,
    add_label: definition.addLabel || `Add ${group.title}`,
    min_items: Number(definition.minItems || 0),
    max_items: definition.maxItems == null ? null : Number(definition.maxItems),
    parent_entity_types: Object.freeze([...parentTypes(definition)]),
    create_enabled: definition.createEnabled !== false,
    data: Object.freeze({ ...(definition.createData || {}) }),
  });
}

export function mobileUadEntityCatalog() {
  const catalog = [];
  for (const [entityType, group] of Object.entries(UAD_REPEATABLE_ENTITY_GROUPS)) {
    if (group.variants) {
      for (const [variantTitle, variant] of Object.entries(group.variants)) {
        catalog.push(publicGroup(entityType, group, variantTitle, variant));
      }
    } else {
      catalog.push(publicGroup(entityType, group));
    }
  }
  return Object.freeze(catalog);
}

const PUBLIC_GROUPS = mobileUadEntityCatalog();

function supportsEntityCreation(entityType) {
  return PUBLIC_GROUPS.some((group) => (
    group.entity_type === entityType && group.create_enabled
  ));
}

function normalizeEntityData(entityType, value) {
  const data = value == null ? {} : value;
  if (!plainObject(data)) throw new Error("invalid_uad_entity_data");
  if (entityType !== "amenity") {
    if (Object.keys(data).length) throw new Error("invalid_uad_entity_data");
    return {};
  }
  if (Object.keys(data).some((key) => key !== "amenity_category")) {
    throw new Error("invalid_uad_entity_data");
  }
  const amenityCategory = String(data.amenity_category || "").trim();
  const allowed = PUBLIC_GROUPS.some((group) =>
    group.entity_type === "amenity" && group.data.amenity_category === amenityCategory);
  if (!allowed) throw new Error("invalid_uad_amenity_category");
  return { amenity_category: amenityCategory };
}

function entityResponse(row) {
  return Object.freeze({
    id: row.id,
    workfile_id: row.workfile_id,
    parent_entity_id: row.parent_entity_id || null,
    entity_type: row.entity_type,
    entity_identifier: row.entity_identifier,
    ordinal: Number(row.ordinal),
    label: row.label || null,
    data: row.data || {},
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  });
}

function normalizeEntitySnapshot(value) {
  if (!plainObject(value)) throw new Error("invalid_uad_entity_base");
  const allowed = new Set([
    "id", "workfile_id", "parent_entity_id", "entity_type", "entity_identifier",
    "ordinal", "label", "data", "created_at", "updated_at",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("invalid_uad_entity_base");
  const entityType = String(value.entity_type || "").trim();
  const entityIdentifier = String(value.entity_identifier || "").trim();
  const ordinal = Number(value.ordinal);
  if (!UAD_REPEATABLE_ENTITY_GROUPS[entityType] || !entityIdentifier || entityIdentifier.length > 160) {
    throw new Error("invalid_uad_entity_base");
  }
  if (!Number.isInteger(ordinal) || ordinal < 1) throw new Error("invalid_uad_entity_base");
  return Object.freeze({
    id: normalizeUuid(value.id, "invalid_uad_entity_id"),
    workfile_id: normalizeUuid(value.workfile_id, "invalid_uad_workfile_id"),
    parent_entity_id: value.parent_entity_id == null
      ? null
      : normalizeUuid(value.parent_entity_id, "invalid_uad_parent_entity"),
    entity_type: entityType,
    entity_identifier: entityIdentifier,
    ordinal,
    label: value.label == null ? null : boundedLabel(value.label),
    data: plainObject(value.data) ? value.data : {},
    created_at: timestamp(value.created_at),
    updated_at: timestamp(value.updated_at),
  });
}

export function normalizeMobileUadEntityProposal(input = {}) {
  const allowed = new Set([
    "client_operation_id", "action", "entity_type", "parent_entity_id",
    "target_entity_id", "label", "data", "base_target_revision", "base_entity",
  ]);
  if (!plainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("invalid_uad_entity_proposal");
  }
  const action = String(input.action || "").trim();
  if (!ACTIONS.has(action)) throw new Error("invalid_uad_entity_action");
  const entityType = String(input.entity_type || "").trim();
  const group = UAD_REPEATABLE_ENTITY_GROUPS[entityType];
  if (!group) throw new Error("invalid_uad_entity_type");
  const baseTargetRevision = Number(input.base_target_revision);
  if (!Number.isInteger(baseTargetRevision) || baseTargetRevision < 1) {
    throw new Error("invalid_uad_entity_base_revision");
  }
  const common = {
    clientOperationId: normalizeUuid(input.client_operation_id, "invalid_client_operation_id"),
    action,
    entityType,
    baseTargetRevision,
  };
  if (action === "delete") {
    if (input.parent_entity_id != null || input.label != null || input.data != null) {
      throw new Error("invalid_uad_entity_proposal");
    }
    const targetEntityId = normalizeUuid(input.target_entity_id, "invalid_uad_entity_id");
    const baseEntity = normalizeEntitySnapshot(input.base_entity);
    if (baseEntity.id !== targetEntityId || baseEntity.entity_type !== entityType) {
      throw new Error("invalid_uad_entity_base");
    }
    return Object.freeze({
      ...common,
      parentEntityId: null,
      targetEntityId,
      label: null,
      data: {},
      baseEntity,
    });
  }
  if (input.target_entity_id != null || input.base_entity != null) {
    throw new Error("invalid_uad_entity_proposal");
  }
  if (!supportsEntityCreation(entityType)) {
    throw new Error("invalid_uad_entity_creation_disabled");
  }
  return Object.freeze({
    ...common,
    parentEntityId: input.parent_entity_id == null
      ? null
      : normalizeUuid(input.parent_entity_id, "invalid_uad_parent_entity"),
    targetEntityId: null,
    label: boundedLabel(input.label),
    data: normalizeEntityData(entityType, input.data),
    baseEntity: null,
  });
}

function proposalResponse(row) {
  return Object.freeze({
    id: row.id,
    client_operation_id: row.client_operation_id,
    action: row.action,
    entity_type: row.entity_type,
    parent_entity_id: row.parent_entity_id || null,
    target_entity_id: row.target_entity_id || null,
    label: row.label || null,
    data: row.entity_data || {},
    base_target_revision: Number(row.base_target_revision),
    base_entity: row.base_entity || null,
    status: row.status,
    conflict: row.conflict || null,
    applied_entity_id: row.applied_entity_id || null,
    applied_target_revision: row.applied_target_revision == null
      ? null
      : Number(row.applied_target_revision),
    reviewed_at: timestamp(row.reviewed_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  });
}

async function uadSession(client, auth, sessionId, { lock = false, writable = false } = {}) {
  const result = await client.query(
    `SELECT session.*, report_file.workflow_type, report_file.registry_revision,
            report_file.uad_workfile_id
       FROM app.inspection_sessions session
       JOIN app.report_files report_file ON report_file.id = session.report_file_id
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3
        AND report_file.workflow_type = 'uad_3_6'
      ${lock ? "FOR UPDATE OF session, report_file" : ""}`,
    [sessionId, auth.organizations.map((item) => item.organizationId), auth.userId],
  );
  if (!result.rows.length) throw new Error("uad_entity_session_not_found");
  if (writable && result.rows[0].status === "completed") {
    throw new Error("inspection_session_completed_conflict");
  }
  return result.rows[0];
}

async function currentWorkfile(client, workfileId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT id, current_revision, specification_release_key, status, signed_at
       FROM appraisal.uad_workfiles WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [workfileId],
  );
  if (!result.rows.length) throw new Error("uad_workfile_not_found");
  return result.rows[0];
}

async function insertEvent(client, session, proposalId, actorUserId, eventType, metadata = {}) {
  await client.query(
    `INSERT INTO app.mobile_uad_entity_events (
       inspection_session_id, report_file_id, proposal_id, actor_user_id, event_type, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [session.id, session.report_file_id, proposalId, actorUserId, eventType, JSON.stringify(metadata)],
  );
}

async function updateReviewStatus(client, sessionId) {
  const pending = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM app.mobile_uad_entity_proposals
        WHERE inspection_session_id = $1 AND status IN ('pending', 'conflict')
       UNION ALL
       SELECT 1 FROM app.mobile_target_field_proposals
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

export async function createMobileUadEntityProposal(pool, auth, sessionIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const request = normalizeMobileUadEntityProposal(input);
  const requestDocument = {
    action: request.action,
    entity_type: request.entityType,
    parent_entity_id: request.parentEntityId,
    target_entity_id: request.targetEntityId,
    label: request.label,
    data: request.data,
    base_target_revision: request.baseTargetRevision,
    base_entity: request.baseEntity,
  };
  const requestHash = createHash("sha256").update(canonicalJson(requestDocument)).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await uadSession(client, auth, sessionId, { lock: true, writable: true });
    if (request.baseEntity && request.baseEntity.workfile_id !== session.uad_workfile_id) {
      throw new Error("invalid_uad_entity_base");
    }
    const existing = await client.query(
      `SELECT * FROM app.mobile_uad_entity_proposals
        WHERE inspection_session_id = $1 AND client_operation_id = $2`,
      [sessionId, request.clientOperationId],
    );
    if (existing.rows.length) {
      if (existing.rows[0].request_sha256 !== requestHash) throw new Error("client_operation_id_conflict");
      await client.query("COMMIT");
      return { proposal: proposalResponse(existing.rows[0]), created: false };
    }
    const workfile = await currentWorkfile(client, session.uad_workfile_id, { lock: true });
    if (request.baseTargetRevision > Number(workfile.current_revision)) {
      throw new Error("invalid_uad_entity_base_revision");
    }
    let status = "pending";
    let conflict = null;
    if (request.action === "delete") {
      const selected = await client.query(
        "SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 AND id = $2",
        [session.uad_workfile_id, request.targetEntityId],
      );
      const current = selected.rows[0] ? entityResponse(selected.rows[0]) : null;
      if (!current || canonicalJson(current) !== canonicalJson(request.baseEntity)) {
        status = "conflict";
        conflict = { base: request.baseEntity, current, detected_at: new Date().toISOString() };
      }
    }
    const inserted = await client.query(
      `INSERT INTO app.mobile_uad_entity_proposals (
         inspection_session_id, report_file_id, uad_workfile_id,
         client_operation_id, request_sha256, action, entity_type,
         parent_entity_id, target_entity_id, label, entity_data,
         base_target_revision, base_entity, status, conflict
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
                 $12, $13::jsonb, $14, $15::jsonb)
       RETURNING *`,
      [
        sessionId, session.report_file_id, session.uad_workfile_id,
        request.clientOperationId, requestHash, request.action, request.entityType,
        request.parentEntityId, request.targetEntityId, request.label, JSON.stringify(request.data),
        request.baseTargetRevision, request.baseEntity ? JSON.stringify(request.baseEntity) : null,
        status, conflict ? JSON.stringify(conflict) : null,
      ],
    );
    await insertEvent(client, session, inserted.rows[0].id, auth.userId, "uad_entity.proposal_created", {
      action: request.action,
      entity_type: request.entityType,
      base_target_revision: request.baseTargetRevision,
      initial_status: status,
    });
    if (conflict) {
      await insertEvent(client, session, inserted.rows[0].id, auth.userId, "uad_entity.proposal_conflict", conflict);
    }
    await updateReviewStatus(client, sessionId);
    await client.query("COMMIT");
    return { proposal: proposalResponse(inserted.rows[0]), created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function reviewRequest(input) {
  const allowed = new Set(["client_operation_id", "decision"]);
  if (!plainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("invalid_uad_entity_review");
  }
  const decision = String(input.decision || "").trim();
  if (!DECISIONS.has(decision)) throw new Error("invalid_uad_entity_review_decision");
  return {
    clientOperationId: normalizeUuid(input.client_operation_id, "invalid_client_operation_id"),
    decision,
  };
}

async function recordUadRevision(client, auth, session, proposal, entity) {
  const workfile = await currentWorkfile(client, session.uad_workfile_id, { lock: true });
  const nextRevision = Number(workfile.current_revision) + 1;
  const [values, entities] = await Promise.all([
    client.query("SELECT * FROM appraisal.uad_field_values WHERE workfile_id = $1 ORDER BY created_at, id", [session.uad_workfile_id]),
    client.query("SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 ORDER BY entity_type, ordinal, created_at, id", [session.uad_workfile_id]),
  ]);
  const document = {
    entities: entities.rows.map(entityResponse),
    field_values: values.rows.map((item) => ({
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
      workfile.specification_release_key, JSON.stringify(document),
      `${proposal.action === "create" ? "Added" : "Removed"} mobile UAD entity ${entity.label || entity.entity_identifier}`,
      auth.userId,
    ],
  );
  await client.query(
    `INSERT INTO appraisal.uad_audit_events (
       workfile_id, actor_user_id, event_type, entity_type, entity_id, metadata
     ) VALUES ($1, $2, 'uad_mobile_entity.accepted', $3, $4, $5::jsonb)`,
    [session.uad_workfile_id, auth.userId, proposal.entity_type, entity.id, JSON.stringify({
      action: proposal.action,
      proposal_id: proposal.id,
      revision_number: nextRevision,
    })],
  );
  return nextRevision;
}

async function bumpReportRevision(client, auth, session, proposal, targetRevision) {
  const updated = await client.query(
    `UPDATE app.report_files SET registry_revision = registry_revision + 1, updated_at = now()
      WHERE id = $1 RETURNING registry_revision`,
    [session.report_file_id],
  );
  const revision = Number(updated.rows[0].registry_revision);
  await client.query(
    `INSERT INTO app.report_file_events (
       report_file_id, actor_user_id, event_type, prior_registry_revision,
       next_registry_revision, changed_fields, metadata
     ) VALUES ($1, $2, 'uad_3_6.mobile_entity_accepted', $3, $4, $5::text[], $6::jsonb)`,
    [
      session.report_file_id, auth.userId, revision - 1, revision,
      [`uad.entities.${proposal.entity_type}`],
      JSON.stringify({ proposal_id: proposal.id, action: proposal.action, applied_target_revision: targetRevision }),
    ],
  );
  await client.query(
    "UPDATE app.inspection_sessions SET base_report_revision = $2, updated_at = now() WHERE id = $1",
    [session.id, revision],
  );
  return revision;
}

function reviewOperationHash(proposalId, decision) {
  return createHash("sha256")
    .update(canonicalJson({ proposal_id: proposalId, decision }))
    .digest("hex");
}

export async function reviewMobileUadEntityProposal(pool, auth, sessionIdValue, proposalIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const proposalId = normalizeUuid(proposalIdValue, "invalid_uad_entity_proposal_id");
  const request = reviewRequest(input);
  const hash = reviewOperationHash(proposalId, request.decision);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const session = await uadSession(client, auth, sessionId, { lock: true, writable: true });
    const priorOperation = await client.query(
      `SELECT request_sha256, result FROM app.mobile_uad_entity_review_operations
        WHERE inspection_session_id = $1 AND client_operation_id = $2`,
      [sessionId, request.clientOperationId],
    );
    if (priorOperation.rows.length) {
      if (priorOperation.rows[0].request_sha256 !== hash) throw new Error("client_operation_id_conflict");
      await client.query("COMMIT");
      return priorOperation.rows[0].result;
    }
    const selected = await client.query(
      `SELECT * FROM app.mobile_uad_entity_proposals
        WHERE id = $1 AND inspection_session_id = $2 FOR UPDATE`,
      [proposalId, sessionId],
    );
    const proposal = selected.rows[0];
    if (!proposal) throw new Error("uad_entity_proposal_not_found");
    const mayRejectConflict = request.decision === "reject" && proposal.status === "conflict";
    if (proposal.status !== "pending" && !mayRejectConflict) {
      throw new Error("uad_entity_proposal_status_conflict");
    }

    let result;
    let operationStatus = "applied";
    if (request.decision === "reject") {
      const rejected = await client.query(
        `UPDATE app.mobile_uad_entity_proposals
            SET status = 'rejected', reviewed_by_user_id = $2,
                reviewed_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [proposalId, auth.userId],
      );
      await insertEvent(client, session, proposalId, auth.userId, "uad_entity.proposal_rejected", {
        action: proposal.action,
        entity_type: proposal.entity_type,
      });
      result = { proposal: proposalResponse(rejected.rows[0]), report_registry_revision: Number(session.registry_revision) };
    } else {
      const workfile = await currentWorkfile(client, session.uad_workfile_id, { lock: true });
      await assertLockedUadWorkfileMutable(client, workfile);
      let conflict = null;
      let appliedEntity = null;
      if (proposal.action === "delete") {
        const currentResult = await client.query(
          "SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 AND id = $2 FOR UPDATE",
          [session.uad_workfile_id, proposal.target_entity_id],
        );
        const current = currentResult.rows[0] ? entityResponse(currentResult.rows[0]) : null;
        if (!current || canonicalJson(current) !== canonicalJson(proposal.base_entity)) {
          conflict = { base: proposal.base_entity, current, detected_at: new Date().toISOString() };
        } else {
          try {
            appliedEntity = await deleteUadEntityWithClient(
              client, session.uad_workfile_id, proposal.target_entity_id, { actorUserId: auth.userId },
            );
          } catch (error) {
            if (String(error?.message || "") !== "uad_entity_minimum_required") throw error;
            conflict = { reason: error.message, detected_at: new Date().toISOString() };
          }
        }
      } else {
        try {
          appliedEntity = await createUadEntityWithClient(client, session.uad_workfile_id, {
            entity_type: proposal.entity_type,
            parent_entity_id: proposal.parent_entity_id,
            label: proposal.label,
            data: proposal.entity_data,
          }, { actorUserId: auth.userId });
        } catch (error) {
          if (!CREATE_CONFLICTS.has(String(error?.message || ""))) throw error;
          conflict = { reason: error.message, detected_at: new Date().toISOString() };
        }
      }

      if (conflict) {
        const conflicted = await client.query(
          `UPDATE app.mobile_uad_entity_proposals
              SET status = 'conflict', conflict = $2::jsonb,
                  reviewed_by_user_id = $3, reviewed_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [proposalId, JSON.stringify(conflict), auth.userId],
        );
        operationStatus = "conflict";
        await insertEvent(client, session, proposalId, auth.userId, "uad_entity.proposal_conflict", conflict);
        result = { proposal: proposalResponse(conflicted.rows[0]), report_registry_revision: Number(session.registry_revision) };
      } else {
        const targetRevision = await recordUadRevision(client, auth, session, proposal, appliedEntity);
        const reportRevision = await bumpReportRevision(client, auth, session, proposal, targetRevision);
        const accepted = await client.query(
          `UPDATE app.mobile_uad_entity_proposals
              SET status = 'accepted', reviewed_by_user_id = $2, reviewed_at = now(),
                  applied_entity_id = $3, applied_target_revision = $4, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [proposalId, auth.userId, appliedEntity.id, targetRevision],
        );
        await insertEvent(client, session, proposalId, auth.userId, "uad_entity.proposal_accepted", {
          action: proposal.action,
          entity_type: proposal.entity_type,
          entity_id: appliedEntity.id,
          applied_target_revision: targetRevision,
          report_registry_revision: reportRevision,
        });
        result = { proposal: proposalResponse(accepted.rows[0]), report_registry_revision: reportRevision };
      }
    }
    await client.query(
      `INSERT INTO app.mobile_uad_entity_review_operations (
         inspection_session_id, proposal_id, client_operation_id, request_sha256,
         decision, status, result, actor_user_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [sessionId, proposalId, request.clientOperationId, hash, request.decision, operationStatus, JSON.stringify(result), auth.userId],
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

export async function getMobileUadEntityReview(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const client = await pool.connect();
  try {
    const session = await uadSession(client, auth, sessionId);
    const [workfile, entities, proposals] = await Promise.all([
      currentWorkfile(client, session.uad_workfile_id),
      client.query(
        "SELECT * FROM appraisal.uad_entities WHERE workfile_id = $1 ORDER BY entity_type, ordinal, created_at, id",
        [session.uad_workfile_id],
      ),
      client.query(
        `SELECT * FROM app.mobile_uad_entity_proposals
          WHERE inspection_session_id = $1 ORDER BY created_at DESC, id DESC`,
        [sessionId],
      ),
    ]);
    return Object.freeze({
      session: sessionResponse(session),
      target: Object.freeze({
        id: workfile.id,
        revision: Number(workfile.current_revision),
        status: workfile.status,
        specification_release_key: workfile.specification_release_key,
      }),
      catalog: PUBLIC_GROUPS,
      entities: entities.rows.map(entityResponse),
      proposals: proposals.rows.map(proposalResponse),
    });
  } finally {
    client.release();
  }
}
