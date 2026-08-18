import express from "express";

import { createMobileAuthenticator } from "./auth.js";
import { MOBILE_WORKFLOW_TYPES } from "./fileNumbers.js";
import { calculateManualSketch } from "./manualSketch.js";
import { getMobileProperty, searchMobileProperties } from "./properties.js";
import {
  createInspectionSession,
  createReportFile,
  getInspectionSession,
  listReportFiles,
} from "./reportFiles.js";
import { getInspectionSnapshot, syncInspectionOperations } from "./sync.js";

const WRITE_ROLES = new Set(["appraiser", "supervisory_appraiser", "organization_admin", "homenode_admin"]);

function errorStatus(error) {
  const message = String(error?.message || "");
  if (error?.statusCode) return error.statusCode;
  if (message.endsWith("_not_found")) return 404;
  if (message.endsWith("_access_denied")) return 403;
  if (message.endsWith("_conflict")) return 409;
  if (message.startsWith("invalid_")) return 400;
  if (error?.code === "23505") return 409;
  if (error?.code === "23503") return 400;
  return 500;
}

function sendError(res, error) {
  const status = errorStatus(error);
  const code = status === 500
    ? "mobile_request_failed"
    : String(error?.message || "mobile_request_failed").split(":")[0];
  if (status === 500) console.error("[mobile] request failed", error);
  return res.status(status).json({ error: code });
}

function requireWriteRole(req, res, next) {
  const allowed = req.mobileAuth.organizations.some((organization) =>
    organization.roles.some((role) => WRITE_ROLES.has(role)));
  if (!allowed) return res.status(403).json({ error: "mobile_write_role_required" });
  return next();
}

export function createMobileRouter({ pool, verifier, enabled = false, recentFileDays = 30 }) {
  const router = express.Router();

  router.get("/capabilities", (_req, res) => {
    res.json({
      enabled,
      authentication: {
        protocol: "oidc",
        configured: Boolean(verifier?.configured),
        token_transport: "bearer",
      },
      workflows: MOBILE_WORKFLOW_TYPES,
      report_file_retention_years: 5,
      sketch: {
        manual_measurement: true,
        lidar: false,
      },
      offline_sync: {
        durable_queue: true,
        maximum_batch_size: 25,
        conflict_resolution: ["accept_server", "apply_mobile"],
      },
    });
  });

  router.use((_req, res, next) => {
    if (enabled) return next();
    return res.status(503).json({ error: "mobile_inspection_disabled" });
  });
  router.use(createMobileAuthenticator({ pool, verifier }));

  router.get("/me", (req, res) => {
    res.json({ user: req.mobileAuth });
  });

  router.get("/properties/search", async (req, res) => {
    try {
      const result = await searchMobileProperties(pool, req.mobileAuth, {
        query: req.query.q,
        limit: req.query.limit,
      });
      return res.json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/properties/:accountId", async (req, res) => {
    try {
      return res.json(await getMobileProperty(pool, req.mobileAuth, req.params.accountId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/sketches/calculate", requireWriteRole, (req, res) => {
    try {
      return res.json({ sketch: calculateManualSketch(req.body || {}) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/report-files", async (req, res) => {
    try {
      const result = await listReportFiles(pool, req.mobileAuth, {
        accountId: req.query.account_id,
        workflowType: req.query.workflow_type,
        recentDays: recentFileDays,
      });
      return res.json({
        account_id: result.accountId,
        workflow_type: result.workflowType,
        files: result.files,
        recommended_file: result.recommended,
        recently_created: result.recentlyCreated,
        requires_creation: result.requiresCreation,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/report-files", requireWriteRole, async (req, res) => {
    try {
      const result = await createReportFile(pool, req.mobileAuth, req.body || {});
      return res.status(result.created ? 201 : 200).json({
        report_file: result.reportFile,
        created: result.created,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions", requireWriteRole, async (req, res) => {
    try {
      const result = await createInspectionSession(pool, req.mobileAuth, req.body || {});
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId", async (req, res) => {
    try {
      const session = await getInspectionSession(pool, req.mobileAuth, req.params.sessionId);
      if (!session) return res.status(404).json({ error: "inspection_session_not_found" });
      return res.json({ session });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/inspection-sessions/:sessionId/snapshot", async (req, res) => {
    try {
      return res.json(await getInspectionSnapshot(pool, req.mobileAuth, req.params.sessionId));
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post("/inspection-sessions/:sessionId/sync", requireWriteRole, async (req, res) => {
    try {
      return res.json(await syncInspectionOperations(
        pool,
        req.mobileAuth,
        req.params.sessionId,
        req.body || {},
      ));
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
