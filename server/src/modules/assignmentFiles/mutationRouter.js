import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { registerOriginalAppraisalReport } from "../../services/appraisalHistory.js";
import {
  ASSIGNMENT_FILE_SELECT,
  assignmentFileResponse,
  normalizeAssignmentFileId,
  normalizeAssignmentFileNumber,
} from "../../services/assignmentFiles.js";
import {
  canonicalCustomAppraisalFileName,
} from "../../services/customAppraisalWorkfiles.js";
import { hasApplicationPermission } from "../../security/applicationAccess.js";
import { decideAssignmentAccess } from "../../security/assignmentAccess.js";
import { validateReportManualSection } from "../../util/reportManualValues.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;
const CUSTOM_APPRAISAL_WORKFLOW = "custom_appraisal";

const ASSIGNMENT_VALIDATION_ERRORS = new Set([
  "invalid_assignment_details",
  "invalid_pud_value",
  "invalid_assignment_type",
  "invalid_hoa_frequency",
  "invalid_occupancy",
  "pud_requires_hoa_dues_or_explanation",
  "other_hoa_frequency_requires_explanation",
  "unknown_occupancy_requires_explanation",
  "other_assignment_type_requires_explanation",
  "invalid_lender_client_name",
  "invalid_lender_client_address",
  "lender_client_name_too_long",
  "lender_client_address_too_long",
  "invalid_subject_under_contract",
  "invalid_contract_arms_length",
  "invalid_seller_match_value",
  "invalid_contract_seller_names",
  "invalid_contract_date",
  "invalid_contract_closing_date",
  "invalid_contract_property_condition",
  "invalid_contract_repairs",
  "invalid_seller_mismatch_explanation",
  "contract_seller_names_too_long",
  "contract_date_too_long",
  "contract_closing_date_too_long",
  "contract_property_condition_too_long",
  "contract_repairs_too_long",
  "seller_mismatch_explanation_too_long",
  "contract_requires_purchase_transaction",
  "contract_requires_arms_length_selection",
  "contract_requires_seller_match_selection",
  "seller_mismatch_requires_explanation",
]);

function isAssignmentValidationError(error) {
  const message = String(error?.message || "");
  return ASSIGNMENT_VALIDATION_ERRORS.has(message)
    || message.startsWith("invalid_neighborhood_")
    || message.startsWith("neighborhood_");
}

function requestedAccountId(req, res) {
  const value = String(req.params.id || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    res.status(400).json({ error: "invalid_account_id" });
    return null;
  }
  return value;
}

function assignmentReviewer(req) {
  const authenticatedReviewer = req.mobileAuth?.displayName
    || req.mobileAuth?.email
    || req.mobileAuth?.userId;
  return String(authenticatedReviewer || "")
    .trim()
    .slice(0, 200);
}

