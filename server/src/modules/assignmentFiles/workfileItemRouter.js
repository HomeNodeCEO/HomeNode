import express from "express";

import { resolveCanonicalAccountId } from "../../services/accountQuality.js";
import { normalizeAssignmentFileId } from "../../services/assignmentFiles.js";
import {
  createAssignmentWorkfileFile,
  createAssignmentWorkfileLink,
  deleteAssignmentWorkfileItem,
  getAssignmentWorkfileScopeState,
  getAssignmentWorkfileFile,
  listAssignmentWorkfileItems,
  MAX_ASSIGNMENT_WORKFILE_ITEM_BYTES,
} from "../../services/assignmentWorkfileItems.js";
import { authorizeUadWorkfileAccess } from "../uad/access.js";

const ACCOUNT_ID_PATTERN = /^[0-9A-Za-z_-]{1,50}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ITEM_ERRORS = new Set([
  "assignment_workfile_not_found",
  "assignment_workfile_status_locked",
  "invalid_workfile_file_name",
  "invalid_workfile_link",
  "uad_workfile_not_found",
  "uad_workfile_status_locked",
  "unsupported_workfile_file_type",
  "workfile_file_content_required",
  "workfile_file_integrity_failed",
  "workfile_file_too_large",
  "workfile_item_not_found",
  "workfile_link_title_required",
  "workfile_storage_not_configured",
]);

function decodedHeader(req, name, fallback = "") {
  const value = String(req.get(name) || fallback);
  try { return decodeURIComponent(value); } catch { return value; }
}

function itemErrorStatus(message) {
  if (message === "workfile_item_not_found") return 404;
  if (message === "workfile_storage_not_configured") return 503;
  if (message === "workfile_file_integrity_failed") return 409;
  if (["assignment_workfile_status_locked", "uad_workfile_status_locked"].includes(message)) return 409;
  if (["assignment_workfile_not_found", "uad_workfile_not_found"].includes(message)) return 404;
  if ([
    "invalid_workfile_file_name",
    "unsupported_workfile_file_type",
    "workfile_file_content_required",
    "workfile_file_too_large",
    "invalid_workfile_link",
    "workfile_link_title_required",
  ].includes(message)) return 400;
  return 500;
}

function boundedItemError(error, fallback) {
  const message = String(error?.message || "");
  return CLIENT_ITEM_ERRORS.has(message) ? message : fallback;
}

