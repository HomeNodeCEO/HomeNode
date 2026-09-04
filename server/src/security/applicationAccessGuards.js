import { editorKeyMatches } from "../util/housingProfileEdit.js";
import { normalizeAssignmentFileId } from "../services/assignmentFiles.js";
import {
  authorizeCustomAssignmentFile,
  authorizePropertyTaxProtestFile,
} from "./assignmentAccess.js";
import {
  APPLICATION_WORKFLOWS,
  hasApplicationPermission,
  hasApplicationRole,
} from "./applicationAccess.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  roleChecker = hasApplicationRole,
  editorKeyChecker = editorKeyMatches,
  assignmentAuthorizer = authorizeCustomAssignmentFile,
  propertyTaxAuthorizer = authorizePropertyTaxProtestFile,
} = {}) {
  assertGuardOptions(pool, authenticationRequired);
  if (typeof roleChecker !== "function") {
    throw new TypeError("application_access_guards_role_checker_required");
  }
  if (typeof propertyTaxAuthorizer !== "function") {
    throw new TypeError("application_access_guards_property_tax_authorizer_required");
  }

  function requirePlatformAdministrator(req, res) {
    if (req.mobileAuth && roleChecker(req.mobileAuth, "homenode_admin")) return true;
    const authenticated = Boolean(req.mobileAuth);
    res.set("cache-control", "no-store")
      .status(authenticated ? 403 : 401)
      .json({ error: authenticated ? "application_access_denied" : "authentication_required" });
    return false;
  }

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

  function requireApplicationReader(req, res) {
    if (!req.mobileAuth) {
      if (!authenticationRequired) return true;
      res.set("cache-control", "no-store")
        .status(401)
        .json({ error: "authentication_required" });
      return false;
    }
    if (APPLICATION_WORKFLOWS.some((workflow) => (
      permissionChecker(req.mobileAuth, workflow, "read")
    ))) return true;
    res.set("cache-control", "no-store")
      .status(403)
      .json({ error: "application_access_denied" });
    return false;
  }

  async function requireCustomAccountScope(
    req,
    res,
    accountId,
    assignmentFileIdValue,
    permission = "read",
  ) {
    if (!requireWorkflowAccess(req, res, "custom_appraisal", permission)) return false;
    let assignmentFileId;
    try {
      assignmentFileId = normalizeAssignmentFileId(assignmentFileIdValue);
    } catch {
      res.set("cache-control", "no-store")
        .status(400)
        .json({ error: "invalid_assignment_file_id" });
      return false;
    }
    if (authenticationRequired && !assignmentFileId) {
      res.set("cache-control", "no-store")
        .status(400)
        .json({ error: "assignment_file_required" });
      return false;
    }
    if (!assignmentFileId) return true;
    return requireCustomAssignmentAccess(
      req,
      res,
      accountId,
      assignmentFileId,
      permission,
    );
  }

  async function requirePropertyTaxAccountScope(
    req,
    res,
    accountId,
    propertyTaxFileIdValue,
    permission = "read",
  ) {
    if (!requireWorkflowAccess(req, res, "property_tax_protest", permission)) return false;
    const rawFileId = String(propertyTaxFileIdValue || "").trim();
    const propertyTaxFileId = UUID_PATTERN.test(rawFileId) ? rawFileId.toLowerCase() : null;
    if (rawFileId && !propertyTaxFileId) {
      res.set("cache-control", "no-store")
        .status(400)
        .json({ error: "invalid_property_tax_protest_file_id" });
      return false;
    }
    if (authenticationRequired && !propertyTaxFileId) {
      res.set("cache-control", "no-store")
        .status(400)
        .json({ error: "property_tax_protest_file_required" });
      return false;
    }
    if (!propertyTaxFileId || !authenticationRequired) return true;
    try {
      await propertyTaxAuthorizer(pool, req.mobileAuth, {
        accountId,
        propertyTaxFileId,
        permission,
      });
      return true;
    } catch (error) {
      const notFound = error?.message === "property_tax_protest_file_not_found";
      res.set("cache-control", "no-store").status(notFound ? 404 : 403).json({
        error: notFound
          ? "property_tax_protest_file_not_found"
          : "property_tax_protest_file_access_denied",
      });
      return false;
    }
  }

  return Object.freeze({
    requireEditor,
    requirePlatformAdministrator,
    requireCustomAssignmentAccess,
    requireCustomAccountScope,
    requirePropertyTaxAccountScope,
    requireWorkflowAccess,
    requireApplicationReader,
  });
}