export function createAssignmentFileMutationRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  ensureAssignmentFilesAvailable,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess,
  authenticationRequired,
  resolveAccountId = resolveCanonicalAccountId,
  hasPermission = hasApplicationPermission,
  decideAccess = decideAssignmentAccess,
  normalizeFileId = normalizeAssignmentFileId,
  normalizeFileNumber = normalizeAssignmentFileNumber,
  validateAssignmentDetails = (value) => (
    validateReportManualSection("report.assignment_details", value)
  ),
  assignmentFileSelect = ASSIGNMENT_FILE_SELECT,
  presentAssignmentFile = assignmentFileResponse,
  buildCanonicalFileName = canonicalCustomAppraisalFileName,
  registerOriginalReport = registerOriginalAppraisalReport,
  logger = console,
} = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("assignment_file_mutation_pool_required");
  }
  if (!accountQualityReady || typeof accountQualityReady.then !== "function") {
    throw new TypeError("assignment_file_mutation_account_readiness_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("assignment_file_mutation_enrichment_readiness_required");
  }
  if (
    typeof ensureAssignmentFilesAvailable !== "function"
    || typeof ensureCustomAppraisalWorkfilesAvailable !== "function"
  ) {
    throw new TypeError("assignment_file_mutation_schema_readiness_required");
  }
  if (
    typeof requireWorkflowAccess !== "function"
    || typeof requireEditor !== "function"
    || typeof requireAssignmentAccess !== "function"
  ) {
    throw new TypeError("assignment_file_mutation_access_policy_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("assignment_file_mutation_authentication_mode_required");
  }
  if (
    typeof resolveAccountId !== "function"
    || typeof hasPermission !== "function"
    || typeof decideAccess !== "function"
    || typeof normalizeFileId !== "function"
    || typeof normalizeFileNumber !== "function"
    || typeof validateAssignmentDetails !== "function"
    || typeof presentAssignmentFile !== "function"
    || typeof buildCanonicalFileName !== "function"
    || typeof registerOriginalReport !== "function"
  ) {
    throw new TypeError("assignment_file_mutation_dependency_required");
  }

  const router = express.Router();

  /** Create a new appraisal file without changing any earlier assignment file. */
  router.post("/api/accounts/:id/assignment-files", async (req, res) => {
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    if (!requireWorkflowAccess(req, res, CUSTOM_APPRAISAL_WORKFLOW, "write")) return undefined;
    if (!requireEditor(req, res)) return undefined;

    const requestedOrganizationId = String(req.body?.organization_id || "").trim();
    const writable = (req.mobileAuth?.organizations || []).filter((organization) =>
      hasPermission(
        req.mobileAuth,
        CUSTOM_APPRAISAL_WORKFLOW,
        "write",
        organization.organizationId,
      ));
    const selected = requestedOrganizationId
      ? writable.find((organization) => organization.organizationId === requestedOrganizationId)
      : writable.length === 1 ? writable[0] : null;
    if (!selected) {
      return res.status(400).json({ error: "organization_selection_required" });
    }
    const creationOrganizationId = selected.organizationId;
    const creatorUserId = req.mobileAuth.userId;

    let fileNumber;
    let inheritedFromFileId;
    try {
      fileNumber = normalizeFileNumber(req.body?.file_number);
      inheritedFromFileId = normalizeFileId(req.body?.inherited_from_file_id);
    } catch (error) {
      return res.status(400).json({ error: error?.message || "invalid_assignment_file" });
    }
    const reviewer = assignmentReviewer(req);
    const client = await pool.connect();
    try {
      await Promise.all([
        accountQualityReady,
        propertyEnrichmentReady,
        ensureAssignmentFilesAvailable(),
        ensureCustomAppraisalWorkfilesAvailable(),
      ]);
      await client.query("BEGIN");
      const canonicalId = await resolveAccountId(client, accountId);
      const accountResult = await client.query(
        "SELECT 1 FROM core.accounts WHERE account_id = $1",
        [canonicalId],
      );
      if (!accountResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "account_not_found" });
      }

      let sourceFile = null;
      if (inheritedFromFileId) {
        const sourceResult = await client.query(
          `SELECT id, assignment_details
           FROM app.assignment_files
           WHERE id = $1 AND account_id = $2
             AND ($3::uuid IS NULL OR organization_id = $3)`,
          [inheritedFromFileId, canonicalId, creationOrganizationId],
        );
        sourceFile = sourceResult.rows[0] || null;
        if (!sourceFile) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "invalid_inherited_assignment_file" });
        }
      }

      let assignmentDetails = req.body?.assignment_details;
      if (assignmentDetails === undefined) {
        if (sourceFile) {
          assignmentDetails = sourceFile.assignment_details;
        } else {
          const latestResult = await client.query(
            `SELECT id, assignment_details
             FROM app.assignment_files
             WHERE account_id = $1
               AND ($2::uuid IS NULL OR organization_id = $2)
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [canonicalId, creationOrganizationId],
          );
          sourceFile = latestResult.rows[0] || null;
          if (sourceFile) inheritedFromFileId = Number(sourceFile.id);
          assignmentDetails = sourceFile?.assignment_details;
        }
        if (assignmentDetails === undefined) assignmentDetails = {};
      }
      validateAssignmentDetails(assignmentDetails);

      const inserted = await client.query(
        `INSERT INTO app.assignment_files (
           account_id, file_number, assignment_details, inherited_from_file_id, reviewer,
           organization_id, assigned_appraiser_user_id, created_by_user_id, updated_by_user_id
         ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$7,$7)
         RETURNING id`,
        [canonicalId, fileNumber, JSON.stringify(assignmentDetails), inheritedFromFileId, reviewer,
          creationOrganizationId, creatorUserId],
      );
      const assignmentFileId = Number(inserted.rows[0].id);
      await client.query(
        `INSERT INTO app.custom_appraisal_workfiles (
           assignment_file_id, canonical_file_name
         ) VALUES ($1, $2)
         ON CONFLICT (assignment_file_id) DO NOTHING`,
        [assignmentFileId, buildCanonicalFileName(fileNumber, assignmentFileId)],
      );
      const reportRegistryResult = await client.query(
        "SELECT to_regclass('app.report_files') AS table_name",
      );
      if (reportRegistryResult.rows[0]?.table_name) {
        const previousRegistryResult = inheritedFromFileId
          ? await client.query(
            `SELECT id FROM app.report_files
              WHERE custom_assignment_file_id = $1`,
            [inheritedFromFileId],
          )
          : { rows: [] };
        await client.query(
          `UPDATE app.report_files
              SET is_current = false, updated_at = now()
            WHERE organization_id IS NOT DISTINCT FROM $2::uuid
              AND account_id = $1
              AND workflow_type = 'custom_appraisal'
              AND is_current = true`,
          [canonicalId, creationOrganizationId],
        );
        const reportFileResult = await client.query(
          `INSERT INTO app.report_files (
             organization_id, account_id, workflow_type, file_number,
             previous_report_file_id, custom_assignment_file_id,
             is_current, registry_revision, created_by_user_id
           ) VALUES ($5, $1, 'custom_appraisal', $2, $3, $4, true, 1, $6)
           ON CONFLICT (custom_assignment_file_id)
             WHERE custom_assignment_file_id IS NOT NULL
           DO UPDATE SET is_current = true, updated_at = now()
           RETURNING id`,
          [
            canonicalId,
            fileNumber,
            previousRegistryResult.rows[0]?.id || null,
            assignmentFileId,
            creationOrganizationId,
            creatorUserId,
          ],
        );
        const historyRegistry = await client.query(
          "SELECT to_regclass('app.appraisal_cases') AS table_name",
        );
        if (historyRegistry.rows[0]?.table_name) {
          await registerOriginalReport(client, reportFileResult.rows[0].id, {
            captureReason: "desktop_custom_appraisal_created",
          });
        }
      }
      await client.query(
        `INSERT INTO app.assignment_file_history (
           assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
         ) VALUES ($1,$2,$3,$4::jsonb,$5,1)`,
        [assignmentFileId, canonicalId, fileNumber, JSON.stringify(assignmentDetails), reviewer],
      );
      const { rows } = await client.query(
        `${assignmentFileSelect} WHERE f.id = $1`,
        [assignmentFileId],
      );
      await client.query("COMMIT");
      return res.status(201).json({
        ok: true,
        assignment_file: presentAssignmentFile(rows[0]),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error?.code === "23505") {
        return res.status(409).json({ error: "assignment_file_number_exists" });
      }
      if (isAssignmentValidationError(error)) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("assignment file create failed", error);
      return res.status(500).json({ error: "assignment_file_create_failed" });
    } finally {
      client.release();
    }
  });

  /** Save additional work while retaining internal audit snapshots for conflict recovery. */
  router.patch("/api/accounts/:id/assignment-files/:fileId", async (req, res) => {
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    if (!requireWorkflowAccess(req, res, CUSTOM_APPRAISAL_WORKFLOW, "write")) return undefined;
    if (!requireEditor(req, res)) return undefined;
    let assignmentFileId;
    try {
      assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
      validateAssignmentDetails(req.body?.assignment_details);
    } catch (error) {
      return res.status(400).json({ error: error?.message || "invalid_assignment_file" });
    }
    const expectedRevision = Number(req.body?.expected_revision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return res.status(400).json({ error: "invalid_expected_revision" });
    }
    const reviewer = assignmentReviewer(req);
    const assignmentDetails = req.body.assignment_details;
    const client = await pool.connect();
    try {
      await Promise.all([
        accountQualityReady,
        propertyEnrichmentReady,
        ensureAssignmentFilesAvailable(),
        ensureCustomAppraisalWorkfilesAvailable(),
      ]);
      const canonicalId = await resolveAccountId(client, accountId);
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "write",
      )) return undefined;
      await client.query("BEGIN");
      const existingResult = await client.query(
        `SELECT assignment_file.id, assignment_file.file_number, assignment_file.revision,
                assignment_file.organization_id,
                assignment_file.assigned_appraiser_user_id,
                assignment_file.supervisory_appraiser_user_id
         FROM app.assignment_files assignment_file
         WHERE assignment_file.id = $1 AND assignment_file.account_id = $2
         FOR UPDATE OF assignment_file`,
        [assignmentFileId, canonicalId],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "assignment_file_not_found" });
      }
      if (!decideAccess(req.mobileAuth, existing, "write")) {
        await client.query("ROLLBACK");
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
        return res.status(409).json({ error: "custom_appraisal_workfile_signed" });
      }
      if (Number(existing.revision) !== expectedRevision) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "assignment_file_revision_conflict",
          current_revision: Number(existing.revision),
        });
      }
      const revision = expectedRevision + 1;
      await client.query(
        `UPDATE app.assignment_files
         SET assignment_details = $1::jsonb, reviewer = $2, revision = $3, updated_at = now()
         WHERE id = $4`,
        [JSON.stringify(assignmentDetails), reviewer, revision, assignmentFileId],
      );
      await client.query(
        `INSERT INTO app.assignment_file_history (
           assignment_file_id, account_id, file_number, assignment_details, reviewer, revision
         ) VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [
          assignmentFileId,
          canonicalId,
          existing.file_number,
          JSON.stringify(assignmentDetails),
          reviewer,
          revision,
        ],
      );
      const { rows } = await client.query(
        `${assignmentFileSelect} WHERE f.id = $1`,
        [assignmentFileId],
      );
      await client.query("COMMIT");
      return res.json({ ok: true, assignment_file: presentAssignmentFile(rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      logger.error?.("assignment file update failed", error);
      return res.status(500).json({ error: "assignment_file_update_failed" });
    } finally {
      client.release();
    }
  });

  return router;
}