export function createAssignmentWorkfileItemRouter({
  pool,
  sharedObjectStorage,
  uadObjectStorage,
  requireWorkflowAccess,
  requireAssignmentAccess,
  resolveAccountId = resolveCanonicalAccountId,
  normalizeFileId = normalizeAssignmentFileId,
  authorizeUad = authorizeUadWorkfileAccess,
  listItems = listAssignmentWorkfileItems,
  getScopeState = getAssignmentWorkfileScopeState,
  createFile = createAssignmentWorkfileFile,
  createLink = createAssignmentWorkfileLink,
  getFile = getAssignmentWorkfileFile,
  deleteItem = deleteAssignmentWorkfileItem,
  maxFileBytes = MAX_ASSIGNMENT_WORKFILE_ITEM_BYTES,
  logger = console,
} = {}) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("assignment_workfile_item_router_pool_required");
  if (!sharedObjectStorage || !uadObjectStorage) throw new TypeError("assignment_workfile_item_router_storage_required");
  if (typeof requireWorkflowAccess !== "function" || typeof requireAssignmentAccess !== "function") {
    throw new TypeError("assignment_workfile_item_router_access_required");
  }
  if ([resolveAccountId, normalizeFileId, authorizeUad, listItems, getScopeState, createFile, createLink, getFile, deleteItem]
    .some(dependency => typeof dependency !== "function")) {
    throw new TypeError("assignment_workfile_item_router_dependency_required");
  }
  const router = express.Router();

  async function customScope(req, res, permission) {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", permission)) return null;
    const requestedAccountId = String(req.params.id || "").trim();
    if (!ACCOUNT_ID_PATTERN.test(requestedAccountId)) {
      res.status(400).json({ error: "invalid_account_id" });
      return null;
    }
    let assignmentFileId;
    try { assignmentFileId = normalizeFileId(req.params.assignmentFileId, { required: true }); } catch {
      res.status(400).json({ error: "invalid_assignment_file_id" });
      return null;
    }
    const accountId = await resolveAccountId(pool, requestedAccountId);
    if (!await requireAssignmentAccess(req, res, accountId, assignmentFileId, permission)) return null;
    const { rows } = await pool.query(
      "SELECT organization_id FROM app.assignment_files WHERE id = $1 AND account_id = $2",
      [assignmentFileId, accountId],
    );
    if (!rows.length) {
      res.status(404).json({ error: "assignment_file_not_found" });
      return null;
    }
    return {
      scope: { assignmentFileId },
      accountId,
      organizationId: rows[0].organization_id,
      storage: sharedObjectStorage,
    };
  }

  async function uadScope(req, res, permission) {
    if (!requireWorkflowAccess(req, res, "uad_3_6", permission)) return null;
    try {
      const workfile = await authorizeUad(pool, req.mobileAuth, req.params.workfileId, {
        write: permission === "write",
      });
      return {
        scope: { uadWorkfileId: workfile.id },
        organizationId: workfile.organization_id,
        storage: uadObjectStorage,
      };
    } catch (error) {
      const message = String(error?.message || "uad_workfile_access_denied");
      if (message === "invalid_uad_workfile_id") res.status(400).json({ error: message });
      else if (message === "uad_workfile_not_found") res.status(404).json({ error: message });
      else if (message === "uad_authentication_required") res.status(401).json({ error: message });
      else res.status(403).json({ error: "uad_workfile_access_denied" });
      return null;
    }
  }

  const customBase = "/api/accounts/:id/assignment-files/:assignmentFileId/workfile/items";
  const uadBase = "/api/appraisal-workfiles/uad/:workfileId/items";

  function mount(base, loadScope) {
    router.get(base, async (req, res) => {
      try {
        const authorized = await loadScope(req, res, "read");
        if (!authorized) return;
        const [items, state] = await Promise.all([
          listItems(pool, authorized.scope),
          getScopeState(pool, authorized.scope),
        ]);
        return res.json({ ok: true, items, mutable: state.mutable });
      } catch (error) {
        const message = boundedItemError(error, "workfile_items_lookup_failed");
        logger.error?.("assignment workfile items list failed", { code: message });
        return res.status(itemErrorStatus(message)).json({ error: message });
      }
    });

    router.post(
      `${base}/files`,
      async (req, res, next) => {
        try {
          const authorized = await loadScope(req, res, "write");
          if (!authorized) return;
          req.assignmentWorkfileItemAccess = authorized;
          return next();
        } catch (error) {
          const message = boundedItemError(error, "workfile_file_upload_failed");
          return res.status(itemErrorStatus(message)).json({ error: message });
        }
      },
      express.raw({ type: () => true, limit: maxFileBytes, inflate: false }),
      (error, _req, res, next) => {
        if (!error) return next();
        if (error.type === "encoding.unsupported") return res.status(415).json({ error: "unsupported_content_encoding" });
        if (error.type === "entity.too.large") return res.status(413).json({ error: "workfile_file_too_large" });
        logger.error?.("assignment workfile upload body rejected", { code: "workfile_file_upload_body_invalid" });
        return res.status(400).json({ error: "workfile_file_upload_body_invalid" });
      },
      async (req, res) => {
        try {
          const authorized = req.assignmentWorkfileItemAccess;
          const item = await createFile(pool, authorized.storage, authorized.scope, {
            organizationId: authorized.organizationId,
            title: decodedHeader(req, "x-workfile-item-title"),
            fileName: decodedHeader(req, "x-workfile-file-name", "workfile-item"),
            contentType: req.get("content-type"),
            content: req.body,
            createdByUserId: req.mobileAuth?.userId || null,
          });
          return res.status(201).json({ ok: true, item });
        } catch (error) {
          const message = boundedItemError(error, "workfile_file_upload_failed");
          logger.error?.("assignment workfile file upload failed", { code: message });
          return res.status(itemErrorStatus(message)).json({ error: message });
        }
      },
    );

    router.post(`${base}/links`, async (req, res) => {
      try {
        const authorized = await loadScope(req, res, "write");
        if (!authorized) return;
        const item = await createLink(pool, authorized.scope, {
          organizationId: authorized.organizationId,
          title: req.body?.title,
          externalUrl: req.body?.external_url,
          createdByUserId: req.mobileAuth?.userId || null,
        });
        return res.status(201).json({ ok: true, item });
      } catch (error) {
        const message = boundedItemError(error, "workfile_link_create_failed");
        return res.status(itemErrorStatus(message)).json({ error: message });
      }
    });

    router.get(`${base}/:itemId/content`, async (req, res) => {
      try {
        if (!UUID_PATTERN.test(String(req.params.itemId || ""))) return res.status(400).json({ error: "invalid_workfile_item_id" });
        const authorized = await loadScope(req, res, "read");
        if (!authorized) return;
        const file = await getFile(pool, authorized.storage, authorized.scope, req.params.itemId);
        const originalName = String(file.original_file_name || "workfile-item").replace(/[\r\n]/g, "_");
        const asciiName = originalName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "workfile-item";
        const encodedName = encodeURIComponent(originalName).replace(/['()*]/g, character => (
          `%${character.charCodeAt(0).toString(16).toUpperCase()}`
        ));
        res.set({
          "cache-control": "private, no-store",
          "content-type": file.content_type,
          "content-length": String(file.body.length),
          "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
          "x-content-type-options": "nosniff",
        });
        return res.send(file.body);
      } catch (error) {
        const message = boundedItemError(error, "workfile_file_download_failed");
        return res.status(itemErrorStatus(message)).json({ error: message });
      }
    });

    router.delete(`${base}/:itemId`, async (req, res) => {
      try {
        if (!UUID_PATTERN.test(String(req.params.itemId || ""))) return res.status(400).json({ error: "invalid_workfile_item_id" });
        const authorized = await loadScope(req, res, "write");
        if (!authorized) return;
        await deleteItem(pool, authorized.storage, authorized.scope, req.params.itemId);
        return res.status(204).end();
      } catch (error) {
        const message = boundedItemError(error, "workfile_item_delete_failed");
        return res.status(itemErrorStatus(message)).json({ error: message });
      }
    });
  }

  mount(customBase, customScope);
  mount(uadBase, uadScope);
  return router;
}
