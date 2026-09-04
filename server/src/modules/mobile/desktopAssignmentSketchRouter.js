import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  getAssignmentInspectionSketch,
  saveAssignmentInspectionSketch,
} from "./desktopSketches.js";
import { renderSketchPdf, renderSketchSvg } from "./sketchArtifacts.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;

function artifactFileName(result) {
  return (result.artifact_options.fileNumber || "homenode")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

export function createDesktopAssignmentSketchRouter({
  pool,
  accountQualityReady,
  propertyEnrichmentReady,
  ensureAssignmentFilesAvailable,
  ensureCustomAppraisalWorkfilesAvailable,
  requireWorkflowAccess,
  requireEditor,
  requireAssignmentAccess,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeAssignmentId = normalizeAssignmentFileId,
  getSketch = getAssignmentInspectionSketch,
  saveSketch = saveAssignmentInspectionSketch,
  renderSvg = renderSketchSvg,
  renderPdf = renderSketchPdf,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("desktop_assignment_sketch_pool_required");
  }
  if (!accountQualityReady || typeof accountQualityReady.then !== "function") {
    throw new TypeError("desktop_assignment_sketch_account_readiness_required");
  }
  if (!propertyEnrichmentReady || typeof propertyEnrichmentReady.then !== "function") {
    throw new TypeError("desktop_assignment_sketch_enrichment_readiness_required");
  }
  if (typeof ensureAssignmentFilesAvailable !== "function") {
    throw new TypeError("desktop_assignment_sketch_schema_required");
  }
  if (typeof ensureCustomAppraisalWorkfilesAvailable !== "function") {
    throw new TypeError("desktop_assignment_sketch_workfile_schema_required");
  }
  if (typeof requireWorkflowAccess !== "function" || typeof requireEditor !== "function") {
    throw new TypeError("desktop_assignment_sketch_workflow_policy_required");
  }
  if (typeof requireAssignmentAccess !== "function") {
    throw new TypeError("desktop_assignment_sketch_assignment_policy_required");
  }
  if (typeof resolveAccountId !== "function" || typeof normalizeAssignmentId !== "function") {
    throw new TypeError("desktop_assignment_sketch_identity_service_required");
  }
  if (typeof getSketch !== "function" || typeof saveSketch !== "function") {
    throw new TypeError("desktop_assignment_sketch_service_required");
  }
  if (typeof renderSvg !== "function" || typeof renderPdf !== "function") {
    throw new TypeError("desktop_assignment_sketch_renderer_required");
  }

  const router = express.Router();

  async function loadArtifact(req, res, format) {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", "read")) return undefined;
    const requestedId = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    try {
      const assignmentFileId = normalizeAssignmentId(req.params.fileId, { required: true });
      await Promise.all([
        accountQualityReady,
        propertyEnrichmentReady,
        ensureAssignmentFilesAvailable(),
        ensureCustomAppraisalWorkfilesAvailable(),
      ]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        "read",
      )) return undefined;
      const result = await getSketch(pool, canonicalId, assignmentFileId);
      if (!result) return res.status(404).json({ error: "assignment_sketch_not_found" });
      const fileName = artifactFileName(result);
      if (format === "svg") {
        const svg = renderSvg(result.sketch, result.artifact_options);
        return res
          .set("Cache-Control", "no-store")
          .set("Content-Disposition", `inline; filename="${fileName}-measured-sketch.svg"`)
          .type("image/svg+xml")
          .send(svg);
      }
      const pdf = await renderPdf(result.sketch, result.artifact_options);
      return res
        .set("Cache-Control", "no-store")
        .set("Content-Disposition", `attachment; filename="${fileName}-measured-sketch.pdf"`)
        .type("application/pdf")
        .send(pdf);
    } catch (error) {
      if (error?.message === "invalid_assignment_file_id") {
        return res.status(400).json({ error: error.message });
      }
      logger.error?.(`assignment sketch ${format.toUpperCase()} failed`, error);
      return res.status(500).json({
        error: format === "svg" ? "assignment_sketch_svg_failed" : "assignment_sketch_pdf_failed",
      });
    }
  }

  /** Download or embed the current report-file sketch as a scalable vector exhibit. */
  router.get(
    "/api/accounts/:id/assignment-files/:fileId/mobile-sketch/preview.svg",
    (req, res) => loadArtifact(req, res, "svg"),
  );

  /** Download the current report-file sketch as a report-ready PDF exhibit. */
  router.get(
    "/api/accounts/:id/assignment-files/:fileId/mobile-sketch/report.pdf",
    (req, res) => loadArtifact(req, res, "pdf"),
  );

  /** Review a mobile sketch on desktop without overwriting an earlier revision. */
  router.patch("/api/accounts/:id/assignment-files/:fileId/mobile-sketch", async (req, res) => {
    const requestedId = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(requestedId)) {
      return res.status(400).json({ error: "invalid_account_id" });
    }
    if (!requireEditor(req, res)) return undefined;
    try {
      const assignmentFileId = normalizeAssignmentId(req.params.fileId, { required: true });
      await Promise.all([
        accountQualityReady,
        propertyEnrichmentReady,
        ensureAssignmentFilesAvailable(),
      ]);
      const canonicalId = await resolveAccountId(pool, requestedId);
      const permission = req.body?.sketch?.review_status === "appraiser_confirmed"
        ? "sign"
        : "write";
      if (!await requireAssignmentAccess(
        req,
        res,
        canonicalId,
        assignmentFileId,
        permission,
      )) return undefined;
      const result = await saveSketch(
        pool,
        canonicalId,
        assignmentFileId,
        req.body,
        req.mobileAuth?.userId || null,
      );
      return res.json({ ok: true, ...result });
    } catch (error) {
      if (error?.message === "assignment_sketch_not_found") {
        return res.status(404).json({ error: error.message });
      }
      if (error?.message === "sketch_revision_conflict") {
        return res.status(409).json({
          error: error.message,
          current_revision: error.currentRevision,
        });
      }
      if (
        String(error?.message || "").startsWith("invalid_")
        || String(error?.message || "").startsWith("duplicate_")
        || error?.message === "sketch_not_ready_for_confirmation"
        || error?.message === "sketch_operation_conflict"
      ) {
        return res.status(error?.message === "sketch_operation_conflict" ? 409 : 400)
          .json({ error: error.message });
      }
      logger.error?.("assignment sketch desktop review failed", error);
      return res.status(500).json({ error: "assignment_sketch_update_failed" });
    }
  });

  return router;
}
