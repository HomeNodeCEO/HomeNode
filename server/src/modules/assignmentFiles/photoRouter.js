import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  createAssignmentPhotoUpload,
  getAssignmentEvidenceVersion,
  getAssignmentPhotoVersion,
  listAssignmentPhotos,
  removeAssignmentPhoto,
  uploadAssignmentPhotoObject,
  updateAssignmentPhotoMetadata,
  verifyAssignmentPhoto,
} from "../../services/assignmentPhotos.js";

const PHOTO_CONTENT_TYPES = [
  "image/avif",
  "image/bmp",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
];

function assignmentPhotoErrorStatus(message) {
  if (message === "assignment_photo_file_not_found" || message === "assignment_photo_not_found"
      || message === "assignment_photo_object_not_found" || message === "account_not_found") return 404;
  if (message === "custom_appraisal_workfile_signed" || message === "assignment_photo_limit_conflict"
      || message === "assignment_photo_id_conflict" || message === "assignment_photo_revision_conflict") return 409;
  if (message === "assignment_photo_storage_not_configured") return 503;
  if (message === "invalid_assignment_file_id" || message.startsWith("invalid_assignment_photo")) return 400;
  return 500;
}

export function createAssignmentPhotoRouter({
  pool,
  objectStorage,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  listPhotos = listAssignmentPhotos,
  getPhotoVersion = getAssignmentPhotoVersion,
  getEvidenceVersion = getAssignmentEvidenceVersion,
  createPhotoUpload = createAssignmentPhotoUpload,
  uploadPhotoObject = uploadAssignmentPhotoObject,
  verifyPhoto = verifyAssignmentPhoto,
  updatePhotoMetadata = updateAssignmentPhotoMetadata,
  removePhoto = removeAssignmentPhoto,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("assignment_photo_router_pool_required");
  }
  if (!objectStorage || typeof objectStorage !== "object") {
    throw new TypeError("assignment_photo_router_storage_required");
  }
  const dependencies = [
    requireWorkflowAccess,
    requireEditor,
    requireAssignmentAccess,
    resolveAccountId,
    normalizeFileId,
    listPhotos,
    getPhotoVersion,
    getEvidenceVersion,
    createPhotoUpload,
    uploadPhotoObject,
    verifyPhoto,
    updatePhotoMetadata,
    removePhoto,
  ];
  if (dependencies.some((dependency) => typeof dependency !== "function")) {
    throw new TypeError("assignment_photo_router_dependency_required");
  }

  const router = express.Router();

  async function resolveAssignment(req, res, permission) {
    const accountId = await resolveAccountId(pool, String(req.params.id || "").trim());
    const assignmentFileId = normalizeFileId(req.params.assignmentFileId);
    if (!assignmentFileId) {
      res.status(400).json({ error: "invalid_assignment_file_id" });
      return null;
    }
    if (!await requireAssignmentAccess(req, res, accountId, assignmentFileId, permission)) {
      return null;
    }
    return { accountId, assignmentFileId };
  }

  /** List one Custom Appraisal file's shared desktop and mobile photo evidence. */
  router.get("/api/accounts/:id/assignment-files/:assignmentFileId/photos", async (req, res) => {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return;
    try {
      const assignment = await resolveAssignment(req, res, "read");
      if (!assignment) return;
      const result = await listPhotos(pool, objectStorage, assignment);
      return res.json({ ok: true, account_id: assignment.accountId, ...result });
    } catch (error) {
      const message = error?.message || "assignment_photos_lookup_failed";
      return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
    }
  });

  /** Cheap change token for near-real-time mobile-to-desktop photo synchronization. */
  router.get(
    "/api/accounts/:id/assignment-files/:assignmentFileId/photos/version",
    async (req, res) => {
      if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return;
      try {
        const assignment = await resolveAssignment(req, res, "read");
        if (!assignment) return;
        const result = await getPhotoVersion(pool, assignment);
        return res.set("cache-control", "no-store").json({
          ok: true,
          account_id: assignment.accountId,
          ...result,
        });
      } catch (error) {
        const message = error?.message || "assignment_photo_version_lookup_failed";
        return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
      }
    },
  );

  /** Lightweight verified photo + committed sketch token for one active appraisal file. */
  router.get(
    "/api/accounts/:id/assignment-files/:assignmentFileId/evidence/version",
    async (req, res) => {
      if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return;
      try {
        const assignment = await resolveAssignment(req, res, "read");
        if (!assignment) return;
        const result = await getEvidenceVersion(pool, assignment);
        return res.set("cache-control", "no-store").json({
          ok: true,
          account_id: assignment.accountId,
          ...result,
        });
      } catch (error) {
        const message = error?.message || "assignment_evidence_version_lookup_failed";
        return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
      }
    },
  );

  /** Create private R2 upload URLs for a desktop-selected appraisal photo. */
  router.post(
    "/api/accounts/:id/assignment-files/:assignmentFileId/photos/upload-requests",
    async (req, res) => {
      if (!requireEditor(req, res)) return;
      try {
        const assignment = await resolveAssignment(req, res, "write");
        if (!assignment) return;
        const result = await createPhotoUpload(pool, objectStorage, {
          ...assignment,
          input: req.body,
        });
        return res.status(201).json({ ok: true, ...result });
      } catch (error) {
        const message = error?.message || "assignment_photo_upload_request_failed";
        return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
      }
    },
  );

  /** Authenticated fallback when a browser cannot PUT directly to private R2. */
  router.put(
    "/api/accounts/:id/assignment-files/:assignmentFileId/photos/:photoId/objects/:objectId/content",
    express.raw({ type: PHOTO_CONTENT_TYPES, limit: "50mb" }),
    async (req, res) => {
      if (!requireEditor(req, res)) return;
      try {
        const assignment = await resolveAssignment(req, res, "write");
        if (!assignment) return;
        const uploaded = await uploadPhotoObject(pool, objectStorage, {
          ...assignment,
          photoId: req.params.photoId,
          objectId: req.params.objectId,
          contentType: req.get("content-type"),
          content: req.body,
        });
        return res.json({ ok: true, uploaded });
      } catch (error) {
        const message = error?.message || "assignment_photo_object_upload_failed";
        return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
      }
    },
  );

  /** Verify uploaded object sizes/types before the photo becomes report evidence. */
  router.post(
    "/api/accounts/:id/assignment-files/:assignmentFileId/photos/:photoId/verify",
    async (req, res) => {
      if (!requireEditor(req, res)) return;
      try {
        const assignment = await resolveAssignment(req, res, "write");
        if (!assignment) return;
        const photo = await verifyPhoto(pool, objectStorage, {
          ...assignment,
          photoId: req.params.photoId,
        });
        return res.json({ ok: true, photo });
      } catch (error) {
        const message = error?.message || "assignment_photo_verification_failed";
        return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
      }
    },
  );

  /** Save an appraiser-reviewed photo category and printable label. */
  router.patch(
    "/api/accounts/:id/assignment-files/:assignmentFileId/photos/:photoId",
    async (req, res) => {
      if (!requireEditor(req, res)) return;
      try {
        const assignment = await resolveAssignment(req, res, "write");
        if (!assignment) return;
        const photo = await updatePhotoMetadata(pool, objectStorage, {
          ...assignment,
          photoId: req.params.photoId,
          input: req.body,
        });
        return res.json({ ok: true, photo });
      } catch (error) {
        const message = error?.message || "assignment_photo_update_failed";
        return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
      }
    },
  );

  /** Remove a placeholder or retain verified evidence as excluded. */
  router.delete(
    "/api/accounts/:id/assignment-files/:assignmentFileId/photos/:photoId",
    async (req, res) => {
      if (!requireEditor(req, res)) return;
      try {
        const assignment = await resolveAssignment(req, res, "write");
        if (!assignment) return;
        const result = await removePhoto(pool, {
          ...assignment,
          photoId: req.params.photoId,
        });
        return res.json({ ok: true, ...result });
      } catch (error) {
        const message = error?.message || "assignment_photo_remove_failed";
        return res.status(assignmentPhotoErrorStatus(message)).json({ error: message });
      }
    },
  );

  return router;
}
