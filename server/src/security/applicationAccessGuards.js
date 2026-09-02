import { editorKeyMatches } from "../util/housingProfileEdit.js";
import { authorizeCustomAssignmentFile } from "./assignmentAccess.js";
import { hasApplicationPermission } from "./applicationAccess.js";

function assertGuardOptions(pool, authenticationRequired) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("application_access_guards_pool_required");
  }
  if (typeof authenticationRequired !== "boolean") {
    throw new TypeError("application_access_guards_authentication_mode_required");
  }
}

export function createApplicationAccessGuards({
  pool,
  authenticationRequired,
  environment = process.env,
  permissionChecker = hasApplicationPermission,
  editorKeyChecker = editorKeyMatches,
  assignmentAuthorizer = authorizeCustomAssignmentFile,
} = {}) {
  assertGuardOptions(pool, authenticationRequired);

  function requireEditor(req, res) {
    if (req.mobileAuth) {
      if (
        permissionChecker(req.mobileAuth, "custom_appraisal", "write")
        || permissionChecker(req.mobileAuth, "property_tax_protest", "write")
      ) {
        return true;
      }
      res.set("cache-control", "no-store")
        .status(403)
        .json({ error: "application_access_denied" });
      return false;
    }
    if (authenticationRequired) {
      res.set("cache-control", "no-store")
        .status(401)
        .json({ error: "authentication_required" });
      return false;
    }
    const configuredEditorKey = String(environment.HOMENODE_EDITOR_KEY || "");
    if (!configuredEditorKey) {
      res.status(503).json({ error: "editor_not_configured" });
      return false;
    }
    if (!editorKeyChecker(req.get("x-homenode-editor-key"), configuredEditorKey)) {
      res.status(401).json({ error: "invalid_editor_key" });
      return false;
    }
    return true;
  }

  async function requireCustomAssignmentAccess(
    req,
    res,
    accountId,
    assignmentFileId,
    permission,
  ) {
    if (!authenticationRequired) return true;
    if (req.mobileAuth) {
      try {
        await assignmentAuthorizer(pool, req.mobileAuth, {
          accountId,
          assignmentFileId,
          permission,
        });
        return true;
      } catch (error) {
        const notFound = error?.message === "assignment_file_not_found";
        res.set("cache-control", "no-store").status(notFound ? 404 : 403).json({
          error: notFound ? "assignment_file_not_found" : "assignment_file_access_denied",
        });
        return false;
      }
    }
    res.set("cache-control", "no-store")
      .status(401)
      .json({ error: "authentication_required" });
    return false;
  }

  function requireWorkflowAccess(req, res, workflow, permission) {
    if (req.mobileAuth) {
      if (permissionChecker(req.mobileAuth, workflow, permission)) return true;
      res.set("cache-control", "no-store")
        .status(403)
        .json({ error: "application_access_denied" });
      return false;
    }
    if (authenticationRequired) {
      res.set("cache-control", "no-store")
        .status(401)
        .json({ error: "authentication_required" });
      return false;
    }
    const configuredEditorKey = String(environment.HOMENODE_EDITOR_KEY || "");
    if (
      configuredEditorKey
      && editorKeyChecker(req.get("x-homenode-editor-key"), configuredEditorKey)
    ) {
      return true;
    }
    if (!authenticationRequired) return true;
    res.set("cache-control", "no-store");
    res.status(req.mobileAuth ? 403 : 401).json({
      error: req.mobileAuth ? "application_access_denied" : "authentication_required",
    });
    return false;
  }

  return Object.freeze({
    requireEditor,
    requireCustomAssignmentAccess,
    requireWorkflowAccess,
  });
}
