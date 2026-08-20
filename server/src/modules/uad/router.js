import express from "express";

import {
  createUadAssetUpload,
  deleteUadAsset,
  listUadAssets,
  verifyUadAssetUpload,
} from "./assets.js";
import { CURRENT_UAD_RELEASE_KEY } from "./constants.js";
import { applyUadCompletionSuggestions } from "./completionApply.js";
import { getUadEditor, saveUadSection } from "./editor.js";
import { createUadEntity, deleteUadEntity } from "./entities.js";
import { getUadSharedData } from "./sharedData.js";
import { listUadSketches, saveUadSketch } from "./sketches.js";
import {
  createUadWorkfile,
  getUadSubjectSummary,
  getUadWorkfile,
  listUadWorkfiles,
} from "./workfiles.js";

function errorStatus(error) {
  const message = String(error?.message || "");
  if (message.includes("not_found")) return 404;
  if (message.includes("source_changed") || message.includes("adapter_changed") || message.includes("stale_revision") || message.includes("selection_changed")) return 409;
  if (message.startsWith("uad_completion_")) return 400;
  if (message.includes("not_configured")) return 503;
  if (message.startsWith("invalid_")) return 400;
  if (["uad_parent_entity_required", "uad_entity_minimum_required"].includes(message)) return 400;
  if (error?.code === "23505") return 409;
  if (error?.code === "23503") return 400;
  return 500;
}

function sendError(res, error) {
  const status = errorStatus(error);
  const code = status === 500 ? "uad_request_failed" : String(error?.message || "uad_request_failed").split(":")[0];
  if (status === 500) console.error("[uad] request failed", error);
  res.status(status).json({ error: code, ...(error?.details ? { details: error.details } : {}) });
}

export function createUadRouter({ pool, storage, enabled = false }) {
  const router = express.Router();

  router.get("/capabilities", (_req, res) => {
    res.json({
      enabled,
      specification_release_key: CURRENT_UAD_RELEASE_KEY,
      initial_property_type: "traditional_single_family",
      object_storage: {
        provider: storage.provider,
        configured: storage.configured,
      },
    });
  });

  router.use((req, res, next) => {
    if (enabled) return next();
    return res.status(503).json({ error: "uad_workspace_disabled" });
  });

  router.get("/accounts/:accountId/workfiles", async (req, res) => {
    try {
      const workfiles = await listUadWorkfiles(pool, req.params.accountId);
      res.json({ account_id: req.params.accountId, workfiles });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/accounts/:accountId/subject-summary", async (req, res) => {
    try {
      const subject = await getUadSubjectSummary(pool, req.params.accountId);
      res.json({ subject });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/accounts/:accountId/workfiles", async (req, res) => {
    try {
      const workfile = await createUadWorkfile(pool, req.params.accountId, req.body || {});
      res.status(201).json({ workfile });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId", async (req, res) => {
    try {
      const workfile = await getUadWorkfile(pool, req.params.workfileId);
      if (!workfile) return res.status(404).json({ error: "uad_workfile_not_found" });
      return res.json({ workfile });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/editor", async (req, res) => {
    try {
      const editor = await getUadEditor(pool, req.params.workfileId);
      res.json(editor);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.patch("/workfiles/:workfileId/sections/:section", async (req, res) => {
    try {
      const result = await saveUadSection(
        pool,
        req.params.workfileId,
        req.params.section,
        req.body || {},
      );
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/shared-data", async (req, res) => {
    try {
      res.json(await getUadSharedData(pool, req.params.workfileId));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/completion-suggestions/apply", async (req, res) => {
    try {
      res.json(await applyUadCompletionSuggestions(
        pool,
        req.params.workfileId,
        req.body || {},
      ));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/sketches", async (req, res) => {
    try {
      res.json({ sketches: await listUadSketches(pool, req.params.workfileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.put("/workfiles/:workfileId/sketches", async (req, res) => {
    try {
      const sketch = await saveUadSketch(pool, req.params.workfileId, req.body || {});
      res.json({ sketch });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/entities", async (req, res) => {
    try {
      const entity = await createUadEntity(pool, req.params.workfileId, req.body || {});
      res.status(201).json({ entity });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete("/workfiles/:workfileId/entities/:entityId", async (req, res) => {
    try {
      await deleteUadEntity(pool, req.params.workfileId, req.params.entityId);
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/workfiles/:workfileId/assets", async (req, res) => {
    try {
      res.json({ assets: await listUadAssets(pool, req.params.workfileId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/assets/upload-url", async (req, res) => {
    try {
      const upload = await createUadAssetUpload(pool, storage, req.params.workfileId, req.body || {});
      res.status(201).json(upload);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/workfiles/:workfileId/assets/:assetId/verify", async (req, res) => {
    try {
      const asset = await verifyUadAssetUpload(
        pool,
        storage,
        req.params.workfileId,
        req.params.assetId,
      );
      res.json({ asset });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete("/workfiles/:workfileId/assets/:assetId", async (req, res) => {
    try {
      await deleteUadAsset(pool, req.params.workfileId, req.params.assetId);
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
