import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { indexAssignmentFileDetails } from "../../services/assignmentFileDetails.js";
import {
  ASSIGNMENT_FILE_SELECT,
  assignmentFileResponse,
  normalizeAssignmentFileId,
} from "../../services/assignmentFiles.js";
import { decideAssignmentAccess } from "../../security/assignmentAccess.js";

export function createAssignmentFileListRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  ensureAssignmentFilesAvailable,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  authenticationRequired,
  sharedObjectStorage,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeAssignmentId = normalizeAssignmentFileId,
  decideAccess = decideAssignmentAccess,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("assignment_file_list_pool_required");
  }
  if (!accountQualityReady || typeof accountQualityReady.then !== "function") {
    throw new TypeError("assignment_file_list_account_readiness_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("assignment_file_list_enrichment_readiness_required");
  }
  if (typeof ensureAssignmentFilesAvailable !== "function") {
    throw new TypeError("assignment_file_list_schema_required");
  }
  if (typeof ensureCustomAppraisalWorkfilesAvailable !== "function") {
    throw new TypeError("assignment_file_list_workfile_schema_required");
  }
  if (typeof requireWorkflowAccess !== "function") {
    throw new TypeError("assignment_file_list_workflow_policy_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("assignment_file_list_authentication_mode_required");
  }
  if (typeof resolveAccountId !== "function") {
    throw new TypeError("assignment_file_list_resolver_required");
  }
  if (typeof normalizeAssignmentId !== "function") {
    throw new TypeError("assignment_file_list_id_normalizer_required");
  }
  if (typeof decideAccess !== "function") {
    throw new TypeError("assignment_file_list_access_policy_required");
  }

  const router = express.Router();

  router.get("/api/accounts/:id/assignment-files", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return undefined;
    const requestedId = String(req.params.id || "").trim();
    const requestedAssignmentFileValue = String(req.query.assignment_file_id || "").trim();
    const requestedAssignmentFileId = requestedAssignmentFileValue
      ? normalizeAssignmentId(requestedAssignmentFileValue)
      : null;
    if (!/^[0-9A-Za-z_-]{1,50}$/.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (requestedAssignmentFileValue && !requestedAssignmentFileId) {
      return res.status(400).json({ error: "invalid_assignment_file_id" });
    }
    try {
      await Promise.all([
        accountQualityReady,
        propertyEnrichmentReady,
        ensureAssignmentFilesAvailable(),
        ensureCustomAppraisalWorkfilesAvailable(),
      ]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const accountResult = await pool.query(
        "SELECT 1 FROM core.accounts WHERE account_id = $1",
        [canonicalId],
      );
      if (!accountResult.rowCount) {
        return res.status(404).json({ error: "account_not_found" });
      }
      const enforcedIdentity = authenticationRequired && req.mobileAuth;
      const [{ rows: queriedRows }, legacyResult] = await Promise.all([
        pool.query(
          `${ASSIGNMENT_FILE_SELECT}
           WHERE f.account_id = $1
           ORDER BY f.created_at DESC, f.id DESC`,
          [canonicalId],
        ),
        enforcedIdentity
          ? Promise.resolve({ rows: [] })
          : pool.query(
            `SELECT attribute_value
             FROM app.property_attribute_manual_values
             WHERE account_id = $1 AND attribute_key = 'report.assignment_details'`,
            [canonicalId],
          ),
      ]);
      const authorizedRows = enforcedIdentity
        ? queriedRows.filter((row) => decideAccess(req.mobileAuth, row, "read"))
        : queriedRows;
      const rows = requestedAssignmentFileId
        ? authorizedRows.filter((row) => Number(row.id) === requestedAssignmentFileId)
        : authorizedRows;
      const assignmentIds = rows.map((row) => Number(row.id));
      let sectionRows = [];
      let mobilePhotoRows = [];
      let mobileSketchRows = [];
      if (assignmentIds.length) {
        try {
          [sectionRows, mobilePhotoRows, mobileSketchRows] = await Promise.all([
            pool.query(
              `SELECT assignment_file_id, section_key, section_value, revision,
                      last_applied_session_id, updated_at
                 FROM app.custom_appraisal_sections
                WHERE assignment_file_id = ANY($1::bigint[])
                ORDER BY assignment_file_id, section_key`,
              [assignmentIds],
            ).then((result) => result.rows),
            pool.query(
              `SELECT report_file.custom_assignment_file_id AS assignment_file_id,
                      photo.id, photo.client_photo_id, photo.origin_channel,
                      photo.category, photo.room_ref, photo.room_label,
                      photo.caption, photo.position, photo.captured_at,
                      photo.status, photo.revision, photo.verified_at,
                      photo.retention_until, photo.required_retention_years,
                      view_object.object_key AS view_object_key
                 FROM app.report_files report_file
                 JOIN app.inspection_photos photo ON photo.report_file_id = report_file.id
                 LEFT JOIN LATERAL (
                   SELECT object_key
                     FROM app.inspection_photo_objects
                    WHERE photo_id = photo.id AND status = 'verified'
                    ORDER BY CASE variant WHEN 'display' THEN 0 ELSE 1 END, id
                    LIMIT 1
                 ) view_object ON true
                WHERE report_file.custom_assignment_file_id = ANY($1::bigint[])
                  AND photo.status = 'verified'
                ORDER BY report_file.custom_assignment_file_id, photo.position, photo.created_at, photo.id`,
              [assignmentIds],
            ).then((result) => result.rows),
            pool.query(
              `SELECT DISTINCT ON (report_file.custom_assignment_file_id)
                      report_file.custom_assignment_file_id AS assignment_file_id,
                      sketch.id, sketch.revision, sketch.document, sketch.summary,
                      sketch.measurement_standard, sketch.measurement_method,
                      sketch.review_status, sketch.confirmed_at, sketch.updated_at
                 FROM app.report_files report_file
                 JOIN app.inspection_sketches sketch ON sketch.report_file_id = report_file.id
                WHERE report_file.custom_assignment_file_id = ANY($1::bigint[])
                ORDER BY report_file.custom_assignment_file_id, sketch.updated_at DESC, sketch.id DESC`,
              [assignmentIds],
            ).then((result) => result.rows),
          ]);
        } catch (error) {
          if (error?.code !== "42P01") throw error;
        }
      }
      mobilePhotoRows = mobilePhotoRows.map((photo) => {
        let view = null;
        if (photo.view_object_key && sharedObjectStorage?.configured) {
          try {
            view = sharedObjectStorage.createDownloadUrl({
              objectKey: photo.view_object_key,
              expiresInSeconds: 300,
            });
          } catch {
            view = null;
          }
        }
        return {
          ...photo,
          view_url: view?.url || null,
          view_url_expires_in_seconds: view?.expires_in_seconds || null,
        };
      });
      const detailIndex = indexAssignmentFileDetails({
        sectionRows,
        mobilePhotoRows,
        mobileSketchRows,
      });
      const files = rows.map((row) => {
        const response = assignmentFileResponse(row);
        return {
          ...response,
          custom_appraisal_sections: detailIndex.sectionsByFile.get(response.id) || {},
          mobile_inspection_sketch: detailIndex.sketchesByFile.get(response.id) || null,
          mobile_inspection_photos: detailIndex.photosByFile.get(response.id) || [],
        };
      });
      return res.json({
        account_id: canonicalId,
        files,
        latest_file: files[0] || null,
        legacy_assignment_details: enforcedIdentity
          ? null
          : legacyResult.rows[0]?.attribute_value || null,
      });
    } catch (error) {
      logger.error?.("assignment file list failed", error);
      return res.status(500).json({ error: "assignment_file_list_failed" });
    }
  });

  return router;
}
