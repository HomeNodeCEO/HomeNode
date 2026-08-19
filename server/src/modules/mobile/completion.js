import { createHash } from "node:crypto";

import { normalizeUuid, sessionResponse } from "./reportFiles.js";
import { canonicalJson } from "./sync.js";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1 || revision > 1_000_000_000) {
    throw new Error("invalid_inspection_completion_revision");
  }
  return revision;
}

export function normalizeInspectionCompletionRequest(input = {}) {
  const allowed = new Set(["client_operation_id", "base_session_revision"]);
  if (!plainObject(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("invalid_inspection_completion_request");
  }
  return Object.freeze({
    clientOperationId: normalizeUuid(input.client_operation_id, "invalid_client_operation_id"),
    baseSessionRevision: boundedRevision(input.base_session_revision),
  });
}

function count(value) {
  const normalized = Number(value || 0);
  return Number.isFinite(normalized) ? Math.max(0, Math.floor(normalized)) : 0;
}

function check(key, label, required, openCount, detail) {
  const normalizedCount = count(openCount);
  return Object.freeze({
    key,
    label,
    required: Boolean(required),
    passed: !required || normalizedCount === 0,
    open_count: normalizedCount,
    detail,
  });
}

export function completionReadinessFromCounts(session, counts) {
  const workflowType = String(session.workflow_type || "");
  const sketchExists = Boolean(counts.sketch_exists);
  const checks = Object.freeze([
    check(
      "sync_conflicts",
      "Offline field conflicts resolved",
      true,
      counts.sync_conflicts,
      "Resolve every server/mobile field conflict before finishing.",
    ),
    check(
      "custom_appraisal_review",
      "Custom Appraisal proposals reviewed",
      workflowType === "custom_appraisal",
      counts.custom_reviews,
      "Accept or reject each pending or conflicted Custom Appraisal proposal.",
    ),
    check(
      "target_field_review",
      "Report field proposals reviewed",
      workflowType === "uad_3_6" || workflowType === "property_tax_protest",
      counts.target_reviews,
      "Accept or reject each pending or conflicted report-field proposal.",
    ),
    check(
      "uad_entity_review",
      "UAD repeatable entities reviewed",
      workflowType === "uad_3_6",
      counts.uad_entity_reviews,
      "Accept or reject each pending or conflicted UAD entity proposal.",
    ),
    check(
      "photo_verification",
      "Photo uploads verified or excluded",
      true,
      counts.unverified_photos,
      "Every captured photo must be verified in private storage or explicitly excluded.",
    ),
    check(
      "saved_sketch_review",
      "Saved sketch confirmed by the appraiser",
      sketchExists,
      counts.draft_sketches,
      sketchExists
        ? "A saved sketch must be closed, reviewed, and appraiser-confirmed."
        : "No sketch was started for this inspection; report validation may still require one.",
    ),
  ]);
  const blockers = Object.freeze(checks.filter((item) => !item.passed).map((item) => item.key));
  const completed = session.status === "completed";
  return Object.freeze({
    session: sessionResponse(session),
    workflow_type: workflowType,
    report_file: Object.freeze({
      id: session.report_file_id,
      file_number: session.file_number,
      registry_revision: Number(session.registry_revision),
    }),
    ready_to_complete: completed || blockers.length === 0,
    completed,
    checks,
    blockers,
  });
}

async function accessibleSession(client, auth, sessionId, { lock = false } = {}) {
  const organizationIds = auth.organizations.map((item) => item.organizationId);
  const { rows } = await client.query(
    `SELECT session.*, report_file.workflow_type, report_file.file_number,
            report_file.registry_revision
       FROM app.inspection_sessions session
       JOIN app.report_files report_file ON report_file.id = session.report_file_id
      WHERE session.id = $1
        AND session.organization_id = ANY($2::uuid[])
        AND session.appraiser_user_id = $3
      ${lock ? "FOR UPDATE OF session" : ""}`,
    [sessionId, organizationIds, auth.userId],
  );
  if (!rows.length) throw new Error("inspection_session_not_found");
  return rows[0];
}

async function readinessCounts(client, sessionId) {
  const { rows } = await client.query(
    `SELECT
       (SELECT count(*) FROM app.mobile_sync_operations
         WHERE inspection_session_id = $1
           AND status = 'conflict' AND resolved_at IS NULL) AS sync_conflicts,
       (SELECT count(*) FROM app.custom_appraisal_proposals
         WHERE inspection_session_id = $1
           AND status IN ('pending', 'conflict')) AS custom_reviews,
       (SELECT count(*) FROM app.mobile_target_field_proposals
         WHERE inspection_session_id = $1
           AND status IN ('pending', 'conflict')) AS target_reviews,
       (SELECT count(*) FROM app.mobile_uad_entity_proposals
         WHERE inspection_session_id = $1
           AND status IN ('pending', 'conflict')) AS uad_entity_reviews,
       (SELECT count(*) FROM app.inspection_photos
         WHERE inspection_session_id = $1
           AND status NOT IN ('verified', 'excluded', 'deleted')) AS unverified_photos,
       EXISTS (
         SELECT 1 FROM app.inspection_sketches WHERE inspection_session_id = $1
       ) AS sketch_exists,
       (SELECT count(*) FROM app.inspection_sketches
         WHERE inspection_session_id = $1
           AND review_status <> 'appraiser_confirmed') AS draft_sketches`,
    [sessionId],
  );
  return rows[0] || {};
}

async function readinessForSession(client, session) {
  return completionReadinessFromCounts(session, await readinessCounts(client, session.id));
}

export async function getInspectionCompletionReadiness(pool, auth, sessionIdValue) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const client = await pool.connect();
  try {
    const session = await accessibleSession(client, auth, sessionId);
    return readinessForSession(client, session);
  } finally {
    client.release();
  }
}

