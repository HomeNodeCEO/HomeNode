import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  saveCustomAppraisalWorkfileSection,
  signCustomAppraisalWorkfile,
} from "../../services/customAppraisalWorkfiles.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;

function requestedAccountId(req, res) {
  const value = String(req.params.id || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(value)) {
    res.status(400).json({ error: "invalid_account_id" });
    return null;
  }
  return value;
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
          reviewer: req.body?.reviewer,
        });
        return res.json({
          ok: true,
          account_id: canonicalId,
          assignment_file_id: assignmentFileId,
          section,
        });
      } catch (error) {
        if (error?.message === "assignment_file_not_found") {
          return res.status(404).json({ error: error.message });
        }
        if (error?.message === "custom_appraisal_section_revision_conflict") {
          return res.status(409).json({
            error: error.message,
            current_revision: Number(error.currentRevision || 0),
          });
        }
        if (error?.message === "custom_appraisal_workfile_signed") {
          return res.status(409).json({ error: error.message });
        }
        if (
          String(error?.message || "").startsWith("invalid_")
          || error?.message === "custom_appraisal_section_too_large"
        ) {
          return res.status(400).json({ error: error.message });
        }
        logger.error?.("custom appraisal workfile section save failed", error);
        return res.status(500).json({ error: "custom_appraisal_workfile_save_failed" });
      }
    },
  );

  /** Create the immutable snapshot that represents the signed/finalized appraisal. */
  router.post("/api/accounts/:id/assignment-files/:fileId/workfile/sign", async (req, res) => {
    const accountId = requestedAccountId(req, res);
    if (!accountId) return undefined;
    if (!requireEditor(req, res)) return undefined;
    if (authenticationRequired && !req.mobileAuth) {
      return res.status(401).json({ error: "authenticated_signer_required" });
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
        "sign",
      )) return undefined;
      const workfile = await signWorkfile(pool, {
        accountId: canonicalId,
        assignmentFileId,
        signedBy: req.mobileAuth?.displayName || req.body?.signed_by || req.body?.reviewer,
        signerUserId: req.mobileAuth?.userId || null,
        signatureEventId: req.body?.signature_event_id,
        signedFromIp: req.ip,
        signedUserAgent: req.get("user-agent"),
        signingSecret: getSigningSecret(),
        acknowledgedWarningCodes: req.body?.acknowledged_warning_codes,
        objectStorage,
      });
      return res.json({ ok: true, account_id: canonicalId, workfile });
    } catch (error) {
      if (error?.message === "assignment_file_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if ([
        "custom_appraisal_workfile_signed",
        "custom_appraisal_workfile_empty",
        "custom_appraisal_signature_event_conflict",
      ].includes(
        error?.message,
      )) {
        return res.status(409).json({ error: error.message });
      }
      if (error?.message === "custom_appraisal_signer_not_assigned") {
        return res.status(403).json({ error: error.message });
      }
      if (error?.message === "custom_appraisal_signing_secret_not_configured") {
        return res.status(503).json({ error: error.message });
      }
      if (error?.message === "custom_appraisal_eo_incomplete") {
        return res.status(422).json({
          error: error.message,
          readiness_errors: error.readinessErrors || [],
          readiness: error.readiness || null,
        });
      }
      if (error?.message === "custom_appraisal_eo_warnings_unacknowledged") {
        return res.status(422).json({
          error: error.message,
          readiness_warnings: error.readinessWarnings || [],
          readiness: error.readiness || null,
        });
      }
      if (String(error?.message || "").startsWith("invalid_")) {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.("custom appraisal workfile signing failed", error);
      return res.status(500).json({ error: "custom_appraisal_workfile_sign_failed" });
    }
  });

  return router;
}
