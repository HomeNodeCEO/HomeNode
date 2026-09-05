import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import { decideAssignmentAccess } from "../../security/assignmentAccess.js";
import { normalizeHousingProfileUpdate } from "../../util/housingProfileEdit.js";
import { validateReportManualSection } from "../../util/reportManualValues.js";

export const REPORT_MANUAL_SECTION_KEYS = new Set([
  "report.subject_identification",
  "report.exemptions",
  "report.sales_history",
  "report.property_characteristics",
  "report.land_details",
  "report.appraisal_values",
  "report.assignment_details",
]);

const MAX_REPORT_SECTIONS_BYTES = 250_000;
const REPORT_ACCOUNT_ID = /^[0-9A-Za-z_-]{1,50}$/;
const ASSIGNMENT_DETAILS_SECTION = "report.assignment_details";

export function createReportManualValuesRouter({
  pool,
  propertyEnrichmentReady,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess,
  authenticationRequired,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  decideAccess = decideAssignmentAccess,
  validateSection = validateReportManualSection,
  normalizeHousingProfile = normalizeHousingProfileUpdate,
  logger = console,
} = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("report_manual_values_pool_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("report_manual_values_readiness_required");
  }
  if (typeof ensureCustomAppraisalWorkfilesAvailable !== "function") {
    throw new TypeError("report_manual_values_schema_readiness_required");
  }
  if (
    typeof requireWorkflowAccess !== "function"
    || typeof requireEditor !== "function"
    || typeof requireAssignmentAccess !== "function"
  ) {
    throw new TypeError("report_manual_values_access_policy_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("report_manual_values_authentication_mode_required");
  }
  if (typeof resolveAccountId !== "function") {
    throw new TypeError("report_manual_values_resolver_required");
  }
  if (typeof validateSection !== "function") {
    throw new TypeError("report_manual_values_validator_required");
  }
  if (typeof normalizeHousingProfile !== "function") {
    throw new TypeError("report_manual_values_housing_normalizer_required");
  }
  if (typeof normalizeFileId !== "function" || typeof decideAccess !== "function") {
    throw new TypeError("report_manual_values_file_normalizer_required");
  }

  const router = express.Router();

  router.patch("/api/accounts/:id/report-manual-values", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!REPORT_ACCOUNT_ID.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "write")) return undefined;
    if (!requireEditor(req, res)) return undefined;
    const sections = req.body?.sections;
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      return res.status(400).json({ error: "invalid_report_sections" });
    }
    const entries = Object.entries(sections);
    if (
      !entries.length ||
      entries.length > REPORT_MANUAL_SECTION_KEYS.size ||
      entries.some(([key, value]) =>
        !REPORT_MANUAL_SECTION_KEYS.has(key) || value === undefined
      )
    ) {
      return res.status(400).json({ error: "invalid_report_sections" });
    }
    let assignmentFileId;
    if (req.body?.assignment_file_id === undefined || req.body?.assignment_file_id === null) {
      return res.status(400).json({ error: "assignment_file_required" });
    }
    try {
      assignmentFileId = normalizeFileId(req.body.assignment_file_id, { required: true });
    } catch (error) {
      return res.status(400).json({ error: error?.message || "invalid_assignment_file_id" });
    }
    if (entries.some(([key]) => key === ASSIGNMENT_DETAILS_SECTION)) {
      return res.status(400).json({ error: "assignment_details_require_assignment_file_api" });
    }
    const expectedRevisions = req.body?.expected_revisions;
    if (
      !expectedRevisions
      || typeof expectedRevisions !== "object"
      || Array.isArray(expectedRevisions)
      || Object.keys(expectedRevisions).length !== entries.length
      || entries.some(([key]) => (
        !Object.hasOwn(expectedRevisions, key)
        || !Number.isSafeInteger(expectedRevisions[key])
        || expectedRevisions[key] < 0
      ))
    ) {
      return res.status(400).json({ error: "report_section_revision_required" });
    }
    const serializedSize = Buffer.byteLength(JSON.stringify(sections), "utf8");
    if (serializedSize > MAX_REPORT_SECTIONS_BYTES) {
      return res.status(413).json({ error: "report_sections_too_large" });
    }
    try {
      for (const [key, value] of entries) validateSection(key, value);
    } catch (error) {
      return res.status(400).json({
        error: error?.message || "invalid_report_section_value",
      });
    }

    const authenticatedReviewer = req.mobileAuth?.displayName
      || req.mobileAuth?.email
      || req.mobileAuth?.userId;
    const reviewer = String(authenticatedReviewer || "")
      .trim()
      .slice(0, 200);
    const notes = String(req.body?.notes || "Property Report manual edit")
      .trim()
      .slice(0, 4000) || null;
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await propertyEnrichmentReady;
      await ensureCustomAppraisalWorkfilesAvailable();
      const canonicalId = await resolveAccountId(client, requestedId);
      const accountResult = await client.query(
        "SELECT 1 FROM core.accounts WHERE account_id = $1",
        [canonicalId],
      );
      if (!accountResult.rowCount) {
        if (transactionStarted) {
          await client.query("ROLLBACK");
          transactionStarted = false;
        }
        return res.status(404).json({ error: "account_not_found" });
      }

      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "write",
      )) return undefined;

      await client.query("BEGIN");
      transactionStarted = true;

      const assignmentResult = await client.query(
        `SELECT assignment_file.id, assignment_file.organization_id,
                assignment_file.assigned_appraiser_user_id,
                assignment_file.supervisory_appraiser_user_id
           FROM app.assignment_files assignment_file
          WHERE assignment_file.id = $1 AND assignment_file.account_id = $2
          FOR UPDATE OF assignment_file`,
        [assignmentFileId, canonicalId],
      );
      const assignment = assignmentResult.rows[0];
      if (!assignment) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(404).json({ error: "assignment_file_not_found" });
      }
      if (!decideAccess(req.mobileAuth, assignment, "write")) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.set("cache-control", "no-store")
          .status(403)
          .json({ error: "assignment_file_access_denied" });
      }
      const workfileResult = await client.query(
        `SELECT status FROM app.custom_appraisal_workfiles
          WHERE assignment_file_id = $1 FOR UPDATE`,
        [assignmentFileId],
      );
      if (workfileResult.rows[0]?.status === "signed") {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(409).json({ error: "custom_appraisal_workfile_signed" });
      }

      const currentResult = await client.query(
        `SELECT section_key, revision
           FROM app.custom_appraisal_sections
          WHERE assignment_file_id = $1 AND section_key = ANY($2::text[])
          FOR UPDATE`,
        [assignmentFileId, entries.map(([key]) => key)],
      );
      const currentRevisions = Object.fromEntries(
        entries.map(([key]) => [key, 0]),
      );
      for (const row of currentResult.rows) {
        currentRevisions[row.section_key] = Number(row.revision);
      }
      if (entries.some(([key]) => currentRevisions[key] !== expectedRevisions[key])) {
        await client.query("ROLLBACK");
        transactionStarted = false;
        return res.status(409).json({
          error: "report_section_revision_conflict",
          current_revisions: currentRevisions,
        });
      }

      const savedEntries = [];
      for (const [attributeKey, attributeValue] of entries) {
        const valueJson = JSON.stringify(attributeValue);
        const { rows } = await client.query(
          `INSERT INTO app.custom_appraisal_sections (
             assignment_file_id, section_key, section_value, revision,
             last_applied_session_id, last_applied_by_user_id
           ) VALUES ($1,$2,$3::jsonb,1,NULL,$4)
           ON CONFLICT (assignment_file_id, section_key) DO UPDATE SET
             section_value = EXCLUDED.section_value,
             revision = app.custom_appraisal_sections.revision + 1,
             last_applied_session_id = NULL,
             last_applied_by_user_id = EXCLUDED.last_applied_by_user_id,
             updated_at = now()
           RETURNING section_key, section_value, revision, updated_at`,
          [assignmentFileId, attributeKey, valueJson, req.mobileAuth.userId],
        );
        await client.query(
          `INSERT INTO app.custom_appraisal_section_history (
             assignment_file_id, section_key, section_value, revision,
             inspection_session_id, actor_user_id, proposal_id, changed_path
           ) VALUES ($1,$2,$3::jsonb,$4,NULL,$5,NULL,ARRAY[$2]::text[])`,
          [
            assignmentFileId,
            attributeKey,
            valueJson,
            Number(rows[0].revision),
            req.mobileAuth.userId,
          ],
        );
        savedEntries.push([attributeKey, {
          value: rows[0].section_value,
          revision: Number(rows[0].revision),
          reviewer,
          notes,
          updated_at: rows[0].updated_at,
        }]);
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return res.json({
        ok: true,
        account_id: canonicalId,
        assignment_file_id: assignmentFileId,
        manual_values: Object.fromEntries(savedEntries),
      });
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => {});
      logger.error?.("/api/accounts/:id/report-manual-values failed", error);
      return res.status(500).json({ error: "report_manual_values_update_failed" });
    } finally {
      client.release();
    }
  });

  return router;
}
