import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  saveCustomAppraisalWorkfileSection,
  signCustomAppraisalWorkfile,
} from "../../services/customAppraisalWorkfiles.js";
import { customAppraisalReadinessErrorDetails } from "../../services/customAppraisalReadinessErrorDetails.js";
import { safeOperationalErrorCode } from "../../security/safeOperationalErrorCode.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;
const SAVE_VALIDATION_ERRORS = new Set([
  "invalid_assignment_file_id",
  "invalid_custom_appraisal_section_key",
  "invalid_custom_appraisal_section_revision",
  "invalid_custom_appraisal_save_reason",
  "invalid_custom_appraisal_section_value",
  "custom_appraisal_section_too_large",
]);
const SIGN_VALIDATION_ERRORS = new Set([
  "invalid_assignment_file_id",
  "invalid_custom_appraisal_signer",
  "invalid_custom_appraisal_signature_event",
  "invalid_custom_appraisal_warning_codes",
]);

function workfileMutationErrorMessage(error) {
  try {
    const message = error?.message;
    return typeof message === "string" ? message : "";
  } catch {
    return "";
  }
}

function workfileConflictRevision(error) {
  try {
    const revision = Number(error?.currentRevision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  } catch {
    return 0;
  }
}

function logMutationFailure(logger, label, error) {
  try {
    logger.error?.(label, safeOperationalErrorCode(error));
  } catch {
    // A broken logger must not replace the bounded response.
  }
}

function requestedAccountId(req, res) {
  const value = String(req.params.id || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    res.status(400).json({ error: "invalid_account_id" });
    return null;
  }
  return value;
}

function authenticatedReviewer(req) {
  const userId = String(req.mobileAuth?.userId || "").trim();
  if (!userId) return null;
  return String(
    req.mobileAuth?.displayName || req.mobileAuth?.email || userId,
  ).trim() || userId;
}

export function createAssignmentWorkfileMutationRouter({
  pool,
  ensureCustomAppraisalWorkfilesAvailable,
  requireEditor,
  requireAssignmentAccess,
  authenticationRequired,
  objectStorage,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  saveSection = saveCustomAppraisalWorkfileSection,
  signWorkfile = signCustomAppraisalWorkfile,
  getSigningSecret = () => process.env.APP_SIGNING_SECRET,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("assignment_workfile_mutation_pool_required");
  }
  if (typeof ensureCustomAppraisalWorkfilesAvailable !== "function") {
    throw new TypeError("assignment_workfile_mutation_schema_readiness_required");
  }
  if (typeof requireEditor !== "function" || typeof requireAssignmentAccess !== "function") {
    throw new TypeError("assignment_workfile_mutation_access_policy_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("assignment_workfile_mutation_authentication_mode_required");
  }
  if (
    typeof resolveAccountId !== "function"
    || typeof normalizeFileId !== "function"
    || typeof saveSection !== "function"
    || typeof signWorkfile !== "function"
    || typeof getSigningSecret !== "function"
  ) {
    throw new TypeError("assignment_workfile_mutation_dependency_required");
  }

  const router = express.Router();

  /** Save one independently versioned Custom Appraisal section. */
  router.put(
    "/api/accounts/:id/assignment-files/:fileId/workfile/sections/:sectionKey",
    async (req, res) => {
      const accountId = requestedAccountId(req, res);
      if (!accountId) return undefined;
      if (!requireEditor(req, res)) return undefined;
      const reviewer = authenticatedReviewer(req);
      if (!reviewer) {
        return res.set("cache-control", "no-store")
          .status(401)
          .json({ error: "authentication_required" });
      }
      try {
        const assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
        await ensureCustomAppraisalWorkfilesAvailable();
        const canonicalId = await resolveAccountId(pool, accountId);
        if (!await requireAssignmentAccess(
          req,
          res,
          canonicalId,
          assignmentFileId,
          "write",
        )) return undefined;
        const section = await saveSection(pool, {
          accountId: canonicalId,
          assignmentFileId,
          sectionKey: req.params.sectionKey,
          sectionValue: req.body?.value,
          expectedRevision: req.body?.expected_revision,
          saveReason: req.body?.save_reason,
          reviewer,
        });
        return res.json({
          ok: true,
          account_id: canonicalId,
          assignment_file_id: assignmentFileId,
          section,
        });
      } catch (error) {
        const message = workfileMutationErrorMessage(error);
        if (message === "assignment_file_not_found") {
          return res.status(404).json({ error: message });
        }
        if (message === "custom_appraisal_section_revision_conflict") {
          return res.status(409).json({
            error: message,
            current_revision: workfileConflictRevision(error),
          });
        }
        if (message === "custom_appraisal_workfile_signed") {
          return res.status(409).json({ error: message });
        }
        if (message === "custom_appraisal_workfile_storage_quota_exceeded") {
          return res.status(409).json({ error: message });
        }
        if (message === "custom_neighborhood_acceptance_workflow_required") {
          return res.status(409).json({ error: message });
        }
        if (SAVE_VALIDATION_ERRORS.has(message)) {
          return res.status(400).json({ error: message });
        }
        logMutationFailure(logger, "custom appraisal workfile section save failed", error);
        return res.status(500).json({ error: "custom_appraisal_workfile_save_failed" });
      }
    },
  );

  /** Create the immutable snapshot that represents the signed/finalized appraisal. */
  router.post("/api/accounts/:id/assignment-files/:fileId/workfile/sign", async (req, res) => {
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    // Finalization is irreversible and must never inherit the editor-key rollout fallback.
    if (!req.mobileAuth?.userId) {
      return res.set("cache-control", "no-store")
        .status(401)
        .json({ error: "authenticated_signer_required" });
    }
    if (!requireEditor(req, res)) return undefined;
    try {
      const assignmentFileId = normalizeFileId(req.params.fileId, { required: true });
      await ensureCustomAppraisalWorkfilesAvailable();
      const canonicalId = await resolveAccountId(pool, accountId);
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "sign",
      )) return undefined;
      const workfile = await signWorkfile(pool, {
        accountId: canonicalId,
        assignmentFileId,
        signedBy: req.mobileAuth.displayName || req.mobileAuth.email || req.mobileAuth.userId,
        signerUserId: req.mobileAuth.userId,
        signatureEventId: req.body?.signature_event_id,
        signedFromIp: req.ip,
        signedUserAgent: req.get("user-agent"),
        signingSecret: getSigningSecret(),
        acknowledgedWarningCodes: req.body?.acknowledged_warning_codes,
        objectStorage,
      });
      return res.json({ ok: true, account_id: canonicalId, workfile });
    } catch (error) {
      const message = workfileMutationErrorMessage(error);
      if (message === "assignment_file_not_found") {
        return res.status(404).json({ error: message });
      }
      if ([
        "custom_appraisal_workfile_signed",
        "custom_appraisal_workfile_empty",
        "custom_appraisal_signature_event_conflict",
      ].includes(message)) {
        return res.status(409).json({ error: message });
      }
      if (message === "custom_appraisal_signer_not_assigned") {
        return res.status(403).json({ error: message });
      }
      if (message === "custom_appraisal_signing_secret_not_configured") {
        return res.status(503).json({ error: message });
      }
      const readinessDetails = customAppraisalReadinessErrorDetails(error);
      if (message === "custom_appraisal_eo_incomplete" && readinessDetails) {
        return res.status(422).json({
          error: message,
          readiness_errors: readinessDetails.readinessErrors || [],
          readiness: readinessDetails.readiness || null,
        });
      }
      if (message === "custom_appraisal_eo_warnings_unacknowledged" && readinessDetails) {
        return res.status(422).json({
          error: message,
          readiness_warnings: readinessDetails.readinessWarnings || [],
          readiness: readinessDetails.readiness || null,
        });
      }
      if (SIGN_VALIDATION_ERRORS.has(message)) {
        return res.status(400).json({ error: message });
      }
      logMutationFailure(logger, "custom appraisal workfile signing failed", error);
      return res.status(500).json({ error: "custom_appraisal_workfile_sign_failed" });
    }
  });

  return router;
}