function notReadyError(readiness) {
  const error = new Error("inspection_not_ready_conflict");
  error.statusCode = 409;
  error.details = { readiness };
  return error;
}

export async function completeInspectionSession(pool, auth, sessionIdValue, input = {}) {
  const sessionId = normalizeUuid(sessionIdValue, "invalid_inspection_session_id");
  const request = normalizeInspectionCompletionRequest(input);
  const requestSha256 = createHash("sha256")
    .update(canonicalJson({ base_session_revision: request.baseSessionRevision }))
    .digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const session = await accessibleSession(client, auth, sessionId, { lock: true });
    const prior = await client.query(
      `SELECT request_sha256, base_session_revision, result
         FROM app.inspection_completion_operations
        WHERE inspection_session_id = $1 AND client_operation_id = $2`,
      [sessionId, request.clientOperationId],
    );
    if (prior.rows.length) {
      if (
        prior.rows[0].request_sha256 !== requestSha256
        || Number(prior.rows[0].base_session_revision) !== request.baseSessionRevision
      ) {
        throw new Error("client_operation_id_conflict");
      }
      await client.query("COMMIT");
      return prior.rows[0].result;
    }
    if (session.status === "completed") {
      const result = JSON.parse(JSON.stringify({
        session: sessionResponse(session),
        readiness: await readinessForSession(client, session),
        completed: false,
        already_completed: true,
        report_registry_revision: Number(session.registry_revision),
      }));
      await client.query("COMMIT");
      return result;
    }
    if (Number(session.revision) !== request.baseSessionRevision) {
      throw new Error("inspection_completion_revision_conflict");
    }
    const readiness = await readinessForSession(client, session);
    if (!readiness.ready_to_complete) throw notReadyError(readiness);
    const priorRevision = Number(session.revision);
    const nextRevision = priorRevision + 1;
    const completionSummary = {
      workflow_type: session.workflow_type,
      report_file_id: session.report_file_id,
      checks: readiness.checks,
      blockers: [],
    };
    const updated = await client.query(
      `UPDATE app.inspection_sessions
          SET status = 'completed', revision = $2, completed_at = now(),
              completed_by_user_id = $3, completion_summary = $4::jsonb,
              last_synced_at = COALESCE(last_synced_at, now()), updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [sessionId, nextRevision, auth.userId, JSON.stringify(completionSummary)],
    );
    const completedSession = { ...session, ...updated.rows[0] };
    const completedReadiness = completionReadinessFromCounts(
      completedSession,
      await readinessCounts(client, sessionId),
    );
    const result = JSON.parse(JSON.stringify({
      session: sessionResponse(completedSession),
      readiness: completedReadiness,
      completed: true,
      already_completed: false,
      report_registry_revision: Number(session.registry_revision),
    }));
    await client.query(
      `INSERT INTO app.inspection_completion_operations (
         inspection_session_id, report_file_id, client_operation_id,
         request_sha256, base_session_revision, status, result, actor_user_id
       ) VALUES ($1, $2, $3, $4, $5, 'applied', $6::jsonb, $7)`,
      [
        sessionId,
        session.report_file_id,
        request.clientOperationId,
        requestSha256,
        request.baseSessionRevision,
        JSON.stringify(result),
        auth.userId,
      ],
    );
    await client.query(
      `INSERT INTO app.inspection_session_events (
         inspection_session_id, actor_user_id, event_type,
         prior_revision, next_revision, metadata
       ) VALUES ($1, $2, 'inspection_session.completed', $3, $4, $5::jsonb)`,
      [sessionId, auth.userId, priorRevision, nextRevision, JSON.stringify(completionSummary)],
    );
    await client.query(
      `INSERT INTO app.report_file_events (
         report_file_id, actor_user_id, event_type, prior_registry_revision,
         next_registry_revision, changed_fields, metadata
       ) VALUES ($1, $2, 'mobile_inspection.completed', $3, $3,
                 ARRAY['inspection_session.status'], $4::jsonb)`,
      [
        session.report_file_id,
        auth.userId,
        Number(session.registry_revision),
        JSON.stringify({ inspection_session_id: sessionId, session_revision: nextRevision }),
      ],
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
